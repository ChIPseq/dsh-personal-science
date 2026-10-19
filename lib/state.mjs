// `sci/STATE.md` reading, digest rendering, and section upserting.

import path from 'node:path'
import { sciDir } from './project.mjs'
import { mtimeOf, tryRead, writeText } from './fsutil.mjs'

// The digest is re-rendered for EVERY model step, so it is bounded hard.
const MAX_DIGEST_CHARS = 2000

const cache = new Map() // root -> { mtime, text }

export function statePath (root) {
  return path.join(sciDir(root), 'STATE.md')
}

export function readState (root) {
  const p = statePath(root)
  const m = mtimeOf(p)
  if (!m) return null
  const hit = cache.get(root)
  if (hit && hit.mtime === m) return hit.text
  const text = tryRead(p) ?? ''
  cache.set(root, { mtime: m, text })
  return text
}

/** The text injected as a runtime context on every step. */
export function stateDigest (root) {
  const text = readState(root)
  if (text === null) {
    return '【personal-science】这个目录已启用科研状态（存在 sci/），但 `sci/STATE.md` 缺失。先运行 `/resume` 重建。'
  }
  const body = text.trim()
  if (!body) {
    return '【personal-science】`sci/STATE.md` 是空的。先写清：当前判断 / 科学问题 / 下一步（<= 45 行）。'
  }
  const clipped = body.length > MAX_DIGEST_CHARS
    ? `${body.slice(0, MAX_DIGEST_CHARS)}\n…（STATE.md 超长已截断：压到 45 行以内，细节移入 sci/log/）`
    : body
  return `【研究状态 · personal-science】\n${clipped}`
}

/**
 * Replace (or append) a `## <title>` section body, leaving every other line
 * untouched. Used by /wrap to keep `## 停在哪里` mechanically accurate.
 */
export function upsertSection (root, title, body) {
  const text = readState(root) ?? ''
  const lines = text.split('\n')
  const head = `## ${title}`
  const start = lines.findIndex((l) => l.trim() === head)
  const block = [head, ...body.split('\n').filter((l) => l.trim() !== ''), '']
  if (start === -1) {
    const next = [...lines.filter((l, i) => !(i === lines.length - 1 && l === '')), '', ...block]
    writeText(statePath(root), next.join('\n') + '\n')
    return
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break }
  }
  const next = [...lines.slice(0, start), ...block, ...lines.slice(end)]
  writeText(statePath(root), next.join('\n').replace(/\n{3,}/g, '\n\n') + '\n')
}

/** Archive the current STATE.md before an agent rewrites it wholesale. */
export function archiveState (root, stamp) {
  const text = readState(root)
  if (!text) return null
  const dir = path.join(sciDir(root), 'state-history')
  const file = path.join(dir, `${stamp}.md`)
  writeText(file, text)
  return file
}
