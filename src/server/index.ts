// Tucano as a server: the core on plain Node (a VPS, a home server), and the
// app's own screens in a browser. Where the desktop app's main process hosts the
// core and the window, this does: it stands in for Electron's parentPort, keeps
// the secrets with a key of its own, and serves the page plus a bridge to the
// core (events down an event stream, requests up by POST). Every request needs
// the server's token.
//
//   node out/main/server.js        (TUCANO_DATA, TUCANO_HOST, TUCANO_PORT, TUCANO_TOKEN, TUCANO_URL, TUCANO_TRUST_PROXY)
//   node out/main/server.js link   prints the link that signs a browser in
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Forwarder, isPrivate } from './forward'
import { ARTIFACT_CSP, BASE_HEADERS, clientIp, decodedPath, Limiter, PAGE_HEADERS, sameOrigin } from './guard'
import { Preview } from './preview'
import { vault } from './vault'
import { verifyLocalUrl } from '../core/local-paths'
import { INSECURE_CONTEXT_SHIM } from './web-shim'

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
// The address people open: TUCANO_URL behind a proxy (https://ana.example.com), else where it listens.
const publicUrl = (process.env['TUCANO_URL'] || `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${port}`).replace(/\/+$/, '')

// `server.js link`: the one place the token is printed. The log never has it, since logs
// get kept, shipped and pasted into issues.
if (process.argv[2] === 'link') {
  console.log(`${publicUrl}/?token=${token}`)
  process.exit(0)
}
// The secrets (Telegram, GitHub, connector keys) are sealed with this key; on a
// desktop it's the system's keychain, which a server doesn't have.
const key = Buffer.from(kept('server.key', () => randomBytes(32).toString('base64')), 'base64')

const { seal, open } = vault(key)
// The core signs the files it has checked a message may show (local-paths.ts); /local/ serves only those.
// A new key each start: an old address stops working with the process that made it.
const localKey = randomBytes(32).toString('base64url')

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

type CoreRequest = { type: string; id?: string; op?: string; data?: string; title?: string; body?: string; conversationId?: string; page?: string }
const parent = new Port((msg) => fromCore(msg as CoreRequest))
const toCore = (data: unknown, ports: Port[] = []): boolean => parent.emit('message', { data, ports })

// What the main process does for the core on a desktop. A server has no screen: nothing to
// open, no login item. Its notifications go to the pages open on it (a browser, the desktop app's
// server window), which show them while the person is looking elsewhere; Telegram carries them too.
const oauthWaits = new Map<string, (r: { ok: boolean; why?: string }) => void>()

function fromCore(msg: CoreRequest): void {
  const id = msg.id
  if (msg.type === 'oauth-result') {
    oauthWaits.get(id ?? '')?.((msg as unknown as { data: { ok: boolean; why?: string } }).data)
    oauthWaits.delete(id ?? '')
    return
  }
  if (msg.type === 'notify') {
    const note = { notify: { title: String(msg.title ?? ''), body: String(msg.body ?? ''), conversationId: msg.conversationId, page: msg.page } }
    for (const c of clients.values()) c.postMessage(note)
    return
  }
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
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
}

function file(res: ServerResponse, path: string, headers: Record<string, string> = {}): void {
  if (!existsSync(path)) return void res.writeHead(404, BASE_HEADERS).end('not found')
  res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', ...BASE_HEADERS, ...headers }).end(readFileSync(path))
}

