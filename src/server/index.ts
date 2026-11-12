// Tucano as a server: the core on plain Node (a VPS, a home server), and the
// app's own screens in a browser. Where the desktop app's main process hosts the
// core and the window, this does: it stands in for Electron's parentPort, keeps
// the secrets with a key of its own, and serves the page plus a bridge to the
// core (events down an event stream, requests up by POST). Every request needs
// the server's token (the owner) or a person's key (someone invited, src/server/people.ts).
//
//   node out/main/server.js        (TUCANO_DATA, TUCANO_HOST, TUCANO_PORT, TUCANO_TOKEN, TUCANO_URL, TUCANO_TRUST_PROXY)
//   node out/main/server.js link   prints the link that signs a browser in
//   node out/main/server.js pair [minutes]   a one-time link for the owner's phone (or a browser)
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Forwarder, isPrivate } from './forward'
import { ARTIFACT_CSP, BASE_HEADERS, body, clientIp, decodedPath, Doors, doorOf, PAGE_HEADERS, PERSON_KEY, sameOrigin, signIn } from './guard'
import { codeMinutes, PairCodes } from './pair-codes'
import { htmlPage, pairLinkPage, pairPost, type PairDoor } from './pair-http'
import { Preview } from './preview'
import { vault } from './vault'
import { applyRestore } from '../core/restore'
import { verifyLocal } from '../core/local-paths'
import { pairingLink } from '../shared/servers'
import { ACCESS_SHIM, INSECURE_CONTEXT_SHIM } from './web-shim'
import { Grants, invitePage, joinFields, NO_ACCESS_PAGE, notifyNote, personNotice, Signins, Streams, UNAUTHORIZED_TEXT, Viewers, type Stream, type Who } from './people'
import type { Person } from '../shared/types'

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
// The second line pairs the desktop app or the phone (Settings › Servers, or a QR code of it).
if (process.argv[2] === 'link') {
  console.log(`${publicUrl}/?token=${token}`)
  console.log(pairingLink({ origin: publicUrl, token }))
  process.exit(0)
}

// One-time codes that sign a device in as a person (pair-codes.ts).
const pairCodes = new PairCodes(join(dataDir, 'pair-codes.json'))

// `server.js pair [minutes]`: a one-time code for the owner, as the link the phone opens (or a QR
// code of it) and as the browser's. Good once, for 10 minutes unless asked otherwise (up to a week).
if (process.argv[2] === 'pair') {
  const { code } = pairCodes.make(null, codeMinutes(process.argv[3]))
  console.log(pairingLink({ origin: publicUrl, code }))
  console.log(`${publicUrl}/?code=${code}`)
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

type CoreRequest = { type: string; id?: string; op?: string; data?: string; title?: string; body?: string; conversationId?: string; page?: string; to?: string[]; person?: Person; removed?: boolean }
const parent = new Port((msg) => fromCore(msg as CoreRequest))
const toCore = (data: unknown, ports: Port[] = []): boolean => parent.emit('message', { data, ports })

// What the main process does for the core on a desktop. A server has no screen: nothing to
// open, no login item. Its notifications go to the pages open on it (a browser, the desktop app's
// server window), which show them while the person is looking elsewhere; Telegram carries them too.
const oauthWaits = new Map<string, (r: { ok: boolean; why?: string }) => void>()
// Questions to the core that wait for its answer (a key's person, a join): by id, a few seconds at most.
const waits = new Map<string, (data: unknown) => void>()
function ask<T>(msg: Record<string, unknown>, timeoutMs = 10_000): Promise<T | undefined> {
  const id = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => waits.delete(id) && resolve(undefined), timeoutMs)
    waits.set(id, (data) => (clearTimeout(timer), waits.delete(id), resolve(data as T)))
    toCore({ ...msg, id })
  })
}
const signins = new Signins((key) => ask<Person | { removed: true } | undefined>({ type: 'auth', key }))
const grants = new Grants((person, what) => ask<boolean>({ type: 'access', person, ...what }))

