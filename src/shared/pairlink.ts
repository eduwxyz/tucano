// The link that hands the Mac app everything it needs to reach a server and pair with it:
//
//   tucano://pair?v=1&code=K7QM-2XPD-9TWH&ssh=you@203.0.113.7:22&port=7337&name=My%20VPS
//   tucano://pair?v=1&code=K7QM-2XPD-9TWH&url=https://tucano.example.com&name=My%20VPS
//
// The server's `pair` command prints it. It is text that comes from outside (a chat, a web page), and the
// app turns it into an `ssh` command, so nothing in it is trusted: a part that isn't exactly what it should
// be makes the whole link a refusal, and the app never builds a command from a rejected link. A user or a
// host can't start with "-" (ssh would read it as an option, `-oProxyCommand=…` runs a command), and only
// letters, digits and a few separators get through at all.

export type Reach =
  | { via: 'ssh'; user: string; host: string; port: number } // an SSH tunnel to the server's own loopback
  | { via: 'url'; url: string } // an address reached as it is: HTTPS (including Tailscale Serve), or local loopback

export type PairLink = { code: string; reach: Reach; remotePort: number; name: string }
export type Parsed = { ok: true; link: PairLink } | { ok: false; error: string }

export const DEFAULT_PORT = 7337
const MAX_LINK = 2048

const CODE = /^[A-HJ-NP-Z2-9]{12}$/ // pairing.ts: no 0, O, 1 or I
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/

function port(text: string | undefined, fallback: number): number | undefined {
  if (text === undefined) return fallback
  if (!/^\d{1,5}$/.test(text)) return undefined
  const n = Number(text)
  return n >= 1 && n <= 65535 ? n : undefined
}

// user@host, user@host:port or user@[::1]:port. The user is required: a link that leaves it to the
// machine's own ssh config would connect as whoever the config says.
export function parseSshTarget(text: string): Extract<Reach, { via: 'ssh' }> | undefined {
  const m = /^([^@\s]+)@(\[[^\]\s]+\]|[^:\s]+)(?::(\d+))?$/.exec(text)
  if (!m) return undefined
  const [, user, bracketed, given] = m as unknown as [string, string, string, string | undefined]
  const host = bracketed.startsWith('[') ? bracketed.slice(1, -1) : bracketed
  const v6 = bracketed.startsWith('[')
  if (!USER.test(user)) return undefined
  if (v6 ? !(IPV6.test(host) && host.includes(':')) : !HOSTNAME.test(host)) return undefined
  const p = port(given, 22)
  return p === undefined ? undefined : { via: 'ssh', user, host, port: p }
}

// A private-looking address does not prove an encrypted route. Direct connections always
// need TLS, including Tailscale/CGNAT addresses. HTTP is only for this machine's loopback
// (also where a managed SSH tunnel terminates).
function loopback(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

export function parseServerUrl(text: string): string | undefined {
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return undefined
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return undefined
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback(u.hostname))) return u.origin
  return undefined
}

const bad = (error: string): Parsed => ({ ok: false, error })

export function parsePairLink(text: string): Parsed {
  if (typeof text !== 'string' || text.length > MAX_LINK) return bad('not a Tucano link')
  let u: URL
  try {
    u = new URL(text.trim())
  } catch {
    return bad('not a Tucano link')
  }
  if (u.protocol !== 'tucano:' || u.hostname !== 'pair') return bad('not a Tucano pairing link')
  if (u.username || u.password || u.port || (u.pathname !== '' && u.pathname !== '/') || u.hash) return bad('unexpected content in pairing link')
  const q = u.searchParams
  for (const k of new Set(q.keys())) if (q.getAll(k).length > 1) return bad(`"${k}" is given twice`)
  if (q.get('v') !== '1') return bad('a link from a version this app doesn’t know')

  const code = (q.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!CODE.test(code)) return bad('the pairing code is not valid')

  const ssh = q.get('ssh')
  const url = q.get('url')
  if ((ssh === null) === (url === null)) return bad('the link must say how to reach the server: ssh or url, one of them')
  let reach: Reach | undefined
  if (ssh !== null) reach = parseSshTarget(ssh)
  else if (url !== null) {
    const origin = parseServerUrl(url)
    reach = origin ? { via: 'url', url: origin } : undefined
  }
  if (!reach) return bad(ssh !== null ? 'the ssh address is not valid (user@host or user@host:port)' : 'the address is not valid (https, or http on localhost only)')

  const remotePort = port(q.get('port') ?? undefined, DEFAULT_PORT)
  if (remotePort === undefined) return bad('the port is not valid')
  const fallback = reach.via === 'ssh' ? reach.host : new URL(reach.url).hostname
  const name = (q.get('name') ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, 60) || fallback

  return { ok: true, link: { code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`, reach, remotePort, name } }
}

export function formatPairLink(link: PairLink): string {
  const q = new URLSearchParams({ v: '1', code: link.code })
  if (link.reach.via === 'ssh') {
    const { user, host, port: p } = link.reach
    q.set('ssh', `${user}@${host.includes(':') ? `[${host}]` : host}${p === 22 ? '' : `:${p}`}`)
    if (link.remotePort !== DEFAULT_PORT) q.set('port', String(link.remotePort))
  } else {
    q.set('url', link.reach.url)
  }
  q.set('name', link.name)
  return `tucano://pair?${q.toString()}`
}
