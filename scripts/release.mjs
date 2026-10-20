#!/usr/bin/env node
// 发布一个版本：校验 → 可选改版本号 → 打 annotated tag → push → 建 GitHub Release
//
// 用法
//   node scripts/release.mjs --dry-run           # 只打印计划，不动任何东西
//   node scripts/release.mjs --yes               # 用 package.json 里的版本发布
//   node scripts/release.mjs --bump patch --yes  # 0.3.0 -> 0.3.1，自动提交并发布
//   node scripts/release.mjs --notes notes.md --yes
//   node scripts/release.mjs --no-release --yes  # 只打 tag + push，不建 Release
//
// 凭据解析顺序：GH_TOKEN / GITHUB_TOKEN 环境变量 → `git credential fill`（Windows
// 凭据管理器 / macOS keychain / Linux libsecret 都能用）。不落盘、不回显。
//
// 为什么用 Node 而不是 PowerShell：fetch 按 UTF-8 发 JSON。PowerShell 的
// Invoke-RestMethod 会把中文 body 按 ISO-8859-1 编，GitHub 直接回
// "Problems parsing JSON"——这个坑已经踩过一次。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const API = 'https://api.github.com'

// ── 小工具 ──────────────────────────────────────────────────────────────────

function sh (cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    input: opts.input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).trim()
}

function git (...args) {
  return sh('git', args)
}

function gitIn (input, ...args) {
  return sh('git', args, { input })
}

function fail (msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function ok (msg) {
  console.log(`✓ ${msg}`)
}

function info (msg) {
  console.log(`  ${msg}`)
}

function parseArgs (argv) {
  const out = { yes: false, dryRun: false, noRelease: false, bump: null, notes: null, offline: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-release') out.noRelease = true
    else if (a === '--offline') out.offline = true
    else if (a === '--bump') out.bump = argv[++i]
    else if (a === '--notes') out.notes = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else fail(`未知参数：${a}（--help 看用法）`)
  }
  return out
}

function bump (version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) fail(`package.json 的 version 不是 x.y.z：${version}`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'major') return `${major + 1}.0.0`
  fail(`--bump 只接受 patch / minor / major，收到：${kind}`)
}

// ── 仓库状态 ────────────────────────────────────────────────────────────────

function readPkg () {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
}

