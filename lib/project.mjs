// Project root resolution and the `sci/` opt-in gate.
//
// opt-in rule: a directory counts as a personal-science project **only** when
// `<cwd>/sci/` exists. Nothing is written into a project that has not run
// `/resume` at least once, so the plugin stays silent in ordinary code repos.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { ensureDir, writeText } from './fsutil.mjs'

export function sciDir (root) {
  return path.join(root, 'sci')
}

export function hasSci (root) {
  return Boolean(root) && existsSync(sciDir(root))
}

/** Resolve the live session's working directory, or null. */
export function resolveProjectRoot (sessions, agent) {
  if (!agent || !sessions || typeof sessions.get !== 'function') return null
  let session
  try {
    session = sessions.get(agent.id)
  } catch {
    return null
  }
  const cwd = session && session.header && session.header.cwd
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) return cwd
  return null
}

export function sessionHeader (sessions, agent) {
  if (!agent || !sessions || typeof sessions.get !== 'function') return null
  try {
    const s = sessions.get(agent.id)
    return (s && s.header) || null
  } catch {
    return null
  }
}

export function ensureScaffold (root) {
  const dir = sciDir(root)
  ensureDir(path.join(dir, 'log'))
  ensureDir(path.join(dir, 'ledger'))
  ensureDir(path.join(dir, 'state-history'))
  if (!existsSync(path.join(dir, 'STATE.md'))) {
    writeText(path.join(dir, 'STATE.md'), STATE_TEMPLATE)
  }
  if (!existsSync(path.join(dir, 'dead-ends.md'))) {
    writeText(path.join(dir, 'dead-ends.md'), DEAD_ENDS_TEMPLATE)
  }
  return dir
}

export const STATE_TEMPLATE = `# 研究状态

<!-- 硬约束：整份文件 <= 45 行 / <= 1800 字。它会被注入到**每一步**模型调用。
     细节、推导、文献摘录一律放 sci/log/ 或 Plan_Summary/，这里只留判定所需的最小状态。
     这个文件是唯一允许整体重写的文件；其余分析文档只允许追加（见 skill: personal-science）。 -->

- 更新时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}
- 阶段：未设定（agenda / literature / design / run / analysis / write / hold）
- 当前分支：主干

## 当前判断（一句话）
（还没想清楚就写"尚未形成判断"，不要留空）

## 科学问题
- Q1：

## 开放假设（<= 5 条，带状态）
- H1 [proposed]：

## 已关闭（最近 3 条）
- （暂无）

## 下一步（1-3 个具体动作，可立刻执行）
1.

## 停在哪里
- 上次动作：
- 待跑作业：
- 未回读：

## 不要重蹈（dead-ends 摘要，<= 3 条）
- （暂无，见 sci/dead-ends.md）
`

export const DEAD_ENDS_TEMPLATE = `# 死路台账（append-only）

只追加、不删除、不改写。每一条都是"试过、不行"的路线，用来防止未来的会话重蹈覆辙。

| 日期 | 试过什么 | 为什么不行 / 证据 | 结论 |
|---|---|---|---|
`
