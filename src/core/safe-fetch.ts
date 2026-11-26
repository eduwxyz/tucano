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
import { blockedAddress } from '../shared/net'

export { blockedAddress } from '../shared/net'
export const MAX_REDIRECTS = 5
const MAX_BODY = 21 * 1024 * 1024 // a little past the wiki's 20 MB, so it can say the page is too big

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>

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
