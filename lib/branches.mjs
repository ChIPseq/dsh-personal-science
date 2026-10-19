// Branch bookkeeping.
//
// DSH already supports forking a conversation; the session header records
// `parentSession` + `isSeeded`, so the exploration tree is reconstructible
// without asking the model anything. What was missing is the *semantics* of a
// branch: which direction it was opened to test.

import path from 'node:path'
import { sciDir } from './project.mjs'
import { mtimeOf, tryRead, writeText, ensureDir } from './fsutil.mjs'

export function branchesPath (root) {
  return path.join(sciDir(root), 'branches.json')
}

// The digest asks for branches on every model step, so keep an mtime cache.
const cache = new Map() // root -> { mtime, db }

export function readBranches (root) {
  const p = branchesPath(root)
  const m = mtimeOf(p)
  if (!m) {
    cache.delete(root)
    return { nodes: [] }
  }
  const hit = cache.get(root)
  if (hit && hit.mtime === m) return hit.db
  let db = { nodes: [] }
  const text = tryRead(p)
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && Array.isArray(parsed.nodes)) db = parsed
    } catch {
      /* keep the empty db */
    }
  }
  cache.set(root, { mtime: m, db })
  return db
}

export function upsertNode (root, node) {
  ensureDir(sciDir(root))
  const db = readBranches(root)
  const i = db.nodes.findIndex((n) => n.id === node.id)
  if (i >= 0) db.nodes[i] = { ...db.nodes[i], ...node }
  else db.nodes.push(node)
  writeText(branchesPath(root), JSON.stringify(db, null, 2) + '\n')
  cache.delete(root)
  return db
}

export function shortId (id) {
  return String(id || '').replace(/^session-/, '').slice(0, 8)
}

/** Depth-first render of the fork tree, newest-last. */
export function renderTree (db, currentId) {
  const nodes = (db && db.nodes) || []
  if (!nodes.length) return '（还没有记录任何分支）'

  const byParent = new Map()
  const ids = new Set(nodes.map((n) => n.id))
  for (const n of nodes) {
    const key = n.parent || ''
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(n)
  }
  // roots: no parent, or parent outside this project's registry
  const roots = nodes.filter((n) => !n.parent || !ids.has(n.parent))
  const out = []
  const walk = (node, depth) => {
    const mark = node.id === currentId ? ' ←当前' : ''
    const dir = node.direction ? `：${node.direction}` : '：（未记录方向，用 /branch <一句话> 补）'
    out.push(`${'  '.repeat(depth)}- ${shortId(node.id)}${node.parent ? ` ← ${shortId(node.parent)}` : ' (主干)'}${dir}${mark}`)
    for (const child of byParent.get(node.id) || []) walk(child, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return out.join('\n')
}
