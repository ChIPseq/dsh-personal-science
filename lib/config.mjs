// Project-level plugin config: `sci/config.json`, read on demand (mtime cache),
// so toggling behaviour never needs a host restart.
//
//   { "inject": "off" | "brief" | "full", "briefChars": 120, "fullSteps": 2 }

import path from 'node:path'
import { sciDir } from './project.mjs'
import { mtimeOf, tryRead, writeText } from './fsutil.mjs'

export const DEFAULTS = { inject: 'off', briefChars: 120, fullSteps: 2 }

const cache = new Map() // root -> { mtime, config }

export function readConfig (root) {
  const p = path.join(sciDir(root), 'config.json')
  const m = mtimeOf(p)
  if (!m) return { ...DEFAULTS }
  const hit = cache.get(root)
  if (hit && hit.mtime === m) return hit.config
  let config = { ...DEFAULTS }
  const text = tryRead(p)
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') config = { ...DEFAULTS, ...parsed }
    } catch {
      /* keep defaults */
    }
  }
  if (!['off', 'brief', 'full'].includes(config.inject)) config.inject = DEFAULTS.inject
  cache.set(root, { mtime: m, config })
  return config
}

export function writeConfig (root, patch) {
  const current = readConfig(root)
  const next = { ...current, ...patch }
  writeText(path.join(sciDir(root), 'config.json'), JSON.stringify(next, null, 2) + '\n')
  cache.delete(root)
  return next
}
