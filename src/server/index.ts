// Tucano as a server: the core on plain Node (a VPS, a home server), and the
// app's own screens in a browser. Where the desktop app's main process hosts the
// core and the window, this does: it stands in for Electron's parentPort, keeps
// the secrets with a key of its own, and serves the page plus a bridge to the
// core (events down an event stream, requests up by POST). Every request needs
// the server's token.
//
//   node out/main/server.js        (TUCANO_DATA, TUCANO_HOST, TUCANO_PORT, TUCANO_TOKEN)
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vault } from './vault'

const dataDir = process.env['TUCANO_DATA'] || join(homedir(), '.tucano-server')
const host = process.env['TUCANO_HOST'] || '127.0.0.1'
const port = Number(process.env['TUCANO_PORT'] || 7337)
const page = join(import.meta.dirname, '..', 'renderer')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })

// A file only this user reads, made once: the server's key or token.
function kept(name: string, make: () => string): string {
  const file = join(dataDir, name)
  if (!existsSync(file)) writeFileSync(file, make(), { mode: 0o600 })
  chmodSync(file, 0o600)
  return readFileSync(file, 'utf8').trim()
}
const token = process.env['TUCANO_TOKEN'] || kept('server-token', () => randomBytes(24).toString('base64url'))
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
  if (!existsSync(path)) return void res.writeHead(404).end('not found')
  res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', ...headers }).end(readFileSync(path))
}

const sameToken = (t: string | undefined): boolean => !!t && t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token))
const cookieToken = (req: IncomingMessage): string | undefined => /(?:^|;\s*)tucano=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]

// The desktop page, told it's in a browser: the bridge script first, and its
// policy letting it frame the agents' pages from this server.
function index(): string {
  return readFileSync(join(page, 'index.html'), 'utf8')
    .replace('frame-src tucano:', "frame-src 'self' tucano:")
    .replace('<title>', '<meta name="viewport" content="width=device-width, initial-scale=1" />\n    <script src="./tucano-web.js"></script>\n    <title>')
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 64 * 1024 * 1024) return reject(new Error('too large'))
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  // The link with ?token= signs this browser in, then drops it from the address bar.
  if (sameToken(url.searchParams.get('token') ?? undefined)) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    return void res.writeHead(302, { 'set-cookie': `tucano=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`, location: '/' }).end()
  }
  if (!sameToken(cookieToken(req))) {
    return void res
      .writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      .end('Tucano: open the link with the token the server printed (…/?token=…).\nTucano: abra o link com o token que o servidor mostrou (…/?token=…).')
  }

  if (url.pathname === '/events') {
    const c = new Port((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`))
    const id = randomUUID()
    clients.set(id, c)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
    res.write(`event: hello\ndata: ${id}\n\n`)
    const beat = setInterval(() => res.write(': \n\n'), 25_000)
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
    body(req).then(
      (text) => {
        c.emit('message', { data: JSON.parse(text) })
        res.writeHead(204).end()
      },
      () => res.writeHead(413).end()
    )
    return
  }

  // What the agents showed in the chat, sandboxed as on the desktop.
  const art = /^\/artifact\/([0-9a-f-]{36})\/([^/]+)$/.exec(url.pathname)
  if (art) {
    const dir = join(dataDir, 'artifacts', art[1]!)
    const path = normalize(join(dir, decodeURIComponent(art[2]!)))
    if (!path.startsWith(dir + sep)) return void res.writeHead(404).end()
    return file(res, path, { 'content-security-policy': 'sandbox allow-scripts allow-popups' })
  }

  if (url.pathname === '/tucano-web.js') return void res.writeHead(200, { 'content-type': TYPES['.js']! }).end(WEB)
  if (url.pathname === '/' || url.pathname === '/index.html') return void res.writeHead(200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-cache' }).end(index())
  const path = normalize(join(page, decodeURIComponent(url.pathname)))
  if (!path.startsWith(page + sep)) return void res.writeHead(404).end()
  file(res, path)
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
;(process as unknown as { parentPort: Port }).parentPort = parent
await import(pathToFileURL(join(import.meta.dirname, 'core.js')).href)

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host
  console.log(`Tucano server: http://${shown}:${port}/?token=${token}`)
  console.log(`Data: ${dataDir}`)
  if (host === '127.0.0.1') console.log('Listening on this machine only: reach it through an SSH tunnel, Tailscale or a reverse proxy with HTTPS (docs/server.md).')
})