function writePkgVersion (version) {
  const p = path.join(ROOT, 'package.json')
  const raw = readFileSync(p, 'utf8')
  writeFileSync(p, raw.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`), 'utf8')
}

function remoteSlug () {
  let url = ''
  try {
    url = git('remote', 'get-url', 'origin')
  } catch {
    fail('没有 origin remote')
  }
  const m = /github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url)
  if (!m) fail(`origin 不是 GitHub 地址：${url}`)
  return `${m[1]}/${m[2]}`
}

function assertClean () {
  const dirty = git('status', '--porcelain')
  if (dirty) fail(`工作树不干净，先提交或 stash：\n${dirty}`)
}

function assertOnMain () {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') fail(`当前分支是 ${branch}，发布请在 main 上`)
  return branch
}

function assertSynced (branch) {
  git('fetch', '--quiet', 'origin')
  const local = git('rev-parse', 'HEAD')
  const remote = git('rev-parse', `origin/${branch}`)
  if (local !== remote) fail(`本地 ${branch} 与 origin/${branch} 不一致，先 pull/push`)
}

function tagExists (tag) {
  return git('tag', '--list', tag) !== ''
}

function previousTag () {
  try {
    return git('describe', '--tags', '--abbrev=0')
  } catch {
    return null
  }
}

// ── Release notes ───────────────────────────────────────────────────────────

function generatedNotes (tag, prev) {
  const range = prev ? `${prev}..HEAD` : 'HEAD'
  const out = git('log', '--no-merges', '--pretty=- %s (`%h`)', range)
  return [
    prev ? `自 ${prev} 以来的变更：` : '首次发布：',
    '',
    out || '- （没有新提交）'
  ].join('\n')
}

// ── 凭据 ────────────────────────────────────────────────────────────────────

function readToken () {
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[k]) return { token: process.env[k], source: `env ${k}` }
  }
  let text = ''
  try {
    text = gitIn('protocol=https\nhost=github.com\n\n', 'credential', 'fill')
  } catch {
    return null
  }
  const user = (/^username=(.*)$/m.exec(text) || [])[1]
  const pass = (/^password=(.*)$/m.exec(text) || [])[1]
  if (!pass) return null
  const basic = Buffer.from(`${user || 'x-access-token'}:${pass}`, 'utf8').toString('base64')
  return { token: basic, source: 'git credential fill', basic: true }
}

async function api (method, urlPath, body, auth) {
  const headers = {
    Authorization: auth.basic ? `Basic ${auth.token}` : `Bearer ${auth.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-personal-science-release',
    'Content-Type': 'application/json; charset=utf-8'
  }
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return text ? JSON.parse(text) : null
}

// ── main ────────────────────────────────────────────────────────────────────

async function main () {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 18).join('\n').replace(/^\/\/ ?/gm, ''))
    return
  }
  if (!args.yes && !args.dryRun && !process.stdin.isTTY) {
    fail('非交互环境请显式加 --yes（或先 --dry-run 看计划）')
  }

  const pkg = readPkg()
  let version = pkg.version
  let bumped = false

  if (args.bump) {
    version = bump(version, args.bump)
    bumped = true
  }

  const tag = `v${version}`
  const slug = remoteSlug()
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')

  console.log(`\n发布计划`)
  info(`仓库      ${slug}`)
  info(`分支      ${branch}`)
  info(`版本      ${pkg.version}${bumped ? ` → ${version}` : ''}`)
  info(`tag       ${tag}`)
  info(`Release   ${args.noRelease ? '跳过（--no-release）' : `会创建于 ${API}/repos/${slug}/releases`}`)

  assertOnMain()
  const tagBlocked = tagExists(tag)
  if (args.dryRun) {
    if (tagBlocked) info(`⚠ tag ${tag} 已存在 —— 真跑会被拦下，先 --bump 或用新版本号`)
    if (!bumped) {
      try {
        assertClean()
      } catch {
        info('⚠ 工作树不干净')
      }
    }
  } else {
    if (tagBlocked) fail(`tag ${tag} 已存在`)
    if (!bumped) assertClean()
  }

  const notes = args.notes
    ? readFileSync(path.resolve(ROOT, args.notes), 'utf8').trim()
    : generatedNotes(tag, previousTag())

  if (args.dryRun) {
    console.log(`\n-- dry-run：以下是会用的 notes --\n\n${notes}\n`)
    return
  }

  if (bumped) {
    writePkgVersion(version)
    git('add', 'package.json')
    git('-c', 'user.name=' + (process.env.GIT_AUTHOR_NAME || git('config', 'user.name')), '-c', 'user.email=' + (process.env.GIT_AUTHOR_EMAIL || git('config', 'user.email')), 'commit', '-q', '-m', `chore(release): ${tag}`)
    ok(`package.json → ${version}，已提交`)
  }

  assertClean()
  assertSynced(branch)

  git('tag', '-a', tag, '-m', notes)
  ok(`tag ${tag} 已创建（annotated）`)

  git('push', 'origin', branch)
  git('push', 'origin', tag)
  ok(`已推送 ${branch} 与 ${tag}`)

  if (args.noRelease || args.offline) {
    console.log('\n完成（未创建 GitHub Release）')
    return
  }

  const auth = readToken()
  if (!auth) {
    console.warn('\n! 找不到 GitHub 凭据（GH_TOKEN / GITHUB_TOKEN / git credential fill 都没有）')
    console.warn(`  tag 已经推上去了。手动建 Release：https://github.com/${slug}/releases/new?tag=${tag}`)
    return
  }

  try {
    const release = await api('POST', `/repos/${slug}/releases`, {
      tag_name: tag,
      name: `${tag}`,
      body: notes,
      draft: false,
      prerelease: false
    }, auth)
    ok(`Release 已创建：${release.html_url}`)
    info(`凭据来源 ${auth.source}`)
  } catch (err) {
    console.warn(`\n! Release 创建失败：${err.message}`)
    console.warn(`  tag ${tag} 已经在远端，可手动补建：https://github.com/${slug}/releases/new?tag=${tag}`)
    process.exitCode = 2
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err && err.message ? err.message : err}`)
  process.exit(1)
})
