// `sci/night.json` — one long-running research window (a "night").
//
// WHY this file exists at all: a research window is the one piece of state that
// a model reliably loses. It survives compaction badly, because "we are still
// inside the window, the budget is not spent yet, stop only at 05:40" is not a
// fact about the repository — it is a fact about the clock. Writing it to a file
// and re-injecting one line per step is the cheapest way to make it survive.
//
// Contract:
//   * The window is opened by `/night start`, advanced by `/night tick`, and
//     closed by `/night close --reason …`.
//   * `close` REFUSES to run without a reason. "We stopped" and "we ran out of
//     budget" must never look the same in the record (this is the failure the
//     2026-11-19 night produced: `status=done`, cost ¥0.49 of ¥4.8, queue empty,
//     and nobody noticed for four hours).
//   * The plugin does not know prices. The caller passes `--spent`; the plugin
//     only compares it to `cap_cny` and to the clock.
//   * Defaults: cap ¥4.8, window ends 06:00 (next morning), stop 20 min early.

import path from 'node:path'
import { sciDir } from './project.mjs'
import { localDate, localTime, tryRead, writeText } from './fsutil.mjs'

export const NIGHT_PATH = 'night.json'
export const DEFAULT_CAP = 4.8
export const DEFAULT_END_HOUR = 6
export const STOP_MARGIN_MIN = 20
export const STOP_REASONS = ['evidence_complete', 'cap', 'time', 'external', 'queue_empty']

const REASON_HINT = 'evidence_complete（需 --evidence <文件>） | cap | time | external | queue_empty'

export function nightPath (root) {
  return path.join(sciDir(root), NIGHT_PATH)
}

const pad = (n) => String(n).padStart(2, '0')

