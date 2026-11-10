// Fetching a link someone typed, from the Tucano's own machine. On a server that machine's network
// isn't the person's: loopback, the LAN, the cloud's metadata (169.254.169.254) must stay out of
// reach. So each hop's name is resolved once, every address it gives is checked, and the connection
// goes to that checked address (a second lookup could answer differently: DNS rebinding);
// redirects are followed by hand, each one checked the same way.
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { isIP } from 'node:net'
import { L } from '../shared/lang'
import { InsideNetworkError } from '../shared/errors'

export const MAX_REDIRECTS = 5
const MAX_BODY = 21 * 1024 * 1024 // a little past the wiki's 20 MB, so it can say the page is too big

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>

// An IPv4 address as a number, or undefined.
function v4(ip: string): number | undefined {
  const p = ip.split('.')
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return undefined
  return p.reduce((n, x) => n * 256 + Number(x), 0)
}

// An IPv6 address as its eight 16-bit groups (a trailing dotted IPv4 included), or undefined.
function v6(ip: string): number[] | undefined {
  let s = ip
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
    .toLowerCase()
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    const n = v4(dotted[1]!)
    if (n === undefined) return undefined
    s = s.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const part = (h: string): number[] => (h ? h.split(':').map((g) => parseInt(g, 16)) : [])
  const head = part(halves[0]!)
  const tail = halves.length === 2 ? part(halves[1]!) : []
  const fill = 8 - head.length - tail.length
  if ((halves.length === 2 ? fill < 0 : fill !== 0) || [...head, ...tail].some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined
  return [...head, ...Array(Math.max(0, fill)).fill(0), ...tail]
}

const inV4 = (n: number, base: string, bits: number): boolean => {
  const b = v4(base)!
  const size = 2 ** (32 - bits)
  return Math.floor(n / size) === Math.floor(b / size)
}

const V4_INSIDE: [string, number][] = [
  ['0.0.0.0', 8], // "this network", 0.0.0.0 reaches loopback
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT (and Tailscale)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, the cloud's metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, broadcast
]

// Whether an address is of the inside (this machine, its networks, the cloud's metadata).
// Anything that isn't a plain IP is refused too.
export function blockedAddress(ip: string): boolean {
  const n4 = v4(ip)
  if (n4 !== undefined) return V4_INSIDE.some(([b, bits]) => inV4(n4, b, bits))
  const g = v6(ip)
  if (!g) return true
  const embedded = (hi: number, lo: number): boolean => blockedAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  if (g.slice(0, 6).every((x) => x === 0)) return true // ::, ::1, and the old IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!) // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!) // NAT64
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!) // 6to4
  if ((g[0]! & 0xffc0) === 0xfe80) return true // link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true // unique local (fd00::/8, the cloud's fd00:ec2::254)
  if ((g[0]! & 0xff00) === 0xff00) return true // multicast
  return false
}

const insideError = (): Error =>
  new InsideNetworkError(L('Esse link aponta pra rede interna do servidor; não dá pra ler daqui.', "That link points into the server's internal network; it can't be read from here."))

// A fetch (the parts the wiki uses) that refuses the inside. `resolve` and `blocked` are for tests.
export function safeFetch(opts: { resolve?: Resolve; blocked?: (ip: string) => boolean } = {}): (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response> {
  const resolve: Resolve = opts.resolve ?? ((host) => lookup(host, { all: true, verbatim: true }))
  const blocked = opts.blocked ?? blockedAddress
  return async (url, init = {}) => {
    let at = new URL(url)
    for (let hop = 0; ; hop++) {
      if (at.protocol !== 'http:' && at.protocol !== 'https:') throw new Error(L('O link precisa começar com http:// ou https://.', 'The link must start with http:// or https://.'))
      const host = at.hostname.replace(/^\[|\]$/g, '')
      const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host)
      if (!addrs.length || addrs.some((a) => blocked(a.address))) throw insideError()
      const res = await once(at, addrs[0]!, init)
      const location = res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? res.headers.location : undefined
      if (!location) return toResponse(res, at.href, init.signal)
      res.resume()
      if (hop >= MAX_REDIRECTS) throw new Error(L('A página tem redirecionamentos demais.', 'The page redirects too many times.'))
      at = new URL(location, at)
    }
  }
}

// One request, to the address already checked (the name stays the Host and the TLS name).
function once(at: URL, addr: { address: string; family: number }, init: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<IncomingMessage> {
  const request = at.protocol === 'https:' ? httpsRequest : httpRequest
  const host = at.hostname.replace(/^\[|\]$/g, '')
  return new Promise((ok, fail) => {
    const options: RequestOptions = {
      protocol: at.protocol,
      hostname: host,
      ...(at.port ? { port: Number(at.port) } : {}),
      path: `${at.pathname}${at.search}`,
      method: 'GET',
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(isIP(host) ? {} : { servername: host }),
      // Straight to the checked address, never through a proxy (src/core/network.ts): a proxy would look the
      // name up again on its own, and could reach the inside this guard keeps out.
      agent: false,
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [addr]) : cb(null, addr.address, addr.family))) as unknown as RequestOptions['lookup']
    }
    const req = request(options, ok)
    req.on('error', fail)
    req.end()
  })
}

async function toResponse(res: IncomingMessage, url: string, signal?: AbortSignal): Promise<Response> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of res) {
    signal?.throwIfAborted()
    size += (c as Buffer).length
    chunks.push(c as Buffer)
    if (size > MAX_BODY) {
      res.destroy()
      break
    }
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  const status = res.statusCode ?? 500
  const out = new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })
  Object.defineProperty(out, 'url', { value: url })
  return out
}
