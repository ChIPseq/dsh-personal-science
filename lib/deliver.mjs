// Deliver a command's result into the conversation — without the command card.
//
// WHY THIS EXISTS (measured, not guessed)
// ───────────────────────────────────────
// On the DSH desktop build we run on, a profile-registered command *executes*:
// the Host appends `command/run` + `command/done` (kind: success, full text) and
// the projection cache advances. The client, however, never materializes the
// command card: `/resume` created `sci/`, `/inbox` listed 7 files, and the
// human saw an empty transcript for both — even after a page reload. That
// turned `/inbox`, `/where` and `/resume` into "nothing happened".
//
// So the result can no longer travel *only* as `result.text`. Two durable
// channels replace it:
//
//   1. `sci/out/<command>.md` — the full report on disk, always written first,
//      so nothing depends on any UI at all (git-able, greppable, survives).
//   2. a visible conversation row — handed to the Agent's own input inbox
//      (`agent.steer`, or `agent.inject` for the cheaper no-turn mode).
//
// `source.kind: "user"` is deliberate and is the only kind that renders:
// the Chat target classifies every other source kind as hidden `context`
// chrome (see the client's chat-visibility rule — context rows are visible only
// when they carry tool additions/removals). The row is prefixed 【…回执】 so the
// human and the model can both tell it apart from something they typed.

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { hasSci, resolveProjectRoot, sciDir } from './project.mjs'
import { readConfig } from './config.mjs'
import { clip, localStamp, writeText } from './fsutil.mjs'

/** Leading marker of every delivered row; the skill keys off this string. */
export const RECEIPT_PREFIX = '【personal-science · 回执】'

/** Longest report inlined into the conversation row (the file keeps the rest). */
export const MAX_INLINE = 4000

const GUIDANCE = '（这是插件命令的只读回执，不是用户输入。请只做一句话确认；'
  + '不要重复罗列、不要移动或修改任何文件、不要调用工具。）'

/** Absolute path of the delivered report for one command. */
export function receiptPath (root, name) {
  return path.join(sciDir(root), 'out', `${name}.md`)
}

/**
 * Compose the visible receipt text for one command result.
 * @param name - command name without the slash.
 * @param text - the handler's `result.text`.
 * @param file - absolute path the full report was written to.
 * @returns the row text, capped at {@link MAX_INLINE}.
 */
export function receiptText (name, text, file) {
  const body = clip(String(text ?? '').trim(), MAX_INLINE)
  const more = String(text ?? '').trim().length > MAX_INLINE
    ? `\n\n（已截断，完整内容见 \`${file}\`）`
    : ''
  return [RECEIPT_PREFIX + '/' + name, GUIDANCE, '', body + more].join('\n')
}

/**
 * Build the input message handed to the Agent inbox.
 * @param name - command name.
 * @param text - report text.
 * @param file - absolute report path.
 * @returns a pending-input message in the Session's own shape.
 */
export function receiptMessage (name, text, file) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: receiptText(name, text, file) }]
  }
}

/**
 * Write the report and hand it to the conversation exactly once.
 *
 * Never throws: delivery is a side channel, and a broken conversation must not
 * turn a successful command into a failure.
 *
 * @param sessions - the `sessions` service used to resolve the project root.
 * @param invocation - the command invocation (`agent` is what we need).
 * @param name - command name without the slash.
 * @param result - the handler's `CommandResult`.
 * @returns how the result was delivered: `file+turn`, `file+pending`, `file`.
 */
export function deliverResult (sessions, invocation, name, result) {
  const out = { mode: 'none', file: null, delivered: false }
  try {
    const text = result && typeof result.text === 'string' ? result.text : ''
    if (!text.trim()) return out
    const agent = invocation && invocation.agent
    const root = resolveProjectRoot(sessions, agent)
    if (!root || !hasSci(root)) return out

    const file = receiptPath(root, name)
    writeText(file, `# /${name} · ${localStamp()}\n\n${text.trim()}\n`)
    out.file = file

    const cfg = readConfig(root)
    const mode = cfg.deliver === 'off' ? 'off' : cfg.deliver
    if (mode === 'off') {
      out.mode = 'file'
      return out
    }

    const message = receiptMessage(name, text, file)
    if (mode === 'turn' && typeof agent.steer === 'function') {
      agent.steer(message)
      out.mode = 'file+turn'
      out.delivered = true
      return out
    }
    if (typeof agent.inject === 'function') {
      agent.inject(message)
      out.mode = 'file+pending'
      out.delivered = true
      return out
    }
    out.mode = 'file'
    return out
  } catch {
    return out
  }
}
