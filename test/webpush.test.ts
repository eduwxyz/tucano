import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { webPushError } from '../src/renderer/src/components/WebPushRow'
import { Doors, signIn } from '../src/server/guard'
import { deviceOf, encrypt, pushEndpoint, pwaFile, vapidAuth, vapidKeys, WebPush, webPushOn, webPushRoute } from '../src/server/webpush'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tucano-webpush-'))
const b64u = (b: Buffer): string => b.toString('base64url')

// A browser's side of a subscription: its keys, and how it reads what arrives.
function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    endpoint,
    keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
    read(body: Buffer): unknown {
      const salt = body.subarray(0, 16)
      const idLen = body[20]!
      const server = body.subarray(21, 21 + idLen)
      const hkdf = (ikm: Buffer, s: Buffer, info: string | Buffer, n: number): Buffer => Buffer.from(hkdfSync('sha256', ikm, s, info, n))
      const ikm = hkdf(ecdh.computeSecret(server), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), server]), 32)
      const sealed = body.subarray(21 + idLen)
      const d = createDecipheriv('aes-128-gcm', hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12))
      d.setAuthTag(sealed.subarray(-16))
      const plain = Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()])
      expect(plain.at(-1)).toBe(2)
      return JSON.parse(plain.subarray(0, -1).toString())
    }
  }
}

// What the push services were sent, answering each address with its status (201 unless told), and
// how many were in flight at most.
function pushServices(status: Record<string, number> = {}) {
  const sent: { endpoint: string; headers: Record<string, string>; body: Buffer; redirect?: string }[] = []
  let flying = 0
  const seen = { most: 0 }
  const fetch = (async (url: string, init: { headers: Record<string, string>; body: Buffer; redirect?: string }) => {
    sent.push({ endpoint: url, headers: init.headers, body: init.body, ...(init.redirect ? { redirect: init.redirect } : {}) })
    seen.most = Math.max(seen.most, ++flying)
    await new Promise((r) => setTimeout(r, 5))
    flying--
    const code = status[url] ?? 201
    return new Response(null, { status: code, ...(code >= 300 && code < 400 ? { headers: { location: 'http://127.0.0.1:7337/rpc' } } : {}) })
  }) as unknown as typeof globalThis.fetch
  return { sent, fetch, seen }
}

function webPush(o: { data?: string; devices?: Record<string, string[]>; fetch?: typeof fetch; ownerDevice?: string } = {}): WebPush {
  const data = o.data ?? dir()
  return new WebPush({ dataDir: data, vapid: vapidKeys(data), subject: 'https://tucano.example.com', devicesOf: async (p) => o.devices?.[p], ...(o.ownerDevice ? { ownerDevice: o.ownerDevice } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) })
}

describe('the VAPID keys', () => {
  it('are made once, kept for this user only, and the same on the next start', () => {
    const data = dir()
    const a = vapidKeys(data)
    const file = join(data, 'webpush-vapid.json')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(vapidKeys(data).publicKey).toBe(a.publicKey)
    const raw = Buffer.from(a.publicKey, 'base64url')
    expect(raw.length).toBe(65)
    expect(raw[0]).toBe(4)
    // What a browser gets is the public point alone: the private part stays in the file.
    expect(a.publicKey).not.toContain((JSON.parse(readFileSync(file, 'utf8')) as { d: string }).d)
  })

  it('sign a token the push service can check, for its own origin', () => {
    const v = vapidKeys(dir())
    const header = vapidAuth('https://fcm.googleapis.com/fcm/send/abc', v, 'https://tucano.example.com', 1_000_000)
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!
    expect(k).toBe(v.publicKey)
    const [h, c, s] = t!.split('.')
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString()) as { aud: string; exp: number; sub: string }
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1000 + 12 * 3600, sub: 'https://tucano.example.com' })
    const raw = Buffer.from(k!, 'base64url')
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' })
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true)
  })
})