function fromCore(msg: CoreRequest): void {
  const id = msg.id
  if (msg.type === 'oauth-result') {
    oauthWaits.get(id ?? '')?.((msg as unknown as { data: { ok: boolean; why?: string } }).data)
    oauthWaits.delete(id ?? '')
    return
  }
  // A backup to restore: a start of its own puts it in (applyRestore, above the core's import).
  // A non-zero code, so systemd's Restart=on-failure brings it back as Docker's restart policy does.
  if (msg.type === 'restart') {
    console.log('Restarting to restore a backup. If nothing starts this server again, start it by hand.')
    server.close()
    setTimeout(() => process.exit(75), 300)
    return
  }
  if (msg.type === 'auth-result') return waits.get(id ?? '')?.(msg.person ?? (msg.removed ? { removed: true } : undefined))
  if (msg.type === 'join-result' || msg.type === 'invite-info-result' || msg.type === 'device-key-result') return waits.get(id ?? '')?.((msg as unknown as { data: unknown }).data)
  if (msg.type === 'access-result') return waits.get(id ?? '')?.((msg as unknown as { ok: boolean }).ok)
  // Removed, or their role changed: what the server remembered of them goes (see personNotice).
  if (personNotice(msg, { signins, grants, viewers, streams })) return
  // Only to the pages of the people it's for.
  if (msg.type === 'notify') {
    streams.deliver(notifyNote(msg as unknown as Record<string, unknown>), Array.isArray(msg.to) ? msg.to : undefined, ownerId)
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

// The page's connections: each one a port of the core, events down its stream, and someone's.
type Client = Stream & { port: Port }
const streams = new Streams<Client>()
// What each page has open: the core marks it read for that page's person, as on a desktop.
const viewers = new Viewers()
// '' is the owner's token, which the core takes for the owner (as a desktop's window).
const tellViewing = (person: string, conversationId: string | null): boolean => toCore({ type: 'viewing', ...(person ? { person } : {}), conversationId })
// The owner's id and name, from the server's own connection (an owner-token page is the owner's).
let ownerId: string | undefined
let ownerName = ''

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
  const m = msg as { id?: number; result?: { computers?: Computer[]; you?: string; people?: Person[] }; event?: { type: string; computer?: Computer; people?: Person[] } }
  if (m.id === 1 && m.result) {
    if (m.result.computers) sawComputers(m.result.computers)
    ownerId = m.result.you
    sawPeople(m.result.people ?? [])
  } else if (m.event?.type === 'computer' && m.event.computer) sawComputers([m.event.computer])
  else if (m.event?.type === 'people') sawPeople(m.event.people ?? [])
})
// Everyone's name by id: whom a pairing link's page says the browser signs in as.
const names = new Map<string, string>()
function sawPeople(list: Person[]): void {
  names.clear()
  for (const p of list) names.set(p.id, p.name)
  const owner = list.find((p) => p.role === 'owner')
  if (owner) [ownerId, ownerName] = [owner.id, owner.name]
}

