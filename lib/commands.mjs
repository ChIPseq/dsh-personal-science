// Human commands: /where, /resume, /wrap, /deadend, /branch, /inject.
//
// These are the only *explicit* surface of the plugin. Everything else is
// passive (ledger + branch listeners), because the point of the design is that
// the agent does not have to remember to call anything — and that the human
// pays no per-step prompt tax just to know where the work stands.

import path from 'node:path'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { ensureScaffold, hasSci, resolveProjectRoot, sciDir, sessionHeader } from './project.mjs'
import { archiveState, readState, upsertSection } from './state.mjs'
import { hhmm, readDayEntries, summarizeDay, todayCounter, topTools } from './ledger.mjs'
import { readBranches, renderTree, shortId, upsertNode } from './branches.mjs'
import { readConfig, writeConfig } from './config.mjs'
import { deliverResult } from './deliver.mjs'
import { listInbox, pendingCount } from './inbox.mjs'
import { humanSize, jobCommands, recentFiles } from './scan.mjs'
import { appendText, clip, localDate, localStamp, localTime } from './fsutil.mjs'

const SKIP = new Set(['sci', 'node_modules', '.git', '_scratch', '_refs', '_analysis'])

function recentEntries (root, k = 8) {
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    if (e.name.startsWith('.')) continue
    try {
      const st = statSync(path.join(root, e.name))
      rows.push({ name: e.name, dir: e.isDirectory(), mtime: st.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime).slice(0, k)
}

function fail (text) {
  return { kind: 'error', text }
}

// A command's rawInput can arrive with a trailing newline plus whatever the
// user typed next (observed: "brief\n测试"). Only the first line/token is the
// argument; the rest is echo, never an error.
function firstLine (raw) {
  return String(raw || '').split(/\r?\n/)[0].trim()
}

function firstToken (raw) {
  return (firstLine(raw).split(/\s+/)[0] || '').toLowerCase()
}

function flatten (raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim()
}

export function registerCommands (ctx, deps) {
  const sessions = deps.sessions
  const diag = deps.diag || null

  const rootOf = (agent) => resolveProjectRoot(sessions, agent)

  // One colliding command name must not take the other three down.
  //
  // Two deliberate details, both learned from the session log:
  //   * a stable `definitionId` per command, so a client that keys command rows
  //     by identity has something to match;
  //   * an ~80ms deferral of the settlement. An instant handler returns before
  //     the client has painted the command row, and the result is dropped
  //     (observed: `/inject` returned success text that never appeared, while
  //     `/where` — which spends time scanning — always rendered).
  //
  // CORRECTION (2026-10-20): the deferral did NOT fix it. In one real session
  // `/resume` and `/inbox` both executed, logged their full text, and still
  // rendered nothing — the 80ms theory was wrong. The card is simply not a
  // reliable channel here, so every result is now ALSO delivered through
  // `lib/deliver.mjs` (file + a receipt row). The deferral stays: it is
  // harmless, and if a future client does render cards, it costs one tick.
  const safe = (definition) => {
    const run = definition.handler
    const handler = async (invocation) => {
      const result = await run(invocation)
      deliverResult(sessions, invocation, definition.name, result)
      await new Promise((resolve) => setTimeout(resolve, 80))
      return result
    }
    try {
      ctx.commands.register({ definitionId: `personal-science/${definition.name}`, ...definition, handler })
    } catch (err) {
      ctx.logger?.warn?.(`[personal-science] command "${definition.name}" not registered: ${err && err.message}`)
    }
  }

  // ── /resume ───────────────────────────────────────────────────────────────
  safe({
    name: 'resume',
    description: '重建并显示科研状态（sci/STATE.md + 今日台账 + 分支），首次使用会初始化 sci/ 目录',
    input: { hint: '无需参数' },
    handler: ({ agent }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      const fresh = !hasSci(root)
      ensureScaffold(root)

      const header = sessionHeader(sessions, agent)
      const node = readBranches(root).nodes.find((n) => n.id === agent.id) || {}
      const branchNote = header && header.parentSession
        ? `当前是分支会话：父 ${shortId(header.parentSession)}。分支方向：${node.direction || '未记录 → /branch <一句话>'}`
        : '主干会话（非分支）'

      const counter = todayCounter(root)
      const day = localDate()
      const state = readState(root) || ''
      const lines = []

      lines.push(fresh ? '## 已初始化 sci/（首次）' : '## 研究状态')
      lines.push('')
      lines.push(state.trim() || '（STATE.md 为空）')
      lines.push('')
      lines.push('## 今日台账')
      lines.push(counter.n === 0
        ? `- ${day}：还没有记录到工具调用`
        : `- ${day}：${counter.n} 次工具调用 / ${counter.fail} 次失败${counter.lastFail ? `；最近失败：${clip(counter.lastFail, 120)}` : ''}`)
      lines.push(`- 分支：${branchNote}`)
      const pendingResume = pendingCount(root)
      if (pendingResume) lines.push(`- 收件箱：${pendingResume} 个待处理（\`/inbox\` 看清单，说「处理 inbox」才会动）`)
      lines.push('')
      lines.push('## 项目近况（按 mtime 自动采集）')
      const recent = recentEntries(root)
      if (recent.length) {
        for (const r of recent) lines.push(`- ${r.dir ? '📁' : '📄'} ${r.name}（${hhmm(new Date(r.mtime).toISOString())}）`)
      } else {
        lines.push('- （空目录）')
      }
      lines.push('')
      lines.push(`sci/ 位于 \`${sciDir(root)}\`。这份状态会在**每一步**自动注入，不需要你手工粘贴背景。`)
      if (fresh) {
        lines.push('')
        lines.push('**下一步**：把 `sci/STATE.md` 的「当前判断 / 科学问题 / 下一步」三节填实（各 1-3 行即可），再用 `/wrap` 在会话结尾记账。')
      }

      return { kind: 'success', text: lines.join('\n') }
    }
  })

  // ── /wrap ─────────────────────────────────────────────────────────────────
  safe({
    name: 'wrap',
    description: '收尾记账：把今日台账折叠进 sci/log/，并机械更新 STATE.md 的「停在哪里」',
    input: { hint: '可选：一句话说明本轮结论' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const date = localDate()
      const sum = summarizeDay(root, date)
      const note = flatten(rawInput)
      const logFile = path.join(sciDir(root), 'log', `${date}.md`)
      const lines = []

      lines.push(`## ${localTime()} · 收尾`)
      lines.push('')
      if (!sum || sum.n === 0) {
        lines.push('- 今天没有记录到工具调用。')
      } else {
        lines.push(`- 工具调用 ${sum.n} 次，失败 ${sum.fail} 次（${hhmm(sum.first)} → ${hhmm(sum.last)}）`)
        lines.push(`- 主要动作：${topTools(sum.tools)}`)
        if (sum.lastFail) lines.push(`- 最近失败：${clip(sum.lastFail, 160)}`)
      }
      if (note) lines.push(`- 本轮结论：${note}`)
      else lines.push('- 待补：① 证实了什么 ② 否证了什么 ③ 下一步')
      lines.push('')
      appendText(logFile, lines.join('\n') + '\n')

      const stop = []
      stop.push(sum && sum.n
        ? `- 上次动作：${hhmm(sum.last)} 收尾（${topTools(sum.tools, 2)}）`
        : '- 上次动作：无工具记录')
      stop.push('- 待跑作业：（如无请写"无"）')
      stop.push('- 未回读：（列出还没读回的结果文件）')
      upsertSection(root, '停在哪里', stop.join('\n'))

      const archived = archiveState(root, `${date}_${localTime().replace(':', '')}`)

      const out = ['已记账。']
      if (sum && sum.n) out.push(`- ${date}：${sum.n} 次调用 / ${sum.fail} 失败 → \`sci/log/${date}.md\``)
      else out.push(`- ${date}：无工具记录 → 已写占位条目`)
      out.push(`- STATE.md 的「停在哪里」已机械更新${archived ? '，旧版本已归档到 sci/state-history/' : ''}`)
      if (!note) {
        out.push('')
        out.push('**还差 3 行**（模型或你自己补）：')
        out.push('1. 本轮证实了什么（含证据文件路径）')
        out.push('2. 本轮否证了什么（→ 建议同时 `/deadend`）')
        out.push('3. 下一步的具体动作')
      }
      return { kind: 'success', text: out.join('\n') }
    }
  })

  // ── /deadend ──────────────────────────────────────────────────────────────
  safe({
    name: 'deadend',
    description: '记录一条"试过但不行"的路线（append-only，防止未来会话重蹈覆辙）',
    input: { hint: '试过什么 / 为什么不行' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const text = flatten(rawInput)
      if (!text) return fail('用法：`/deadend 试过 X，因为 Y 不行（证据：路径/Z）`')

      const file = path.join(sciDir(root), 'dead-ends.md')
      if (!existsSync(file)) ensureScaffold(root)
      appendText(file, `| ${localDate()} | ${text} |  |  |\n`)
      return {
        kind: 'success',
        text: `已写入 \`sci/dead-ends.md\`：\n- ${localDate()}：${clip(text, 140)}`
      }
    }
  })

  // ── /branch ───────────────────────────────────────────────────────────────
  safe({
    name: 'branch',
    description: '查看探索分支树；带参数则记录当前分支要验证的方向',
    input: { hint: '可选：这个分支要验证什么' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const text = firstLine(rawInput)
      const header = sessionHeader(sessions, agent)

      if (text) {
        upsertNode(root, {
          id: agent.id,
          parent: (header && header.parentSession) || null,
          at: (header && header.createdAt) || Date.now(),
          direction: text,
          directedAt: localStamp()
        })
        return {
          kind: 'success',
          text: `已记录分支方向：${text}\n- 会话 ${shortId(agent.id)}${header && header.parentSession ? `（父 ${shortId(header.parentSession)}）` : ''}`
        }
      }

      if (!readBranches(root).nodes.some((n) => n.id === agent.id)) {
        upsertNode(root, {
          id: agent.id,
          parent: (header && header.parentSession) || null,
          at: (header && header.createdAt) || Date.now()
        })
      }
      const db = readBranches(root)
      return {
        kind: 'success',
        text: ['## 探索分支树', '', renderTree(db, agent.id), '', '用 `/branch <一句话>` 补记方向。'].join('\n')
      }
    }
  })

  // ── /where ────────────────────────────────────────────────────────────────
  // The everyday question: "任务跑到哪了 / 结果在哪 / 路径是什么". Cheap: reads
  // today's ledger tail plus a bounded directory scan. Never renders STATE.md.
  safe({
    name: 'where',
    description: '一眼看现在：最近动作、最近产物、可能是作业的命令、关键路径（轻量）',
    input: { hint: '可选：显示多少条最近动作（默认 6）' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const want = Math.min(Math.max(parseInt(firstToken(rawInput), 10) || 6, 3), 20)
      const cfg = readConfig(root)
      const sum = summarizeDay(root)
      const entries = readDayEntries(root, localDate(), 500)
      const jobs = jobCommands(entries, 5)
      const files = recentFiles(root, 8)
      const header = sessionHeader(sessions, agent)
      const node = readBranches(root).nodes.find((n) => n.id === agent.id) || {}
      const pending = pendingCount(root)
      const out = []

      // Line 1 is what the collapsed command card shows, so it carries the whole
      // answer: any reader can act on this one line without expanding anything.
      out.push([
        '## 现在',
        `注入 ${cfg.inject}`,
        sum && sum.n ? `今日 ${sum.n} 次调用/${sum.fail} 失败` : '今日台账为空',
        pending ? `收件箱 ${pending} 个待处理` : '收件箱空',
        header && header.parentSession ? `分支 · 父 ${shortId(header.parentSession)}` : '主干'
      ].join(' · '))
      out.push(cfg.inject === 'off'
        ? '- 注入：off（要一行状态的自动注入用 `/inject brief`）'
        : `- 注入：${cfg.inject}`)
      out.push(`- 回执：${cfg.deliver}（命令卡片只显示一行；全文在 \`sci/out/\`）`)
      out.push(`- 分支：${header && header.parentSession ? `分支 · 父 ${shortId(header.parentSession)} · ${node.direction || '方向未记'}` : '主干'}`)
      out.push(sum && sum.n
        ? `- 今日：${sum.n} 次调用 / ${sum.fail} 失败（${hhmm(sum.first)} → ${hhmm(sum.last)}｜${topTools(sum.tools, 3)}）`
        : '- 今日：台账为空')
      if (pending) out.push(`- 收件箱：**${pending} 个待处理**（\`/inbox\` 看清单）`)

      out.push('', `## 最近动作（倒序 ${want} 条）`)
      const tail = entries.slice(-want).reverse()
      if (!tail.length) out.push('- （无）')
      for (const e of tail) {
        out.push(`- ${hhmm(e.t)} ${e.ok === false ? '✗' : '✓'} ${e.tool}: ${clip(e.sig, 64)}${e.err ? ` — ${clip(e.err, 40)}` : ''}`)
      }

      out.push('', '## 最近产物（按 mtime，跳过 sci/ 与隐藏目录）')
      if (!files.length) out.push('- （无）')
      for (const f of files) out.push(`- ${f.rel}（${hhmm(new Date(f.mtime).toISOString())}，${humanSize(f.size)}）`)

      out.push('', '## 可能的作业（今日提交过）')
      if (!jobs.length) out.push('- （今日台账里没有 qsub / sbatch / nohup 一类命令）')
      for (const j of jobs) out.push(`- ${hhmm(j.t)} ${clip(j.sig, 96)}`)

      out.push('', '## 路径')
      out.push(`- 项目根：\`${root}\``)
      out.push(`- 状态：\`${sciDir(root)}\``)
      if (files[0]) out.push(`- 最近改动目录：\`${path.dirname(path.join(root, files[0].rel))}\``)

      if (diag) {
        out.push('', '## 注入自检')
        out.push(`- 渲染 ${diag.calls} 次｜agent=${diag.agent ? 'ok' : 'none'}｜cwd=${diag.root ? 'ok' : 'none'}｜sci=${diag.sci ? 'ok' : 'none'}｜模式=${diag.mode}｜上次长度=${diag.len}`)
        if (diag.preview) out.push(`- 上次注入：${clip(diag.preview, 140)}`)
        if (diag.error) out.push(`- 错误：${diag.error}`)
      }

      out.push('', '完整状态用 `/resume`；记一条死路用 `/deadend`。')
      return { kind: 'success', text: out.join('\n') }
    }
  })

  // ── /inject ───────────────────────────────────────────────────────────────
  safe({
    name: 'inject',
    description: '自动注入开关：不带参数＝循环切换（off→brief→full）；也可 /inject off|brief|full',
    input: { hint: '可留空（循环切换）' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const cur = readConfig(root)
      const arg = firstToken(rawInput)

      // No argument: cycle. One Enter always does something visible.
      const CYCLE = { off: 'brief', brief: 'full', full: 'off' }
      let mode = arg
      if (!mode) mode = CYCLE[cur.inject] || 'brief'

      if (!['off', 'brief', 'full'].includes(mode)) {
        return {
          kind: 'error',
          text: [
            `无法识别的参数：\`${clip(firstLine(rawInput), 40)}\``,
            `当前模式：${cur.inject}`,
            '',
            '用法：`/inject`（循环切换）或 `/inject off|brief|full`'
          ].join('\n')
        }
      }

      writeConfig(root, { inject: mode })
      const meaning = {
        off: '不注入（默认）。日常用 `/where` 就够。',
        brief: '每一步注入一行状态（~100 字）。',
        full: '会话前 2 步注入完整 STATE，之后回落到 brief。'
      }[mode]
      return {
        kind: 'success',
        text: [
          `注入模式：${cur.inject} → **${mode}**`,
          `- ${meaning}`,
          '- 已写入 `sci/config.json`，下一次模型调用即生效。',
          '- 校验：随便发一条消息，然后 `/where` 看「注入自检」里的渲染次数（应 >0 且上次长度 >0）。'
        ].join('\n')
      }
    }
  })

  // ── /inbox ────────────────────────────────────────────────────────────────
  safe({
    name: 'inbox',
    description: '投放箱：看待处理文件与建议归属；处理完再确认它已清空',
    input: { hint: '无需参数' },
    handler: ({ agent }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      // Idempotent: also repairs projects scaffolded before inbox/ existed.
      ensureScaffold(root)
      const { dir, items } = listInbox(root)

      if (!items.length) {
        return {
          kind: 'success',
          text: [
            '## 收件箱（空）',
            `\`${dir}\``,
            '',
            '没有待处理文件。把资料（PDF / 报告 / 数据表）拖进这个目录，然后说一句「处理 inbox」。'
          ].join('\n')
        }
      }

      let total = 0
      for (const it of items) total += it.size
      const out = []
      out.push(`## 收件箱：${items.length} 个待处理（共 ${humanSize(total)}）`)
      out.push(`\`${dir}\``)
      out.push('')
      for (const it of items) {
        out.push(`- ${it.isDirectory ? '[目录]' : ''} ${it.name}（${it.isDirectory ? '—' : humanSize(it.size)}，${hhmm(new Date(it.mtime).toISOString())}）`)
        out.push(`  → 建议：${it.target}`)
      }
      out.push('')
      out.push('把下面这句发给模型即可（归属由它读内容后判断，不由扩展名决定）：')
      out.push('')
      out.push(`> 处理 inbox：读这 ${items.length} 个文件，按内容判断归属并移动到 papers/ / Plan_Summary/ / data/ / Experiment/ 等位置，在 sci/log 记一行，最后确认 inbox 已清空。`)
      out.push('')
      out.push('读不动的（扫描版 PDF、加密、超大二进制）应该留在 inbox 并告诉你，不会硬猜。')
      return { kind: 'success', text: out.join('\n') }
    }
  })

  return { names: ['where', 'resume', 'wrap', 'deadend', 'branch', 'inject', 'inbox'] }
}