describe('the message to a browser (RFC 8291)', () => {
  it('matches the RFC’s own example', () => {
    const local = createECDH('prime256v1')
    local.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'))
    const out = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', {
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      local
    })
    expect(b64u(out)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    )
  })

  it('takes only the browsers’ push services as addresses', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://api.push.apple.com/x'])
      expect(pushEndpoint(ok)).toBe(ok)
    for (const bad of [
      'http://fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://evilgoogleapis.com/x',
      'https://storage.googleapis.com/bucket/x', // Google, but not its push service
      'https://android.googleapis.com/gcm/send/x',
      'https://notify.windows.com.evil.example/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://169.254.169.254/latest',
      42
    ])
      expect(pushEndpoint(bad)).toBeUndefined()
  })
})

describe('sending', () => {
  it('reaches only the subscriptions of the people it is for, and everyone’s when it names no one', async () => {
    const services = pushServices()
    const wp = webPush({ fetch: services.fetch })
    const ana = browser()
    const bia = browser()
    wp.add(ana, 'ana', 'dev-ana')
    wp.add(bia, 'bia', 'dev-bia')
    expect(await wp.send({ title: 'Aprovação', body: 'O agente quer rodar um comando', conversationId: 'c1', kind: 'approval' }, ['ana'])).toBe(1)
    expect(services.sent.map((s) => s.endpoint)).toEqual([ana.endpoint])
    expect(ana.read(services.sent[0]!.body)).toEqual({ title: 'Aprovação', body: 'O agente quer rodar um comando', conversationId: 'c1', kind: 'approval' })
    expect(services.sent[0]!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', urgency: 'high' })
    expect(services.sent[0]!.headers['authorization']).toMatch(/^vapid t=.+, k=/)
    // Someone else's browser can't read it.
    expect(() => bia.read(services.sent[0]!.body)).toThrow()
    services.sent.length = 0
    expect(await wp.send({ title: 'Pronto', body: 'Resposta pronta' }, undefined)).toBe(2)
    expect(services.sent.map((s) => s.endpoint).sort()).toEqual([ana.endpoint, bia.endpoint].sort())
    services.sent.length = 0
    expect(await wp.send({ title: 'x', body: 'y' }, ['carla'])).toBe(0)
    expect(services.sent).toEqual([])
  })

  it('forgets a subscription the push service no longer knows (404, 410), and keeps one that only failed', async () => {
    const gone = browser()
    const lost = browser()
    const down = browser()
    const data = dir()
    const services = pushServices({ [gone.endpoint]: 410, [lost.endpoint]: 404, [down.endpoint]: 500 })
    const wp = webPush({ data, fetch: services.fetch })
    for (const b of [gone, lost, down]) wp.add(b, 'ana', 'dev')
    await wp.send({ title: 't', body: 'b' }, ['ana'])
    expect(wp.list().map((s) => s.endpoint)).toEqual([down.endpoint])
    // And so does the next start.
    expect(webPush({ data }).list().map((s) => s.endpoint)).toEqual([down.endpoint])
    if (process.platform !== 'win32') expect(statSync(join(data, 'webpush-subscriptions.json')).mode & 0o777).toBe(0o600)
  })

  it('stops for a device that was disconnected and for someone removed, never for the owner’s own sign-in', async () => {
    const owner = deviceOf('the-owner-token')
    const wp = webPush({ devices: { ana: ['kept'], own: [] }, ownerDevice: owner })
    const kept = browser()
    const dropped = browser()
    const ownerBrowser = browser()
    wp.add(kept, 'ana', 'kept')
    wp.add(dropped, 'ana', 'disconnected')
    wp.add(ownerBrowser, 'own', owner)
    await wp.pruneAll()
    expect(wp.list().map((s) => s.endpoint).sort()).toEqual([kept.endpoint, ownerBrowser.endpoint].sort())
    wp.forget('ana')
    expect(wp.list().map((s) => s.endpoint)).toEqual([ownerBrowser.endpoint])
  })

  // The core turns a port away for more than a removal (access changed, a moment of doubt): no list
  // is never "no devices". Only person-removed (forget) or a device missing from a real list counts.
  it('keeps everything when the core turns the asking away or doesn’t answer', async () => {
    const wp = webPush({ devices: {} })
    wp.add(browser(), 'ana', 'dev')
    await wp.prune('ana')
    await wp.pruneAll()
    expect(wp.list()).toHaveLength(1)
  })

  it('follows redirects nowhere: a 3xx is a failure, and the subscription stays', async () => {
    const b = browser()
    const services = pushServices({ [b.endpoint]: 302 })
    const wp = webPush({ fetch: services.fetch })
    wp.add(b, 'ana', 'dev')
    expect(await wp.send({ title: 't', body: 'b' }, ['ana'])).toBe(0)
    expect(services.sent.map((s) => s.redirect)).toEqual(['manual'])
    expect(services.sent).toHaveLength(1)
    expect(wp.list()).toHaveLength(1)
  })

  it('forgets a subscription turned away three times in a row (400, 401, 403), counting again after one that went', async () => {
    const b = browser()
    const status: Record<string, number> = { [b.endpoint]: 403 }
    const services = pushServices(status)
    const data = dir()
    const wp = webPush({ data, fetch: services.fetch })
    wp.add(b, 'ana', 'dev')
    await wp.send({ title: 't', body: 'b' }, undefined)
    status[b.endpoint] = 401
    await wp.send({ title: 't', body: 'b' }, undefined)
    status[b.endpoint] = 201
    await wp.send({ title: 't', body: 'b' }, undefined)
    expect(wp.list()[0]!.strikes).toBe(0)
    status[b.endpoint] = 400
    for (let i = 0; i < 2; i++) await wp.send({ title: 't', body: 'b' }, undefined)
    expect(webPush({ data }).list()[0]!.strikes).toBe(2) // kept across a restart
    await wp.send({ title: 't', body: 'b' }, undefined)
    expect(wp.list()).toEqual([])
  })

  it('keeps at most ten browsers a person, dropping the oldest', () => {
    const wp = webPush()
    const ana = Array.from({ length: 12 }, () => browser())
    const bia = browser()
    wp.add(bia, 'bia', 'dev')
    for (const b of ana) wp.add(b, 'ana', 'dev')
    expect(wp.list().filter((s) => s.person === 'ana').map((s) => s.endpoint)).toEqual(ana.slice(2).map((b) => b.endpoint))
    expect(wp.list().some((s) => s.endpoint === bia.endpoint)).toBe(true)
  })

  it('sends a few at a time', async () => {
    const services = pushServices()
    const wp = webPush({ fetch: services.fetch })
    for (const p of ['a', 'b', 'c']) for (let i = 0; i < 6; i++) wp.add(browser(), p, 'dev')
    expect(await wp.send({ title: 't', body: 'b' }, undefined)).toBe(18)
    expect(services.seen.most).toBe(5)
  })
})

describe('the subscription route', () => {
  let server: Server | undefined
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

  // As src/server/index.ts does: signed in first (guard.ts), then the route, as that person and sign-in.
  async function serve(wp: WebPush | undefined, keys: Record<string, string>): Promise<string> {
    const doors = new Doors()
    server = createServer((req, res) => {
      const cookie = /(?:^|;\s*)tucano=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      void signIn({ cookie, ip: 'x', doors, isOwnerToken: (t) => t === 'owner-token', strongOwnerToken: true, lookup: async (k) => (keys[k] ? { person: { id: keys[k], name: keys[k], role: 'member' } as never } : undefined) }).then((r) => {
        if (r.status === 'owner') return webPushRoute(wp, req, res, new URL(req.url!, 'http://x').pathname, { person: 'owner', device: deviceOf(cookie) })
        if (r.status === 'person') return webPushRoute(wp, req, res, new URL(req.url!, 'http://x').pathname, { person: r.person.id, device: deviceOf(cookie) })
        res.writeHead(401).end()
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }
  const anaKey = `p_${'a'.repeat(43)}`
  const biaKey = `p_${'b'.repeat(43)}`
  const post = (url: string, path: string, data: unknown, cookie?: string, origin?: string) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `tucano=${cookie}` } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify(data) })

  it('needs someone signed in', async () => {
    const wp = webPush()
    const url = await serve(wp, { [anaKey]: 'ana' })
    expect((await post(url, '/webpush/subscribe', browser())).status).toBe(401)
    expect((await post(url, '/webpush/subscribe', browser(), `p_${'z'.repeat(43)}`)).status).toBe(401)
    expect((await fetch(`${url}/webpush/key`)).status).toBe(401)
    expect(wp.list()).toEqual([])
  })

  it('keeps a subscription as the person and the sign-in that sent it, and only from this page', async () => {
    const wp = webPush()
    const url = await serve(wp, { [anaKey]: 'ana', [biaKey]: 'bia' })
    expect(await (await fetch(`${url}/webpush/key`, { headers: { cookie: `tucano=${anaKey}` } })).json()).toEqual({ key: wp.publicKey })
    const b = browser()
    expect((await post(url, '/webpush/subscribe', b, anaKey, 'https://evil.example')).status).toBe(403)
    expect((await post(url, '/webpush/subscribe', { ...b, endpoint: 'https://127.0.0.1/x' }, anaKey)).status).toBe(400)
    expect((await post(url, '/webpush/subscribe', b, anaKey)).status).toBe(204)
    expect(wp.list()).toMatchObject([{ endpoint: b.endpoint, person: 'ana', device: deviceOf(anaKey) }])
    // Someone else can neither take it off nor test it.
    expect((await post(url, '/webpush/unsubscribe', { endpoint: b.endpoint }, biaKey)).status).toBe(204)
    expect(wp.list()).toHaveLength(1)
    expect((await post(url, '/webpush/test', { endpoint: b.endpoint }, biaKey)).status).toBe(404)
    expect((await post(url, '/webpush/unsubscribe', { endpoint: b.endpoint }, anaKey)).status).toBe(204)
    expect(wp.list()).toEqual([])
  })

  it('answers a body that is no object with a 400, never leaving the request hanging', async () => {
    const wp = webPush()
    const url = await serve(wp, { [anaKey]: 'ana' })
    for (const path of ['/webpush/subscribe', '/webpush/unsubscribe', '/webpush/test'])
      for (const data of [null, [], 'x', 3, { endpoint: browser().endpoint, keys: null }])
        expect((await post(url, path, data, anaKey)).status, `${path} ${JSON.stringify(data)}`).toBe(400)
    const raw = await fetch(`${url}/webpush/subscribe`, { method: 'POST', headers: { cookie: `tucano=${anaKey}` }, body: '{not json' })
    expect(raw.status).toBe(400)
    expect(wp.list()).toEqual([])
  })

  it('answers 500, not silence, when something breaks inside', async () => {
    const wp = webPush()
    wp.add = () => {
      throw new Error('disk full')
    }
    const url = await serve(wp, { [anaKey]: 'ana' })
    expect((await post(url, '/webpush/subscribe', browser(), anaKey)).status).toBe(500)
  })

  it('sends the test to that one browser', async () => {
    const services = pushServices()
    const wp = webPush({ fetch: services.fetch })
    const url = await serve(wp, { [anaKey]: 'ana' })
    const mine = browser()
    const other = browser()
    wp.add(other, 'ana', 'elsewhere')
    expect((await post(url, '/webpush/subscribe', mine, anaKey)).status).toBe(204)
    expect(await (await post(url, '/webpush/test', { endpoint: mine.endpoint, lang: 'en' }, anaKey)).json()).toEqual({ sent: 1 })
    expect(services.sent.map((s) => s.endpoint)).toEqual([mine.endpoint])
    expect(mine.read(services.sent[0]!.body)).toEqual({ title: 'Tucano', body: 'Notifications are coming through on this device.', test: true })
  })

  // The phone's case: the browser subscribed again (a new address), or the server never heard of it.
  // The test carries the subscription as it is now, which the server keeps before sending.
  it('tests the subscription the browser has now, even one the server didn’t know', async () => {
    const services = pushServices()
    const wp = webPush({ fetch: services.fetch })
    const url = await serve(wp, { [anaKey]: 'ana' })
    const old = browser()
    wp.add(old, 'ana', deviceOf(anaKey))
    const now = browser()
    expect(await (await post(url, '/webpush/test', { ...now, lang: 'pt-BR' }, anaKey)).json()).toEqual({ sent: 1 })
    expect(services.sent.map((s) => s.endpoint)).toEqual([now.endpoint])
    expect(wp.list().find((s) => s.endpoint === now.endpoint)).toMatchObject({ person: 'ana', device: deviceOf(anaKey) })
  })

  it('says why a test didn’t go: no subscription, or what the push service answered', async () => {
    const refused = browser()
    const services = pushServices({ [refused.endpoint]: 403 })
    const wp = webPush({ fetch: services.fetch })
    const url = await serve(wp, { [anaKey]: 'ana' })
    const none = await post(url, '/webpush/test', { endpoint: browser().endpoint }, anaKey)
    expect([none.status, await none.json()]).toEqual([404, { error: 'no subscription' }])
    const r = await post(url, '/webpush/test', refused, anaKey)
    expect([r.status, await r.json()]).toEqual([502, { sent: 0, error: 'push service 403', status: 403 }])
    const bad = await post(url, '/webpush/subscribe', { ...refused, endpoint: 'https://127.0.0.1/x' }, anaKey)
    expect([bad.status, await bad.json()]).toEqual([400, { error: 'not a push service address or keys' }])
  })
})

describe('the settings row’s errors', () => {
  it('say the reason and the HTTP status, never only “try again”', () => {
    expect(webPushError({ code: 'push', status: 502, detail: 'push service 403' })).toBe('O serviço de notificações do navegador recusou o envio. (HTTP 502: push service 403)')
    expect(webPushError({ code: 'nosub', status: 404, detail: 'no subscription' })).toContain('não está inscrito')
    expect(webPushError({ code: 'signin', status: 0 })).toContain('login do proxy')
    expect(webPushError({ code: 'denied', status: 403, detail: 'another origin' })).toContain('HTTP 403: another origin')
    expect(webPushError({ code: 'network', status: 0, detail: 'Failed to fetch' })).toContain('(Failed to fetch)')
    expect(webPushError(new Error('boom'))).toContain('boom')
  })
})

describe('TUCANO_WEBPUSH=off', () => {
  it('turns it off, and on is the default', () => {
    expect(webPushOn({})).toBe(true)
    expect(webPushOn({ TUCANO_WEBPUSH: '1' })).toBe(true)
    for (const off of ['off', 'OFF', '0', 'false', 'no']) expect(webPushOn({ TUCANO_WEBPUSH: off })).toBe(false)
  })

  it('leaves no route to subscribe with', async () => {
    const server = createServer((req, res) => void webPushRoute(undefined, req, res, new URL(req.url!, 'http://x').pathname, { person: 'ana', device: 'd' }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${url}/webpush/key`)).status).toBe(404)
    expect((await fetch(`${url}/webpush/subscribe`, { method: 'POST', body: JSON.stringify(browser()) })).status).toBe(404)
    await new Promise((r) => server.close(r))
  })

  it('serves no app to install, and a worker that takes itself away', async () => {
    const page = dir()
    writeFileSync(join(page, 'sw.js'), '// the real worker')
    writeFileSync(join(page, 'manifest.webmanifest'), '{}')
    const server = createServer((req, res) => {
      const on = req.headers['x-on'] === '1'
      if (!pwaFile(new URL(req.url!, 'http://x').pathname, res, page, on)) res.writeHead(401).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect(await (await fetch(`${url}/sw.js`, { headers: { 'x-on': '1' } })).text()).toBe('// the real worker')
    expect((await fetch(`${url}/manifest.webmanifest`, { headers: { 'x-on': '1' } })).status).toBe(200)
    const off = await fetch(`${url}/sw.js`)
    expect(off.headers.get('content-type')).toMatch(/javascript/)
    expect(await off.text()).toContain('self.registration.unregister()')
    expect((await fetch(`${url}/manifest.webmanifest`)).status).toBe(401)
    expect((await fetch(`${url}/icon-192.png`)).status).toBe(401)
    await new Promise((r) => server.close(r))
  })
})
