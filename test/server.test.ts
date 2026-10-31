import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Forwarder, isPrivate } from '../src/server/forward'
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
