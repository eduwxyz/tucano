import { randomBytes } from 'node:crypto'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer as tcpServer, connect, type AddressInfo, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Preview, withoutOurCookies } from '../src/server/preview'

// An agent's page on the loopback, and the server's front door in front of it (as src/server does).
let site: Server
let ws: ReturnType<typeof tcpServer>
let front: Server
let sitePort = 0
let wsPort = 0
let frontPort = 0
let seen: IncomingHttpHeaders = {}
let now = 1_000_000
const preview = new Preview(randomBytes(32), 'ana.example.com', (p) => p === sitePort || p === wsPort, () => now)
const listen = (s: { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown }): Promise<number> => new Promise((r) => void s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

beforeAll(async () => {
  site = createServer((req, res) => {
    seen = req.headers
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`site:${req.url}`)
  })
  sitePort = await listen(site)
  // A WebSocket-ish server: answers the upgrade, then echoes.
  ws = tcpServer((sock) => {
    sock.once('data', () => {
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      sock.on('data', (d) => sock.write(`echo:${d}`))
    })
  })
  wsPort = await listen(ws)
  front = createServer((req, res) => {
    const p = preview.portOf(req.headers.host)
    if (p) preview.handle(req, res, p)
    else res.writeHead(418).end()
  })
  front.on('upgrade', (req, socket: Socket, head) => {
    const p = preview.portOf(req.headers.host)
    if (p) preview.upgrade(req, socket, head, p)
    else socket.destroy()
  })
  frontPort = await listen(front)
})
afterAll(() => {
  site.close()
  ws.close()
  front.close()
})

const ask = (host: string, path: string, cookie?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: frontPort, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    r.on('error', reject)
    r.end()
  })
const signIn = async (port: number): Promise<string> => {
  const grant = new URL(preview.grantUrl(port, '/app?x=1'))
  const r = await ask(grant.host, `${grant.pathname}${grant.search}`)
  expect(r.status).toBe(302)
  expect(r.headers.location).toBe('/app?x=1')
  return String(r.headers['set-cookie']).split(';')[0]!
}

describe("an agent's page at an address of its own", () => {
  it('knows its own preview addresses, and nothing else', () => {
    expect(preview.portOf('5173-ana.example.com')).toBe(5173)
    expect(preview.portOf('ana.example.com')).toBeUndefined() // Tucano's own address
    expect(preview.portOf('5173-bruno.example.com')).toBeUndefined()
    expect(preview.portOf('99999-ana.example.com')).toBeUndefined()
    expect(preview.portOf(undefined)).toBeUndefined()
  })

  it('signs in with a grant from the app, and passes the page through without our cookies', async () => {
    const host = `${sitePort}-ana.example.com`
    expect((await ask(host, '/app')).status).toBe(401)
    const cookie = await signIn(sitePort)
    const r = await ask(host, '/app?x=1', `${cookie}; tucano=the-servers-token; theirs=1`)
    expect(r.status).toBe(200)
    expect(r.body).toBe('site:/app?x=1')
    expect(seen.cookie).toBe('theirs=1') // the page never sees Tucano's cookies
    expect(seen.host).toBe(`127.0.0.1:${sitePort}`) // as a dev server expects (Vite refuses other hosts)
    // With only our cookies, as a browser sends them: none left, and the page still answers.
    const only = await ask(host, '/', cookie)
    expect(only.status).toBe(200)
    expect(seen.cookie).toBeUndefined()
  })

  it('refuses a grant that expired, was changed, or is for another port', async () => {
    const grant = new URL(preview.grantUrl(sitePort, '/'))
    const tampered = grant.search.replace(/g=[^&]+/, 'g=forged')
    expect((await ask(grant.host, `${grant.pathname}${tampered}`)).status).toBe(403)
    expect((await ask(`${wsPort}-ana.example.com`, `${grant.pathname}${grant.search}`)).status).toBe(403)
    now += 6 * 60_000
    expect((await ask(grant.host, `${grant.pathname}${grant.search}`)).status).toBe(403)
    now -= 6 * 60_000
    // A cookie made for one port opens no other.
    const cookie = await signIn(sitePort)
    expect((await ask(`${wsPort}-ana.example.com`, '/', cookie)).status).toBe(401)
  })

  it('passes nothing to a port no agent serves', async () => {
    const off = new Preview(randomBytes(32), 'ana.example.com', () => false)
    const grant = new URL(off.grantUrl(sitePort, '/'))
    const s = createServer((req, res) => off.handle(req, res, sitePort))
    const p = await listen(s)
    const get = (path: string, cookie?: string): Promise<number> =>
      new Promise((r) => request({ host: '127.0.0.1', port: p, path, headers: { host: grant.host, ...(cookie ? { cookie } : {}) } }, (res) => (res.resume(), r(res.statusCode ?? 0))).end())
    const entered = await new Promise<string>((r) => request({ host: '127.0.0.1', port: p, path: `${grant.pathname}${grant.search}`, headers: { host: grant.host } }, (res) => (res.resume(), r(String(res.headers['set-cookie']).split(';')[0]!))).end())
    expect(await get('/', entered)).toBe(404)
    s.close()
  })

  it('carries a WebSocket both ways, signed in only', async () => {
    const cookie = await signIn(wsPort)
    const talk = (withCookie: boolean): Promise<string> =>
      new Promise((resolve) => {
        const sock = connect(frontPort, '127.0.0.1', () => sock.write(`GET /hmr HTTP/1.1\r\nHost: ${wsPort}-ana.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${withCookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`))
        let got = ''
        sock.on('data', (d) => {
          got += d
          if (got.includes('101') && !got.includes('echo')) sock.write('ping')
          if (got.includes('echo:ping')) (sock.destroy(), resolve(got))
        })
        sock.on('close', () => resolve(got))
      })
    expect(await talk(true)).toContain('echo:ping')
    expect(await talk(false)).toBe('')
  })

  it('keeps only the page’s own cookies', () => {
    expect(withoutOurCookies('a=1; tucano=x; tucano_preview=y; b=2')).toBe('a=1; b=2')
    expect(withoutOurCookies('tucano=x')).toBeUndefined()
    expect(withoutOurCookies(undefined)).toBeUndefined()
  })
})
