// dsh-personal-science — Host half.
//
// Design contract (v0):
//   * ZERO new agent tools. The model keeps using native read/write/edit/pwsh.
//   * The science state is injected as a runtime context on every step, so it
//     survives compaction, forks and cold starts without the agent asking.
//   * The ledger is written from the `tools/result` event, so provenance does
//     not depend on the model remembering to call an artifact tool.
//   * Everything is gated on the existence of `<cwd>/sci/`: projects that never
//     ran `/resume` see nothing and get nothing written into them.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasSci, resolveProjectRoot, sessionHeader } from './lib/project.mjs'
import { stateDigest } from './lib/state.mjs'
import { recordToolResult, todayCounter } from './lib/ledger.mjs'
import { readBranches, shortId, upsertNode } from './lib/branches.mjs'
import { registerCommands } from './lib/commands.mjs'

export const name = 'personal-science'

// Hard requirements only; every other service is looked up lazily so a partial
// composition (CLI without a web server, etc.) still loads the plugin.
export const inject = ['systemPrompt', 'commands']

const here = path.dirname(fileURLToPath(import.meta.url))

/** Minimal YAML frontmatter reader for SKILL.md (no dependency). */
function parseSkill (raw) {
  const text = String(raw || '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
    if (mm) meta[mm[1]] = mm[2].replace(/^['"]|['"]$/g, '')
  }
  return { meta, body: text.slice(m[0].length).trim() }
}

/** Branch note appended to the digest when this session is a fork. */
function branchLine (sessions, agent, root) {
  const header = sessionHeader(sessions, agent)
  if (!header || !header.parentSession) return ''
  const node = readBranches(root).nodes.find((n) => n.id === agent.id)
  const direction = (node && node.direction) || '未记录（用 /branch <一句话> 补）'
  return `【分支】本会话是 ${shortId(header.parentSession)} 的分支，方向：${direction}`
}

/** Ledger one-liner for the digest (in-memory counters: no disk read per step). */
function ledgerLine (root) {
  const c = todayCounter(root)
  if (!c.n) return ''
  const tail = c.fail ? `，最近失败：${c.lastFail.slice(0, 90)}` : ''
  return `【今日】${c.n} 次工具调用 / ${c.fail} 次失败${tail}`
}

export function apply (ctx) {
  const sessions = ctx.get('sessions')
  const skills = ctx.get('skills')

  // ── 1. Runtime-context injection (the core mechanism) ─────────────────────
  // `assembleContextFor(agent)` passes the live Agent both as `agent` and as
  // `scope`, so a single global registration serves every agent.
  try {
    ctx.systemPrompt.context({
      name: 'personal-science-state',
      order: 55,
      text: (assembly) => {
        try {
          const agent = assembly && assembly.agent
          if (!agent) return ''
          const root = resolveProjectRoot(sessions, agent)
          if (!hasSci(root)) return ''

          const parts = [stateDigest(root)]
          const ledger = ledgerLine(root)
          if (ledger) parts.push(ledger)
          const branch = branchLine(sessions, agent, root)
          if (branch) parts.push(branch)
          return parts.join('\n\n')
        } catch {
          return ''
        }
      }
    })
  } catch (err) {
    ctx.logger?.warn?.(`[personal-science] context registration failed: ${err && err.message}`)
  }

  // ── 2. Human commands ─────────────────────────────────────────────────────
  try {
    registerCommands(ctx, { sessions })
  } catch (err) {
    ctx.logger?.warn?.(`[personal-science] commands failed to register: ${err && err.message}`)
  }

  // ── 3. Append-only ledger from the tool pipeline ──────────────────────────
  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec && exec.agent
      if (!agent) return
      const root = resolveProjectRoot(sessions, agent)
      if (!hasSci(root)) return
      recordToolResult(root, exec, result)
    } catch {
      /* the ledger must never break a tool call */
    }
  })

  // ── 4. Branch bookkeeping from the session header ─────────────────────────
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      const root = resolveProjectRoot(sessions, agent)
      if (!hasSci(root)) return
      const header = sessionHeader(sessions, agent)
      if (!header) return
      if (header.origin === 'subagent') return
      upsertNode(root, {
        id: agent.id,
        parent: header.parentSession || null,
        at: header.createdAt || Date.now()
      })
    } catch {
      /* bookkeeping only */
    }
  })

  // ── 5. The skill (conventions the model reads on demand) ──────────────────
  try {
    const raw = readFileSync(path.join(here, 'skills', 'personal-science', 'SKILL.md'), 'utf8')
    const { meta, body } = parseSkill(raw)
    if (skills && typeof skills.register === 'function' && body) {
      skills.register({
        name: meta.name || 'personal-science',
        description: meta.description || '科研项目的工作记忆与结构约定',
        whenToUse: meta.whenToUse,
        content: body,
        source: 'bundled'
      })
    }
  } catch {
    /* skill is optional: the plugin still works without it */
  }
}

export default { name, inject, apply }
