// Smoke test: exercises the plugin against a mock Cordis context, so the whole
// host half can be verified without booting DSH.
//
//   node test/smoke.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply } from '../index.mjs'
import { RECEIPT_PREFIX, receiptPath } from '../lib/deliver.mjs'
import { writeConfig } from '../lib/config.mjs'

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

const commands = new Map()
const listeners = new Map()
const skills = []

const ctx = {
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

/** Run the `system-prompt/assemble` waterfall the way the agent loop does. */
async function render (agentId = 'session-main') {
  const fns = listeners.get('system-prompt/assemble') || []
  const base = { sections: [], contexts: [], tools: [], variables: {} }
  const step = (i, asm) => (i >= fns.length
    ? Promise.resolve(asm)
    : fns[i](asm, { agent: { id: agentId }, scope: { id: agentId } }, () => step(i + 1, asm)))
  const out = await step(0, base)
  return (out.contexts || []).map((c) => c.text).join('\n')
}

function invoke (name, rawInput = '', agentId = 'session-main') {
  const def = commands.get(name)
  if (!def) throw new Error(`command not registered: ${name}`)
  return def.handler({
    commandId: 'c1',
    agent: makeAgent(agentId),
    rawInput,
    attachments: [],
    signal: new AbortController().signal
  })
}

// Command output barely renders in the desktop client, so every result is also
// delivered into the conversation through the agent's own inbox. The mock
// records both routes so the tests can assert what the human would actually see.
const delivered = [] // { agent, mode: 'turn' | 'pending', text }
function makeAgent (agentId) {
  return {
    id: agentId,
    steer (message) {
      delivered.push({ agent: agentId, mode: 'turn', text: message.content[0].text, message })
    },
    inject (message) {
      delivered.push({ agent: agentId, mode: 'pending', text: message.content[0].text, message })
    }
  }
}
const lastDelivery = () => delivered[delivered.length - 1]
const deliveryCount = () => delivered.length

async function main () {
  console.log('apply()')
  apply(ctx)
  ok(commands.size === 7, 'registered 7 commands')
  ok(skills.length === 1 && skills[0].name === 'personal-science', 'registered the skill')
  ok((listeners.get('system-prompt/assemble') || []).length === 1, 'hooked the assemble waterfall')

  console.log('\nopt-in gate')
  ok((await render()) === '', 'no sci/ -> injects nothing')
  emit('tools/result', { name: 'pwsh', agent: { id: 'session-main' }, arguments: { command: 'qsub x.pbs' } }, { isError: false })
  ok(!existsSync(path.join(root, 'sci')), 'no sci/ -> nothing written to disk')

  console.log('\n/resume')
  const r1 = await invoke('resume')
  ok(r1.kind === 'success', '/resume succeeds')
  ok(existsSync(path.join(root, 'sci', 'STATE.md')), 'STATE.md created')
  ok(existsSync(path.join(root, 'sci', 'dead-ends.md')), 'dead-ends.md created')
  ok((await render()) === '', 'injection stays OFF by default')

  console.log('\n/inject')
  const inj = await invoke('inject', 'brief')
  ok(inj.kind === 'success', '/inject brief succeeds')
  const dBrief = await render()
  ok(dBrief.includes('【'), 'brief injection renders after opting in')
  ok(dBrief.length < 400, 'brief injection stays small')
  await invoke('inject', 'full')
  const dFull = await render()
  ok(dFull.includes('研究状态'), 'full injection includes the state digest')
  const injTolerant = await invoke('inject', 'brief\n测试这是误带进来的下一句话')
  ok(injTolerant.kind === 'success', 'arg with a trailing line/text is still accepted')
  ok(injTolerant.text.includes('brief'), 'tolerant parse reported the brief mode')
  const injCycle = await invoke('inject')
  ok(injCycle.kind === 'success' && injCycle.text.includes('→'), 'no-arg /inject cycles the mode')

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
  const w0 = await invoke('where')
  ok(w0.kind === 'success', '/where succeeds')
  ok(w0.text.includes('最近动作'), '/where lists recent actions')
  ok(w0.text.includes('sbatch run.sh'), '/where shows the submitted job')
  ok(w0.text.includes('注入自检'), '/where reports injection diagnostics')
  ok(!w0.text.includes('## 科学问题'), '/where does not dump the whole STATE')

  console.log('\n/inbox')
  const box = path.join(root, 'inbox')
  ok(existsSync(path.join(box, 'README.md')) && existsSync(path.join(box, '.gitignore')), 'inbox scaffolded by /resume')
  const emptyBox = await invoke('inbox')
  ok(emptyBox.text.includes('收件箱（空）'), 'empty inbox reports empty')
  writeFileSync(path.join(box, '20261019_综述.pdf'), 'x')
  writeFileSync(path.join(box, 'matrix.csv'), 'a,b\n1,2\n')
  const listed = await invoke('inbox')
  ok(listed.text.includes('2 个待处理'), 'inbox counts pending files')
  ok(listed.text.includes('papers/pdf/'), 'pdf is suggested to papers/')
  ok(listed.text.includes('data/'), 'csv is suggested to data/')
  ok(listed.text.includes('处理 inbox'), 'inbox prints a ready-to-send instruction')
  const wInbox = await invoke('where')
  ok(wInbox.text.includes('收件箱：**2 个待处理**'), '/where surfaces the pending inbox count')
  rmSync(path.join(box, '20261019_综述.pdf'))
  rmSync(path.join(box, 'matrix.csv'))
  const cleared = await invoke('inbox')
  ok(cleared.text.includes('收件箱（空）'), 'emptying the folder returns to empty')

  console.log('\ndelivery (output that does not depend on the command card)')
  const inboxReceipt = receiptPath(root, 'inbox')
  ok(existsSync(inboxReceipt), 'receipt file written under sci/out/')
  ok(readFileSync(inboxReceipt, 'utf8').includes('收件箱'), 'receipt file carries the report')
  ok(lastDelivery().mode === 'turn', 'result is delivered by opening one turn')
  ok(lastDelivery().text.startsWith(RECEIPT_PREFIX), 'delivered row is marked as a receipt')
  ok(lastDelivery().message.source.kind === 'user', 'receipt rides the only source kind the chat renders')
  ok(lastDelivery().text.includes('不要移动或修改任何文件'), 'receipt forbids the model from acting on it')
  const beforeOff = deliveryCount()
  writeConfig(root, { deliver: 'off' })
  await invoke('where')
  ok(deliveryCount() === beforeOff, 'deliver:off suppresses the conversation row')
  ok(readFileSync(receiptPath(root, 'where'), 'utf8').includes('最近动作'), 'deliver:off still writes the report')
  writeConfig(root, { deliver: 'pending' })
  await invoke('where')
  ok(lastDelivery().mode === 'pending', 'deliver:pending queues the receipt without a turn')
  writeConfig(root, { deliver: 'turn' })
  const bareResult = await commands.get('where').handler({
    commandId: 'c2',
    agent: { id: 'session-main' },
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal
  })
  ok(bareResult.kind === 'success', 'an agent without steer/inject still runs the command')
  const beforeOther = deliveryCount()
  const otherBox = await invoke('inbox', '', 'session-other')
  ok(otherBox.kind === 'error', 'a project without sci/ refuses /inbox')
  ok(deliveryCount() === beforeOther + 1, 'even a refusal is delivered to the human')
  ok(lastDelivery().text.includes('先运行'), 'the refusal explains how to opt in')

  console.log('\n/wrap')
  const w = await invoke('wrap', '证实了 A')
  ok(w.kind === 'success', '/wrap succeeds')
  const logFile = path.join(root, 'sci', 'log', `${date}.md`)
  ok(existsSync(logFile), 'log entry written')
  ok(readFileSync(logFile, 'utf8').includes('本轮结论：证实了 A'), 'wrap records the note')
  ok(readFileSync(path.join(root, 'sci', 'STATE.md'), 'utf8').includes('上次动作'), 'STATE 停在哪里 updated')
  ok(readdirSync(path.join(root, 'sci', 'state-history')).length === 1, 'previous STATE archived')

  console.log('\n/deadend')
  const de = await invoke('deadend', '试过 FIMO-only 弱监督，循环论证')
  ok(de.kind === 'success', '/deadend succeeds')
  ok(readFileSync(path.join(root, 'sci', 'dead-ends.md'), 'utf8').includes('循环论证'), 'dead-end row appended')

  console.log('\n/branch')
  const b1 = await invoke('branch', '验证顺式 vs 反式归因')
  ok(b1.kind === 'success', '/branch with direction succeeds')
  const branches = JSON.parse(readFileSync(path.join(root, 'sci', 'branches.json'), 'utf8'))
  ok(branches.nodes[0].direction === '验证顺式 vs 反式归因', 'branch direction stored')
  const b2 = await invoke('branch')
  ok(b2.text.includes('探索分支树') && b2.text.includes('当前'), 'branch tree renders current node')

  console.log('\nbranch detection from session header')
  emit('agent/created', { agent: { id: 'session-child' } })
  const nodes = JSON.parse(readFileSync(path.join(root, 'sci', 'branches.json'), 'utf8')).nodes
  const child = nodes.find((n) => n.id === 'session-child')
  ok(child && child.parent === 'session-main', 'fork recorded with parent')
  const dChild = await render('session-child')
  ok(dChild.includes('分支'), 'fork session gets a branch note in its digest')

  console.log('\nother project stays untouched')
  ok((await render('session-other')) === '', 'unrelated project injects nothing')
  ok(!existsSync(path.join(otherRoot, 'sci')), 'unrelated project gets no files')

  rmSync(root, { recursive: true, force: true })
  rmSync(otherRoot, { recursive: true, force: true })

  console.log(`\n${pass} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
