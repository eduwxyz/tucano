import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Forwarder, isPrivate } from '../src/server/forward'
import { clientIp, decodedPath, Limiter, MAX_FAILS, PAGE_HEADERS, sameOrigin, WINDOW_MS } from '../src/server/guard'
import { vault } from '../src/server/vault'

describe('the server vault', () => {
  it('opens what it sealed, and nothing sealed with another key', () => {
    const v = vault(randomBytes(32))
    const sealed = v.seal('bot-token:123 ção')
    expect(sealed).not.toContain('bot-token')
    expect(v.open(sealed)).toBe('bot-token:123 ção')
    expect(() => vault(randomBytes(32)).open(sealed)).toThrow()
  })

  it('refuses a tampered secret and a key of the wrong size', () => {
    const v = vault(randomBytes(32))
    const b = Buffer.from(v.seal('x'), 'base64')
    b[b.length - 1]! ^= 1
    expect(() => v.open(b.toString('base64'))).toThrow()
    expect(() => vault(randomBytes(16))).toThrow()
  })
})

describe('passing services through on a private address', () => {
  it('knows a private address from a public one', () => {
    for (const h of ['100.86.178.43', '100.64.0.1', '192.168.3.1', '10.0.0.2', '172.20.1.1']) expect(isPrivate(h)).toBe(true)
    for (const h of ['0.0.0.0', '116.203.200.219', '100.63.0.1', '100.128.0.1', '172.32.0.1', '127.0.0.1']) expect(isPrivate(h)).toBe(false)
  })

  // Needs an address of this machine on a private network to listen on.
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal && isPrivate(i.address))?.address
  it.skipIf(!lan)('serves a loopback page at the private address, then stops', async () => {
    const page = createServer((_q, r) => void r.end('do serviço'))
    await new Promise<void>((r) => page.listen(0, '127.0.0.1', r))
    const p = (page.address() as AddressInfo).port
    const f = new Forwarder(lan!)
    f.set(new Set([p]))
    await new Promise((r) => setTimeout(r, 100))
    expect(await (await fetch(`http://${lan}:${p}/`)).text()).toBe('do serviço')
    f.set(new Set())
    await new Promise((r) => setTimeout(r, 100))
    await expect(fetch(`http://${lan}:${p}/`)).rejects.toThrow()
    await new Promise((r) => page.close(r))
  })
})

describe('the server on the internet', () => {
  const req = (headers: Record<string, string | string[]>, remoteAddress = '10.0.0.9') => ({ headers, socket: { remoteAddress } }) as never

  it('slows a guesser to nothing, one address at a time, and forgets after the window', () => {
    let now = 0
    const l = new Limiter(() => now)
    for (let i = 0; i < MAX_FAILS - 1; i++) l.fail('1.1.1.1')
    expect(l.blocked('1.1.1.1')).toBe(false)
    l.fail('1.1.1.1')
    expect(l.blocked('1.1.1.1')).toBe(true)
    // Someone else, from another address, still gets in.
    expect(l.blocked('2.2.2.2')).toBe(false)
    now += WINDOW_MS + 1
    expect(l.blocked('1.1.1.1')).toBe(false)
  })

  it("takes the proxy's word for the address only when told to", () => {
    const r = req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, '127.0.0.1')
    expect(clientIp(r, true)).toBe('203.0.113.7') // the one the proxy itself added
    expect(clientIp(r, false)).toBe('127.0.0.1') // without a proxy, the header is the asker's own word
    expect(clientIp(req({}, '127.0.0.1'), true)).toBe('127.0.0.1')
  })

  it("answers its own page, not a sibling subdomain's", () => {
    expect(sameOrigin(req({ host: 'ana.pro.example', origin: 'https://ana.pro.example' }))).toBe(true)
    expect(sameOrigin(req({ host: 'ana.pro.example', origin: 'https://bruno.pro.example' }))).toBe(false)
    expect(sameOrigin(req({ host: 'ana.pro.example', origin: 'null' }))).toBe(false)
    expect(sameOrigin(req({ host: 'ana.pro.example' }))).toBe(true) // a navigation, or a program
  })

  it("can't be framed by another site, and reads a broken path as nothing", () => {
    expect(PAGE_HEADERS['x-frame-options']).toBe('DENY')
    expect(PAGE_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(decodedPath('/a%20b.png')).toBe('/a b.png')
    expect(decodedPath('/%E0%A4%A')).toBeUndefined()
  })
})