const sameToken = (t: string | undefined): boolean => !!t && t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token))
const cookieToken = (req: IncomingMessage): string | undefined => /(?:^|;\s*)tucano=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]

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
// Behind https (TUCANO_URL), each page an agent serves gets an address of its own, <port>-<this
// address> (preview.ts): only the ports the agents' computers say they serve, never this server's.
const publicHost = publicUrl.startsWith('https://') ? new URL(publicUrl).host : ''
const preview = publicHost
  ? new Preview(Buffer.from(kept('preview.key', () => randomBytes(32).toString('base64')), 'base64'), publicHost, (p) => p !== port && [...servicePorts.values()].some((l) => l.includes(p)))
  : undefined

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
    .replace('frame-src tucano:', `frame-src 'self' tucano:${privateHost ? ` http://${host}:*` : ''}${publicHost ? ` https://*.${publicHost.split('.').slice(1).join('.')}` : ''}`)
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

function oauthCallback(url: URL, res: ServerResponse): void {
  const id = randomUUID()
  const answer = (r: { ok: boolean; why?: string }): void => {
    const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    const [title, line] = r.ok ? ['Pronto · Done', 'O conector está autorizado. Pode fechar esta aba e voltar ao Tucano. · The connector is authorized. You can close this tab and go back to Tucano.'] : ['Não deu · It didn’t work', r.why ?? '']
    res
      .writeHead(r.ok ? 200 : 400, { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" })
      .end(`<!doctype html><meta charset="utf-8"><title>Tucano</title><style>body{font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f6f3ee;color:#1d1a16}@media(prefers-color-scheme:dark){body{background:#1a1917;color:#f1ece4}}main{max-width:460px;padding:24px}p{opacity:.8;line-height:1.5}</style><main><h2>${esc(title)}</h2><p>${esc(line)}</p></main>`)
  }
  const timer = setTimeout(() => oauthWaits.get(id) && (oauthWaits.delete(id), answer({ ok: false, why: 'O Tucano não respondeu. Tente de novo pelo app. · Tucano didn’t answer. Try again from the app.' })), 30_000)
  oauthWaits.set(id, (r) => (clearTimeout(timer), answer(r)))
  toCore({ type: 'oauth-callback', id, data: { state: url.searchParams.get('state') ?? '', code: url.searchParams.get('code') ?? '', error: url.searchParams.get('error') ?? '' } })
}

const trustProxy = process.env['TUCANO_TRUST_PROXY'] === '1'
const MAX_UPLOAD = 1024 * 1024 * 1024 // a vault with its pictures, zipped
const guesses = new Limiter()

// A request it can't read (a scanner's, a broken client's) gets an answer, never the whole server.
const server = createServer((req, res) => {
  try {
    handle(req, res)
  } catch (e) {
    console.error('[server]', req.method, e instanceof Error ? e.message : e)
    if (!res.headersSent) res.writeHead(400, BASE_HEADERS).end()
  }
})

function handle(req: IncomingMessage, res: ServerResponse): void {
  // A preview address answers only its agent's page: nothing below (the app, /rpc, files) is reachable there.
  const previewPort = preview?.portOf(req.headers.host)
  if (previewPort) return preview!.handle(req, res, previewPort)
  const url = new URL(req.url ?? '/', 'http://x')
  const ip = clientIp(req, trustProxy)
  if (guesses.blocked(ip)) return void res.writeHead(429, { ...BASE_HEADERS, 'retry-after': '600' }).end()
  // Back from a connector's authorization page. No token here: it may open in a browser that never
  // signed in (the desktop app sends it to the system's). What makes it count is the state, made
  // by the core for that one request and good once.
  if (url.pathname === '/oauth/callback') return oauthCallback(url, res)
  // The link with ?token= signs this browser in, then drops it from the address bar. Lax, not
  // Strict: the link is often clicked from elsewhere (a chat), and a Strict cookie wouldn't ride
  // the redirect that follows. Lax still keeps it off other sites' POSTs to /rpc.
  const offered = url.searchParams.get('token') ?? undefined
  if (offered !== undefined && !sameToken(offered)) guesses.fail(ip)
  if (sameToken(offered)) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    return void res.writeHead(302, { ...BASE_HEADERS, 'set-cookie': `tucano=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`, location: '/' }).end()
  }
  const cookie = cookieToken(req)
  if (!sameToken(cookie)) {
    if (cookie !== undefined && offered === undefined) guesses.fail(ip)
    return void res
      .writeHead(401, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
      .end('Tucano: open the link from `node out/main/server.js link`.\nTucano: abra o link que o `node out/main/server.js link` mostra.')
  }
  // Signed in, but asked from another site's page: a sibling subdomain shares the cookie's site.
  if ((url.pathname === '/events' || url.pathname === '/rpc' || url.pathname === '/upload') && !sameOrigin(req)) return void res.writeHead(403, BASE_HEADERS).end()

  // A file sent from the person's computer (a vault's .zip): straight to disk, in parts, into a
  // folder of the server's own; the core takes it from there and deletes it when done.
  if (url.pathname === '/upload' && req.method === 'POST') {
    const name = (url.searchParams.get('name') ?? 'file').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
    // For a message: ~/Enviados, under its own name (a number added when taken), where the agents
    // on this computer find it. Anything else (a vault): the server's own folder, for the core.
    const forMessage = url.searchParams.get('for') === 'message'
    const dir = forMessage ? join(homedir(), 'Enviados') : join(dataDir, 'uploads')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let path = forMessage ? join(dir, name) : join(dir, `${randomUUID()}-${name}`)
    for (let n = 2; forMessage && existsSync(path); n++) path = join(dir, name.replace(/(\.[^.]*)?$/, ` (${n})$1`))
    const out = createWriteStream(path, { mode: 0o600 })
    let size = 0
    const fail = (code: number): void => {
      out.destroy()
      rmSync(path, { force: true })
      if (!res.headersSent) res.writeHead(code, BASE_HEADERS).end()
    }
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_UPLOAD) {
        req.destroy()
        fail(413)
      }
    })
    req.on('error', () => fail(400))
    req.pipe(out).on('finish', () => !res.headersSent && res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/json' }).end(JSON.stringify({ path })))
    return
  }

  if (url.pathname === '/events') {
    const c = new Port((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`))
    const id = randomUUID()
    clients.set(id, c)
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
    res.write(`event: hello\ndata: ${id}\n\n`)
    // A beat the page can hear (a comment line it couldn't): it tells a dead line from a quiet one.
    const beat = setInterval(() => res.write('event: ping\ndata: \n\n'), 25_000)
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
    if (!c) return void res.writeHead(410, BASE_HEADERS).end()
    body(req).then(
      (text) => {
        let data: unknown
        try {
          data = JSON.parse(text)
        } catch {
          return void res.writeHead(400, BASE_HEADERS).end()
        }
        try {
          c.emit('message', { data })
        } catch (e) {
          console.error('[server] rpc', e instanceof Error ? e.message : e)
          return void res.writeHead(400, BASE_HEADERS).end()
        }
        res.writeHead(204, BASE_HEADERS).end()
      },
      () => res.writeHead(413, BASE_HEADERS).end()
    )
    return
  }

  // An agent's page, from the app's panel: signed in here, the browser goes on to its own address.
  const pv = /^\/preview\/(\d{2,5})(\/.*)?$/.exec(url.pathname)
  if (pv && preview) {
    const p = Number(pv[1])
    if (p === port || ![...servicePorts.values()].some((l) => l.includes(p))) return void res.writeHead(404, BASE_HEADERS).end()
    return void res.writeHead(302, { ...BASE_HEADERS, location: preview.grantUrl(p, `${pv[2] ?? '/'}${url.search}`), 'cache-control': 'no-store' }).end()
  }

  // Choosing a folder on the server (the wiki's, one lent to an agent): its subfolders, for the
  // bridge's picker. Names only; it starts at the home folder.
  if (url.pathname === '/folders') {
    const asked = url.searchParams.get('path') || homedir()
    const at = isAbsolute(asked) ? resolve(asked) : resolve(homedir(), asked)
    let folders: string[]
    try {
      folders = readdirSync(at, { withFileTypes: true })
        .filter((d) => d.isDirectory() || (d.isSymbolicLink() && statSync(join(at, d.name), { throwIfNoEntry: false })?.isDirectory()))
        .map((d) => d.name)
        .sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b))
        .slice(0, 1000)
    } catch {
      return void res.writeHead(404, { ...BASE_HEADERS, 'content-type': 'application/json' }).end('{}')
    }
    return void res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ path: at, parent: dirname(at) === at ? null : dirname(at), home: homedir(), folders }))
  }

  // A file an agent cited, checked and signed by the core: shown (an image, a video) or saved.
  if (url.pathname.startsWith('/local/')) {
    const path = verifyLocalUrl(localKey, new URL(url.pathname.replace(/^\/local/, ''), 'tucano://local'))
    let size = -1
    try {
      size = path && statSync(path).isFile() ? statSync(path).size : -1
    } catch {}
    if (!path || size < 0) return void res.writeHead(404, BASE_HEADERS).end()
    const saving = url.searchParams.has('download')
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': saving ? 'application/octet-stream' : (TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'),
      'content-length': String(size),
      'content-security-policy': 'sandbox',
      ...(saving ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}` } : {})
    })
    return void createReadStream(path).on('error', () => res.destroy()).pipe(res)
  }

  // What the agents showed in the chat, sandboxed as on the desktop.
  const art = /^\/artifact\/([0-9a-f-]{36})\/([^/]+)$/.exec(url.pathname)
  if (art) {
    const dir = join(dataDir, 'artifacts', art[1]!)
    const name = decodedPath(art[2]!)
    const path = name === undefined ? '' : normalize(join(dir, name))
    if (!path.startsWith(dir + sep)) return void res.writeHead(404, BASE_HEADERS).end()
    return file(res, path, { 'content-security-policy': ARTIFACT_CSP })
  }

  if (url.pathname === '/tucano-web.js') return void res.writeHead(200, { ...BASE_HEADERS, 'content-type': TYPES['.js']! }).end(WEB)
  if (url.pathname === '/' || url.pathname === '/index.html') return void res.writeHead(200, { ...PAGE_HEADERS, 'content-type': TYPES['.html']!, 'cache-control': 'no-cache' }).end(index())
  const name = decodedPath(url.pathname)
  const path = name === undefined ? '' : normalize(join(page, name))
  if (!path.startsWith(page + sep)) return void res.writeHead(404, BASE_HEADERS).end()
  file(res, path)
}

