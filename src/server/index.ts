// Tucano as a server: the core on plain Node (a VPS, a home server), and the
// app's own screens in a browser. Where the desktop app's main process hosts the
// core and the window, this does: it stands in for Electron's parentPort, keeps
// the secrets with a key of its own, and serves the page plus a bridge to the
// core (events down an event stream, requests up by POST). Every request needs
// a token: the server's own, or the one a paired device was given (pairing.ts).
//
//   node out/main/server.js        (TUCANO_DATA, TUCANO_HOST, TUCANO_PORT, TUCANO_TOKEN)
//   node out/main/server.js pair | devices | revoke    who may sign in (cli.ts, docs/pairing.md)
//
// Behind a reverse proxy on this machine (Caddy, nginx, a tunnel), wrong tokens are counted by the address the
// proxy saw (X-Forwarded-For). TUCANO_ORIGINS (https://tucano.example.com, comma separated) names the page's
// origin if the proxy doesn't pass Host on, and TUCANO_COOKIE_SECURE=1 marks the cookie Secure if it doesn't
// send X-Forwarded-Proto.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cli } from './cli'
import { Forwarder, isPrivate } from './forward'
import { clearedCookie, clientKey, cookieValue, decodePart, parseJson, parseOrigins, sameOrigin, sessionCookie, Strikes } from './guard'
import { cookieName, Pairing, pairRequest, SESSION_MS } from './pairing'
import { vault } from './vault'

const dataDir = process.env['TUCANO_DATA'] || join(homedir(), '.tucano-server')
const host = process.env['TUCANO_HOST'] || '127.0.0.1'
const port = Number(process.env['TUCANO_PORT'] || 7337)
const page = join(import.meta.dirname, '..', 'renderer')
const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host
mkdirSync(dataDir, { recursive: true, mode: 0o700 })

// Who is paired. The commands run here, before anything starts, and leave.
const pairing = new Pairing(join(dataDir, 'pairing.json'))
const exit = cli(process.argv.slice(2), pairing, `http://${shown}:${port}`, console.log)
if (exit !== undefined) process.exit(exit)

// A file only this user reads, made once: the server's key or token.
function kept(name: string, make: () => string): string {
  const file = join(dataDir, name)
  if (!existsSync(file)) writeFileSync(file, make(), { mode: 0o600 })
  chmodSync(file, 0o600)
  return readFileSync(file, 'utf8').trim()
}
const token = process.env['TUCANO_TOKEN'] || kept('server-token', () => randomBytes(24).toString('base64url'))
// A cookie belongs to a host, not to a port: two servers reached through tunnels on 127.0.0.1 would take each
// other's. So each one's cookie is named after an id of its own.
const serverId = kept('server-id', () => randomBytes(6).toString('hex'))
const COOKIE = cookieName(serverId)
// The secrets (Telegram, GitHub, connector keys) are sealed with this key; on a
// desktop it's the system's keychain, which a server doesn't have.
const key = Buffer.from(kept('server.key', () => randomBytes(32).toString('base64')), 'base64')

const { seal, open } = vault(key)

// Electron's MessagePortMain and parentPort, as far as the core uses them.
class Port extends EventEmitter {
  constructor(readonly postMessage: (msg: unknown) => void) {
    super()
  }
  start(): void {}
  close(): void {
    this.emit('close')
  }
}

type CoreRequest = { type: string; id?: string; op?: string; data?: string }
const parent = new Port((msg) => fromCore(msg as CoreRequest))
const toCore = (data: unknown, ports: Port[] = []): boolean => parent.emit('message', { data, ports })

// What the main process does for the core on a desktop. A server has no screen:
// no notifications (Telegram carries them), nothing to open, no login item.
function fromCore(msg: CoreRequest): void {
  const id = msg.id
  if (msg.type === 'secret') {
    try {
      toCore({ type: 'secret-result', id, data: msg.op === 'encrypt' ? seal(msg.data ?? '') : open(msg.data ?? '') })
    } catch (e) {
      toCore({ type: 'secret-result', id, error: e instanceof Error ? e.message : String(e) })
    }
  } else if (msg.type === 'screenshot') {
    toCore({ type: 'screenshot-result', id, error: 'screenshots need the desktop app' })
  } else if (msg.type === 'browser') {
    // Only when there's no Chrome: the core drives Chrome or Chromium itself when one is installed.
    toCore({ type: 'browser-result', id, error: 'install Google Chrome or Chromium on the server for the agents’ browser' })
  }
}

