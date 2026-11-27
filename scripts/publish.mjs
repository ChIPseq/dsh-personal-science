#!/usr/bin/env node
// 只把**插件树**推到公开仓：科研（science/）、过程记录（process/）、母状态（sci/）
// 永远不进公开历史。
//
// 背景：工作目录 D:\workspace\dsh-science 同时住着三样东西——插件、科研、过程记录。
// 直接 `git push main` 会把科研数据带上公开仓。所以发布走一条独立分支：
//
//   main（本地，三层混在一起，永不直接推）
//     └─ publish（只含 plugin/dsh-personal-science/ 的内容，接在 origin/main 后面）→ push 到 origin/main
//
// 用法
//   node plugin/dsh-personal-science/scripts/publish.mjs           # 构建 publish 分支并显示差异（不推）
//   node plugin/dsh-personal-science/scripts/publish.mjs --push    # 构建 + 推送 publish:main
//   node ... --push-url https://github.com/OWNER/REPO.git          # SSH 不通时改走 HTTPS
//
// 为什么需要 --push-url：本机 origin 是 SSH，而 github.com 的 SSH 解析经常失败；HTTPS 通常可用。

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { checkChangelog, describe } from './verify.mjs'

const PLUGIN = path.resolve(import.meta.dirname, '..')
const BRANCH = 'publish'
const WORKTREE = path.join(mkdtempSync(path.join(tmpdir(), 'ps-publish-')), 'tree')

// 公开树的白名单（相对插件根）。只有这些路径会出现在 GitHub 上。
const ALLOWED = [
  '.gitignore',
  'README.md',
  'LICENSE',
  'package.json',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'index.mjs',
  'lib',
  'skills',
  'test',
  'docs/DESIGN.md',
  'scripts/release.mjs',
  'scripts/night.mjs',
  'scripts/publish.mjs'
]

// 只要这些出现在公开树里，就是漏了（相对公开树根）。
const FORBIDDEN = ['science', 'process', 'sci', 'dsh-science-x1', 'journal', 'cost', 'runbooks', 'Plan_Summary', 'secrets']

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: PLUGIN, encoding: 'utf8' }).trim()

function git (...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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
    execFileSync('git', ['worktree', 'remove', '--force', WORKTREE], { cwd: REPO, stdio: 'ignore' })
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
const pushUrl = argv.includes('--push-url') ? argv[argv.indexOf('--push-url') + 1] : null
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法：node plugin/dsh-personal-science/scripts/publish.mjs [--push] [--push-url <https url>]')
  process.exit(0)
}

try {
  // 发布闸门：没有验证字段的版本不许推。
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
  const gate = checkChangelog(PLUGIN, pkg.version)
  if (!gate.ok && !argv.includes('--force')) fail(describe(pkg.version, gate))
  console.log(gate.ok ? `✓ ${describe(pkg.version, gate)}` : `⚠ ${describe(pkg.version, gate)}（--force 跳过）`)

  // 永远基于 origin/main 重建：publish 只是"这一次要推的树"，历史不复用
  //（复用会把已移出白名单的文件留在历史里）。
  const baseBranch = 'origin/main'

  console.log(`\n发布树（只含插件）`)
  console.log(`  插件根    ${PLUGIN}`)
  console.log(`  仓库根    ${REPO}`)
  console.log(`  基础分支  ${baseBranch}`)
  console.log(`  白名单    ${ALLOWED.filter((rel) => existsSync(path.join(PLUGIN, rel))).join(', ')}`)

  git('worktree', 'add', '--detach', WORKTREE, baseBranch)

  for (const name of readdirSync(WORKTREE)) {
    if (name === '.git') continue
    rmSync(path.join(WORKTREE, name), { recursive: true, force: true })
  }

  let copied = 0
  for (const rel of ALLOWED) {
    const src = path.join(PLUGIN, rel)
    if (!existsSync(src)) continue
    cpSync(src, path.join(WORKTREE, rel), { recursive: true })
    copied += 1
  }

  for (const banned of FORBIDDEN) {
    if (existsSync(path.join(WORKTREE, banned))) fail(`公开树里出现了不该有的目录：${banned}`)
  }

  gitIn(WORKTREE, 'add', '-A')
  if (!gitIn(WORKTREE, 'status', '--porcelain')) {
    console.log('\n公开树没有变化；不创建新提交。')
    cleanup()
    process.exit(0)
  }

  const name = git('config', 'user.name') || 'dsh-personal-science'
  const email = git('config', 'user.email') || 'noreply@local'
  gitIn(WORKTREE, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `release: 同步插件树（${new Date().toISOString().slice(0, 10)}）`)

  const head = gitIn(WORKTREE, 'rev-parse', 'HEAD')
  console.log(`\n新提交 ${head.slice(0, 12)}（${copied} 个路径）`)
  console.log(gitIn(WORKTREE, 'diff', '--stat', `${baseBranch}..HEAD`) || '  （无差异）')

  git('branch', '-f', BRANCH, head)
  cleanup()

  console.log(`\n本地分支 ${BRANCH} → ${head.slice(0, 12)}（未推送）`)

  if (!push) {
    console.log('\n下一步（确认无误后）：')
    console.log(`  git push origin ${BRANCH}:main`)
    console.log('  或  node plugin/dsh-personal-science/scripts/publish.mjs --push [--push-url <https url>]')
    process.exit(0)
  }

  const target = pushUrl || 'origin'
  console.log(`\n推送 ${BRANCH} → ${target} 的 main`)
  try {
    execFileSync('git', ['push', target, `${BRANCH}:main`], { cwd: REPO, stdio: 'inherit' })
  } catch {
    fail(
      '推送失败。若报 git@github.com 解析失败，本机 SSH 到 GitHub 不通，改用 HTTPS：\n' +
        '  node plugin/dsh-personal-science/scripts/publish.mjs --push --push-url https://github.com/ChIPseq/dsh-personal-science.git\n' +
        '（HTTPS 需要凭据：GITHUB_TOKEN 或系统凭据管理器）'
    )
  }
  console.log('\n✓ 公开仓已更新（只含插件树）')
} catch (err) {
  fail(String((err && err.message) || err))
}