/** Local ISO-8601 with offset, e.g. 2026-11-20T22:00:00+08:00 (keeps the clock readable). */
export function isoLocal (d = new Date()) {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${localDate(d)}T${localTime(d)}:${pad(d.getSeconds())}${sign}${pad(abs / 60)}:${pad(abs % 60)}`
}

export function readNight (root) {
  const text = tryRead(nightPath(root))
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeNight (root, data) {
  const next = { ...data, updated_at: isoLocal() }
  writeText(nightPath(root), JSON.stringify(next, null, 2) + '\n')
  return next
}

/** End of the current window: the next 06:00 after `since`. */
export function endOf (night) {
  const start = new Date(night.since || Date.now())
  const end = new Date(start)
  end.setHours(DEFAULT_END_HOUR, 0, 0, 0)
  if (end <= start) end.setDate(end.getDate() + 1)
  return end
}

/**
 * Pure stop decision. `stop` is true only for the two legitimate reasons —
 * budget or clock. An empty queue is NOT a stop reason (it is a failure mode).
 */
export function decide (night, now = new Date()) {
  const spent = Number(night.spent_cny || 0)
  const cap = Number(night.cap_cny ?? DEFAULT_CAP)
  const end = endOf(night)
  const minutesLeft = (end - now) / 60000
  const byCap = spent >= cap
  const byTime = minutesLeft <= STOP_MARGIN_MIN
  return {
    stop: byCap || byTime,
    reason: byCap ? 'cap' : byTime ? 'time' : null,
    spent,
    cap,
    end,
    minutesLeft
  }
}

function nextNumber (root) {
  const prev = readNight(root)
  if (!prev) return 1
  return Number(prev.night || 0) + 1
}

export function openNight (root, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date()
  return writeNight(root, {
    night: Number(opts.night || nextNumber(root)),
    date: localDate(now),
    status: 'running',
    since: isoLocal(now),
    started_at: isoLocal(now),
    cap_cny: Number(opts.cap ?? DEFAULT_CAP),
    spent_cny: Number(opts.spent || 0),
    tick_seconds: Number(opts.tick ?? 1200),
    stop_reason: null,
    weak: false,
    closed_at: null
  })
}

export function tickNight (root, opts = {}) {
  const night = readNight(root)
  if (!night) return null
  const spent = opts.spent === undefined ? Number(night.spent_cny || 0) : Number(opts.spent)
  const next = writeNight(root, { ...night, spent_cny: Number.isFinite(spent) ? spent : 0 })
  return { night: next, decision: decide(next, opts.now ? new Date(opts.now) : new Date()) }
}

export function closeNight (root, opts = {}) {
  const night = readNight(root)
  if (!night) return null
  const reason = String(opts.reason || '')
  if (!STOP_REASONS.includes(reason)) {
    return { error: `必须给出收口理由：${REASON_HINT}（收到：${reason || '空'}）` }
  }
  const spent = opts.spent === undefined ? Number(night.spent_cny || 0) : Number(opts.spent)
  const now = opts.now ? new Date(opts.now) : new Date()
  const d = decide({ ...night, spent_cny: spent }, now)

  // `evidence_complete` 是唯一"正常收口"：实验逻辑闭合、证据够，就可以停。
  // 它必须指到一份写好的收口清单——否则又回到"我说够了就够了"。
  if (reason === 'evidence_complete') {
    const rel = String(opts.evidence || '').trim()
    if (!rel) return { error: 'evidence_complete 需要 --evidence <收口清单文件>（六条 E1–E6 逐条判定）' }
    const text = tryRead(path.resolve(root, rel))
    if (text === null) return { error: `找不到收口清单：${rel}` }
    if (!/E1[\s\S]*E6/.test(text)) return { error: `收口清单 ${rel} 里没有 E1–E6 六条判定` }
  }

  // 理由要和事实对得上：`cap` 却是 79% 花费、`time` 却是凌晨三点，都是
  // "把提前收工解释成正常收工"。2026-11-24 夜 9 就发生过一次（¥3.77 记成 cap）。
  if (reason === 'cap' && spent < Number(d.cap)) {
    return { error: `cap 要求本夜花费 ≥ ¥${Number(d.cap).toFixed(2)}，当前 ¥${spent.toFixed(2)}；没花完就收工请用 queue_empty（记 weak）或 external` }
  }
  if (reason === 'time' && d.minutesLeft > STOP_MARGIN_MIN) {
    const left = Math.round(d.minutesLeft / 60)
    return { error: `time 要求距收窗 ≤ ${STOP_MARGIN_MIN} 分钟（当前还剩约 ${left} 小时）；提前收工请用 queue_empty 或 external` }
  }

  const next = writeNight(root, {
    ...night,
    status: 'closed',
    spent_cny: Number.isFinite(spent) ? spent : Number(night.spent_cny || 0),
    stop_reason: reason,
    weak: reason === 'queue_empty' || Boolean(night.weak),
    closed_at: isoLocal(now)
  })
  return { night: next }
}

/** One line for `inject: brief` / `full`. Empty when there is no open night. */
export function nightLine (root, now = new Date()) {
  const night = readNight(root)
  if (!night || night.status !== 'running') return ''
  const d = decide(night, now)
  const h = Math.floor(Math.max(0, d.minutesLeft) / 60)
  const m = Math.round(Math.max(0, d.minutesLeft) % 60)
  const clock = h > 0 ? `${h}h${pad(m)}m` : `${m}min`
  return `【夜窗 #${night.night}】¥${d.spent.toFixed(2)}/${Number(d.cap).toFixed(1)} · 距收窗 ${clock} · stop=${d.stop}${
    d.stop ? `(${d.reason})` : ''
  }`
}

export function renderNight (root, now = new Date()) {
  const night = readNight(root)
  if (!night) return '没有夜窗记录（`/night start` 开一个）。'
  const d = decide(night, now)
  const lines = []
  lines.push(`## 夜窗 #${night.night} · ${night.status}`)
  lines.push(`- 开始：${night.since}（${night.date} 夜）`)
  lines.push(`- 预算：¥${d.spent.toFixed(2)} / ¥${Number(d.cap).toFixed(2)}｜判停线 05:40｜窗口 ${localTime(d.end)} 结束`)
  lines.push(`- 剩余：${Math.max(0, Math.floor(d.minutesLeft / 60))}h${pad(Math.max(0, Math.round(d.minutesLeft % 60)))}m`)
  if (night.status === 'running') {
    lines.push(d.stop
      ? `- **已到停止条件（${d.reason}）**：立刻 \`/night close --reason ${d.reason}\`，不要再派新任务`
      : '- 未到停止条件：继续派工；tick 间隔 ' + Math.round(Number(night.tick_seconds || 1200) / 60) + ' 分钟')
  } else {
    lines.push(`- 收口：${night.stop_reason}${night.weak ? '（weak：队列空/未触顶，属失败）' : ''} @ ${night.closed_at}`)
  }
  lines.push(`- 文件：\`${nightPath(root)}\``)
  return lines.join('\n')
}

export { REASON_HINT }
