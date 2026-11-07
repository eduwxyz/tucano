// A link someone gives the wiki is fetched by the Tucano itself: on a server that machine's own
// network (loopback, the cloud's metadata, the LAN) must stay out of reach, at every redirect, and
// a name that resolves to one address can't be swapped for another between the check and the call.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blockedAddress, safeFetch } from '../src/core/safe-fetch'
import { extractLink } from '../src/core/wiki-extract'

describe('an address of the inside', () => {
  it('is any private, loopback, link-local, CGNAT, metadata or unspecified one, v4 or v6', () => {
    const inside = ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '100.64.0.1', '100.127.255.254', '169.254.169.254', '0.0.0.0', '255.255.255.255', '224.0.0.1', '::', '::1', 'fe80::1', 'fc00::1', 'fd00::abcd', 'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'ff02::1']
    for (const ip of inside) expect(blockedAddress(ip), ip).toBe(true)
    const outside = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']
    for (const ip of outside) expect(blockedAddress(ip), ip).toBe(false)
  })
})

describe('a guarded fetch', () => {
  let server: Server
  let port = 0
  const hits: string[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.headers.host} ${req.url}`)
      if (req.url === '/to-metadata') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
      if (req.url === '/to-private-name') return void res.writeHead(301, { location: 'http://intranet.test/' }).end()
      if (req.url === '/to-ok') return void res.writeHead(302, { location: '/ok' }).end()
      if (req.url === '/loop') return void res.writeHead(302, { location: '/loop' }).end()
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>ok</title><p>tudo certo por aqui</p>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  // In these tests 127.0.0.1 stands for a public address (the only server we can stand up);
  // everything else blocked stays blocked.
  const asPublic = (ip: string): boolean => ip !== '127.0.0.1' && blockedAddress(ip)
  const names: Record<string, string> = { 'site.test': '127.0.0.1', 'intranet.test': '10.0.0.5' }
  const resolve = async (host: string): Promise<{ address: string; family: number }[]> => [{ address: names[host] ?? host, family: names[host]?.includes(':') ? 6 : 4 }]

  it('refuses a loopback, private or metadata address outright, before any connection', async () => {
    const before = hits.length
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://100.64.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/', `http://[::1]:${port}/`, 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/']) {
      await expect(safeFetch()(url), url).rejects.toThrow(/rede interna/)
    }
    expect(hits.length).toBe(before)
  })

  it('checks every redirect, and stops one into the inside', async () => {
    const f = safeFetch({ resolve, blocked: asPublic })
    await expect(f(`http://site.test:${port}/to-metadata`)).rejects.toThrow(/rede interna/)
    await expect(f(`http://site.test:${port}/to-private-name`)).rejects.toThrow(/rede interna/)
    await expect(f(`http://site.test:${port}/loop`)).rejects.toThrow(/redirecionamentos/)
    const ok = await f(`http://site.test:${port}/to-ok`)
    expect(ok.status).toBe(200)
    expect(ok.url).toBe(`http://site.test:${port}/ok`)
    expect(await ok.text()).toContain('tudo certo')
  })

  it('resolves a name once and connects to the address it checked (no rebinding)', async () => {
    let asked = 0
    // The first answer is the checked one; any later lookup would hand out the inside.
    const rebinding = async (): Promise<{ address: string; family: number }[]> => [{ address: asked++ === 0 ? '127.0.0.1' : '10.0.0.5', family: 4 }]
    const res = await safeFetch({ resolve: rebinding, blocked: asPublic })(`http://rebind.test:${port}/ok`)
    expect(res.status).toBe(200)
    expect(asked).toBe(1)
    expect(hits.at(-1)).toBe(`rebind.test:${port} /ok`) // the name stays the Host
  })

  it('refuses a name when any of its addresses is inside', async () => {
    const mixed = async (): Promise<{ address: string; family: number }[]> => [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.5', family: 4 }]
    await expect(safeFetch({ resolve: mixed, blocked: asPublic })(`http://mixed.test:${port}/ok`)).rejects.toThrow(/rede interna/)
  })

  it('is what a wiki link goes through unless told otherwise', async () => {
    await expect(extractLink(`http://127.0.0.1:${port}/ok`)).rejects.toThrow(/rede interna/)
    await expect(extractLink('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/rede interna/)
  })
})
