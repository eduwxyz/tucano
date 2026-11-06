// What keeps the server standing and its token to itself once it's on the internet:
// a request it can't read gets a 400 instead of taking it down, guessing the token is
// slowed to nothing, and the page answers only its own origin, never inside another site's frame.
import type { IncomingMessage } from 'node:http'

// Guessing: after this many wrong tokens from one address in the window, that address waits.
export const MAX_FAILS = 20
export const WINDOW_MS = 10 * 60_000

export class Limiter {
  private fails = new Map<string, { n: number; since: number }>()

  constructor(private now: () => number = Date.now) {}

  blocked(ip: string): boolean {
    const f = this.fails.get(ip)
    if (!f) return false
    if (this.now() - f.since > WINDOW_MS) return void this.fails.delete(ip), false
    return f.n >= MAX_FAILS
  }

  fail(ip: string): void {
    const f = this.fails.get(ip)
    if (!f || this.now() - f.since > WINDOW_MS) this.fails.set(ip, { n: 1, since: this.now() })
    else f.n++
    // An address that only ever fails stays bounded: the oldest go first.
    if (this.fails.size > 10_000) this.fails.delete(this.fails.keys().next().value!)
  }
}

// Who is asking. Behind a reverse proxy (TUCANO_TRUST_PROXY=1) every request comes from the
// proxy, so the address it was asked from is the last one it added to X-Forwarded-For. Without
// it, that header is the asker's own word and counts for nothing.
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean): string {
  const direct = req.socket.remoteAddress ?? ''
  if (!trustProxy) return direct
  const fwd = req.headers['x-forwarded-for']
  const last = (Array.isArray(fwd) ? fwd.join(',') : (fwd ?? '')).split(',').pop()?.trim()
  return last || direct
}

// A page of another origin (another person's Tucano on a sibling subdomain, for one) may not
// talk to this one. A browser always says where a fetch or an EventSource comes from; with no
// Origin it's a navigation or a program, which the token alone decides.
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

// On every answer. The app's page can't be framed by any site (an approval clicked through a
// frame); an agent's page can only be framed by the app, which shows it in its panel.
export const BASE_HEADERS: Record<string, string> = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
export const PAGE_HEADERS: Record<string, string> = { ...BASE_HEADERS, 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }
export const ARTIFACT_CSP = "sandbox allow-scripts allow-popups; frame-ancestors 'self'"

// A path out of the address, or undefined when it can't be read (a stray % from a scanner).
export function decodedPath(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}
