// Small filesystem/date helpers. No third-party dependencies.

import { mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'

export function ensureDir (p) {
  mkdirSync(p, { recursive: true })
}

export function tryRead (p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function mtimeOf (p) {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

export function appendText (p, text) {
  ensureDir(path.dirname(p))
  appendFileSync(p, text, 'utf8')
}

export function writeText (p, text) {
  ensureDir(path.dirname(p))
  writeFileSync(p, text, 'utf8')
}

const pad = (n) => String(n).padStart(2, '0')

export function localDate (d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localTime (d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function localStamp (d = new Date()) {
  return `${localDate(d)} ${localTime(d)}`
}

export function clip (s, max) {
  const t = String(s ?? '')
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
