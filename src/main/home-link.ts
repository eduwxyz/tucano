// The phone at home: the desktop app opens its Tucano to the iPhone app on the same Wi-Fi, as the
// owner. Off until the owner turns it on (Settings › Celular › Seu iPhone); then an HTTPS address on
// this computer's network, with a certificate of its own (self-signed.ts) whose fingerprint rides
// in the QR code, so the phone knows it's talking to this Mac.
//
// It speaks the part of the server's protocol the phone uses (src/server/index.ts): POST /pair
// trades a one-time code for a key of the phone's own (the core keeps it, as on a server), then the
// key opens /events (the core's port, as an event stream), /rpc (requests up), /artifact and /upload.
// Only addresses of a private network get an answer: nothing here is for the internet.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import { homedir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { ARTIFACT_CSP, BASE_HEADERS, decodedPath, Doors } from '../server/guard'
import { deviceLabel, PairCodes } from '../server/pair-codes'
import { pairingLink } from '../shared/servers'
import type { Person } from '../shared/types'

// What the link needs of the core (index.ts wires it to the workspace's process).
export interface HomeCore {
  // The person a key opens; removed: a key that was someone's who's gone.
  auth(key: string): Promise<Person | { removed: true } | undefined>
  // A new key for the owner, for one device.
  deviceKey(label: string): Promise<string | undefined>
  // A port to the core as this person: what the core says comes to onMessage. `device`: the hash of
  // the key the phone signed in with, so the core can end this line when that device is disconnected
  // (Settings › Celular › Seu iPhone); then onClose.
  open(person: string, onMessage: (msg: unknown) => void, o?: { device?: string; onClose?: () => void }): { post(data: unknown): void; close(): void }
  // Where the workspace keeps what agents showed (artifacts/<id>/<name>).
  dataDir(): string
}

type Stream = { person: string; res: ServerResponse; port: { post(data: unknown): void; close(): void } }

const PERSON_KEY = /^p_[\w-]{43}$/
const MAX_UPLOAD = 1024 * 1024 * 1024

// A private network's address (home Wi-Fi, Tailscale), loopback, or link-local; never the internet.
export function isLocalAddress(raw: string | undefined): boolean {
  const ip = (raw ?? '').replace(/^::ffff:/, '').toLowerCase()
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.)/.test(ip)) return true
  return ip === '::1' || /^fe[89ab][0-9a-f]:/.test(ip) || /^f[cd][0-9a-f]{2}:/.test(ip)
}

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
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
}

export class HomeLink {
  private server?: Server
  private streams = new Map<string, Stream>()
  private doors = new Doors()
  private codes: PairCodes
  private origin = ''
  port = 0

  constructor(
    private o: {
      tls: { key: string; cert: string; fingerprint: string }
      codesFile: string
      core: () => HomeCore | undefined
      sentDir?: string // where a phone's file for a message lands: ~/Enviados, as on a server
      onChange?: () => void // a phone connected, left, or paired
    }
  ) {
    this.codes = new PairCodes(o.codesFile)
  }

  get running(): boolean {
    return !!this.server?.listening
  }

  // Phones on the line now.
  get connected(): number {
    return this.streams.size
  }

  // Listens on every interface, at `port` or the next free one of a few: IPv6 and IPv4 together
  // (macOS, Windows, most Linux), or IPv4 alone where the system has no IPv6 (some Linux).
  async start(port: number, host: string): Promise<number> {
    if (this.server) return this.port
    let any = '::'
    for (let p = port; p < port + 10; p++) {
      const server = createServer({ key: this.o.tls.key, cert: this.o.tls.cert }, (req, res) => this.handle(req, res))
      const listen = (on: string): Promise<string | undefined> =>
        new Promise((done) => {
          server.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'))
          server.listen(p, on, () => done(undefined))
        })
      let failed = await listen(any)
      if (failed === 'EAFNOSUPPORT' || failed === 'EADDRNOTAVAIL') failed = await listen((any = '0.0.0.0'))
      if (failed) continue
      server.on('error', (e) => console.error('[home-link]', e.message))
      this.server = server
      this.port = p
      this.origin = `https://${host.includes(':') ? `[${host}]` : host}:${p}`
      return p
    }
    throw new Error('no free port')
  }

  async stop(): Promise<void> {
    for (const s of this.streams.values()) s.res.end()
    this.streams.clear()
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((done) => server.close(() => done()).closeAllConnections())
  }

  // A one-time code for the owner's phone, as the link the QR code holds.
  makeCode(): { link: string; expiresAt: number } {
    const { code, expiresAt } = this.codes.make(null)
    return { link: pairingLink({ origin: this.origin, code, fp: this.o.tls.fingerprint }), expiresAt }
  }

