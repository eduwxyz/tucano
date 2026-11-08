// A Tucano on a server, opened from this app: the link that pairs it, and what belongs to it.
//
//   tucano://connect?url=https://ana.example.com&token=…   (`server.js link` prints it)
//   tucano://connect?url=https://ana.example.com&code=…    (a one-time code: `server.js pair`, for a phone, a browser or this app)

// origin: https://ana.example.com, nothing after it. A token (the server's own, `server.js link`)
// signs in as it; a code (`server.js pair`, Settings › Pessoas › Conectar um celular) is traded,
// once, for a key of this device's own (redeemCode, src/main/redeem.ts).
import { L } from './lang'

export type Pairing = { origin: string } & ({ token: string } | { code: string })

const CODE = /^[A-Za-z0-9_-]{16,64}$/ // src/server/pair-codes.ts CODE_SHAPE

// A link from anywhere (a chat, a web page) can ask the system to open this one, so it's read
// strictly: only https, or http on this machine's loopback (a server under test), and a token
// or a code of the shape the server makes. Anything else is not a pairing.
export function parsePairing(link: string): Pairing | null {
  let u: URL
  try {
    u = new URL(link.trim())
  } catch {
    return null
  }
  // The browser's line of `server.js pair` (https://ana.example.com/?code=…) pairs too: the same
  // code, so the welcome email's one link opens in a browser or here.
  if (u.protocol === 'https:' && u.pathname === '/' && u.searchParams.has('code') && !u.username && !u.password) {
    const code = u.searchParams.get('code') ?? ''
    return CODE.test(code) ? { origin: u.origin, code } : null
  }
  if (u.protocol !== 'tucano:' || u.hostname !== 'connect') return null
  const token = u.searchParams.get('token')
  const code = u.searchParams.get('code')
  if (token !== null ? !/^[A-Za-z0-9_-]{16,256}$/.test(token) : code === null || !CODE.test(code)) return null
  let server: URL
  try {
    server = new URL(u.searchParams.get('url') ?? '')
  } catch {
    return null
  }
  const loopback = server.hostname === '127.0.0.1' || server.hostname === 'localhost'
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && loopback)) return null
  if (server.username || server.password) return null
  return token !== null ? { origin: server.origin, token } : { origin: server.origin, code: code! }
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

// Why a pairing didn't happen, in the person's words: the app's window and the system's dialog say the same.
export function pairProblem(r: 'invalid' | 'used' | 'unreachable'): { title: string; detail: string } {
  if (r === 'used')
    return {
      title: L('Esse link já foi usado', 'That link was already used'),
      detail: L('Cada link de conexão vale uma vez, por um tempo. Gere outro no navegador, em Configurações › Pessoas › Conectar um celular, ou peça um novo a quem cuida do servidor.', 'Each connection link works once, for a while. Make another in the browser, in Settings › People › Connect a phone, or ask whoever runs the server for a new one.')
    }
  if (r === 'unreachable')
    return {
      title: L('O servidor não respondeu', "The server didn't answer"),
      detail: L('Confira a internet e o endereço, e tente de novo. O link não foi gasto.', 'Check the internet and the address, and try again. The link was not spent.')
    }
  return {
    title: L('Esse não é um link de conexão do Tucano', "That's not a Tucano connection link"),
    detail: L('O link de conexão começa com tucano://connect (ou é o link do navegador com ?code=) e sai do servidor.', 'A connection link starts with tucano://connect (or is the browser link with ?code=) and comes from the server.')
  }
}
