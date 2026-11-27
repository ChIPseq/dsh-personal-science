// 夜窗 CLI 的回归测试：模型能通过跑脚本完成 start/tick/close（而不是靠斜杠命令）。
//
//   node test/night-cli.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../scripts/night.mjs', import.meta.url))
const root = mkdtempSync(path.join(tmpdir(), 'ps-night-'))

let pass = 0
let failed = 0
function ok (cond, label) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`) } else { failed += 1; console.log(`  FAIL ${label}`) }
}

function run (...args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args, '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status ?? 1, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') }
  }
}

try {
  console.log('start')
  const start = run('start', '--cap', '4.8')
  ok(start.code === 0, 'start exits 0')
  ok(existsSync(path.join(root, 'sci', 'night.json')), 'start writes sci/night.json')

  console.log('tick')
  const low = run('tick', '--spent', '1.2')
  ok(low.code === 0 && low.stdout.includes('stop=false'), 'tick below cap says stop=false')
  const high = run('tick', '--spent', '5.0')
  ok(high.stdout.includes('stop=true (cap)'), 'tick above cap says stop=cap')

  console.log('close guard')
  const noReason = run('close', '--reason', 'cap', '--spent', '1.0')
  ok(noReason.code === 1, 'close cap at 1.0 is refused (reason must match reality)')
  const good = run('close', '--reason', 'cap', '--spent', '5.0')
  ok(good.code === 0, 'close cap at 5.0 succeeds')

  console.log('evidence_complete')
  run('start', '--cap', '4.8')
  const noEv = run('close', '--reason', 'evidence_complete')
  ok(noEv.code === 1, 'evidence_complete without a checklist is refused')
  writeFileSync(path.join(root, 'closure.md'), '# closure\n\nE1 pass\nE2 pass\nE3 pass\nE4 pass\nE5 pass\nE6 pass\n')
  const withEv = run('close', '--reason', 'evidence_complete', '--evidence', 'closure.md')
  ok(withEv.code === 0, 'evidence_complete with a checklist succeeds')
  ok(withEv.stdout.includes('start writing'), 'evidence_complete tells the agent to start writing')

  console.log('status')
  const status = run('status')
  ok(status.code === 0 && status.stdout.includes('closed'), 'status reports the closed window')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
