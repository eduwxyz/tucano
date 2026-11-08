// A pairing link opened by something other than its person (a chat's link preview, a browser's
// prefetch or prerender, a scanner) spends nothing: only the page's button, a same-origin POST, does
// (src/server/pair-http.ts). And the devices a code made can be seen and disconnected.
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Hub, People } from '../src/core/people'
import { Doors, MAX_FAILS } from '../src/server/guard'
import { PairCodes } from '../src/server/pair-codes'
import { pairLinkPage, pairPost, prefetching, type PairDoor } from '../src/server/pair-http'
import { parsePairing } from '../src/shared/servers'
import { redeemCode, thisDevice } from '../src/main/redeem'

const hashOf = (key: string): string => createHash('sha256').update(key).digest('base64url')

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

// The two routes as the server has them, with a real code file and a real core's People behind.
async function start(): Promise<{ base: string; host: string; codes: PairCodes; db: Db; people: People; doors: Doors }> {
  const db = new Db(':memory:')
  db.renamePerson(db.ownerId(), 'Ana')
  const people = new People(db)
  const codes = new PairCodes(join(mkdtempSync(join(tmpdir(), 'tucano-pairlink-')), 'pair-codes.json'))
  const doors = new Doors()
  const door: PairDoor = {
    codes,
    doors,
    mint: async (person, label) => people.deviceKey(person, label)?.key,
    owner: () => 'Ana',
    nameOf: (person) => (person ? db.person(person)?.name : db.owner().name)
  }
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/pair' && req.method === 'POST') return void pairPost(door, req, res, '10.0.0.1')
    const code = url.searchParams.get('code')
    if (code !== null && req.method === 'GET') return pairLinkPage(door, req, res, '10.0.0.1', code)
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base: `http://${host}`, host, codes, db, people, doors }
}

const devices = (db: Db): number => db.people().find((p) => p.id === db.ownerId())?.devices ?? 0
const form = (host: string, code: string, origin = `http://${host}`): RequestInit => ({
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
  body: new URLSearchParams({ code }).toString()
})

