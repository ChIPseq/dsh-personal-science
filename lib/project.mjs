// Project root resolution and the `sci/` opt-in gate.
//
// opt-in rule: a directory counts as a personal-science project **only** when
// `<cwd>/sci/` exists. Nothing is written into a project that has not run
// `/resume` at least once, so the plugin stays silent in ordinary code repos.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { ensureDir, localStamp, writeText } from './fsutil.mjs'

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

  // The drop box lives in the project root, not under sci/: the human has to
  // be able to see it in their file manager and drag files into it.
  const box = path.join(root, 'inbox')
  ensureDir(box)
  if (!existsSync(path.join(box, 'README.md'))) writeText(path.join(box, 'README.md'), INBOX_README)
  if (!existsSync(path.join(box, '.gitignore'))) {
    writeText(path.join(box, '.gitignore'), '# 投放的文件不进入版本控制\n*\n!.gitignore\n!README.md\n')
  }
  return dir
}

export const INBOX_README = `# inbox —— 投放资料的地方

把想让 AI 读的东西放在这里，然后**显式**说一句：

> 处理 inbox：读这些文件，归类放好，清空收件箱。

支持的典型内容：别人发来的调研报告、PDF 文献、数据表、方案文档、图。

处理规则（由 personal-science 约定）：

- 只有你显式要求时才会处理，平时它只是一块空地。
- AI 会读完内容再决定归属，**移动**而不是复制：
  - 文献 PDF → \`papers/pdf/\`，并在 \`papers/papers.csv\` 登记
  - 调研报告 / 综述 / 方案 → \`Plan_Summary/<日期>_<主题>.md\`
  - 数据表 → \`data/\`；脚本 → \`Experiment/<日期>_<主题>/scripts/\`；图 → \`figures/\`
- 读不动的文件（扫描版 PDF、加密、超大二进制）不会硬猜，会列出来问你。
- 处理完这里必须**回到只有 README.md 和 .gitignore 的状态**。
- 这里的东西默认不进 git（\`.gitignore\` 已配好）。
`

export const STATE_TEMPLATE = `# 研究状态

<!-- 硬约束：整份文件 <= 45 行 / <= 1800 字。它会被注入到**每一步**模型调用。
     细节、推导、文献摘录一律放 sci/log/ 或 Plan_Summary/，这里只留判定所需的最小状态。
     这个文件是唯一允许整体重写的文件；其余分析文档只允许追加（见 skill: personal-science）。 -->

- 更新时间：${localStamp()}
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
