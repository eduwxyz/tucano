// The pages agents serve (a site, a dashboard, an API on 127.0.0.1:5173 inside the server), opened
// from anywhere at an address of their own: https://5173-ana.example.com for https://ana.example.com.
//
// That address is another origin on purpose. The page there is code an agent wrote: it never sees
// Tucano's cookie, and the address answers nothing of Tucano's own (no page, no /rpc). It has a
// sign-in of its own: the app's page (signed in) sends the browser to it with a grant good for a few
// minutes, which becomes a cookie only that address knows. Only the ports the agents' computers say
// they serve are passed through, never Tucano's own.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'

const GRANT_MS = 5 * 60_000
const COOKIE = 'tucano_preview'
const ENTER = '/__tucano/enter'

const safeEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// The person's cookies for this server (Tucano's and the preview's) stay out of what the agent's page gets.
export function withoutOurCookies(cookie: string | undefined): string | undefined {
  const kept = (cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !/^(tucano|tucano_preview)=/.test(c))
  return kept.length ? kept.join('; ') : undefined
}

// What the agent's page gets of a request: the host it expects (a dev server refuses others) and the
// person's cookies, without ours. A request that only had ours has none left, and no header for it.
function forwarded(req: IncomingMessage, port: number, extra: Record<string, string> = {}): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== 'cookie') out[k] = v
  const cookie = withoutOurCookies(req.headers.cookie)
  if (cookie) out['cookie'] = cookie
  return { ...out, host: `127.0.0.1:${port}`, ...extra }
}

export class Preview {
  constructor(
    private key: Buffer,
    private publicHost: string, // ana.example.com
    private allowed: (port: number) => boolean,
    private now: () => number = Date.now
  ) {}

  private sign(text: string): string {
    return createHmac('sha256', this.key).update(text).digest('base64url')
  }

  // The port a preview address stands for, or undefined when the address is Tucano's own (or another's).
  portOf(host: string | undefined): number | undefined {
    const m = /^(\d{2,5})-(.+)$/.exec((host ?? '').toLowerCase())
    if (!m || m[2] !== this.publicHost.toLowerCase()) return undefined
    const port = Number(m[1])
    return port > 0 && port < 65536 ? port : undefined
  }

  // From the app's page: where its browser goes to open a page on that port.
  grantUrl(port: number, path: string): string {
    const exp = this.now() + GRANT_MS
    const to = path.startsWith('/') && !path.startsWith('//') ? path : '/'
    return `https://${port}-${this.publicHost}${ENTER}?e=${exp}&g=${this.sign(`${port}.${exp}`)}&to=${encodeURIComponent(to)}`
  }

  private cookieValue(port: number): string {
    return this.sign(`cookie.${port}-${this.publicHost}`)
  }

  signedIn(req: IncomingMessage, port: number): boolean {
    const got = /(?:^|;\s*)tucano_preview=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    return !!got && safeEqual(got, this.cookieValue(port))
  }

  // Everything asked at a preview address comes here, and nothing else of the server answers it.
  handle(req: IncomingMessage, res: ServerResponse, port: number): void {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === ENTER) {
      const exp = Number(url.searchParams.get('e'))
      const ok = exp > this.now() && exp - this.now() <= GRANT_MS && safeEqual(url.searchParams.get('g') ?? '', this.sign(`${port}.${exp}`))
      if (!ok) return void page(res, 403, 'Esse link de prévia venceu. Abra a página de novo pelo Tucano. · This preview link expired. Open the page again from Tucano.')
      const to = url.searchParams.get('to') ?? '/'
      return void res
        .writeHead(302, {
          'set-cookie': `${COOKIE}=${this.cookieValue(port)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`,
          location: to.startsWith('/') && !to.startsWith('//') ? to : '/',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer'
        })
        .end()
    }
    if (!this.signedIn(req, port)) return void page(res, 401, 'Abra esta página pelo Tucano: é dele que sai o acesso. · Open this page from Tucano: that’s where access comes from.')
    if (!this.allowed(port)) return void page(res, 404, 'Nenhum agente está servindo uma página nessa porta agora. · No agent is serving a page on that port right now.')
    const up = request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers: forwarded(req, port, { 'x-forwarded-host': req.headers.host ?? '', 'x-forwarded-proto': 'https' }) },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      }
    )
    up.on('error', () => (res.headersSent ? res.destroy() : page(res, 502, 'A página do agente não respondeu. Ela pode ter parado. · The agent’s page didn’t answer. It may have stopped.')))
    req.pipe(up)
  }

  // A WebSocket (a dev server reloading itself as the code changes): the same checks, then the bytes both ways.
  upgrade(req: IncomingMessage, socket: Socket, head: Buffer, port: number): void {
    if (!this.signedIn(req, port) || !this.allowed(port)) return void socket.destroy()
    const up = connect(port, '127.0.0.1', () => {
      const lines = Object.entries(forwarded(req, port)).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`))
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) up.write(head)
      socket.pipe(up).pipe(socket)
    })
    const end = (): void => {
      up.destroy()
      socket.destroy()
    }
    up.on('error', end)
    socket.on('error', end)
  }
}

function page(res: ServerResponse, status: number, text: string): void {
  res
    .writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' })
    .end(`<!doctype html><meta charset="utf-8"><title>Tucano</title><style>body{font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f6f3ee;color:#1d1a16}@media(prefers-color-scheme:dark){body{background:#1a1917;color:#f1ece4}}p{max-width:460px;padding:24px;line-height:1.5;opacity:.85}</style><p>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p>`)
}
