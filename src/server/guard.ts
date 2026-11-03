// What the server checks before it trusts a request. Pure functions, so tests can reach them: index.ts
// starts a server the moment it's imported.

// A client picks what JSON.parse and decodeURIComponent are given, and both throw on bad input. A throw in
// the request handler would stop the whole server, so a bad request comes back as nothing here, and as a
// 400 there.
export function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

export function decodePart(part: string): string | undefined {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

// The origins a page may come from besides the server's own address (TUCANO_ORIGINS, comma separated, e.g.
// https://tucano.example.com). For a proxy that doesn't pass Host on; what isn't a URL is left out.
export function parseOrigins(list: string | undefined): string[] {
  return (list ?? '').split(',').flatMap((item) => {
    try {
      return item.trim() ? [new URL(item.trim()).origin] : []
    } catch {
      return []
    }
  })
}

// A browser says which page a request comes from. The cookie is SameSite=Lax, which already keeps it off other
// sites' POSTs; this refuses them outright, and other sites' reads of the event stream. No Origin means it
// isn't a browser (curl, a script): the token still decides.
export function sameOrigin(origin: string | undefined, host: string | undefined, allowed: readonly string[] = []): boolean {
  if (origin === undefined) return true
  let from: URL
  try {
    from = new URL(origin)
  } catch {
    return false // also 'null': a sandboxed page
  }
  return (!!host && from.host === host.toLowerCase()) || allowed.includes(from.origin)
}

const loopback = (address: string): boolean => /^127\./.test(address) || address === '::1' || address.startsWith('::ffff:127.')

// Who is asking, to count wrong tokens. Behind a reverse proxy on this machine (Caddy, nginx, a tunnel) every
// request comes from the proxy's own address, so there the address the proxy wrote at the end of
// X-Forwarded-For is the one to use (earlier entries are whatever the client claimed). From any other address
// the header is just something the client wrote, and is ignored.
export function clientKey(remote: string | undefined, forwarded: string | string[] | undefined): string {
  if (remote && loopback(remote)) {
    const header = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')
    const last = header.split(',').at(-1)?.trim()
    if (last) return last
  }
  return remote ?? 'unknown'
}

const MAX_KEYS = 10_000

// Wrong tokens by who sent them: past the limit within the window, a key waits until its oldest strike
// ages out. A bound on the keys, so a flood of addresses can't grow it forever.
export class Strikes {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now
  ) {}

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs
    const list = (this.hits.get(key) ?? []).filter((t) => t > since)
    if (list.length) this.hits.set(key, list)
    else this.hits.delete(key)
    return list
  }

  // Seconds until the key may try again; 0 when it may now.
  retryAfter(key: string): number {
    const list = this.recent(key)
    if (list.length < this.limit) return 0
    return Math.max(1, Math.ceil((list[list.length - this.limit]! + this.windowMs - this.now()) / 1000))
  }

  fail(key: string): void {
    const list = this.recent(key)
    list.push(this.now())
    this.hits.set(key, list)
    if (this.hits.size > MAX_KEYS) {
      const oldest = this.hits.keys().next()
      if (!oldest.done) this.hits.delete(oldest.value)
    }
  }

  clear(key: string): void {
    this.hits.delete(key)
  }
}

// The cookie that signs a browser in. HttpOnly, and Lax: not Strict, because the link that signs in is often
// clicked from elsewhere (a chat) and a Strict cookie wouldn't ride the redirect that follows.
export const sessionCookie = (name: string, value: string, maxAgeSeconds: number, secure: boolean): string =>
  `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`

// The same cookie with nothing in it and no time left: the browser drops it. Sent with the 401 for a cookie that
// opens nothing any more, so a page left open stops sending it, and stops being counted as a wrong guess.
export const clearedCookie = (name: string, secure: boolean): string => sessionCookie(name, '', 0, secure)

// One cookie by name out of the Cookie header; an empty one is none.
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || undefined
  }
  return undefined
}
