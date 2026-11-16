// Web Push for the browsers people keep Tucano in (the app installed from Chrome on Android, Chrome or
// Edge on a computer): the notifications the open pages get, also while no page is open. The message
// is encrypted for the browser (RFC 8291, aes128gcm) and signed by this server (RFC 8292, VAPID), with
// node:crypto alone. The VAPID private key is made once and never leaves TUCANO_DATA. Each browser's
// subscription is someone's, from one of their sign-ins: it gets what the core says is theirs, and goes
// when that sign-in or that person does. TUCANO_WEBPUSH=off turns it all off.
import { createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type ECDH, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { BASE_HEADERS, body, sameOrigin } from './guard'

export const webPushOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(off|0|false|no)$/i.test(env['TUCANO_WEBPUSH']?.trim() ?? '')

const b64u = (b: Buffer): string => b.toString('base64url')
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url')

// The server's VAPID keys: made on the first start, kept in a file only this user reads.
export interface Vapid {
  publicKey: string // the raw P-256 point, base64url: what a browser subscribes with
  privateKey: KeyObject
}

export function vapidKeys(dataDir: string): Vapid {
  const file = join(dataDir, 'webpush-vapid.json')
  if (!existsSync(file)) {
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
    writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 })
  }
  chmodSync(file, 0o600)
  const jwk = JSON.parse(readFileSync(file, 'utf8')) as { x: string; y: string; d: string }
  const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', ...jwk }, format: 'jwk' })
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateKey }
}

// RFC 8292: who sends (sub) to which push service (aud), signed with the VAPID key, good for 12 hours.
export function vapidAuth(endpoint: string, vapid: Vapid, subject: string, now = Date.now()): string {
  const part = (o: unknown): string => b64u(Buffer.from(JSON.stringify(o)))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`
  const signature = sign('sha256', Buffer.from(unsigned), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${b64u(signature)}, k=${vapid.publicKey}`
}

// RFC 8291: the message, readable only by the browser that holds this subscription's keys. One
// record, so the whole message has to fit one (the push services take 4 KB). `salt` and `local`
// are for the RFC's own example; each message gets new ones.
export function encrypt(plain: Buffer, p256dh: string, auth: string, o: { salt?: Buffer; local?: ECDH } = {}): Buffer {
  const browser = unb64u(p256dh)
  const local = o.local ?? createECDH('prime256v1')
  if (!o.local) local.generateKeys()
  const localPublic = local.getPublicKey()
  const salt = o.salt ?? randomBytes(16)
  const hkdf = (ikm: Buffer, s: Buffer, info: string | Buffer, len: number): Buffer => Buffer.from(hkdfSync('sha256', ikm, s, info, len))
  const ikm = hkdf(local.computeSecret(browser), unb64u(auth), Buffer.concat([Buffer.from('WebPush: info\0'), browser, localPublic]), 32)
  const key = hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16)
  const nonce = hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12)
  const cipher = createCipheriv('aes-128-gcm', key, nonce)
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const head = Buffer.alloc(21)
  salt.copy(head, 0)
  head.writeUInt32BE(4096, 16)
  head[20] = localPublic.length
  return Buffer.concat([head, localPublic, sealed])
}

// A browser's subscription, and whose: the person and the sign-in (the hash of its cookie) it came from.
export interface Subscription {
  endpoint: string
  p256dh: string
  auth: string
  person: string
  device: string
  at: number
  strikes?: number // refusals in a row
}

export interface WebPushNote {
  title: string
  body: string
  conversationId?: string
  threadId?: string
  kind?: string
  page?: string
  test?: boolean // shown even with a page in front
}

// Only the browsers' own push services: an address someone signed in hands over is never one of this
// server's neighbours. FCM (Chrome), Mozilla's, Apple's, and WNS (Edge), whose hosts vary by region.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'])
const PUSH_DOMAINS = ['.notify.windows.com', '.push.apple.com']
export function pushEndpoint(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return undefined
  try {
    const u = new URL(endpoint)
    const known = PUSH_HOSTS.has(u.hostname) || PUSH_DOMAINS.some((d) => u.hostname.endsWith(d))
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && known ? u.href : undefined
  } catch {
    return undefined
  }
}

