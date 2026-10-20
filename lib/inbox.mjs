// The drop box: a single, predictable place where the human puts material they
// want the agent to read (a report someone sent them, a PDF, a data table).
//
// Contract:
//   * location is `<root>/<cfg.inbox>` (default `inbox/`), stable across sessions;
//   * nothing is processed automatically — the human must ask;
//   * after processing the folder must be EMPTY again (only README/.gitignore).

import path from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { readConfig } from './config.mjs'

const HOUSEKEEPING = new Set(['README.md', '.gitignore'])

export function inboxRel (root) {
  const cfg = readConfig(root)
  const rel = typeof cfg.inbox === 'string' ? cfg.inbox.trim() : ''
  return rel || 'inbox'
}

export function inboxDir (root) {
  return path.join(root, inboxRel(root))
}

/**
 * Best-guess destination from name/extension alone. This is a *hint* printed to
 * the human and the model, never an automatic move: classification needs the
 * file's content.
 */
export function suggestTarget (name, isDirectory = false) {
  const lower = String(name).toLowerCase()
  const ext = path.extname(lower)

  if (isDirectory) return 'data/ 或 Experiment/<日期>_<主题>/（先看内容再定）'
  if (['.pdf', '.bib', '.ris', '.nbib', '.enw'].includes(ext)) return 'papers/pdf/ + 在 papers/papers.csv 追加一行'
  if (['.csv', '.tsv', '.xlsx', '.xls', '.json', '.jsonl', '.parquet', '.h5', '.hdf5', '.gz'].includes(ext)) return 'data/'
  if (['.py', '.sh', '.r', '.rmd', '.pbs', '.slurm', '.ipynb'].includes(ext)) return 'Experiment/<日期>_<主题>/scripts/'
  if (['.md', '.docx', '.doc', '.txt', '.tex', '.rtf'].includes(ext)) {
    if (/调研|报告|方案|综述|笔记|思路|review|report|plan|note/.test(lower)) return 'Plan_Summary/<日期>_<主题>.md'
    return 'Plan_Summary/ 或 reference/（看是报告还是资料）'
  }
  if (['.png', '.jpg', '.jpeg', '.svg', '.tif', '.tiff', '.gif'].includes(ext)) return 'figures/'
  return '拿不准：先读内容再定；确实无法归类就留在 inbox 并说明'
}

export function listInbox (root) {
  const dir = inboxDir(root)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { dir, exists: false, items: [] }
  }

  const items = []
  for (const entry of entries) {
    if (HOUSEKEEPING.has(entry.name) || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    items.push({
      name: entry.name,
      path: full,
      isDirectory: entry.isDirectory(),
      size: entry.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
      target: suggestTarget(entry.name, entry.isDirectory())
    })
  }
  items.sort((a, b) => b.mtime - a.mtime)
  return { dir, exists: true, items }
}

export function pendingCount (root) {
  return listInbox(root).items.length
}
