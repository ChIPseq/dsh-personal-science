// How a command's result reaches the human (and the model) without depending on
// the command card being readable.
//
// WHAT WE MEASURED
// ────────────────
// 1. A profile-registered command does execute: the Host appends
//    `command/run` + `command/done` (kind: success, full text) and the session
//    log/projection record it.
// 2. In the client the result shows up as one *collapsed* row — `> name · text…`
//    — where the whole report is squashed onto a single ellipsized line
//    (expandable on click). Before any turn follows, that row was reported as
//    simply absent; after a turn it is there. Either way it is unreadable at a
//    glance, which is what "什么都没有" and later "非常的奇怪" were about.
// 3. So the report cannot travel *only* as `result.text`.
//
// WHAT THIS MODULE DOES
// ─────────────────────
//   `sci/out/<command>.md` — the full report, always written first. Independent
//   of every UI question: greppable, git-able, survives restarts.
//
//   plus one conversation row, in one of two flavours:
//
//     pending (default) — spliced into the Agent inbox with a *non-user* source
//       kind. The client classifies that as hidden `context` chrome (see the
//       chat-visibility rule), so nothing fake appears in the transcript, while
//       the model still receives the receipt on its next step. Cost: zero.
//
//     turn — a user-role row, which the client *does* render as a bubble. It is
//       the only source kind that renders arbitrary text, so it is opt-in only:
//       it looks exactly like something the human typed (misleading), hence not
//       the default. Use it when the report must be visible immediately.
//
// The receipt is always prefixed 【personal-science · 回执】 so the skill can
// tell the model "this is plugin output, not the human speaking".

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { hasSci, resolveProjectRoot, sciDir } from './project.mjs'
import { readConfig } from './config.mjs'
import { clip, localStamp, writeText } from './fsutil.mjs'

/** Leading marker of every delivered receipt; the skill keys off this string. */
export const RECEIPT_PREFIX = '【personal-science · 回执】'

/** Source kind of the visible (user-role) flavour — the only one that renders. */
export const VISIBLE_SOURCE = 'user'

/** Source kind of the hidden flavour: model-visible, human-invisible chrome. */
export const HIDDEN_SOURCE = 'personal-science'

/** Longest report inlined into the receipt (the file keeps the rest). */
export const MAX_INLINE = 4000

const GUIDANCE_TURN = '（这是插件命令的只读回执，不是用户输入。请只做一句话确认；'
  + '不要重复罗列、不要移动或修改任何文件、不要调用工具。）'

const GUIDANCE_PENDING = '（这是插件命令的只读回执，不是用户输入，也还没被展示给用户。'
  + '仅作背景；用户问起时再复述，不要主动展开，不要移动或修改任何文件。）'

/** Absolute path of the delivered report for one command. */
export function receiptPath (root, name) {
  return path.join(sciDir(root), 'out', `${name}.md`)
}

/**
 * Compose the receipt text for one command result.
 * @param name - command name without the slash.
 * @param text - the handler's `result.text`.
 * @param file - absolute path the full report was written to (null when no sci/).
 * @param visible - whether this receipt is going to be shown as a user bubble.
 * @returns the receipt text, capped at {@link MAX_INLINE}.
 */
export function receiptText (name, text, file, visible = false) {
  const raw = String(text ?? '').trim()
  const body = clip(raw, MAX_INLINE)
  const more = raw.length > MAX_INLINE && file
    ? `\n\n（已截断，完整内容见 \`${file}\`）`
    : ''
  const guidance = visible ? GUIDANCE_TURN : GUIDANCE_PENDING
  return [RECEIPT_PREFIX + '/' + name, guidance, '', body + more].join('\n')
}

/**
 * Build the input message handed to the Agent inbox.
 * @param name - command name.
 * @param text - report text.
 * @param file - absolute report path (null when the project has no sci/).
 * @param visible - true for the user-role flavour, false for hidden chrome.
 * @returns a pending-input message in the Session's own shape.
 */
export function receiptMessage (name, text, file, visible = false) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: visible ? VISIBLE_SOURCE : HIDDEN_SOURCE },
    content: [{ type: 'text', text: receiptText(name, text, file, visible) }]
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

    // A project without sci/ has nowhere to put the report and no config to
    // read — but its *refusals* ("先运行 /resume") are what a human must see, so
    // they still ride the conversation with the visible flavour.
    let mode = 'turn'
    let file = null
    if (root && hasSci(root)) {
      file = receiptPath(root, name)
      writeText(file, `# /${name} · ${localStamp()}\n\n${text.trim()}\n`)
      out.file = file
      mode = readConfig(root).deliver
    }
    if (mode === 'off') {
      out.mode = 'file'
      return out
    }

    if (mode === 'turn' && typeof agent.steer === 'function') {
      agent.steer(receiptMessage(name, text, file, true))
      out.mode = 'file+turn'
      out.delivered = true
      return out
    }
    if (typeof agent.inject === 'function') {
      agent.inject(receiptMessage(name, text, file, mode === 'turn'))
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
