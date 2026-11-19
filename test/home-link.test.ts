import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeLink, isLocalAddress, type HomeCore } from '../src/main/home-link'
import { fingerprintOf, makeCertificate, matches } from '../src/main/self-signed'
import type { Person } from '../src/shared/types'

describe('self-signed certificate', () => {
  it('is a valid X.509 signed by its own key, with the fingerprint the QR carries', () => {
    const c = makeCertificate('Tucano', ['eduardos-mac.local', '192.168.1.20'], new Date('2026-11-07T12:00:00Z'))
    const x = new X509Certificate(c.cert)
    expect(x.verify(x.publicKey)).toBe(true)
    expect(x.subject).toContain('CN=Tucano')
    expect(x.subjectAltName).toContain('DNS:eduardos-mac.local')
    expect(x.subjectAltName).toContain('IP Address:192.168.1.20')
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2036)
    expect(c.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/) // what the iPhone app's Pairing.parse takes
    expect(fingerprintOf(c.cert)).toBe(c.fingerprint)
    expect(matches(c)).toBe(true)
    expect(matches({ key: makeCertificate('x', []).key, cert: c.cert })).toBe(false)
  })
})

describe('isLocalAddress', () => {
  it('answers a home network, loopback and link-local, never the internet', () => {
    for (const ip of ['192.168.0.12', '::ffff:10.0.0.4', '172.20.1.1', '100.101.102.103', '127.0.0.1', '::1', 'fe80::1c2:3', 'fd7a:115c::1', '169.254.3.4']) expect(isLocalAddress(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '::ffff:1.1.1.1', '2001:db8::1', '172.32.0.1', undefined]) expect(isLocalAddress(ip)).toBe(false)
  })
})

const OWNER: Person = { id: 'owner-1', name: 'Eduardo', role: 'owner' } as Person

function fakeCore(dir: string): HomeCore & { keys: string[]; posted: unknown[]; say: (m: unknown) => void } {
  const keys: string[] = []
  const posted: unknown[] = []
  let listener: ((m: unknown) => void) | undefined
  return {
    keys,
    posted,
    say: (m) => listener?.(m),
    auth: async (key) => (keys.includes(key) ? OWNER : undefined),
    deviceKey: async () => {
      const k = `p_${'k'.repeat(42)}${keys.length}`
      keys.push(k)
      return k
    },
    open: (_person, onMessage) => {
      listener = onMessage
      return { post: (d) => posted.push(d), close: () => (listener = undefined) }
    },
    dataDir: () => dir
  }
}

type Reply = { status: number; body: string; fp: string }
function call(port: number, path: string, o: { method?: string; body?: string; cookie?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', rejectUnauthorized: false, agent: false, headers: { ...(o.cookie ? { cookie: `tucano=${o.cookie}` } : {}), 'content-type': 'application/json' } }, (res) => {
      const fp = createHash('sha256').update((res.socket as TLSSocket).getPeerCertificate().raw).digest('base64url')
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, fp }))
    })
    req.on('error', reject)
    req.end(o.body)
  })
}

// The first lines of an event stream, then it hangs up.
function listen(port: number, key: string, until: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/events', rejectUnauthorized: false, headers: { cookie: `tucano=${key}` } }, (res) => {
      let text = ''
      res.on('data', (c) => {
        text += c
        if (until(text)) (req.destroy(), resolve(text))
      })
    })
    req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)))
    req.end()
  })
}