export const MAX_PER_PERSON = 10 // browsers a person keeps subscribed: past it, the oldest goes
export const MAX_STRIKES = 3 // refusals in a row (400, 401, 403) before a subscription goes
const PARALLEL = 5 // pushes in flight at once

const cut = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

export class WebPush {
  private subs: Subscription[]
  private file: string

  constructor(
    private o: {
      dataDir: string
      vapid: Vapid
      subject: string // the VAPID contact: the server's https address, or a mailto:
      devicesOf: (person: string) => Promise<string[] | undefined> // the person's sign-ins now; undefined: no answer
      ownerDevice?: string // the owner's token's sign-in, which is no device key
      fetch?: typeof fetch
      now?: () => number
    }
  ) {
    this.file = join(o.dataDir, 'webpush-subscriptions.json')
    try {
      const list = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      this.subs = Array.isArray(list) ? (list as Subscription[]).filter((s) => s && pushEndpoint(s.endpoint) && typeof s.person === 'string') : []
    } catch {
      this.subs = []
    }
  }

  get publicKey(): string {
    return this.o.vapid.publicKey
  }

  list(): readonly Subscription[] {
    return this.subs
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.subs), { mode: 0o600 })
    renameSync(tmp, this.file)
    chmodSync(this.file, 0o600)
  }

  // A browser subscribes (or says so again): the same address moves to whoever signed in last.
  add(sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }, person: string, device: string): boolean {
    const endpoint = pushEndpoint(sub.endpoint)
    const { p256dh, auth } = sub.keys ?? {}
    if (!endpoint || typeof p256dh !== 'string' || typeof auth !== 'string' || unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) return false
    // A strict order, so "the oldest" is always one.
    const at = Math.max((this.o.now ?? Date.now)(), ...this.subs.map((s) => s.at + 1))
    this.subs = [...this.subs.filter((s) => s.endpoint !== endpoint), { endpoint, p256dh, auth, person, device, at }]
    const theirs = this.subs.filter((s) => s.person === person).sort((a, b) => a.at - b.at)
    const over = new Set(theirs.slice(0, Math.max(0, theirs.length - MAX_PER_PERSON)).map((s) => s.endpoint))
    if (over.size) this.subs = this.subs.filter((s) => !over.has(s.endpoint))
    this.save()
    return true
  }

  // Only the person's own.
  remove(endpoint: unknown, person: string): boolean {
    const before = this.subs.length
    this.subs = this.subs.filter((s) => !(s.endpoint === endpoint && s.person === person))
    if (this.subs.length === before) return false
    this.save()
    return true
  }

  // Someone removed: their browsers get nothing more.
  forget(person: string): void {
    if (!this.subs.some((s) => s.person === person)) return
    this.subs = this.subs.filter((s) => s.person !== person)
    this.save()
  }

  // Their sign-ins changed (a device disconnected): only the browsers of the ones left keep getting them.
  // No list (the core didn't answer, or turned the asking away): nothing goes; a removal is forget's.
  async prune(person: string): Promise<void> {
    if (!this.subs.some((s) => s.person === person)) return
    const devices = await this.o.devicesOf(person)
    if (!devices) return
    const keep = (s: Subscription): boolean => s.person !== person || devices.includes(s.device) || (!!this.o.ownerDevice && s.device === this.o.ownerDevice)
    if (this.subs.every(keep)) return
    this.subs = this.subs.filter(keep)
    this.save()
  }

  async pruneAll(): Promise<void> {
    for (const person of new Set(this.subs.map((s) => s.person))) await this.prune(person)
  }

  // `to`: the people it's for, by id (the core's rule, as for the open pages); unset, everyone.
  // `only`: one browser (Settings › Test). Fire and forget: a push service that's down only means none this time.
  async send(note: WebPushNote, to: string[] | undefined, only?: string): Promise<number> {
    const targets = this.subs.filter((s) => (only ? s.endpoint === only : !to || to.includes(s.person)))
    return [...(await this.deliver(note, targets)).values()].filter((o) => o.ok).length
  }

  // Settings › Test: this one browser, and what its push service said.
  async test(endpoint: string, note: WebPushNote): Promise<Outcome> {
    const s = this.subs.find((x) => x.endpoint === endpoint)
    return s ? ((await this.deliver(note, [s])).get(endpoint) ?? { ok: false, error: 'not sent' }) : { ok: false, error: 'no subscription' }
  }

  private async deliver(note: WebPushNote, targets: Subscription[]): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>()
    if (!targets.length) return out
    const payload = Buffer.from(
      JSON.stringify({
        title: cut(note.title, 120),
        body: cut(note.body, 600),
        ...(note.conversationId ? { conversationId: note.conversationId } : {}),
        ...(note.threadId ? { threadId: note.threadId } : {}),
        ...(note.kind ? { kind: note.kind } : {}),
        ...(note.page ? { page: note.page } : {}),
        ...(note.test ? { test: true } : {})
      })
    )
    const gone = new Set<string>()
    let changed = false
    const one = async (s: Subscription): Promise<void> => {
      try {
        const r = await (this.o.fetch ?? fetch)(s.endpoint, {
          method: 'POST',
          headers: {
            authorization: vapidAuth(s.endpoint, this.o.vapid, this.o.subject, (this.o.now ?? Date.now)()),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(24 * 3600),
            urgency: note.kind === 'approval' || note.kind === 'question' ? 'high' : 'normal'
          },
          body: new Uint8Array(encrypt(payload, s.p256dh, s.auth)),
          redirect: 'manual', // a push service answers itself: it never sends this server elsewhere
          signal: AbortSignal.timeout(15_000)
        })
        // The push service no longer knows that browser (it unsubscribed, its data was cleared), or
        // keeps turning it away.
        out.set(s.endpoint, r.status >= 200 && r.status < 300 ? { ok: true, status: r.status } : { ok: false, status: r.status, error: r.status ? `push service ${r.status}` : 'push service redirected' })
        if (r.status === 404 || r.status === 410) gone.add(s.endpoint)
        else if (r.status === 400 || r.status === 401 || r.status === 403) {
          s.strikes = (s.strikes ?? 0) + 1
          changed = true
          if (s.strikes >= MAX_STRIKES) gone.add(s.endpoint)
          console.error('[webpush]', r.status, new URL(s.endpoint).host)
        } else if (r.status < 200 || r.status >= 300) console.error('[webpush]', r.status || 'redirect', new URL(s.endpoint).host)
        else if (s.strikes) [s.strikes, changed] = [0, true]
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        out.set(s.endpoint, { ok: false, error })
        console.error('[webpush]', error)
      }
    }
    // A few at a time, not hundreds of requests at once.
    const queue = [...targets]
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        for (let s = queue.shift(); s; s = queue.shift()) await one(s)
      })
    )
    if (gone.size) this.subs = this.subs.filter((s) => !gone.has(s.endpoint))
    if (gone.size || changed) this.save()
    return out
  }
}