describe('a pairing link opened before its person opens it', () => {
  it('knows a prefetch or prerender from a visit', () => {
    const r = (headers: Record<string, string>) => ({ headers })
    expect(prefetching(r({ 'sec-purpose': 'prefetch' }))).toBe(true)
    expect(prefetching(r({ 'sec-purpose': 'prefetch;prerender' }))).toBe(true)
    expect(prefetching(r({ purpose: 'prefetch' }))).toBe(true)
    expect(prefetching(r({ 'x-purpose': 'preview' }))).toBe(true)
    expect(prefetching(r({ 'x-moz': 'prefetch' }))).toBe(true)
    expect(prefetching(r({}))).toBe(false)
  })

  it('a plain GET, a prefetch and a link preview spend nothing and make no device', async () => {
    const { base, codes, db } = await start()
    const { code } = codes.make(null)
    const plain = await fetch(`${base}/?code=${code}`, { redirect: 'manual' })
    expect(plain.status).toBe(200)
    expect(plain.headers.get('set-cookie')).toBeNull()
    expect(plain.headers.get('cache-control')).toBe('no-store')
    const html = await plain.text()
    expect(html).toContain('Entrar no Tucano de Ana')
    expect(html).toContain('Entrar neste navegador · Sign in on this browser')
    expect(html).toContain('method="post" action="./pair"')
    for (const headers of <Record<string, string>[]>[{ 'sec-purpose': 'prefetch;prerender' }, { purpose: 'prefetch' }, { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }, { 'user-agent': 'WhatsApp/2.23.20.0' }, { 'user-agent': 'facebookexternalhit/1.1' }]) {
      const r = await fetch(`${base}/?code=${code}`, { headers, redirect: 'manual' })
      expect(r.headers.get('set-cookie')).toBeNull()
      expect([200, 503]).toContain(r.status)
    }
    expect(devices(db)).toBe(0)
    expect(codes.peek(code)).toEqual({ person: null }) // still good
  })

  it("says whom the browser signs in as, someone invited's code included", async () => {
    const { base, codes, db } = await start()
    const { code: invite } = new People(db).createInvite(db.owner(), { role: 'member' })
    const bia = new People(db).join(invite, 'Bia')
    if ('error' in bia) throw new Error(bia.error)
    const { code } = codes.make(bia.person.id)
    const html = await (await fetch(`${base}/?code=${code}`)).text()
    expect(html).toContain('<b>Bia</b>')
  })

  it('the POST spends it once: a cookie and a device; a second POST gets 410', async () => {
    const { base, host, codes, db, people } = await start()
    const { code } = codes.make(null)
    await fetch(`${base}/?code=${code}`) // a preview got there first
    const r = await fetch(`${base}/pair`, form(host, code))
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/')
    const key = /tucano=(p_[\w-]{43})/.exec(r.headers.get('set-cookie') ?? '')?.[1]
    expect(key).toBeDefined()
    expect(people.authenticate(key!)?.id).toBe(db.ownerId())
    expect(devices(db)).toBe(1)
    const again = await fetch(`${base}/pair`, form(host, code))
    expect(again.status).toBe(410)
    expect(again.headers.get('set-cookie')).toBeNull()
    expect(devices(db)).toBe(1)
    // And now the link itself says so.
    const used = await fetch(`${base}/?code=${code}`)
    expect(used.status).toBe(410)
    expect(await used.text()).toContain('já foi usado ou passou do prazo')
  })

  it("refuses another site's form, and spends nothing", async () => {
    const { host, base, codes, db } = await start()
    const { code } = codes.make(null)
    expect((await fetch(`${base}/pair`, form(host, code, 'https://evil.example'))).status).toBe(403)
    expect((await fetch(`${base}/pair`, form(host, code, 'null'))).status).toBe(403)
    expect(devices(db)).toBe(0)
    expect(codes.peek(code)).toBeDefined()
  })

  it('counts a wrong or late code as a guess, the same at the link and at the form; a good one costs none', async () => {
    const { base, host, codes, doors } = await start()
    const { code } = codes.make(null)
    for (let i = 0; i < MAX_FAILS + 3; i++) expect((await fetch(`${base}/?code=${code}`)).status).toBe(200)
    expect(doors.blocked('join', '10.0.0.1')).toBe(false)
    for (let i = 0; i < MAX_FAILS / 2; i++) expect((await fetch(`${base}/?code=${'x'.repeat(24)}`)).status).toBe(410)
    for (let i = 0; i < MAX_FAILS / 2 - 1; i++) expect((await fetch(`${base}/pair`, form(host, 'y'.repeat(24)))).status).toBe(410)
    expect((await fetch(`${base}/?code=short`)).status).toBe(410)
    expect(doors.blocked('join', '10.0.0.1')).toBe(true)
    expect((await fetch(`${base}/?code=${code}`)).status).toBe(429) // a waiting address reads nothing, not even a good code
    expect((await fetch(`${base}/pair`, form(host, code))).status).toBe(429)
    // And the good code is still unspent.
    expect(codes.peek(code)).toBeDefined()
  })

  it('a prefetch costs no guess, even with a wrong code', async () => {
    const { base, doors } = await start()
    for (let i = 0; i < MAX_FAILS + 1; i++) expect((await fetch(`${base}/?code=${'z'.repeat(24)}`, { headers: { 'sec-purpose': 'prefetch' } })).status).toBe(503)
    expect(doors.blocked('join', '10.0.0.1')).toBe(false)
  })
})

