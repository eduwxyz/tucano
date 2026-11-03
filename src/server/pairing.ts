// Pairing: how a browser or the Mac app gets in without ever holding the server's own token.
// `pair` makes a one-time code (12 characters, 5 minutes). Trading it gives the device a token of
// its own, good for 30 days from its last use, kept here only as a hash and revocable one by one.
// The state is one small file in the data dir, read again on every call, so the commands on this
// machine and the running server see each other's changes at once. A change is made one writer at
// a time (a lock file), from what the file holds at that moment: a `revoke` and a session renewing
// at the same time can't undo each other.

import { createHash, randomBytes, randomInt } from 'node:crypto'
import { chmodSync, closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { parseJson } from './guard'

export const CODE_TTL_MS = 5 * 60_000
export const SESSION_MS = 30 * 24 * 60 * 60_000
const RENEW_AFTER_MS = 60 * 60_000 // a session renews with use, but the file isn't rewritten on every request
const MAX_PENDING = 20
const MAX_DEVICES = 100
const CODE_LENGTH = 12
const RENEW_WAIT_MS = 500 // the server doesn't stand waiting for a lock just to renew a session
// No 0, O, 1 or I: a code is often read out, or typed from a screen.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export type Device = { id: string; label: string; created: number; seen: number }
export type Issued = { token: string; device: Device }
type Stored = Device & { hash: string }
type Pending = { hash: string; label: string; expires: number }
type State = { devices: Stored[]; pending: Pending[] }

// How long a lock may be held before it is taken to be left by a process that died, and how long to
// wait for one that is held.
export type Lock = { staleMs: number; waitMs: number }
const LOCK: Lock = { staleMs: 10_000, waitMs: 5_000 }

const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Codes and tokens are random and long, so a plain hash is enough to keep them out of the file.
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

const strip = ({ id, label, created, seen }: Stored): Device => ({ id, label, created, seen })

// What was typed is read in any case, with or without the dashes or spaces.
export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

export function cleanLabel(label: unknown, fallback: string): string {
  const s = typeof label === 'string' ? label.replace(/\p{Cc}/gu, ' ').trim().slice(0, 60) : ''
  return s || fallback
}

// A cookie belongs to a host, not to a port: two servers reached through tunnels on 127.0.0.1 would take each
// other's cookie. So each server names its own, after an id it makes once (only letters and digits are kept).
export const cookieName = (serverId: string): string => `tucano-${serverId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`

// What the app (or a script) sends to POST /pair: JSON with the code and, if it has one, a name for the device.
// Anything else is nothing, and not a wrong guess.
export function pairRequest(text: string): { code: string; label: string | undefined } | undefined {
  const v = parseJson(text)?.value
  if (typeof v !== 'object' || v === null) return undefined
  const { code, label } = v as { code?: unknown; label?: unknown }
  if (typeof code !== 'string' || !code.trim() || code.length > 64) return undefined
  return { code, label: typeof label === 'string' ? label : undefined }
}

export class Pairing {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly lock: Lock = LOCK
  ) {}

  // One writer at a time: whoever makes `pairing.json.lock` holds it, until the work is done. A lock older than
  // staleMs was left by a process that died. Synchronous, like the rest: the work inside is a small file.
  private exclusively<T>(work: () => T, waitMs = this.lock.waitMs): T {
    const path = `${this.file}.lock`
    const until = Date.now() + waitMs
    for (;;) {
      try {
        closeSync(openSync(path, 'wx', 0o600))
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > this.lock.staleMs) {
          unlinkSync(path)
          continue
        }
      } catch {
        // Gone since, or taken back by someone else: look again.
      }
      if (Date.now() >= until) throw new Error('pairing.json is busy: another Tucano command is changing it. Try again.')
      pause(20)
    }
    try {
      return work()
    } finally {
      try {
        unlinkSync(path)
      } catch {
        // Already gone.
      }
    }
  }

  private load(): State {
    let raw: { devices?: unknown; pending?: unknown } = {}
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8')) ?? {}
    } catch {
      // None yet, or unreadable: nobody is paired, which is the safe way to fail.
    }
    const t = this.now()
    const devices = (Array.isArray(raw.devices) ? raw.devices : []) as Stored[]
    const pending = (Array.isArray(raw.pending) ? raw.pending : []) as Pending[]
    return {
      // A session that went 30 days unused, and a code that ran out, are gone.
      devices: devices.filter((d) => typeof d?.hash === 'string' && t - d.seen <= SESSION_MS),
      pending: pending.filter((p) => typeof p?.hash === 'string' && p.expires > t)
    }
  }

  private save(s: State): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
    renameSync(tmp, this.file)
    chmodSync(this.file, 0o600)
  }

  private make(s: State, label: string): Issued {
    const t = this.now()
    const token = `tk_${randomBytes(32).toString('base64url')}`
    const device: Stored = { id: randomBytes(4).toString('hex'), label, created: t, seen: t, hash: sha(token) }
    s.devices = [...s.devices, device].sort((a, b) => b.seen - a.seen).slice(0, MAX_DEVICES)
    return { token, device: strip(device) }
  }

  // A one-time code for one device. The label is the owner's name for it ("My Mac").
  invite(label?: string): { code: string; expires: number } {
    return this.exclusively(() => {
      const s = this.load()
      const raw = Array.from({ length: CODE_LENGTH }, () => ALPHABET.charAt(randomInt(ALPHABET.length))).join('')
      const expires = this.now() + CODE_TTL_MS
      s.pending = [...s.pending, { hash: sha(raw), label: cleanLabel(label, ''), expires }].slice(-MAX_PENDING)
      this.save(s)
      return { code: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`, expires }
    })
  }

  // The code for the device's own token, once. A wrong, used or expired code answers nothing.
  redeem(code: string, label?: string): Issued | undefined {
    const norm = normalizeCode(code)
    if (norm.length !== CODE_LENGTH) return undefined
    const h = sha(norm)
    // A wrong code costs a read, not the lock: guessing can't keep the commands waiting.
    if (!this.load().pending.some((p) => p.hash === h)) return undefined
    return this.exclusively(() => {
      const s = this.load()
      const at = s.pending.findIndex((p) => p.hash === h)
      const found = s.pending[at]
      if (!found) return undefined
      s.pending = s.pending.filter((_, i) => i !== at)
      const issued = this.make(s, found.label || cleanLabel(label, 'device'))
      this.save(s)
      return issued
    })
  }

  // A device the owner already vouched for with the server's own token.
  enroll(label: string): Issued {
    return this.exclusively(() => {
      const s = this.load()
      const issued = this.make(s, cleanLabel(label, 'device'))
      this.save(s)
      return issued
    })
  }

  // Whose token this is, if it is one. Using it renews the session.
  check(token: string | undefined): Device | undefined {
    if (!token || token.length > 200) return undefined
    const h = sha(token)
    const found = this.load().devices.find((x) => x.hash === h)
    if (!found) return undefined
    if (this.now() - found.seen <= RENEW_AFTER_MS) return strip(found)
    // Renewing writes the file, so it starts again from what the file holds under the lock: a device revoked a
    // moment ago must not come back with a new date. If the file stays busy, the device still gets in and the
    // session renews on a later request.
    try {
      return this.exclusively(() => {
        const s = this.load()
        const d = s.devices.find((x) => x.hash === h)
        if (!d) return undefined
        d.seen = this.now()
        this.save(s)
        return strip(d)
      }, Math.min(this.lock.waitMs, RENEW_WAIT_MS))
    } catch {
      return strip(found)
    }
  }

  list(): Device[] {
    return this.load()
      .devices.map(strip)
      .sort((a, b) => a.created - b.created)
  }

  // By id or by label (any case). How many lost their access.
  revoke(which: string): number {
    return this.exclusively(() => {
      const s = this.load()
      const w = which.trim().toLowerCase()
      const keep = s.devices.filter((d) => d.id !== w && d.label.toLowerCase() !== w)
      const n = s.devices.length - keep.length
      if (n) {
        s.devices = keep
        this.save(s)
      }
      return n
    })
  }

  // Every device, and the codes not used yet.
  revokeAll(): number {
    return this.exclusively(() => {
      const n = this.load().devices.length
      this.save({ devices: [], pending: [] })
      return n
    })
  }
}