// What a push service did with one message.
export interface Outcome {
  ok: boolean
  status?: number
  error?: string
}

// The sign-in a browser's cookie is, as a device: its hash, as the core keeps a person's keys.
export const deviceOf = (cookie: string | undefined): string => (cookie ? createHash('sha256').update(cookie).digest('base64url') : '')

// /webpush/*, signed in: the key to subscribe with, a subscription in and out, and a test to this browser.
export async function webPushRoute(wp: WebPush | undefined, req: IncomingMessage, res: ServerResponse, path: string, who: { person: string | undefined; device: string }): Promise<void> {
  const answer = (status: number, value?: unknown): void => {
    if (res.headersSent) return
    // What each request got, for the log: never a key, a cookie or a whole address.
    const why = value && typeof value === 'object' && 'error' in value ? ` ${String((value as { error: unknown }).error)}` : ''
    console.log(`[webpush] ${req.method} ${path} ${status}${why}${who.person ? '' : ' (no person)'}`)
    res.writeHead(status, { ...BASE_HEADERS, 'cache-control': 'no-store', ...(value === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }) }).end(value === undefined ? undefined : JSON.stringify(value))
  }
  // Every request gets an answer, whatever goes wrong.
  try {
    await route(wp, req, path, who, answer)
  } catch (e) {
    console.error('[webpush]', e instanceof Error ? e.message : e)
    answer(500)
  }
}

