// One-time codes that sign a device in (a phone, a browser, the desktop app) as a person of this
// Tucano. A code is made on a page already signed in (Settings › Pessoas › Conectar um celular) for
// whoever is asking, or by `server.js pair` on the server for the owner, and is good once, for a few
// minutes. Spent at POST /pair (the phone's JSON, or the form the browser's /?code= page posts), it
// becomes a key of that person's own (the core makes it, like an invite's): one per device, so one
// can go without the others. Opening /?code= only looks at it (peek): link previews, prefetches and
// scanners open links too, and must not spend one.
//
// `server.js pair` runs as another process than the server, so the codes live in a file of the data
// folder (only this user reads it), read again whenever it changed. Only each code's hash is kept.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

export const CODE_MINUTES = 10
export const MAX_CODE_MINUTES = 7 * 24 * 60
export const CODE_SHAPE = /^[A-Za-z0-9_-]{16,64}$/

interface Saved {
  hash: string
  expires: number
  person: string | null // null: the owner (the server's own `pair`, or the owner's token)
}

const hashOf = (code: string): string => createHash('sha256').update(code).digest('base64url')

// How long a code asked for lives: whole minutes, 1 to a week.
export const codeMinutes = (asked: unknown): number => Math.min(MAX_CODE_MINUTES, Math.max(1, Math.floor(Number(asked)) || CODE_MINUTES))

export class PairCodes {
  private codes: Saved[] = []
  private mtime = -2

  constructor(
    private file: string,
    private now: () => number = Date.now
  ) {}

  // Read again when another process (`server.js pair`) wrote it.
  private load(): void {
    let m = -1
    try {
      m = statSync(this.file).mtimeMs
    } catch {}
    if (m === this.mtime) return
    this.mtime = m
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as { codes?: unknown }
      this.codes = Array.isArray(s.codes) ? (s.codes as Saved[]).filter((c) => typeof c?.hash === 'string' && typeof c.expires === 'number') : []
    } catch {
      this.codes = []
    }
  }

  private save(): void {
    this.codes = this.codes.filter((c) => c.expires > this.now())
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ codes: this.codes }), { mode: 0o600 })
    renameSync(tmp, this.file)
    chmodSync(this.file, 0o600)
    this.mtime = statSync(this.file).mtimeMs
  }

  // A new code for a person (null: the owner), good for `minutes`.
  make(person: string | null, minutes = CODE_MINUTES): { code: string; expiresAt: number } {
    this.load()
    const code = randomBytes(18).toString('base64url')
    const expiresAt = this.now() + codeMinutes(minutes) * 60_000
    this.codes.push({ hash: hashOf(code), expires: expiresAt, person })
    this.save()
    return { code, expiresAt }
  }

  // Whose the code is, without spending it: undefined when it's wrong, used or late.
  peek(code: unknown): { person: string | null } | undefined {
    if (typeof code !== 'string' || !CODE_SHAPE.test(code)) return undefined
    this.load()
    const h = hashOf(code)
    const found = this.codes.find((c) => c.hash === h && c.expires > this.now())
    return found ? { person: found.person ?? null } : undefined
  }

  // The code, spent (once, even when it's late): whose it was, or undefined when it's wrong, used or late.
  spend(code: unknown): { person: string | null } | undefined {
    if (typeof code !== 'string' || !CODE_SHAPE.test(code)) return undefined
    this.load()
    const h = hashOf(code)
    const found = this.codes.find((c) => c.hash === h)
    if (!found) return undefined
    this.codes = this.codes.filter((c) => c !== found)
    this.save()
    return found.expires > this.now() ? { person: found.person ?? null } : undefined
  }
}

// What a device says it is, as the label its key keeps: never trusted, only shown.
export function deviceLabel(name: unknown, platform: unknown): string {
  const clean = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')
  const n = clean(name, 80)
  const p = clean(platform, 20).toLowerCase()
  return [n || 'Aparelho', p].filter(Boolean).join(' · ')
}

// A browser's User-Agent, as a short name for the device it signs in.
export function browserName(ua: string): string {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador'
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${b} · ${os}` : b
}