// The desktop page, told it's in a browser: the bridge script first, and its
// policy letting it frame the agents' pages from this server.
function index(): string {
  return readFileSync(join(page, 'index.html'), 'utf8')
    .replace('frame-src tucano:', `frame-src 'self' tucano:${privateHost ? ` http://${host}:*` : ''}${publicHost ? ` https://*.${publicHost.split('.').slice(1).join('.')}` : ''}`)
    .replace('<title>', '<meta name="viewport" content="width=device-width, initial-scale=1" />\n    <script src="./tucano-web.js"></script>\n    <title>')
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
const doors = new Doors()
// A one-time code's door (pair-http.ts): a spent code's person gets a key of this device's own, from the core.
const pairDoor: PairDoor = {
  codes: pairCodes,
  doors,
  mint: async (person, label) => (await ask<{ key?: string }>({ type: 'device-key', person, label }))?.key,
  owner: () => ownerName,
  nameOf: (person) => names.get(person ?? ownerId ?? '')
}

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
  // Back from a connector's authorization page. No token here: it may open in a browser that never
  // signed in (the desktop app sends it to the system's). What makes it count is the state, made
  // by the core for that one request and good once.
  if (url.pathname === '/oauth/callback') return oauthCallback(url, res)
  // A one-time code (pair-codes.ts), traded for a key of the device's own: the phone posts it here,
  // and so does the page a browser's /?code= opens (opening it spends nothing: see pair-http.ts).
  // No sign-in: the code is what counts, and a wrong one counts as a guess.
  if (url.pathname === '/pair' && req.method === 'POST') return void pairPost(pairDoor, req, res, ip)
  const offeredCode = url.searchParams.get('code')
  if (offeredCode !== null && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return pairLinkPage(pairDoor, req, res, ip, offeredCode)
  const offered = url.searchParams.get('token') ?? undefined
  // An invite's page and its form come before signing in: they're how someone new gets a key. A
  // guesser of codes waits at that door; the other door stays open (see Doors).
  if (doorOf(url.pathname, req.method, url.searchParams.has('invite')) === 'join' && !sameToken(offered)) {
    if (doors.blocked('join', ip)) return void res.writeHead(429, { ...BASE_HEADERS, 'retry-after': '600' }).end()
    if (req.method === 'GET') return void invitePageFor(req, res, url.searchParams.get('invite') ?? '')
    return void joinPage(req, res, ip)
  }
  // The link with ?token= signs this browser in, then drops it from the address bar. Lax, not
  // Strict: the link is often clicked from elsewhere (a chat), and a Strict cookie wouldn't ride
  // the redirect that follows. Lax still keeps it off other sites' POSTs to /rpc. A cookie is the
  // owner's token or a person's key (the core says whose; the answer is kept a few seconds).
  void signIn({ cookie: cookieToken(req), offered, ip, doors, isOwnerToken: sameToken, strongOwnerToken: !process.env['TUCANO_TOKEN'], lookup: (key) => signins.lookup(key) })
    .then((r) => {
      if (r.status === 'link') {
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
        return void res.writeHead(302, { ...BASE_HEADERS, 'set-cookie': `tucano=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`, location: '/' }).end()
      }
      if (r.status === 'owner') return authed(req, res, url, { owner: true, role: 'owner' })
      if (r.status === 'person') return authed(req, res, url, { person: r.person.id, role: r.person.role })
      if (r.status === 'blocked') return void res.writeHead(429, { ...BASE_HEADERS, 'retry-after': '600' }).end()
      // Someone removed: their page says so (the bridge reads the 401), and nothing more.
      if (r.status === 'removed') return htmlPage(res, NO_ACCESS_PAGE, 401)
      res.writeHead(401, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end(UNAUTHORIZED_TEXT)
    })
    .catch((e: unknown) => {
      console.error('[server]', req.method, e instanceof Error ? e.message : e)
      if (!res.headersSent) res.writeHead(503, BASE_HEADERS).end()
    })
}

// An invite that brings someone back comes with their name filled in (they can still change it).
// An app asks for JSON (accept: application/json): whose Tucano it is, and that name.
async function invitePageFor(req: IncomingMessage, res: ServerResponse, code: string): Promise<void> {
  const info = code ? await ask<{ name?: string }>({ type: 'invite-info', code: code.slice(0, 200) }, 5_000) : undefined
  if (wantsJson(req)) return json(res, 200, { owner: ownerName, ...(info?.name ? { name: info.name } : {}) })
  htmlPage(res, invitePage({ owner: ownerName, code, ...(info?.name ? { name: info.name } : {}) }))
}

const wantsJson = (req: IncomingMessage): boolean => /application\/json/.test(String(req.headers['accept'] ?? ''))
const json = (res: ServerResponse, status: number, value: unknown): void =>
  void res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value))

// The invite's form: a code and a name become a person with a key, kept in this browser's cookie.
// A code that's wrong, used or expired counts as a guess.
async function joinPage(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
  if (!sameOrigin(req)) return void res.writeHead(403, BASE_HEADERS).end()
  // An app (the phone) sends JSON and reads JSON: the key itself, never a cookie.
  const app = /application\/json/.test(String(req.headers['content-type'] ?? ''))
  let fields: { code: string; name: string }
  try {
    fields = joinFields(await body(req, 16 * 1024), req.headers['content-type'])
  } catch {
    return void res.writeHead(413, BASE_HEADERS).end()
  }
  if (!fields.name.trim()) {
    if (app) return json(res, 400, { error: 'Diga seu nome. · Tell us your name.' })
    return htmlPage(res, invitePage({ owner: ownerName, code: fields.code, error: 'Diga seu nome. · Tell us your name.' }), 400)
  }
  const out = await ask<{ key?: string; error?: string }>({ type: 'join', code: fields.code, name: fields.name })
  if (!out?.key) {
    doors.fail('join', ip)
    const error = out?.error ?? 'O Tucano não respondeu. Tente de novo. · Tucano didn’t answer. Try again.'
    if (app) return json(res, 400, { error })
    return htmlPage(res, invitePage({ owner: ownerName, code: fields.code, name: fields.name, error }), 400)
  }
  if (app) return json(res, 200, { key: out.key })
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  res.writeHead(302, { ...BASE_HEADERS, 'set-cookie': `tucano=${out.key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`, location: './', 'cache-control': 'no-store' }).end()
}

// Signed in: the owner, or a person. A failure here answers this request, never the whole server.
function authed(req: IncomingMessage, res: ServerResponse, url: URL, who: Who): void {
  try {
    signedIn(req, res, url, who)
  } catch (e) {
    console.error('[server]', req.method, e instanceof Error ? e.message : e)
    if (!res.headersSent) res.writeHead(400, BASE_HEADERS).end()
  }
}

function signedIn(req: IncomingMessage, res: ServerResponse, url: URL, who: Who): void {
  // Signed in, but asked from another site's page: a sibling subdomain shares the cookie's site.
  if ((url.pathname === '/events' || url.pathname === '/rpc' || url.pathname === '/upload' || url.pathname === '/viewing' || url.pathname === '/pair/new') && !sameOrigin(req)) return void res.writeHead(403, BASE_HEADERS).end()

  // Conectar um celular: a one-time code for whoever asks (their own person), as the link the phone
  // opens and as the browser's.
  if (url.pathname === '/pair/new' && req.method === 'POST') {
    const { code, expiresAt } = pairCodes.make(who.owner ? null : who.person)
    return json(res, 200, { code, link: pairingLink({ origin: publicUrl, code }), browser: `${publicUrl}/?code=${code}`, expiresAt })
  }

  // A file sent from the person's computer (a vault's .zip): straight to disk, in parts, into a
  // folder of the server's own; the core takes it from there and deletes it when done.
  if (url.pathname === '/upload' && req.method === 'POST') {
    const name = (url.searchParams.get('name') ?? 'file').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
    // For a message: ~/Enviados, under its own name (a number added when taken), where the agents
    // on this computer find it. Anything else (a vault): the server's own folder, for the core.
    const forMessage = url.searchParams.get('for') === 'message'
    // Anything but a message's file (a vault for the wiki) is the admins'. Someone invited gets a
    // folder of their own under Enviados: no name of theirs lands beside the owner's files.
    if (!forMessage && who.role === 'member') return void res.writeHead(403, BASE_HEADERS).end()
    const dir = forMessage ? (who.person && who.role !== 'owner' ? join(homedir(), 'Enviados', who.person) : join(homedir(), 'Enviados')) : join(dataDir, 'uploads')
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
    // Once the line is closed (the person removed, a device disconnected), a late answer goes nowhere.
    const port = new Port((msg) => void (!res.writableEnded && res.write(`data: ${JSON.stringify(msg)}\n\n`)))
    const id = randomUUID()
    // Ended by the server (the person was removed) or by the core (it closed the port): the page loses the line.
    const end = (): void => {
      streams.delete(id)
      if (!res.writableEnded) res.end()
    }
    streams.add(id, { who, port, send: (msg) => port.postMessage(msg), end })
    port.once('close', end)
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
    res.write(`event: hello\ndata: ${id}\n\n`)
    // A beat the page can hear (a comment line it couldn't): it tells a dead line from a quiet one.
    const beat = setInterval(() => res.write('event: ping\ndata: \n\n'), 25_000)
    // The core learns whose port this is: nothing named is the owner, as on a desktop. A person's
    // page also says which of their keys (by its hash): the one Settings › Pessoas marks as this device.
    const cookie = cookieToken(req)
    toCore(who.owner ? null : { person: who.person, ...(cookie && PERSON_KEY.test(cookie) ? { device: createHash('sha256').update(cookie).digest('base64url') } : {}) }, [port])
    req.on('close', () => {
      clearInterval(beat)
      streams.delete(id)
      port.close()
      // A closed page isn't looking at anything: its person's other page, if any, still is.
      const left = viewers.drop(id)
      if (left) tellViewing(left.person, left.conversation)
    })
    return
  }

  // The conversation a page has open (window.tucano.viewing): only for its own stream.
  if (url.pathname === '/viewing' && req.method === 'POST') {
    const stream = url.searchParams.get('c') ?? ''
    const found = streams.get(stream)
    if (!found || found.who.person !== who.person || !!found.who.owner !== !!who.owner) return void res.writeHead(410, BASE_HEADERS).end()
    body(req, 4 * 1024).then(
      (text) => {
        let id: unknown
        try {
          id = (JSON.parse(text) as { conversationId?: unknown }).conversationId
        } catch {
          return void res.writeHead(400, BASE_HEADERS).end()
        }
        tellViewing(who.person ?? '', viewers.set(stream, who.person ?? '', typeof id === 'string' ? id : null))
        res.writeHead(204, BASE_HEADERS).end()
      },
      () => res.writeHead(413, BASE_HEADERS).end()
    )
    return
  }

  if (url.pathname === '/rpc' && req.method === 'POST') {
    // Only its own stream: another person's stream id opens nothing.
    const found = streams.get(url.searchParams.get('c') ?? '')
    const c = found && found.who.person === who.person && !!found.who.owner === !!who.owner ? found.port : undefined
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
    // A page started by a reply in someone's DM is theirs alone.
    void grants.may(who.person ?? ownerId, { port: p }).then((ok) =>
      ok ? res.writeHead(302, { ...BASE_HEADERS, location: preview.grantUrl(p, `${pv[2] ?? '/'}${url.search}`), 'cache-control': 'no-store' }).end() : res.writeHead(404, BASE_HEADERS).end()
    )
    return
  }

  // Choosing a folder on the server (the wiki's, one lent to an agent): its subfolders, for the
  // bridge's picker. Names only; it starts at the home folder. The server's disk is for admins.
  if (url.pathname === '/folders') {
    if (who.role === 'member') return void res.writeHead(403, BASE_HEADERS).end()
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
    // Signed for one person: anyone else (a link passed on) gets nothing.
    const signed = verifyLocal(localKey, new URL(url.pathname.replace(/^\/local/, ''), 'tucano://local'))
    const path = signed && (signed.person ? signed.person === (who.person ?? ownerId) : who.owner) ? signed.path : null
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
    // Only who sees the conversation it was shown in (someone else's DM: not found).
    void grants.may(who.person ?? ownerId, { artifact: art[1]! }).then((ok) => (ok ? file(res, path, { 'content-security-policy': ARTIFACT_CSP }) : res.writeHead(404, BASE_HEADERS).end()))
    return
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
  ${ACCESS_SHIM}
  let client = null
  // The conversation open on this page, told to the server once the line is up (and on each change),
  // so what arrives there is read already, as on the desktop.
  let looking = null
  const tellViewing = () => {
    if (!client) return
    fetch('./viewing?c=' + encodeURIComponent(client), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: looking }) }).catch(() => {})
  }
  // Starting fresh is how this page reconnects. What's typed in the message field is kept first
  // (Conversation.tsx listens), so a reload on its own never costs a draft.
  const restart = () => {
    if (access.gone) return
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
      if (looking) tellViewing()
    })
    // Closed for good (a reconnect the server refused): out of access, or only a network that's down.
    es.onerror = () => es.readyState === 2 && access.check().then((gone) => gone && es.close())
    es.onmessage = (e) => {
      heard = Date.now()
      const m = JSON.parse(e.data)
      if (m && m.notify) return notify(m.notify)
      ch.port2.postMessage(m)
    }
    ch.port2.onmessage = (m) => {
      fetch('./rpc?c=' + encodeURIComponent(client), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m.data) }).then((r) => {
        if (access.answer(r.status)) return es.close()
        if (r.status === 410) restart()
      })
    }
  }
  // A notification of the system, as the desktop app shows, unless the person is reading that
  // conversation here. Inside the Tucano app (Settings › Servers) the app shows it as its own
  // (src/preload/server.ts), and a click brings that server and conversation back on screen.
  // A browser asks for permission once, on the first click (it won't ask without one), and shows
  // none over plain HTTP outside this machine (Tailscale, a home network): it only does on HTTPS.
  let toConversation = () => {}
  let toPage = () => {}
  const desktop = window.tucanoDesktop
  if (desktop) desktop.onOpen((n) => (n.conversationId ? toConversation(n.conversationId, n.threadId) : n.page === 'skills' && toPage('skills')))
  const notifyState = () =>
    desktop ? 'on' : !('Notification' in window) ? 'unsupported' : !window.isSecureContext ? 'insecure' : Notification.permission === 'granted' ? 'on' : Notification.permission === 'denied' ? 'blocked' : 'ask'
  const notify = (n) => {
    if (document.hasFocus() && n.conversationId && n.conversationId === looking) return
    if (desktop) return desktop.notify(n)
    if (notifyState() !== 'on') return
    const shown = new Notification(n.title, { body: n.body, tag: n.conversationId || undefined })
    shown.onclick = () => {
      window.focus()
      if (n.conversationId) toConversation(n.conversationId, n.threadId)
      else if (n.page === 'skills') toPage('skills')
      shown.close()
    }
  }
  // Settings › General › Notifications: one sent now, or why none can come here.
  const testNotify = async () => {
    if (!desktop && notifyState() === 'ask') await Notification.requestPermission().catch(() => {})
    const state = notifyState()
    if (state !== 'on') return state
    const title = 'Tucano'
    const body = document.documentElement.lang !== 'en' ? 'As notificações estão chegando.' : 'Notifications are coming through.'
    if (desktop) desktop.notify({ title, body })
    else new Notification(title, { body })
    return 'shown'
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
  if (!desktop && notifyState() === 'ask')
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
    viewing: (id) => {
      looking = typeof id === 'string' ? id : null
      tellViewing()
    },
    notifyState,
    testNotify,
    updateState: async () => ({ version: '', status: 'off' }),
    onUpdate: () => {},
    checkUpdates: () => {},
    installUpdate: () => {}
  }
})()
`

// A backup the owner confirmed: its files take the place of these before the core opens them.
if (applyRestore(dataDir)) console.log('Restored a backup; what was here is in restore/before-…')

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
