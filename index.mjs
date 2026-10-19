// dsh-personal-science — Host half.
//
// Design contract (v0.2, after first dogfood feedback):
//   * ZERO new agent tools. The model keeps using native read/write/edit/pwsh.
//   * The research state is NOT injected by default (`inject: "off"`). The
//     everyday need is "where is the task, which files changed, which paths
//     matter" — that is `/where`, a cheap on-demand command, not a per-step
//     prompt tax. `inject: brief|full` is opt-in per project via `sci/config.json`
//     (toggle with `/inject`), no restart required.
//   * The ledger is written from the `tools/result` event, so provenance does
//     not depend on the model remembering to call an artifact tool.
//   * Everything is gated on the existence of `<cwd>/sci/`.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasSci, resolveProjectRoot, sessionHeader } from './lib/project.mjs'
import { readConfig } from './lib/config.mjs'
import { stateDigest, stateBrief } from './lib/state.mjs'
import { recordToolResult, todayCounter } from './lib/ledger.mjs'
import { readBranches, shortId, upsertNode } from './lib/branches.mjs'
import { registerCommands } from './lib/commands.mjs'

export const name = 'personal-science'

// Hard requirements only; every other service is looked up lazily. Note that
// the prompt hook is an *event* (`system-prompt/assemble`), not the
// `systemPrompt` service — see the comment at the injection site.
export const inject = ['commands']

const here = path.dirname(fileURLToPath(import.meta.url))

// How many assemblies into a session still get the full digest (in `full` mode).
const seen = new Map() // sessionId -> assemblies

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

function branchNote (sessions, agent, root) {
  const header = sessionHeader(sessions, agent)
  if (!header || !header.parentSession) return ''
  const node = readBranches(root).nodes.find((n) => n.id === agent.id)
  const direction = (node && node.direction) || '未记录（/branch <一句话>）'
  return `【分支】父 ${shortId(header.parentSession)}，方向：${direction}`
}

function ledgerLine (root) {
  const c = todayCounter(root)
  if (!c.n) return ''
  const tail = c.fail ? `，最近失败：${c.lastFail.slice(0, 80)}` : ''
  return `【今日】${c.n} 次工具调用 / ${c.fail} 次失败${tail}`
}

export function apply (ctx) {
  const sessions = ctx.get('sessions')
  const skills = ctx.get('skills')

  // Self-report surface for `/where`: tells us exactly why a render was empty.
  const diag = { calls: 0, at: 0, mode: 'off', agent: false, root: null, sci: false, len: 0, error: null }

  // ── 1. Runtime-context injection (opt-in) ────────────────────────────────
  //
  // WHY NOT `systemPrompt.context()`: that API writes through
  // `layers.effect(this.ctx, ...)`, i.e. into the scope layer owned by the
  // SystemPrompt *service instance the caller is bound to*. The web-app bundle
  // overrides the `system-prompt` row, so a bundle plugin can end up holding a
  // different instance than the one the agent loop assembles from: registration
  // succeeds, the callback is never invoked (measured: 0 renders). The
  // `system-prompt/assemble` waterfall is an event on ctx, so every assembly
  // reaches us regardless of which instance or layer runs it.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    let base
    try {
      base = await next()
    } catch (err) {
      diag.error = String((err && err.message) || err)
      throw err
    }

    diag.calls += 1
    diag.at = Date.now()
    try {
      const agent = (context && (context.agent || context.scope)) || null
      diag.agent = Boolean(agent && agent.id)
      if (!diag.agent) {
        diag.len = 0
        return base
      }
      const root = resolveProjectRoot(sessions, agent)
      diag.root = root
      diag.sci = hasSci(root)
      if (!diag.sci) {
        diag.len = 0
        return base
      }

      const cfg = readConfig(root)
      diag.mode = cfg.inject
      if (cfg.inject === 'off') {
        diag.len = 0
        return base
      }

      const n = (seen.get(agent.id) || 0) + 1
      seen.set(agent.id, n)

      let out
      if (cfg.inject === 'full' && n <= (cfg.fullSteps || 2)) {
        const parts = [stateDigest(root)]
        const l = ledgerLine(root)
        if (l) parts.push(l)
        const b = branchNote(sessions, agent, root)
        if (b) parts.push(b)
        out = parts.join('\n\n')
      } else {
        const parts = [stateBrief(root, cfg.briefChars || 120)]
        const l = ledgerLine(root)
        if (l) parts.push(l)
        const b = branchNote(sessions, agent, root)
        out = parts.filter(Boolean).join('\n')
      }
      diag.len = out.length
      if (!out) return base
      return { ...base, contexts: [...(base.contexts || []), { name: 'personal-science-state', text: out }] }
    } catch (err) {
      diag.error = String((err && err.message) || err)
      diag.len = 0
      return base
    }
  })

  // ── 2. Human commands ────────────────────────────────────────────────────
  try {
    registerCommands(ctx, { sessions, diag })
  } catch (err) {
    ctx.logger?.warn?.(`[personal-science] commands failed to register: ${(err && err.message) || err}`)
  }

  // ── 3. Append-only ledger from the tool pipeline ─────────────────────────
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

  // ── 4. Branch bookkeeping from the session header ────────────────────────
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      const root = resolveProjectRoot(sessions, agent)
      if (!hasSci(root)) return
      const header = sessionHeader(sessions, agent)
      if (!header || header.origin === 'subagent') return
      upsertNode(root, {
        id: agent.id,
        parent: header.parentSession || null,
        at: header.createdAt || Date.now()
      })
    } catch {
      /* bookkeeping only */
    }
  })

  // ── 5. The skill ─────────────────────────────────────────────────────────
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
    /* skill is optional */
  }
}

export default { name, inject, apply }
