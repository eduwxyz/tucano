// A Tucano on a server, opened from this app: the link that pairs it, and what belongs to it.
//
//   tucano://connect?url=https://ana.example.com&token=…   (`server.js link` prints it)
//   tucano://connect?url=https://ana.example.com&code=…    (a one-time code: `server.js pair`, for the phone)

export interface Pairing {
  origin: string // https://ana.example.com, nothing after it
  token: string
}

// A link from anywhere (a chat, a web page) can ask the system to open this one, so it's read
// strictly: only https, or http on this machine's loopback (a server under test), and a token
// of the shape the server makes. Anything else is not a pairing.
export function parsePairing(link: string): Pairing | null {
  let u: URL
  try {
    u = new URL(link.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'tucano:' || u.hostname !== 'connect') return null
  const token = u.searchParams.get('token') ?? ''
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) return null
  let server: URL
  try {
    server = new URL(u.searchParams.get('url') ?? '')
  } catch {
    return null
  }
  const loopback = server.hostname === '127.0.0.1' || server.hostname === 'localhost'
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && loopback)) return null
  if (server.username || server.password) return null
  return { origin: server.origin, token }
}

// The link that pairs it: with the server's token (`server.js link`), or with a one-time code
// (`server.js pair`, Settings › Pessoas › Conectar um celular) that the phone trades for a key of its own.
// A computer at home (src/main/home-link.ts) adds its certificate's fingerprint (`fp`): the phone
// talks to that certificate and no other.
export const pairingLink = (p: { origin: string; fp?: string } & ({ token: string } | { code: string })): string =>
  `tucano://connect?url=${encodeURIComponent(p.origin)}&${'code' in p ? `code=${encodeURIComponent(p.code)}` : `token=${encodeURIComponent(p.token)}`}${p.fp ? `&fp=${encodeURIComponent(p.fp)}` : ''}`

// Where a server's window may go: its own pages, and nothing else.
export function onServer(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

// One of a server's preview addresses (src/server/preview.ts): https://5173-ana.example.com for https://ana.example.com.
export function isPreviewOf(url: string, origin: string): boolean {
  try {
    const u = new URL(url)
    const host = new URL(origin).host
    return u.protocol === 'https:' && new RegExp(`^\\d{2,5}-${host.replace(/[.]/g, '\\.')}$`, 'i').test(u.host)
  } catch {
    return false
  }
}

// What the person sees for a server: its address, without the scheme.
export const serverName = (origin: string): string => origin.replace(/^https?:\/\//, '')
