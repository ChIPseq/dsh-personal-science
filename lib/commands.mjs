// Human commands: /where, /resume, /wrap, /deadend, /branch, /inject.
//
// These are the only *explicit* surface of the plugin. Everything else is
// passive (ledger + branch listeners), because the point of the design is that
// the agent does not have to remember to call anything — and that the human
// pays no per-step prompt tax just to know where the work stands.

import path from 'node:path'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { ensureScaffold, hasSci, resolveProjectRoot, sciDir, sessionHeader } from './project.mjs'
import { archiveState, readState, upsertSection } from './state.mjs'
import { hhmm, readDayEntries, summarizeDay, todayCounter, topTools } from './ledger.mjs'
import { readBranches, renderTree, shortId, upsertNode } from './branches.mjs'
import { readConfig, writeConfig } from './config.mjs'
import { humanSize, jobCommands, recentFiles } from './scan.mjs'
import { appendText, clip, localDate, localStamp, localTime } from './fsutil.mjs'

const SKIP = new Set(['sci', 'node_modules', '.git', '_scratch', '_refs', '_analysis'])

function recentEntries (root, k = 8) {
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    if (e.name.startsWith('.')) continue
    try {
      const st = statSync(path.join(root, e.name))
      rows.push({ name: e.name, dir: e.isDirectory(), mtime: st.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime).slice(0, k)
}

function fail (text) {
  return { kind: 'error', text }
}

export function registerCommands (ctx, deps) {
  const sessions = deps.sessions
  const diag = deps.diag || null

  const rootOf = (agent) => resolveProjectRoot(sessions, agent)

  // One colliding command name must not take the other three down.
  const safe = (definition) => {
    try {
      ctx.commands.register(definition)
    } catch (err) {
      ctx.logger?.warn?.(`[personal-science] command "${definition.name}" not registered: ${err && err.message}`)
    }
  }

  // ── /resume ───────────────────────────────────────────────────────────────
  safe({
    name: 'resume',
    description: '重建并显示科研状态（sci/STATE.md + 今日台账 + 分支），首次使用会初始化 sci/ 目录',
    input: { hint: '无需参数' },
    handler: ({ agent }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      const fresh = !hasSci(root)
      ensureScaffold(root)

      const header = sessionHeader(sessions, agent)
      const node = readBranches(root).nodes.find((n) => n.id === agent.id) || {}
      const branchNote = header && header.parentSession
        ? `当前是分支会话：父 ${shortId(header.parentSession)}。分支方向：${node.direction || '未记录 → /branch <一句话>'}`
        : '主干会话（非分支）'

      const counter = todayCounter(root)
      const day = localDate()
      const state = readState(root) || ''
      const lines = []

      lines.push(fresh ? '## 已初始化 sci/（首次）' : '## 研究状态')
      lines.push('')
      lines.push(state.trim() || '（STATE.md 为空）')
      lines.push('')
      lines.push('## 今日台账')
      lines.push(counter.n === 0
        ? `- ${day}：还没有记录到工具调用`
        : `- ${day}：${counter.n} 次工具调用 / ${counter.fail} 次失败${counter.lastFail ? `；最近失败：${clip(counter.lastFail, 120)}` : ''}`)
      lines.push(`- 分支：${branchNote}`)
      lines.push('')
      lines.push('## 项目近况（按 mtime 自动采集）')
      const recent = recentEntries(root)
      if (recent.length) {
        for (const r of recent) lines.push(`- ${r.dir ? '📁' : '📄'} ${r.name}（${hhmm(new Date(r.mtime).toISOString())}）`)
      } else {
        lines.push('- （空目录）')
      }
      lines.push('')
      lines.push(`sci/ 位于 \`${sciDir(root)}\`。这份状态会在**每一步**自动注入，不需要你手工粘贴背景。`)
      if (fresh) {
        lines.push('')
        lines.push('**下一步**：把 `sci/STATE.md` 的「当前判断 / 科学问题 / 下一步」三节填实（各 1-3 行即可），再用 `/wrap` 在会话结尾记账。')
      }

      return { kind: 'success', text: lines.join('\n') }
    }
  })

  // ── /wrap ─────────────────────────────────────────────────────────────────
  safe({
    name: 'wrap',
    description: '收尾记账：把今日台账折叠进 sci/log/，并机械更新 STATE.md 的「停在哪里」',
    input: { hint: '可选：一句话说明本轮结论' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const date = localDate()
      const sum = summarizeDay(root, date)
      const note = String(rawInput || '').trim()
      const logFile = path.join(sciDir(root), 'log', `${date}.md`)
      const lines = []

      lines.push(`## ${localTime()} · 收尾`)
      lines.push('')
      if (!sum || sum.n === 0) {
        lines.push('- 今天没有记录到工具调用。')
      } else {
        lines.push(`- 工具调用 ${sum.n} 次，失败 ${sum.fail} 次（${hhmm(sum.first)} → ${hhmm(sum.last)}）`)
        lines.push(`- 主要动作：${topTools(sum.tools)}`)
        if (sum.lastFail) lines.push(`- 最近失败：${clip(sum.lastFail, 160)}`)
      }
      if (note) lines.push(`- 本轮结论：${note}`)
      else lines.push('- 待补：① 证实了什么 ② 否证了什么 ③ 下一步')
      lines.push('')
      appendText(logFile, lines.join('\n') + '\n')

      const stop = []
      stop.push(sum && sum.n
        ? `- 上次动作：${hhmm(sum.last)} 收尾（${topTools(sum.tools, 2)}）`
        : '- 上次动作：无工具记录')
      stop.push('- 待跑作业：（如无请写"无"）')
      stop.push('- 未回读：（列出还没读回的结果文件）')
      upsertSection(root, '停在哪里', stop.join('\n'))

      const archived = archiveState(root, `${date}_${localTime().replace(':', '')}`)

      const out = ['已记账。']
      if (sum && sum.n) out.push(`- ${date}：${sum.n} 次调用 / ${sum.fail} 失败 → \`sci/log/${date}.md\``)
      else out.push(`- ${date}：无工具记录 → 已写占位条目`)
      out.push(`- STATE.md 的「停在哪里」已机械更新${archived ? '，旧版本已归档到 sci/state-history/' : ''}`)
      if (!note) {
        out.push('')
        out.push('**还差 3 行**（模型或你自己补）：')
        out.push('1. 本轮证实了什么（含证据文件路径）')
        out.push('2. 本轮否证了什么（→ 建议同时 `/deadend`）')
        out.push('3. 下一步的具体动作')
      }
      return { kind: 'success', text: out.join('\n') }
    }
  })

  // ── /deadend ──────────────────────────────────────────────────────────────
  safe({
    name: 'deadend',
    description: '记录一条"试过但不行"的路线（append-only，防止未来会话重蹈覆辙）',
    input: { hint: '试过什么 / 为什么不行' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const text = String(rawInput || '').trim()
      if (!text) return fail('用法：`/deadend 试过 X，因为 Y 不行（证据：路径/Z）`')

      const file = path.join(sciDir(root), 'dead-ends.md')
      if (!existsSync(file)) ensureScaffold(root)
      appendText(file, `| ${localDate()} | ${text} |  |  |\n`)
      return {
        kind: 'success',
        text: `已写入 \`sci/dead-ends.md\`：\n- ${localDate()}：${clip(text, 140)}`
      }
    }
  })

  // ── /branch ───────────────────────────────────────────────────────────────
  safe({
    name: 'branch',
    description: '查看探索分支树；带参数则记录当前分支要验证的方向',
    input: { hint: '可选：这个分支要验证什么' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const text = String(rawInput || '').trim()
      const header = sessionHeader(sessions, agent)

      if (text) {
        upsertNode(root, {
          id: agent.id,
          parent: (header && header.parentSession) || null,
          at: (header && header.createdAt) || Date.now(),
          direction: text,
          directedAt: localStamp()
        })
        return {
          kind: 'success',
          text: `已记录分支方向：${text}\n- 会话 ${shortId(agent.id)}${header && header.parentSession ? `（父 ${shortId(header.parentSession)}）` : ''}`
        }
      }

      if (!readBranches(root).nodes.some((n) => n.id === agent.id)) {
        upsertNode(root, {
          id: agent.id,
          parent: (header && header.parentSession) || null,
          at: (header && header.createdAt) || Date.now()
        })
      }
      const db = readBranches(root)
      return {
        kind: 'success',
        text: ['## 探索分支树', '', renderTree(db, agent.id), '', '用 `/branch <一句话>` 补记方向。'].join('\n')
      }
    }
  })

  // ── /where ────────────────────────────────────────────────────────────────
  // The everyday question: "任务跑到哪了 / 结果在哪 / 路径是什么". Cheap: reads
  // today's ledger tail plus a bounded directory scan. Never renders STATE.md.
  safe({
    name: 'where',
    description: '一眼看现在：最近动作、最近产物、可能是作业的命令、关键路径（轻量）',
    input: { hint: '可选：显示多少条最近动作（默认 6）' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const want = Math.min(Math.max(parseInt(String(rawInput || '').trim(), 10) || 6, 3), 20)
      const cfg = readConfig(root)
      const sum = summarizeDay(root)
      const entries = readDayEntries(root, localDate(), 500)
      const jobs = jobCommands(entries, 5)
      const files = recentFiles(root, 8)
      const header = sessionHeader(sessions, agent)
      const node = readBranches(root).nodes.find((n) => n.id === agent.id) || {}
      const out = []

      out.push('## 现在')
      out.push(cfg.inject === 'off'
        ? '- 注入：off（要一行状态的自动注入用 `/inject brief`）'
        : `- 注入：${cfg.inject}`)
      out.push(`- 分支：${header && header.parentSession ? `分支 · 父 ${shortId(header.parentSession)} · ${node.direction || '方向未记'}` : '主干'}`)
      out.push(sum && sum.n
        ? `- 今日：${sum.n} 次调用 / ${sum.fail} 失败（${hhmm(sum.first)} → ${hhmm(sum.last)}｜${topTools(sum.tools, 3)}）`
        : '- 今日：台账为空')

      out.push('', `## 最近动作（倒序 ${want} 条）`)
      const tail = entries.slice(-want).reverse()
      if (!tail.length) out.push('- （无）')
      for (const e of tail) {
        out.push(`- ${hhmm(e.t)} ${e.ok === false ? '✗' : '✓'} ${e.tool}: ${clip(e.sig, 64)}${e.err ? ` — ${clip(e.err, 40)}` : ''}`)
      }

      out.push('', '## 最近产物（按 mtime，跳过 sci/ 与隐藏目录）')
      if (!files.length) out.push('- （无）')
      for (const f of files) out.push(`- ${f.rel}（${hhmm(new Date(f.mtime).toISOString())}，${humanSize(f.size)}）`)

      out.push('', '## 可能的作业（今日提交过）')
      if (!jobs.length) out.push('- （今日台账里没有 qsub / sbatch / nohup 一类命令）')
      for (const j of jobs) out.push(`- ${hhmm(j.t)} ${clip(j.sig, 96)}`)

      out.push('', '## 路径')
      out.push(`- 项目根：\`${root}\``)
      out.push(`- 状态：\`${sciDir(root)}\``)
      if (files[0]) out.push(`- 最近改动目录：\`${path.dirname(path.join(root, files[0].rel))}\``)

      if (diag) {
        out.push('', '## 注入自检')
        out.push(`- 渲染 ${diag.calls} 次｜agent=${diag.agent ? 'ok' : 'none'}｜cwd=${diag.root ? 'ok' : 'none'}｜sci=${diag.sci ? 'ok' : 'none'}｜模式=${diag.mode}｜上次长度=${diag.len}`)
        if (diag.error) out.push(`- 错误：${diag.error}`)
      }

      out.push('', '完整状态用 `/resume`；记一条死路用 `/deadend`。')
      return { kind: 'success', text: out.join('\n') }
    }
  })

  // ── /inject ───────────────────────────────────────────────────────────────
  safe({
    name: 'inject',
    description: '开关自动注入：/inject off|brief|full（写 sci/config.json，立即生效，无需重启）',
    input: { hint: 'off | brief | full' },
    handler: ({ agent, rawInput }) => {
      const root = rootOf(agent)
      if (!root) return fail('拿不到会话工作目录，无法定位项目根。')
      if (!hasSci(root)) return fail('这个项目还没启用科研状态。先运行 `/resume`。')

      const mode = String(rawInput || '').trim().toLowerCase()
      if (!['off', 'brief', 'full'].includes(mode)) {
        const cur = readConfig(root)
        return {
          kind: 'success',
          text: [
            `当前注入模式：${cur.inject}`,
            '',
            '用法：`/inject off|brief|full`',
            '- off：不注入（默认）。日常用 `/where` 就够。',
            '- brief：每一步注入一行状态（~100 字）。',
            '- full：会话前 2 步注入完整 STATE，之后回落到 brief。'
          ].join('\n')
        }
      }
      writeConfig(root, { inject: mode })
      return { kind: 'success', text: `已设为 ${mode}（\`sci/config.json\`）。下一步模型调用即生效。` }
    }
  })

  return { names: ['where', 'resume', 'wrap', 'deadend', 'branch', 'inject'] }
}