describe('HomeLink', () => {
  let dir: string
  let link: HomeLink
  let core: ReturnType<typeof fakeCore>
  const tls = makeCertificate('Tucano', ['localhost'])

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'home-link-'))
    core = fakeCore(dir)
    link = new HomeLink({ tls, codesFile: join(dir, 'codes.json'), core: () => core, sentDir: join(dir, 'Enviados') })
  })
  afterEach(async () => {
    await link.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('pairs the phone once with a code, over the pinned certificate', async () => {
    const port = await link.start(47350, '127.0.0.1')
    const { link: qr } = link.makeCode()
    const u = new URL(qr)
    expect(u.protocol).toBe('tucano:')
    expect(u.searchParams.get('url')).toBe(`https://127.0.0.1:${port}`)
    expect(u.searchParams.get('fp')).toBe(tls.fingerprint)
    const code = u.searchParams.get('code')!
    const first = await call(port, '/pair', { method: 'POST', body: JSON.stringify({ code, name: 'iPhone', platform: 'ios' }) })
    expect(first.status).toBe(200)
    expect(first.fp).toBe(tls.fingerprint)
    expect(JSON.parse(first.body).key).toBe(core.keys[0])
    const again = await call(port, '/pair', { method: 'POST', body: JSON.stringify({ code, name: 'iPhone', platform: 'ios' }) })
    expect(again.status).toBe(410)
  })

  it('opens the core to a paired phone only: events down, requests up', async () => {
    const port = await link.start(47360, '127.0.0.1')
    expect((await call(port, '/events')).status).toBe(401)
    expect((await call(port, '/events', { cookie: `p_${'x'.repeat(43)}` })).status).toBe(401)
    const key = await core.deviceKey('iPhone')
    const stream = listen(port, key!, (t) => t.includes('"hi"'))
    await new Promise((r) => setTimeout(r, 100))
    expect(link.connected).toBe(1)
    core.say({ hi: true })
    const text = await stream
    const client = /event: hello\ndata: (\S+)/.exec(text)?.[1]
    expect(client).toBeTruthy()
    expect(text).toContain('data: {"hi":true}')
  })

  it('takes requests on the stream it opened, and nobody else’s', async () => {
    const port = await link.start(47370, '127.0.0.1')
    const key = (await core.deviceKey('iPhone'))!
    let client = ''
    const stream = listen(port, key, (t) => !!(client = /event: hello\ndata: (\S+)/.exec(t)?.[1] ?? ''))
    await stream
    // The stream it named is gone once it hung up: a request on it is refused.
    await new Promise((r) => setTimeout(r, 50))
    expect((await call(port, `/rpc?c=${client}`, { method: 'POST', body: '{"id":1}', cookie: key })).status).toBe(410)
  })

  it('saves a file sent for a message in Enviados, under a name of its own', async () => {
    const port = await link.start(47380, '127.0.0.1')
    const key = (await core.deviceKey('iPhone'))!
    const one = await call(port, '/upload?name=nota.txt&for=message', { method: 'POST', body: 'oi', cookie: key })
    const two = await call(port, '/upload?name=nota.txt&for=message', { method: 'POST', body: 'de novo', cookie: key })
    expect(readFileSync(JSON.parse(one.body).path, 'utf8')).toBe('oi')
    expect(JSON.parse(two.body).path).toMatch(/nota \(2\)\.txt$/)
    expect((await call(port, '/upload?name=x.zip', { method: 'POST', body: 'x', cookie: key })).status).toBe(403)
  })
})

