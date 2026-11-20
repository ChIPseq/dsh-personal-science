#!/usr/bin/env node
// 只把**插件树**推到公开仓：科研工作区（dsh-science-x1/、journal/、cost/、sci/ …）
// 永远不进公开历史。
//
// 背景：这个工作目录同时是插件仓和科研项目的家。直接 `git push main` 会把
// 400+ 个科研文件（实验数据、日志、账本）带到公开仓。所以发布走一条独立分支：
//
//   main（本地，插件+科研混在一起，永不直接推）
//     └─ publish（只含插件文件，线性接在 origin/main 后面）→ push 到 origin/main
//
// 用法
//   node scripts/publish.mjs           # 只构建 publish 分支并显示将要推送的差异（不推）
//   node scripts/publish.mjs --push    # 构建 + 推送 publish:main
//   node scripts/publish.mjs --push-url https://github.com/OWNER/REPO.git
//
// 为什么需要 --push-url：本机的 origin 是 SSH，而 github.com 的 SSH 解析经常失败；
// HTTPS 通常可用。

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const BRANCH = 'publish'
const WORKTREE = path.join(mkdtempSync(path.join(tmpdir(), 'ps-publish-')), 'tree')

// 公开树的白名单。只有这里列出的东西会出现在 GitHub 上。
const ALLOWED = [
  '.gitignore',
  'README.md',
  'LICENSE',
  'package.json',
  'cordis.patch.yml',
  'index.mjs',
  'lib',
  'skills',
  'test',
  'docs/DESIGN.md',
  'scripts/release.mjs',
  'scripts/publish.mjs'
]

// 只要这些东西出现在公开树里，就是漏了。
const FORBIDDEN = [
  'dsh-science-x1',
  'journal',
  'cost',
  'sci',
  'runbooks',
  'Plan_Summary',
  '_scratch',
  '_refs',
  '_analysis',
  'secrets'
]

function git (...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitIn (dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fail (msg) {
  console.error(`\n✗ ${msg}`)
  cleanup()
  process.exit(1)
}

function cleanup () {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', WORKTREE], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    /* already gone */
  }
  try {
    rmSync(path.dirname(WORKTREE), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const argv = process.argv.slice(2)
const push = argv.includes('--push')
const pushUrl = argv[argv.indexOf('--push-url') + 1] && argv.includes('--push-url') ? argv[argv.indexOf('--push-url') + 1] : null
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法：node scripts/publish.mjs [--push] [--push-url <https url>]')
  process.exit(0)
}

function exists (p) {
  return existsSync(path.join(ROOT, p))
}

try {
  // 永远基于 origin/main 重建，而不是上一次的 publish：publish 分支只是
  // "这一次要推的树"，它的历史不能被复用（复用会把已经移出白名单的文件
  // 留在历史里）。
  const baseBranch = 'origin/main'

  console.log(`\n发布树（只含插件）`)
  console.log(`  基础分支  ${baseBranch}`)
  console.log(`  白名单    ${ALLOWED.filter(exists).join(', ')}`)

  git('worktree', 'add', '--detach', WORKTREE, baseBranch)

  // 清空基础树（保留 .git 文件），再按白名单铺一遍。
  for (const name of readdirSync(WORKTREE)) {
    if (name === '.git') continue
    rmSync(path.join(WORKTREE, name), { recursive: true, force: true })
  }

  let copied = 0
  for (const rel of ALLOWED) {
    const src = path.join(ROOT, rel)
    if (!existsSync(src)) continue
    const dest = path.join(WORKTREE, rel)
    cpSync(src, dest, { recursive: true })
    copied += 1
  }

  for (const banned of FORBIDDEN) {
    if (existsSync(path.join(WORKTREE, banned))) fail(`公开树里出现了不该有的目录：${banned}`)
  }

  gitIn(WORKTREE, 'add', '-A')
  const staged = gitIn(WORKTREE, 'status', '--porcelain')
  if (!staged) {
    console.log('\n公开树没有变化；不创建新提交。')
    cleanup()
    process.exit(0)
  }

  // 提交者信息沿用当前仓库配置，避免在公开历史里留下奇怪的身份。
  const name = git('config', 'user.name') || 'dsh-personal-science'
  const email = git('config', 'user.email') || 'noreply@local'
  gitIn(WORKTREE, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `release: 同步插件树（${new Date().toISOString().slice(0, 10)}）`)

  const head = gitIn(WORKTREE, 'rev-parse', 'HEAD')
  console.log(`\n新提交 ${head.slice(0, 12)}（${copied} 个路径）`)
  const stat = gitIn(WORKTREE, 'diff', '--stat', `${baseBranch}..HEAD`)
  console.log(stat || '  （无差异）')

  git('branch', '-f', BRANCH, head)
  cleanup()

  console.log(`\n本地分支 ${BRANCH} → ${head.slice(0, 12)}（未推送）`)

  if (!push) {
    console.log('\n下一步（确认无误后）：')
    console.log(`  git push origin ${BRANCH}:main`)
    console.log('  或  node scripts/publish.mjs --push [--push-url <https url>]')
    process.exit(0)
  }

  const target = pushUrl || 'origin'
  console.log(`\n推送 ${BRANCH} → ${target} 的 main`)
  try {
    execFileSync('git', ['push', target, `${BRANCH}:main`], { cwd: ROOT, stdio: 'inherit' })
  } catch {
    fail(
      '推送失败。若报 git@github.com 解析失败，本机 SSH 到 GitHub 不通，改用 HTTPS：\n' +
        '  node scripts/publish.mjs --push --push-url https://github.com/ChIPseq/dsh-personal-science.git\n' +
        '（HTTPS 需要凭据：GITHUB_TOKEN 或系统凭据管理器）'
    )
  }
  console.log('\n✓ 公开仓已更新（只含插件树）')
} catch (err) {
  fail(String((err && err.message) || err))
}
