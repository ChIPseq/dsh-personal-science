// Regression test for scripts/release.mjs (issue #1: --dry-run must survive a
// dirty tree and still print the notes).
//
// The script resolves its repository root from its own location, so the test
// copies it into a throwaway repo and runs it there.
//
//   node test/release.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let failed = 0
function ok (cond, label) {
  if (cond) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
  }
}

const repo = mkdtempSync(path.join(tmpdir(), 'ps-release-'))
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

function runDry () {
  try {
    const stdout = execFileSync('node', ['scripts/release.mjs', '--dry-run'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status ?? 1, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') }
  }
}

try {
  console.log('fixture')
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n')
  mkdirSync(path.join(repo, 'scripts'))
  copyFileSync(fileURLToPath(new URL('../scripts/release.mjs', import.meta.url)), path.join(repo, 'scripts', 'release.mjs'))
  copyFileSync(fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url)), path.join(repo, 'scripts', 'verify.mjs'))
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', 'git@github.com:fixture/fixture.git')
  ok(git('status', '--porcelain') === '', 'fixture repo is clean')

  console.log('\ndry run on a clean tree')
  const clean = runDry()
  ok(clean.code === 0, 'clean dry run exits 0')
  ok(clean.stdout.includes('以下是会用的 notes'), 'clean dry run prints the notes')

  console.log('\ndry run on a dirty tree (issue #1)')
  writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted\n')
  ok(git('status', '--porcelain').trim() !== '', 'fixture repo is dirty')
  const dirty = runDry()
  ok(dirty.code === 0, 'dirty dry run exits 0 instead of 1')
  ok(dirty.stdout.includes('工作树不干净'), 'dirty dry run warns about the working tree')
  ok(dirty.stdout.includes('以下是会用的 notes'), 'dirty dry run still prints the notes')

  console.log('\nverification gate (no CHANGELOG -> warning, real run blocked)')
  ok(dirty.stdout.includes('缺少验证字段') || dirty.stdout.includes('CHANGELOG.md'), 'dry run warns that the verification fields are missing')

  console.log('\nverification gate (CHANGELOG present -> passes)')
  writeFileSync(path.join(repo, 'CHANGELOG.md'), [
    '# CHANGELOG',
    '',
    '## 0.0.1 — 2026-11-24',
    '',
    '- **观察**：fixture',
    '- **改动**：fixture',
    '- **指标**：fixture',
    '- **判据**：fixture',
    '- **读取日期**：2026-12-01',
    ''
  ].join('\n'))
  const gated = runDry()
  ok(gated.code === 0, 'dry run with a complete CHANGELOG exits 0')
  ok(gated.stdout.includes('验证字段齐全'), 'dry run reports the verification fields as complete')
} finally {
  rmSync(repo, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