// A phone paired over the home Wi-Fi is one of the owner's devices (people.deviceKey): Settings ›
// Celular › Seu iPhone lists it and disconnects it (removeDevice), which ends its open line at once.
describe('HomeLink, a phone disconnected from the computer', () => {
  let dir: string
  let link: HomeLink
  afterEach(async () => {
    await link.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('shows as a device of the owner, and losing it closes its stream and its key', async () => {
    const { Db } = await import('../src/core/db')
    const { Hub, People } = await import('../src/core/people')
    dir = mkdtempSync(join(tmpdir(), 'home-link-dev-'))
    const db = new Db(':memory:')
    const people = new People(db)
    type P = { postMessage(m: unknown): void; close(): void }
    const hub = new Hub<P>(people, db)
    // The core as home-phone.ts wires it, minus Electron: a port the hub knows by person and device.
    const core: HomeCore = {
      auth: async (key) => people.authenticate(key) ?? (db.removedKey(createHash('sha256').update(key).digest('base64url')) ? { removed: true } : undefined),
      deviceKey: async (label) => people.deviceKey(null, label)?.key,
      open: (person, onMessage, o) => {
        let open = true
        const port: P = { postMessage: (m) => open && onMessage(m), close: () => void (open && ((open = false), o?.onClose?.())) }
        hub.add(port, { person, device: o?.device })
        return { post: () => {}, close: () => port.close() }
      },
      dataDir: () => dir
    }
    link = new HomeLink({ tls: makeCertificate('Tucano', ['localhost']), codesFile: join(dir, 'codes.json'), core: () => core })
    const port = await link.start(47390, '127.0.0.1')
    const code = new URL(link.makeCode().link).searchParams.get('code')!
    const { key } = JSON.parse((await call(port, '/pair', { method: 'POST', body: JSON.stringify({ code, name: 'iPhone de Eduardo', platform: 'ios' }) })).body) as { key: string }
    const mine = db.personKeys(db.ownerId())
    expect(mine.map((k) => k.label)).toEqual(['iPhone de Eduardo · ios'])

    // On the line; then disconnected from the computer, as the core's removeDevice does.
    let ended = false
    const stream = new Promise<string>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/events', rejectUnauthorized: false, headers: { cookie: `tucano=${key}` } }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => ((ended = true), resolve(text)))
      })
      req.end()
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(link.connected).toBe(1)
    expect(db.removePersonKey(db.ownerId(), mine[0]!.hash)).toBe(true)
    hub.closeDevice(mine[0]!.hash)
    expect(await stream).toContain('event: hello')
    expect(ended).toBe(true)
    expect(link.connected).toBe(0)
    // Its key opens nothing now (and reads as signed out, not as a guess).
    expect((await call(port, '/events', { cookie: key })).status).toBe(401)
    expect(people.authenticate(key)).toBeUndefined()
    // Deliveries to a closed line go nowhere.
    expect(() => link.deliver({ notify: {} })).not.toThrow()
  })

  it('never spends a code on a GET', async () => {
    dir = mkdtempSync(join(tmpdir(), 'home-link-get-'))
    const core = fakeCore(dir)
    link = new HomeLink({ tls: makeCertificate('Tucano', ['localhost']), codesFile: join(dir, 'codes.json'), core: () => core })
    const port = await link.start(47395, '127.0.0.1')
    const code = new URL(link.makeCode().link).searchParams.get('code')!
    for (const path of [`/?code=${code}`, `/pair?code=${code}`]) expect((await call(port, path)).status).toBe(401)
    expect(core.keys).toHaveLength(0)
    expect((await call(port, '/pair', { method: 'POST', body: JSON.stringify({ code, name: 'iPhone', platform: 'ios' }) })).status).toBe(200)
  })
})

describe('lanAddress', () => {
  it('picks the Wi-Fi or the cable over the virtual networks Windows and Linux add', async () => {
    const { lanAddress } = await import('../src/main/home-phone-net')
    const nets = {
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.28.48.1', internal: false }],
      'VirtualBox Host-Only Network': [{ family: 'IPv4', address: '192.168.56.1', internal: false }],
      docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
      'Wi-Fi': [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.0.12', internal: false }],
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }]
    }
    expect(lanAddress(nets)).toBe('192.168.0.12')
    expect(lanAddress({ eth0: [{ family: 4, address: '10.0.0.7', internal: false }], wlan0: [{ family: 'IPv4', address: '172.20.10.2', internal: false }] })).toBe('10.0.0.7')
    expect(lanAddress({ eth0: [{ family: 'IPv4', address: '8.8.8.8', internal: false }] })).toBeUndefined()
  })
})

describe('homeHost', () => {
  it('puts the home network address in the QR code, not the .local name', async () => {
    const { homeHost } = await import('../src/main/home-phone-net')
    expect(homeHost({ en0: [{ family: 'IPv4', address: '192.168.3.112', internal: false }], utun4: [{ family: 'IPv4', address: '100.101.1.2', internal: false }] })).toBe('192.168.3.112')
  })

  it('makes each QR code with the address it has now', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-host-'))
    const link = new HomeLink({ tls: makeCertificate('Tucano', []), codesFile: join(dir, 'codes.json'), core: () => undefined })
    try {
      const port = await link.start(47390, '192.168.0.10')
      expect(new URL(link.makeCode().link).searchParams.get('url')).toBe(`https://192.168.0.10:${port}`)
      link.setHost('192.168.0.77')
      expect(new URL(link.makeCode().link).searchParams.get('url')).toBe(`https://192.168.0.77:${port}`)
    } finally {
      await link.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