// The page's connections: each one a port of the core, events down its stream.
const clients = new Map<string, Port>()

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
}

function file(res: ServerResponse, path: string, headers: Record<string, string> = {}): void {
  if (!existsSync(path) || !statSync(path).isFile()) return void res.writeHead(404).end('not found')
  res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', ...headers }).end(readFileSync(path))
}

// Compared by digest, so a token of another length or with other characters is only a wrong one.
const digest = (s: string): Buffer => createHash('sha256').update(s).digest()
const tokenDigest = digest(token)
const sameToken = (t: string | undefined): boolean => !!t && timingSafeEqual(digest(t), tokenDigest)

// The server's own token (a script's Authorization: Bearer, or the ?token= link) or a paired device's.
const allowed = (t: string | undefined): boolean => sameToken(t) || !!pairing.check(t)

// Wrong tokens and codes, counted by who sent them: 10 in 10 minutes, then a wait (guard.ts).
const strikes = new Strikes()
const origins = parseOrigins(process.env['TUCANO_ORIGINS'])
const cookieSecure = process.env['TUCANO_COOKIE_SECURE'] === '1'
const JSON_BODY = { 'content-type': 'application/json', 'cache-control': 'no-store' }

// The pages agents serve (a dashboard, an API) listen on the server's own
// loopback. On a private address (Tailscale, a home network) each running one
// is passed through on the same port at the server's address, so the preview
// panel can show it. Never on a public address: those pages have no token.
const privateHost = isPrivate(host)
const forwarder = new Forwarder(host)
const forwardServices = (ports: Set<number>): void => {
  if (privateHost) forwarder.set(new Set([...ports].filter((p) => p !== port)))
}
const servicePorts = new Map<string, number[]>() // by agent
const loopbackPort = (url?: string): number | undefined => (url ? Number(/^http:\/\/127\.0\.0\.1:(\d+)/.exec(url)?.[1]) || undefined : undefined)
type Computer = { agentId: string; services: { url?: string; running: boolean }[] }
function sawComputers(list: Computer[]): void {
  for (const c of list) servicePorts.set(c.agentId, c.services.filter((s) => s.running).flatMap((s) => loopbackPort(s.url) ?? []))
  forwardServices(new Set([...servicePorts.values()].flat()))
}
// The server's own connection to the core, to follow the services.
const watcher = new Port((msg) => {
  const m = msg as { id?: number; result?: { computers?: Computer[] }; event?: { type: string; computer?: Computer } }
  if (m.id === 1 && m.result?.computers) sawComputers(m.result.computers)
  else if (m.event?.type === 'computer' && m.event.computer) sawComputers([m.event.computer])
})

