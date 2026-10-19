// Cheap project scanning for /where: recent files and job-looking commands.
//
// Everything here is bounded: /where must stay a sub-second command on a
// workspace with hundreds of thousands of files.

import path from 'node:path'
import { readdirSync, statSync } from 'node:fs'

// `_scratch` is intentionally NOT skipped: agents dump their freshest outputs
// there, and "where did it go" is exactly what /where must answer.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'sci', '_refs', '.dsh', 'dist', 'build', '__pycache__'])
const BUDGET = 6000

/** Newest files under `root`, bounded by a directory-entry budget. */
export function recentFiles (root, k = 8) {
  const found = []
  let budget = BUDGET
  const stack = [{ dir: root, depth: 0 }]

  while (stack.length && budget > 0) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (budget-- <= 0) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        if (depth < 4) stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      try {
        const st = statSync(full)
        found.push({ path: full, rel: path.relative(root, full), mtime: st.mtimeMs, size: st.size })
      } catch {
        /* ignore */
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, k)
}

const JOB_RE = /\b(qsub|sbatch|bsub|salloc|srun|nohup|apptainer|singularity|docker run)\b/i

/** Commands in today's ledger that look like job submissions. */
export function jobCommands (entries, k = 5) {
  return entries
    .filter((e) => JOB_RE.test(e.sig || ''))
    .slice(-k)
    .reverse()
}

export function humanSize (bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}