describe('the other ways a code is spent', () => {
  it("the phone's JSON POST still trades it for a key, once", async () => {
    const { base, codes, db, people } = await start()
    const { code } = codes.make(null)
    const post = () => fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'iPhone de Ana', platform: 'ios' }) })
    const r = await post()
    expect(r.status).toBe(200)
    const { key } = (await r.json()) as { key: string }
    expect(people.authenticate(key)?.id).toBe(db.ownerId())
    expect(db.personKeys(db.ownerId())[0]!.label).toBe('iPhone de Ana · ios')
    const again = await post()
    expect(again.status).toBe(410)
    expect(((await again.json()) as { error: string }).error).toContain('já foi usado')
    expect((await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400)
  })

  it('the desktop app trades a code like the phone, once, and its link alone spends nothing', async () => {
    const { base, codes, db, people } = await start()
    const { code } = codes.make(null)
    // Reading the link (as the app does before asking "Conectar?") spends nothing.
    const p = parsePairing(`tucano://connect?url=${encodeURIComponent('https://ana.example.com')}&code=${code}`)
    expect(p).toEqual({ origin: 'https://ana.example.com', code })
    expect(parsePairing(`https://ana.example.com/?code=${code}`)).toEqual({ origin: 'https://ana.example.com', code })
    // The click: a key of the computer's own, named after it.
    const got = await redeemCode(base, code, thisDevice('MacBook-de-Ana.local', 'darwin'))
    expect('key' in got && people.authenticate(got.key)?.id).toBe(db.ownerId())
    expect(db.personKeys(db.ownerId()).map((k) => k.label)).toContain('MacBook-de-Ana · macos')
    expect(await redeemCode(base, code, thisDevice('MacBook-de-Ana', 'darwin'))).toEqual({ error: 'used' })
    expect(await redeemCode('http://127.0.0.1:1', code, thisDevice('x', 'linux'))).toEqual({ error: 'unreachable' })
    // The server's token still pairs as it always did.
    expect(parsePairing(`tucano://connect?url=https%3A%2F%2Fana.example.com&token=${'t'.repeat(32)}`)).toEqual({ origin: 'https://ana.example.com', token: 't'.repeat(32) })
  })
})

describe('my devices', () => {
  it('are listed, a never-used one says so, and one can go without the others', async () => {
    const { db, people } = await start()
    const used = people.deviceKey(null, 'Chrome · macOS · browser')!.key
    const orphan = people.deviceKey(null, 'Discordbot · browser')!.key
    people.authenticate(used)
    const list = db.personKeys(db.ownerId())
    expect(list.map((k) => k.label).sort()).toEqual(['Chrome · macOS · browser', 'Discordbot · browser'])
    expect(list.find((k) => k.hash === hashOf(used))!.seenAt).toBeGreaterThan(0)
    expect(list.find((k) => k.hash === hashOf(orphan))!.seenAt).toBeUndefined()
    expect(list.some((k) => JSON.stringify(k).includes(orphan))).toBe(false) // only hashes
    expect(db.removePersonKey(db.ownerId(), hashOf(orphan))).toBe(true)
    expect(db.removePersonKey(db.ownerId(), hashOf(orphan))).toBe(false)
    expect(people.authenticate(orphan)).toBeUndefined()
    expect(db.removedKey(hashOf(orphan))).toBe(true) // its browser reads "no access", not a guess
    expect(people.authenticate(used)?.id).toBe(db.ownerId())
    expect(devices(db)).toBe(1)
  })

  it("no one disconnects someone else's device by its id", async () => {
    const { db, people } = await start()
    const { code } = people.createInvite(db.owner(), { role: 'member' })
    const bia = people.join(code, 'Bia')
    if ('error' in bia) throw new Error(bia.error)
    const ana = people.deviceKey(null, 'phone')!.key
    expect(db.removePersonKey(bia.person.id, hashOf(ana))).toBe(false)
    expect(people.authenticate(ana)?.id).toBe(db.ownerId())
  })

  it("the hub knows each page's device, and closes only that device's pages", async () => {
    const { db, people } = await start()
    const hub = new Hub<{ postMessage(m: unknown): void; close(): void; closed?: boolean }>(people, db)
    const port = () => ({ postMessage() {}, close() { this.closed = true }, closed: false })
    const a = port()
    const b = port()
    hub.add(a, { person: db.ownerId(), device: 'h1' })
    hub.add(b, { person: db.ownerId(), device: 'h2' })
    expect(hub.deviceOf(a)).toBe('h1')
    hub.closeDevice('h1')
    expect(a.closed).toBe(true)
    expect(b.closed).toBe(false)
    expect(hub.personOf(a)).toBeUndefined()
    expect(hub.personOf(b)?.id).toBe(db.ownerId())
  })
})
