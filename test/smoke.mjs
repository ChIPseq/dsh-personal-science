// Smoke test: exercises the plugin against a mock Cordis context, so the whole
// host half can be verified without booting DSH.
//
//   node test/smoke.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply } from '../index.mjs'

let pass = 0
let failed = 0
function ok (cond, label) {
  if (cond) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'ps-sci-'))
const otherRoot = mkdtempSync(path.join(tmpdir(), 'ps-plain-'))

const CWDS = {
  'session-main': root,
  'session-child': root,
  'session-other': otherRoot
}

const sessions = {
  get (id) {
    const cwd = CWDS[id]
    if (!cwd) return undefined
    return {
      header: {
        cwd,
        createdAt: Date.now(),
        isSeeded: id === 'session-child',
        parentSession: id === 'session-child' ? 'session-main' : undefined
      }
    }
  }
}

const contexts = []
const commands = new Map()
const listeners = new Map()
const skills = []

const ctx = {
  systemPrompt: { context: (c) => { contexts.push(c); return () => {} } },
  commands: { register: (d) => { commands.set(d.name, d); return () => {} } },
  get: (k) => k === 'sessions' ? sessions : k === 'skills' ? { register: (s) => skills.push(s) } : undefined,
  on: (ev, fn) => {
    const arr = listeners.get(ev) || []
    arr.push(fn)
    listeners.set(ev, arr)
  },
  logger: { warn: () => {} }
}

function emit (ev, ...args) {
  for (const fn of listeners.get(ev) || []) fn(...args)
}

function invoke (name, rawInput = '', agentId = 'session-main') {
  const def = commands.get(name)
  if (!def) throw new Error(`command not registered: ${name}`)
  return def.handler({
    commandId: 'c1',
    agent: { id: agentId },
    rawInput,
    attachments: [],
    signal: new AbortController().signal
  })
}

function digest (agentId = 'session-main') {
  return contexts[0].text({ agent: { id: agentId } })
}

console.log('apply()')
apply(ctx)
ok(commands.size === 6, 'registered 6 commands')
ok(skills.length === 1 && skills[0].name === 'personal-science', 'registered the skill')
ok(typeof contexts[0].text === 'function', 'registered runtime context')

console.log('\nopt-in gate')
ok(digest() === '', 'no sci/ -> injects nothing')
emit('tools/result', { name: 'pwsh', agent: { id: 'session-main' }, arguments: { command: 'qsub x.pbs' } }, { isError: false })
ok(!existsSync(path.join(root, 'sci')), 'no sci/ -> nothing written to disk')

console.log('\n/resume')
const r1 = invoke('resume')
ok(r1.kind === 'success', '/resume succeeds')
ok(existsSync(path.join(root, 'sci', 'STATE.md')), 'STATE.md created')
ok(existsSync(path.join(root, 'sci', 'dead-ends.md')), 'dead-ends.md created')
ok(digest() === '', 'injection stays OFF by default')

console.log('\n/inject')
const inj = invoke('inject', 'brief')
ok(inj.kind === 'success', '/inject brief succeeds')
const dBrief = digest()
ok(dBrief.includes('【'), 'brief injection renders after opting in')
ok(dBrief.length < 400, 'brief injection stays small')
invoke('inject', 'full')
const dFull = digest()
ok(dFull.includes('研究状态'), 'full injection includes the state digest')

console.log('\nledger')
emit('tools/result', { name: 'pwsh', agent: { id: 'session-main' }, arguments: { command: 'sbatch run.sh' } }, { isError: false })
emit('tools/result', { name: 'read', agent: { id: 'session-main' }, arguments: { file_path: '/x/y.md' } }, { isError: true, error: { message: 'ENOENT' } })
const day = new Date()
const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
const ledgerFile = path.join(root, 'sci', 'ledger', `${date}.jsonl`)
ok(existsSync(ledgerFile), 'ledger file written')
const ledgerLines = readFileSync(ledgerFile, 'utf8').trim().split('\n')
ok(ledgerLines.length === 2, 'ledger has 2 entries')
ok(JSON.parse(ledgerLines[1]).err === 'ENOENT', 'failure reason captured')

console.log('\n/where')
const w0 = invoke('where')
ok(w0.kind === 'success', '/where succeeds')
ok(w0.text.includes('最近动作'), '/where lists recent actions')
ok(w0.text.includes('sbatch run.sh'), '/where shows the submitted job')
ok(w0.text.includes('注入自检'), '/where reports injection diagnostics')
ok(!w0.text.includes('## 科学问题'), '/where does not dump the whole STATE')

console.log('\n/wrap')
const w = invoke('wrap', '证实了 A')
ok(w.kind === 'success', '/wrap succeeds')
const logFile = path.join(root, 'sci', 'log', `${date}.md`)
ok(existsSync(logFile), 'log entry written')
ok(readFileSync(logFile, 'utf8').includes('本轮结论：证实了 A'), 'wrap records the note')
ok(readFileSync(path.join(root, 'sci', 'STATE.md'), 'utf8').includes('上次动作'), 'STATE 停在哪里 updated')
ok(readdirSync(path.join(root, 'sci', 'state-history')).length === 1, 'previous STATE archived')

console.log('\n/deadend')
const de = invoke('deadend', '试过 FIMO-only 弱监督，循环论证')
ok(de.kind === 'success', '/deadend succeeds')
ok(readFileSync(path.join(root, 'sci', 'dead-ends.md'), 'utf8').includes('循环论证'), 'dead-end row appended')

console.log('\n/branch')
const b1 = invoke('branch', '验证顺式 vs 反式归因')
ok(b1.kind === 'success', '/branch with direction succeeds')
const branches = JSON.parse(readFileSync(path.join(root, 'sci', 'branches.json'), 'utf8'))
ok(branches.nodes[0].direction === '验证顺式 vs 反式归因', 'branch direction stored')
const b2 = invoke('branch')
ok(b2.text.includes('探索分支树') && b2.text.includes('当前'), 'branch tree renders current node')

console.log('\nbranch detection from session header')
emit('agent/created', { agent: { id: 'session-child' } })
const nodes = JSON.parse(readFileSync(path.join(root, 'sci', 'branches.json'), 'utf8')).nodes
const child = nodes.find((n) => n.id === 'session-child')
ok(child && child.parent === 'session-main', 'fork recorded with parent')
const dChild = digest('session-child')
ok(dChild.includes('分支'), 'fork session gets a branch note in its digest')

console.log('\nother project stays untouched')
ok(digest('session-other') === '', 'unrelated project injects nothing')
ok(!existsSync(path.join(otherRoot, 'sci')), 'unrelated project gets no files')

rmSync(root, { recursive: true, force: true })
rmSync(otherRoot, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