// window.tucano for a browser: the core's port comes from the event stream and
// the requests go up by POST; what only the desktop does is left out quietly.
const WEB = `${INSECURE_CONTEXT_SHIM}(() => {
  window.__TUCANO_WEB__ = true
  let client = null
  // Starting fresh is how this page reconnects. What's typed in the message field is kept first
  // (Conversation.tsx listens), so a reload on its own never costs a draft.
  const restart = () => {
    window.dispatchEvent(new Event('tucano:reloading'))
    location.reload()
  }
  // A line that went quiet without closing (the computer slept, the Wi-Fi changed) never says so:
  // the server beats every 25 s, and a minute without anything means it's gone.
  let heard = Date.now()
  const STALE_MS = 60_000
  const stale = () => client && Date.now() - heard > STALE_MS
  setInterval(() => stale() && restart(), 10_000)
  window.addEventListener('online', () => stale() && restart())
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && stale() && restart())
  const connect = () => {
    const ch = new MessageChannel()
    const es = new EventSource('./events')
    let opened = false
    es.addEventListener('ping', () => (heard = Date.now()))
    es.addEventListener('hello', (e) => {
      heard = Date.now()
      if (opened) return restart() // a new connection after a drop: start fresh
      opened = true
      client = e.data
      window.postMessage('core:port', '*', [ch.port1])
    })
    es.onmessage = (e) => {
      heard = Date.now()
      const m = JSON.parse(e.data)
      if (m && m.notify) return notify(m.notify)
      ch.port2.postMessage(m)
    }
    ch.port2.onmessage = (m) => {
      fetch('./rpc?c=' + encodeURIComponent(client), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m.data) }).then((r) => {
        if (r.status === 410) restart()
      })
    }
  }
  // A notification of the system, as the desktop app shows, while the person isn't on this page.
  // The browser asks for permission once, on the first click (it won't ask without one).
  let toConversation = () => {}
  let toPage = () => {}
  const notify = (n) => {
    if (!('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return
    const shown = new Notification(n.title, { body: n.body, tag: n.conversationId || undefined })
    shown.onclick = () => {
      window.focus()
      if (n.conversationId) toConversation(n.conversationId)
      else if (n.page === 'skills') toPage('skills')
      shown.close()
    }
  }
  // The server's folders, in the app's own dialog look: a browser can't show the server's disk.
  const pickFolder = () =>
    new Promise((done) => {
      const pt = document.documentElement.lang !== 'en'
      const t = (a, b) => (pt ? a : b)
      const el = (tag, cls, text) => {
        const e = document.createElement(tag)
        if (cls) e.className = cls
        if (text !== undefined) e.textContent = text
        return e
      }
      const shade = el('div', 'modal')
      const card = el('div', 'modal__card')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')
      const head = el('header', 'modal__head')
      head.append(el('strong', '', t('Escolher pasta no servidor', 'Choose a folder on the server')))
      const where = el('p', 'small muted mono modal__lead')
      const list = el('div', 'folder-pick')
      list.style.cssText = 'max-height:320px;overflow:auto;display:grid;gap:2px;margin:8px 0'
      const foot = el('footer', 'modal__foot')
      const cancel = el('button', 'btn btn--ghost btn--sm', t('Cancelar', 'Cancel'))
      const choose = el('button', 'btn btn--primary btn--sm', t('Escolher esta pasta', 'Choose this folder'))
      foot.append(el('span', 'grow'), cancel, choose)
      card.append(head, where, list, foot)
      shade.append(card)
      document.body.append(shade)
      let current = ''
      const close = (v) => {
        shade.remove()
        document.removeEventListener('keydown', onKey, true)
        done(v)
      }
      const onKey = (e) => {
        if (e.key === 'Escape') (e.stopImmediatePropagation(), close(null))
      }
      document.addEventListener('keydown', onKey, true)
      shade.addEventListener('mousedown', (e) => e.target === shade && close(null))
      cancel.onclick = () => close(null)
      choose.onclick = () => close(current || null)
      const row = (label, path) => {
        const b = el('button', 'btn btn--ghost btn--sm', label)
        b.style.cssText = 'justify-content:flex-start;text-align:left'
        b.onclick = () => go(path)
        list.append(b)
      }
      const go = (path) =>
        fetch('./folders' + (path ? '?path=' + encodeURIComponent(path) : ''))
          .then((r) => (r.ok ? r.json() : Promise.reject()))
          .then((r) => {
            current = r.path
            where.textContent = r.path
            list.replaceChildren()
            if (r.parent) row('↑ ' + t('Pasta acima', 'Up a folder'), r.parent)
            for (const f of r.folders) row(f + '/', r.path.replace(/\\/+$/, '') + '/' + f)
            if (!r.folders.length) list.append(el('p', 'small muted', t('Nenhuma pasta aqui dentro.', 'No folders in here.')))
          })
          .catch(() => (where.textContent = t('Não consegui abrir essa pasta.', "Couldn't open that folder.")))
      go('')
      choose.focus()
    })
  if ('Notification' in window && Notification.permission === 'default')
    document.addEventListener('pointerdown', () => void Notification.requestPermission().catch(() => {}), { once: true })
  window.tucano = {
    connect,
    pickFolder: () => pickFolder(),
    // A file from this computer up to the server; where it landed there.
    upload: (file, purpose) =>
      fetch('./upload?name=' + encodeURIComponent(file.name) + (purpose === 'message' ? '&for=message' : ''), { method: 'POST', body: file }).then((r) =>
        r.ok ? r.json().then((j) => j.path) : Promise.reject(new Error(r.status === 413 ? 'O arquivo passa de 1 GB. / The file is over 1 GB.' : 'Não consegui enviar o arquivo. / Could not send the file.'))
      ),
    onNavigate: (cb) => (toConversation = cb),
    onNavigatePage: (cb) => (toPage = cb),
    viewing: () => {},
    updateState: async () => ({ version: '', status: 'off' }),
    onUpdate: () => {},
    checkUpdates: () => {},
    installUpdate: () => {}
  }
})()
`

process.env['TUCANO_DATA'] = dataDir
process.env['TUCANO_LOCAL_KEY'] = localKey
process.env['TUCANO_PACKAGED'] = '1'
process.env['TUCANO_SERVER'] = '1'
;(process as unknown as { parentPort: Port }).parentPort = parent
await import(pathToFileURL(join(import.meta.dirname, 'core.js')).href)
toCore(null, [watcher])
watcher.emit('message', { data: { id: 1, method: 'snapshot' } })

// WebSockets: only an agent's page at its preview address has any (a dev server reloading itself).
server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const p = preview?.portOf(req.headers.host)
  if (p) preview!.upgrade(req, socket, head, p)
  else socket.destroy()
})

server.listen(port, host, () => {
  console.log(`Tucano server: ${publicUrl}`)
  console.log('To sign a browser in, open the link that `node out/main/server.js link` prints.')
  console.log(`Data: ${dataDir}`)
  if (host === '127.0.0.1') console.log('Listening on this machine only: reach it through an SSH tunnel, Tailscale or a reverse proxy with HTTPS (docs/server.md).')
})