  // Something the core tells the phones (a notification): to each one on the line.
  deliver(msg: unknown): void {
    for (const s of this.streams.values()) if (!s.res.writableEnded) s.res.write(`data: ${JSON.stringify(msg)}\n\n`)
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!isLocalAddress(req.socket.remoteAddress)) return void res.writeHead(403, BASE_HEADERS).end()
      const url = new URL(req.url ?? '/', 'https://x')
      const ip = req.socket.remoteAddress ?? ''
      if (url.pathname === '/pair' && req.method === 'POST') return void this.pair(req, res, ip)
      const key = /(?:^|;\s*)tucano=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      if (this.doors.blocked('signin', ip)) return void res.writeHead(429, { ...BASE_HEADERS, 'retry-after': '600' }).end()
      const core = this.o.core()
      if (!core) return void res.writeHead(503, BASE_HEADERS).end()
      if (!key || !PERSON_KEY.test(key)) return this.unauthorized(res, ip)
      void core.auth(key).then(
        (who) => {
          if (!who) return this.unauthorized(res, ip)
          if ('removed' in who) return void res.writeHead(401, BASE_HEADERS).end()
          this.signedIn(req, res, url, who, core, key)
        },
        () => !res.headersSent && res.writeHead(503, BASE_HEADERS).end()
      )
    } catch (e) {
      console.error('[home-link]', req.method, e instanceof Error ? e.message : e)
      if (!res.headersSent) res.writeHead(400, BASE_HEADERS).end()
    }
  }

  private unauthorized(res: ServerResponse, ip: string): void {
    this.doors.fail('signin', ip)
    res.writeHead(401, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('unauthorized')
  }

  // POST /pair {code, name, platform}: the phone's key, as {key}. A wrong, used or late code: 410.
  private async pair(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (this.doors.blocked('join', ip)) return void res.writeHead(429, { ...BASE_HEADERS, 'retry-after': '600' }).end()
    let asked: { code?: unknown; name?: unknown; platform?: unknown } = {}
    try {
      asked = JSON.parse(await body(req, 4 * 1024)) as typeof asked
    } catch {
      return void res.writeHead(400, BASE_HEADERS).end()
    }
    const spent = this.codes.spend(asked?.code)
    const key = spent ? await this.o.core()?.deviceKey(deviceLabel(asked?.name, asked?.platform)) : undefined
    if (!key) {
      this.doors.fail('join', ip)
      return json(res, 410, { error: 'Esse código já foi usado ou passou do prazo. Gere outro no Tucano do computador. · That code was already used or has expired. Make a new one in Tucano on your computer.' })
    }
    json(res, 200, { key })
    this.o.onChange?.()
  }

  private signedIn(req: IncomingMessage, res: ServerResponse, url: URL, who: Person, core: HomeCore, key: string): void {
    if (url.pathname === '/events') {
      const id = randomUUID()
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`event: hello\ndata: ${id}\n\n`)
      // Disconnected from the computer (the core closed the port): the phone loses the line now,
      // and its next request finds its key gone.
      const device = createHash('sha256').update(key).digest('base64url')
      const port = core.open(who.id, (msg) => void (!res.writableEnded && res.write(`data: ${JSON.stringify(msg)}\n\n`)), {
        device,
        onClose: () => {
          if (this.streams.delete(id)) this.o.onChange?.()
          if (!res.writableEnded) res.end()
        }
      })
      this.streams.set(id, { person: who.id, res, port })
      // A beat the phone hears: it tells a dead line from a quiet one.
      const beat = setInterval(() => !res.writableEnded && res.write('event: ping\ndata: \n\n'), 25_000)
      req.on('close', () => {
        clearInterval(beat)
        this.streams.delete(id)
        port.close()
        this.o.onChange?.()
      })
      this.o.onChange?.()
      return
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      const s = this.streams.get(url.searchParams.get('c') ?? '')
      if (!s || s.person !== who.id) return void res.writeHead(410, BASE_HEADERS).end()
      body(req).then(
        (text) => {
          let data: unknown
          try {
            data = JSON.parse(text)
          } catch {
            return void res.writeHead(400, BASE_HEADERS).end()
          }
          s.port.post(data)
          res.writeHead(204, BASE_HEADERS).end()
        },
        () => res.writeHead(413, BASE_HEADERS).end()
      )
      return
    }

    // The conversation open on the phone: the desktop's window keeps telling its own, so the phone's isn't passed on.
    if (url.pathname === '/viewing' && req.method === 'POST') return void req.resume().on('end', () => res.writeHead(204, BASE_HEADERS).end())

    // What the agents showed in the chat, sandboxed as on the desktop.
    const art = /^\/artifact\/([0-9a-f-]{36})\/([^/]+)$/.exec(url.pathname)
    if (art && req.method === 'GET') {
      const dir = join(core.dataDir(), 'artifacts', art[1]!)
      const name = decodedPath(art[2]!)
      const path = name === undefined ? '' : normalize(join(dir, name))
      if (!path.startsWith(dir + sep) || !existsSync(path) || !statSync(path).isFile()) return void res.writeHead(404, BASE_HEADERS).end()
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'content-security-policy': ARTIFACT_CSP })
      return void createReadStream(path).on('error', () => res.destroy()).pipe(res)
    }

    // A file from the phone for a message: ~/Enviados, under its own name (a number added when taken).
    if (url.pathname === '/upload' && req.method === 'POST') {
      if (url.searchParams.get('for') !== 'message') return void res.writeHead(403, BASE_HEADERS).end()
      const name = (url.searchParams.get('name') ?? 'file').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
      const dir = this.o.sentDir ?? join(homedir(), 'Enviados')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      let path = join(dir, name)
      for (let n = 2; existsSync(path); n++) path = join(dir, name.replace(/(\.[^.]*)?$/, ` (${n})$1`))
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
      req.pipe(out).on('finish', () => !res.headersSent && json(res, 200, { path }))
      return
    }

    res.writeHead(404, BASE_HEADERS).end()
  }
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

const json = (res: ServerResponse, status: number, value: unknown): void =>
  void res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value))
