// A computer lent to a server's Tucano (docs/local-node.md): the desktop app calls the server, never the
// other way around, so it works from behind any home or office router, with no port open on the computer
// and no network of its own (no Tailscale). It signs in with the key it got when it was paired with the
// server (Settings › Servers), the same one its window there uses.
//
// The way: a stream (GET NODE_LINK_PATH, server-sent events, like the pages' /events) brings the server's
// MCP messages to the computer; the computer posts its answers back (POST NODE_LINK_PATH?id=<link>). On the
// server, the computer is a connector of its person's own, at a `tucano-node://` address.

export const NODE_LINK_PATH = '/node/link'
// Sent on every request of a link: a page of another site can't add a header without asking the server
// first (CORS), so a link never starts from a browser that happens to hold the cookie.
export const NODE_LINK_HEADER = 'x-tucano-node'
// The largest message the computer may post (a file read, a screenshot as text).
export const NODE_LINK_MAX_BYTES = 8 * 1024 * 1024

const SCHEME = 'tucano-node:'

// The connector's address on the server: the computer (its device id) and whose it is (unset: the Tucano's owner).
export const nodeUrl = (device: string, owner?: string): string => `tucano-node://${encodeURIComponent(device)}${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`

export function nodeOf(url: string | undefined): { device: string; owner?: string } | undefined {
  if (!url?.startsWith(SCHEME)) return undefined
  try {
    const u = new URL(url)
    const device = decodeURIComponent(u.hostname || u.pathname.replace(/^\/+/, ''))
    if (!device) return undefined
    const owner = u.searchParams.get('owner') ?? undefined
    return { device, ...(owner ? { owner } : {}) }
  } catch {
    return undefined
  }
}

// A device id or a computer's name as the server keeps them: plain, short.
export const cleanDevice = (s: unknown): string => (typeof s === 'string' ? s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '')
export const cleanMachine = (s: unknown): string => (typeof s === 'string' ? s.replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '')

// How a link to one server is doing, for the computer's screen.
export type UplinkState = 'connecting' | 'connected' | 'refused' | 'outdated' | 'error'
export interface UplinkStatus {
  serverId: string
  origin: string
  state: UplinkState
  error?: string // in people's words
  since?: number // connected since
}
