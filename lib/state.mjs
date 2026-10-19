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

/** Drop authoring comments and the leading H1 before injecting: every step pays for them. */
function forPrompt (text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#\s.*(\r?\n|$)/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The text injected as a runtime context on every step. */
export function stateDigest (root) {
  const text = readState(root)
  if (text === null) {
    return '【personal-science】这个目录已启用科研状态（存在 sci/），但 `sci/STATE.md` 缺失。先运行 `/resume` 重建。'
  }
  const body = forPrompt(text)
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

/** Body lines of the first `## <prefix>...` section, template placeholders dropped. */
export function sectionByPrefix (text, prefix) {
  const lines = String(text || '').split('\n')
  const start = lines.findIndex((l) => l.trim().startsWith(prefix))
  if (start === -1) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('<!--') || t.startsWith('-->')) continue
    if (/^（.*）$/.test(t)) continue // template placeholder in full-width parens
    if (/^[-*]?\s*\d*\.?$/.test(t)) continue // empty numbered slot
    if (/^[-*]\s*[:：]?\s*$/.test(t)) continue
    out.push(t.replace(/^[-*]\s*/, ''))
  }
  return out
}

/**
 * One-line status, used by `/where` and by `inject: brief`.
 * Deliberately terse: this text may ride on every model step.
 */
export function stateBrief (root, maxChars = 120) {
  const text = readState(root)
  if (!text) return ''
  const name = path.basename(root)
  const phase = (/^-\s*阶段[:：]\s*(.+)$/m.exec(text) || [])[1]
  const judge = sectionByPrefix(text, '## 当前判断')[0]
  const next = sectionByPrefix(text, '## 下一步')[0]
  const stop = sectionByPrefix(text, '## 停在哪里')[0]

  const parts = [`【${name}${phase ? `·${phase.replace(/（.*$/, '').trim()}` : ''}】`]
  if (judge) parts.push(`判断：${judge.length > 46 ? judge.slice(0, 45) + '…' : judge}`)
  if (next) parts.push(`下一步：${next.length > 34 ? next.slice(0, 33) + '…' : next}`)
  if (stop) parts.push(`停：${stop.length > 32 ? stop.slice(0, 31) + '…' : stop}`)
  const s = parts.join(' · ')
  return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s
}