async function route(wp: WebPush | undefined, req: IncomingMessage, path: string, who: { person: string | undefined; device: string }, answer: (status: number, value?: unknown) => void): Promise<void> {
  // Behind a proxy that rewrites Host, this is where a page's requests would stop: both names say why.
  if (!sameOrigin(req)) return answer(403, { error: `another origin (${String(req.headers.origin ?? '').replace(/^https?:\/\//, '')} vs ${req.headers.host ?? ''})` })
  if (!wp) return answer(404, { error: 'web push is off' })
  if (!who.person || !who.device) return answer(403, { error: 'no person or sign-in' })
  if (path === '/webpush/key' && req.method === 'GET') return answer(200, { key: wp.publicKey })
  if (req.method !== 'POST') return answer(404, { error: 'not found' })
  let data: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; lang?: unknown }
  try {
    data = JSON.parse(await body(req, 8 * 1024)) as typeof data
  } catch {
    return answer(400, { error: 'unreadable body' })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data.keys !== undefined && (!data.keys || typeof data.keys !== 'object'))) return answer(400, { error: 'body is no subscription' })
  if (path === '/webpush/subscribe') return wp.add(data, who.person, who.device) ? answer(204) : answer(400, { error: 'not a push service address or keys' })
  if (path === '/webpush/unsubscribe') return void (wp.remove(pushEndpoint(data.endpoint) ?? data.endpoint, who.person), answer(204))
  if (path === '/webpush/test') {
    // The browser sends its subscription as it is now: kept again first, so the test goes where it is
    // (a browser that subscribed anew, or signed in again, is up to date).
    if (data.keys && !wp.add(data, who.person, who.device)) return answer(400, { error: 'not a push service address or keys' })
    const endpoint = pushEndpoint(data.endpoint)
    const mine = endpoint ? wp.list().find((s) => s.endpoint === endpoint && s.person === who.person) : undefined
    if (!mine) return answer(404, { error: 'no subscription' })
    const line = data.lang === 'en' ? 'Notifications are coming through on this device.' : 'As notificações estão chegando neste aparelho.'
    const r = await wp.test(mine.endpoint, { title: 'Tucano', body: line, test: true })
    return r.ok ? answer(200, { sent: 1 }) : answer(502, { sent: 0, error: r.error ?? 'not sent', ...(r.status ? { status: r.status } : {}) })
  }
  answer(404, { error: 'not found' })
}

// The app as something to install: these go to anyone, signed in or not (a browser fetches the
// manifest and its icons without the cookie), and say nothing about this Tucano.
const PUBLIC: Record<string, string> = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png'
}
// TUCANO_WEBPUSH=off: nothing to install, and a worker installed before takes itself and its cache
// away the next time the browser checks it.
const SW_OFF = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister().then(() => caches.keys()).then((n) => Promise.all(n.map((k) => caches.delete(k))))))
`
export function pwaFile(pathname: string, res: ServerResponse, pageDir: string, on = true): boolean {
  if (!on) {
    if (pathname !== '/sw.js') return false
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': PUBLIC['/sw.js']!, 'cache-control': 'no-cache' }).end(SW_OFF)
    return true
  }
  const type = PUBLIC[pathname]
  const path = type ? join(pageDir, pathname.slice(1)) : ''
  if (!type || !existsSync(path)) return false
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': type, 'cache-control': 'no-cache' }).end(readFileSync(path))
  return true
}

// What the page's head gets in a browser: the manifest, the bar's colour, and the worker's script.
// The manifest goes with the cookies: behind an auth proxy, the manifest is requested with credentials, like the page.
export const PWA_HEAD =
  '<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials" />\n    <meta name="theme-color" content="#f3f0ea" media="(prefers-color-scheme: light)" />\n    <meta name="theme-color" content="#121110" media="(prefers-color-scheme: dark)" />\n    <script src="./tucano-pwa.js"></script>\n    '
