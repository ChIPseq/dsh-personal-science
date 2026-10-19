// Append-only tool ledger: written from the `tools/result` event, never from
// the model. This is the "auditable history" that does not depend on the agent
// remembering to call an artifact tool.

import path from 'node:path'
import { sciDir } from './project.mjs'
import { appendText, clip, ensureDir, localDate, tryRead } from './fsutil.mjs'

const counters = new Map() // `${root}|${date}` -> { n, fail, lastFail }

/** A short, human-recognisable signature for one tool call. */
export function signatureOf (name, args) {
  let s = ''
  if (args && typeof args === 'object') {
    if (typeof args.command === 'string') s = args.command
    else if (typeof args.file_path === 'string') s = args.file_path
    else if (typeof args.path === 'string') s = args.path
    else if (Array.isArray(args.queries)) s = args.queries.join(' | ')
    else if (typeof args.query === 'string') s = args.query
    else if (typeof args.prompt === 'string') s = args.prompt
    else if (typeof args.description === 'string') s = args.description
    else {
      try {
        s = JSON.stringify(args)
      } catch {
        s = ''
      }
    }
  }
  return clip(String(s).replace(/\s+/g, ' ').trim(), 140)
}

export function recordToolResult (root, exec, result) {
  const date = localDate()
  const dir = path.join(sciDir(root), 'ledger')
  ensureDir(dir)

  const ok = !(result && result.isError)
  const entry = {
    t: new Date().toISOString(),
    tool: String((exec && exec.name) || '?'),
    sig: signatureOf(exec && exec.name, exec && exec.arguments),
    ok
  }
  if (!ok) {
    const e = result && result.error
    const reason = (e && (e.message || e.code)) || 'error'
    entry.err = clip(reason, 120)
  }

  const key = `${root}|${date}`
  const c = counters.get(key) || { n: 0, fail: 0, lastFail: '' }
  c.n += 1
  if (!ok) {
    c.fail += 1
    c.lastFail = `${entry.tool}: ${entry.sig}${entry.err ? ` (${entry.err})` : ''}`
  }
  counters.set(key, c)

  appendText(path.join(dir, `${date}.jsonl`), JSON.stringify(entry) + '\n')
}

export function todayCounter (root) {
  const key = `${root}|${localDate()}`
  return { ...(counters.get(key) || { n: 0, fail: 0, lastFail: '' }) }
}

/** Read a whole day's ledger file and reduce it. */
export function summarizeDay (root, date = localDate()) {
  const text = tryRead(path.join(sciDir(root), 'ledger', `${date}.jsonl`))
  if (!text) return null

  let n = 0
  let fail = 0
  let first = null
  let last = null
  let lastFail = ''
  const tools = {}

  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    n += 1
    tools[e.tool] = (tools[e.tool] || 0) + 1
    if (e.ok === false) {
      fail += 1
      lastFail = `${e.tool}: ${e.sig}${e.err ? ` (${e.err})` : ''}`
    }
    if (!first) first = e.t
    last = e.t
  }
  return { n, fail, tools, first, last, lastFail }
}

export function topTools (tools, k = 4) {
  return Object.entries(tools || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([name, count]) => `${name} ×${count}`)
    .join(' / ')
}

export function hhmm (iso) {
  if (!iso) return '--:--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
