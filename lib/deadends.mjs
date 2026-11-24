// 最近几条死路，供注入用。
//
// 为什么放在注入里而不是文档里：dead-ends.md 只有人主动去看才有用；而
// 已经踩过的坑通常是在"又要派一个类似的活"时才需要想起来——那时模型不会
// 主动翻文件。一行注入是唯一不依赖它记性的位置。
//
// 只取最后 n 条、每条截断，避免把 prompt 撑大。

import path from 'node:path'
import { sciDir } from './project.mjs'
import { tryRead } from './fsutil.mjs'

const DATE = /^\s*(?:[-|]\s*)?(\d{4}-\d{2}-\d{2})/

function parseRows (text) {
  const rows = []
  for (const line of String(text || '').split('\n')) {
    const m = DATE.exec(line)
    if (!m) continue
    const date = m[1]
    let body = line.trim().replace(/^[-|]\s*/, '')
    // bullet: 日期 时间 · 试过什么 · 证据
    // table:  | 日期 | 试过什么 | 证据 | 结论 |
    const cells = body.includes('|')
      ? body.split('|').map((s) => s.trim()).filter(Boolean)
      : body.split(' · ').map((s) => s.trim())
    const what = cells[1] || ''
    if (!what) continue
    rows.push({ date, what })
  }
  return rows
}

export function recentDeadEnds (root, n = 2) {
  const text = tryRead(path.join(sciDir(root), 'dead-ends.md'))
  if (!text) return []
  return parseRows(text).slice(-n)
}

/** One line for `inject: brief|full`; empty when there is nothing to show. */
export function deadEndsLine (root, n = 2, maxChars = 46) {
  const rows = recentDeadEnds(root, n)
  if (!rows.length) return ''
  const items = rows.map((r) => {
    const clipped = r.what.length > maxChars ? r.what.slice(0, maxChars - 1) + '…' : r.what
    return `${r.date.slice(5)} ${clipped}`
  })
  return `【死路】${items.join('；')}`
}