// The desktop page, told it's in a browser: the bridge script first, and its
// policy letting it frame the agents' pages from this server.
function index(): string {
  return readFileSync(join(page, 'index.html'), 'utf8')
    .replace('frame-src tucano:', `frame-src 'self' tucano:${privateHost ? ` http://${host}:*` : ''}`)
    .replace('<title>', '<meta name="viewport" content="width=device-width, initial-scale=1" />\n    <script src="./tucano-web.js"></script>\n    <title>')
}

function body(req: IncomingMessage, max = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) return reject(new Error('too large'))
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// A bug while handling one request answers that request and goes no further.
function fail(res: ServerResponse): void {
  if (!res.headersSent) res.writeHead(500)
  res.end()
}

function route(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const who = clientKey(req.socket.remoteAddress, req.headers['x-forwarded-for'])
  const wait = strikes.retryAfter(who)
  if (wait) {
    return void res
      .writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(wait) })
      .end('Tucano: too many wrong tokens, try again later.\nTucano: tokens errados demais, tente de novo mais tarde.')
  }

  // Public, read-only identity lets a paired desktop detect an address now serving a different
  // database before transmitting its device token. It contains no credentials or user data.
  if (url.pathname === '/identity' && req.method === 'GET') {
    return void res.writeHead(200, { ...JSON_BODY, 'cache-control': 'no-store' })
      .end(JSON.stringify({ server: serverId, protocol: 1 }))
  }

  const secure = cookieSecure || req.headers['x-forwarded-proto'] === 'https'

  // The app (or a script) trades a pairing code for its token by POST and keeps the token itself: it is sent
  // back in the body, with no cookie to pick out of a Set-Cookie header. A wrong code counts like a wrong token;
  // a body that isn't a request for one isn't a guess.
  if (url.pathname === '/pair' && req.method === 'POST') {
    if (!sameOrigin(req.headers.origin, req.headers.host, origins)) return void res.writeHead(403).end()
    body(req, 4096)
      .then(
        (text) => {
          const ask = pairRequest(text)
          if (!ask) return void res.writeHead(400).end()
          const issued = pairing.redeem(ask.code, ask.label)
          if (!issued) {
            strikes.fail(who)
            return void res.writeHead(401, JSON_BODY).end(JSON.stringify({ error: 'wrong or expired code' }))
          }
          strikes.clear(who)
          res
            .writeHead(200, JSON_BODY)
            .end(JSON.stringify({ server: serverId, token: issued.token, device: issued.device, days: SESSION_MS / 86_400_000 }))
        },
        () => res.writeHead(413).end()
      )
      .catch(() => fail(res))
    return
  }

  // A browser signs in with a pairing code (…/?pair=CODE, made by `pair` on this machine) or with the
  // server's own token (…/?token=…). Either is traded for a token of the browser's own, kept in a
  // cookie, good for 30 days from its last use and revocable: the server's own token never sits in
  // the cookie. Then the code or token is dropped from the address bar. Lax, not Strict: the link is
  // often clicked from elsewhere (a chat), and a Strict cookie wouldn't ride the redirect that follows.
  // Lax still keeps it off other sites' POSTs to /rpc.
  const code = url.searchParams.get('pair') ?? undefined
  const given = url.searchParams.get('token') ?? undefined
  const signedIn = (code !== undefined ? pairing.redeem(code) : undefined) ?? (sameToken(given) ? pairing.enroll('browser') : undefined)
  if (signedIn) {
    strikes.clear(who)
    return void res
      .writeHead(302, {
        // The shared name from before pairing is dropped too: that cookie held the server's own token.
        'set-cookie': [sessionCookie(COOKIE, signedIn.token, SESSION_MS / 1000, secure), clearedCookie('tucano', secure)],
        location: '/'
      })
      .end()
  }

  const cookie = cookieValue(req.headers.cookie, COOKIE)
  const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
  // Whichever proves who is asking, kept to prove it again on a stream that stays open.
  const proof = [cookie, bearer].find(allowed)
  if (proof === undefined) {
    // Opening the address with no token at all isn't a guess, and doesn't count.
    if (code !== undefined || given !== undefined || cookie !== undefined || bearer !== undefined) strikes.fail(who)
    // A cookie that opens nothing any more (revoked, expired) is taken back, so a page left open stops sending
    // it, and stops being counted against its owner with every request.
    const stale = cookie === undefined ? {} : { 'set-cookie': clearedCookie(COOKIE, secure) }
    return void res
      .writeHead(401, { 'content-type': 'text/plain; charset=utf-8', ...stale })
      .end('Tucano: open the link the server printed (…/?token=…), or pair with a code (…/?pair=CODE).\nTucano: abra o link que o servidor mostrou (…/?token=…) ou pareie com um código (…/?pair=CÓDIGO).')
  }

  if ((url.pathname === '/events' || url.pathname === '/rpc') && !sameOrigin(req.headers.origin, req.headers.host, origins)) {
    return void res.writeHead(403).end()
  }

  if (url.pathname === '/events') {
    const c = new Port((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`))
    const id = randomUUID()
    clients.set(id, c)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
    res.write(`event: hello\ndata: ${id}\n\n`)
    // On each beat, the device is checked again: one revoked since is cut off here.
    const beat = setInterval(() => (allowed(proof) ? res.write(': \n\n') : res.end()), 25_000)
    toCore(null, [c])
    req.on('close', () => {
      clearInterval(beat)
      clients.delete(id)
      c.close()
    })
    return
  }

  if (url.pathname === '/rpc' && req.method === 'POST') {
    const c = clients.get(url.searchParams.get('c') ?? '')
    if (!c) return void res.writeHead(410).end()
    body(req)
      .then(
        (text) => {
          const msg = parseJson(text)
          if (!msg) return void res.writeHead(400).end()
          c.emit('message', { data: msg.value })
          res.writeHead(204).end()
        },
        () => res.writeHead(413).end()
      )
      .catch(() => fail(res))
    return
  }

  // What the agents showed in the chat, sandboxed as on the desktop.
  const art = /^\/artifact\/([0-9a-f-]{36})\/([^/]+)$/.exec(url.pathname)
  if (art) {
    const dir = join(dataDir, 'artifacts', art[1]!)
    const name = decodePart(art[2]!)
    if (name === undefined) return void res.writeHead(400).end()
    const path = normalize(join(dir, name))
    if (!path.startsWith(dir + sep)) return void res.writeHead(404).end()
    return file(res, path, { 'content-security-policy': 'sandbox allow-scripts allow-popups' })
  }

  if (url.pathname === '/tucano-web.js') return void res.writeHead(200, { 'content-type': TYPES['.js']! }).end(WEB)
  if (url.pathname === '/' || url.pathname === '/index.html') return void res.writeHead(200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-cache' }).end(index())
  const rel = decodePart(url.pathname)
  if (rel === undefined) return void res.writeHead(400).end()
  const path = normalize(join(page, rel))
  if (!path.startsWith(page + sep)) return void res.writeHead(404).end()
  file(res, path)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  try {
    route(req, res, url)
  } catch {
    fail(res)
  }
})

// window.tucano for a browser: the core's port comes from the event stream and
// the requests go up by POST; what only the desktop does is left out quietly.
const WEB = `(() => {
  window.__TUCANO_WEB__ = true
  let client = null
  const connect = () => {
    const ch = new MessageChannel()
    const es = new EventSource('./events')
    let opened = false
    es.addEventListener('hello', (e) => {
      if (opened) return location.reload() // a new connection after a drop: start fresh
      opened = true
      client = e.data
      window.postMessage('core:port', '*', [ch.port1])
    })
    es.onmessage = (e) => ch.port2.postMessage(JSON.parse(e.data))
    ch.port2.onmessage = (m) => {
      fetch('./rpc?c=' + encodeURIComponent(client), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m.data) }).then((r) => {
        if (r.status === 410) location.reload()
      })
    }
  }
  window.tucano = {
    connect,
    pickFolder: async () => {
      const p = prompt('Pasta no servidor (caminho completo) / Folder on the server (full path):')
      return p && p.trim() ? p.trim() : null
    },
    onNavigate: () => {},
    viewing: () => {},
    updateState: async () => ({ version: '', status: 'off' }),
    onUpdate: () => {},
    checkUpdates: () => {},
    installUpdate: () => {}
  }
})()
`

process.env['TUCANO_DATA'] = dataDir
process.env['TUCANO_PACKAGED'] = '1'
process.env['TUCANO_SERVER'] = '1'
;(process as unknown as { parentPort: Port }).parentPort = parent
await import(pathToFileURL(join(import.meta.dirname, 'core.js')).href)
toCore(null, [watcher])
watcher.emit('message', { data: { id: 1, method: 'snapshot' } })

server.listen(port, host, () => {
  console.log(`Tucano server: http://${shown}:${port}/`)
  console.log(`Data: ${dataDir}`)
  // The server's own token is not printed: a log (journalctl, a file a service writes) is read by more people
  // than the one who owns the server, and the token opens everything for good. A device pairs with a code that
  // works once and dies in minutes; with nobody paired yet, the first is made here.
  let first: string | undefined
  if (!pairing.list().length) {
    try {
      first = pairing.invite('first device').code
    } catch {
      // The file is busy: `pair` below still works.
    }
  }
  if (first) console.log(`Nobody is paired yet. This browser can sign in once, in the next 5 minutes: http://${shown}:${port}/?pair=${first}`)
  console.log('To pair a browser or the Mac app with a one-time code: node out/main/server.js pair --label "My Mac" [--ssh you@host] (docs/pairing.md)')
  if (!process.env['TUCANO_TOKEN']) console.log(`The server's own token, for scripts (Authorization: Bearer …), is in ${join(dataDir, 'server-token')}`)
  if (host === '127.0.0.1') console.log('Listening on this machine only: reach it through an SSH tunnel, Tailscale or a reverse proxy with HTTPS (docs/server.md).')
})
