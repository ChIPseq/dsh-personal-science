#!/usr/bin/env node
// 夜窗的命令行入口——给**模型**用的那一半。
//
// 为什么要有它：`/night` 是注册给**人**的斜杠命令，模型没有"调用命令"这个动作。
// 所以夜窗上线后一次都没被用过（sci/night.json 从未出现）。这里把同一套逻辑
// （lib/night.mjs）包成模型本来就会做的事：跑一个 node 脚本。
//
// 用法（root 默认是当前目录）：
//   node scripts/night.mjs start  --root <dir> --cap 4.8
//   node scripts/night.mjs tick   --root <dir> --spent 3.20
//   node scripts/night.mjs close  --root <dir> --reason cap --spent 5.10
//   node scripts/night.mjs close  --root <dir> --reason evidence_complete --evidence Plan_Summary/x.md
//   node scripts/night.mjs status --root <dir>
//
// 退出码：0 = 成功/判停成立；1 = 拒绝（理由与事实不符、缺清单等）。

import path from 'node:path'
import process from 'node:process'
import { closeNight, decide, endOf, nightPath, openNight, readNight, tickNight } from '../lib/night.mjs'

const argv = process.argv.slice(2)
const cmd = (argv.shift() || 'status').toLowerCase()
function flag (name, def) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const root = path.resolve(flag('root', process.cwd()))
const pad = (n) => String(n).padStart(2, '0')
const clock = (min) => {
  const m = Math.max(0, Math.round(min))
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`
}

function failOut (msg) {
  console.error(`night: ${msg}`)
  process.exit(1)
}

if (cmd === 'start') {
  const night = openNight(root, { cap: flag('cap'), spent: flag('spent') })
  console.log(`night #${night.night} open: ${night.since} -> ${clock((endOf(night) - new Date(night.since)) / 60000)}`)
  console.log(`cap ¥${Number(night.cap_cny).toFixed(2)}; file ${nightPath(root)}`)
  console.log('next: every tick run  node night.mjs tick --spent <window-check 的 spent>')
  process.exit(0)
}

if (cmd === 'tick') {
  const out = tickNight(root, { spent: flag('spent') })
  if (!out) failOut('no night window; run start first')
  const { night, decision } = out
  console.log(`spent ¥${decision.spent.toFixed(2)}/¥${Number(decision.cap).toFixed(2)}  left ${clock(decision.minutesLeft)}  stop=${decision.stop}${decision.stop ? ` (${decision.reason})` : ''}`)
  if (decision.stop) {
    console.log(`next: close now -> node night.mjs close --reason ${decision.reason} --spent ${decision.spent.toFixed(2)}`)
    process.exit(0)
  }
  console.log('next: keep dispatching; recreate the next tick')
  process.exit(0)
}

if (cmd === 'close') {
  const out = closeNight(root, { reason: flag('reason', ''), spent: flag('spent'), evidence: flag('evidence'), now: flag('now') })
  if (!out) failOut('no night window')
  if (out.error) failOut(out.error)
  const n = out.night
  console.log(`closed: reason=${n.stop_reason} ¥${Number(n.spent_cny).toFixed(2)}/¥${Number(n.cap_cny).toFixed(2)} at ${n.closed_at}`)
  if (n.stop_reason === 'evidence_complete') console.log('evidence complete -> stop experiments, start writing')
  if (n.weak) console.log('WEAK: queue_empty (agenda done, evidence not complete)')
  process.exit(0)
}

if (cmd === 'status') {
  const n = readNight(root)
  if (!n) failOut('no night window')
  const d = decide(n)
  console.log(`night #${n.night} ${n.status}  spent ¥${d.spent.toFixed(2)}/¥${Number(d.cap).toFixed(2)}  left ${clock(d.minutesLeft)}  stop=${d.stop}${d.stop ? ` (${d.reason})` : ''}`)
  if (n.stop_reason) console.log(`closed: ${n.stop_reason}${n.weak ? ' (weak)' : ''}`)
  process.exit(0)
}

failOut(`unknown command: ${cmd} (start|tick|close|status)`)
