// A connector that can't connect on a company network said "Sem conexão com a internet" for every reason
// Node hides under "fetch failed". The reason is in the error's causes, and each one says what to do; and
// the core trusts the system's certificates and takes the system's (or the environment's) proxy.
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { causeText, friendly, InsideNetworkError, netProblem, offline } from '../src/shared/errors'
import { callError, connectError, connectProblem } from '../src/core/connectors'
import { proxyEnv, proxyFromPac, trustSystemCertificates, useProxy } from '../src/core/network'
import { setLang } from '../src/shared/lang'

afterEach(() => setLang('pt'))

const coded = (message: string, code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(message), { code, ...extra })
// What undici throws: "fetch failed", the reason in `cause`.
const failed = (cause: unknown): TypeError => new TypeError('fetch failed', { cause })

describe('a network failure, by its cause', () => {
  it('says a certificate a company proxy or antivirus swapped, with what to do', () => {
    for (const cause of [
      coded('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
      coded('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'),
      coded('unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'),
      coded("Hostname/IP does not match certificate's altnames: Host: api.githubcopilot.com.", 'ERR_TLS_CERT_ALTNAME_INVALID', { host: 'api.githubcopilot.com' })
    ]) {
      const f = connectProblem(failed(cause), 'https://api.githubcopilot.com/mcp/')
      expect(f.text).toMatch(/^O certificado do servidor \(api\.githubcopilot\.com\) não foi aceito\. Numa rede de empresa, um proxy ou antivírus que inspeciona HTTPS/)
      expect(f.detail).toContain('fetch failed ← ')
      expect(f.detail).toContain((cause as unknown as { code: string }).code)
    }
    expect(netProblem(failed(coded('certificate has expired', 'CERT_HAS_EXPIRED')))?.kind).toBe('expired')
    expect(friendly(failed(coded('certificate has expired', 'CERT_HAS_EXPIRED'))).text).toMatch(/vencido.*data e a hora/)
    setLang('en')
    expect(connectError(failed(coded('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN')))).toMatch(/^The server's certificate wasn't accepted\. On a company network/)
  })

  it('tells a proxy that refused, or wants a login, apart', () => {
    const login = netProblem(failed(coded('Proxy response (407) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED')))
    expect(login).toMatchObject({ kind: 'proxy', status: 407 })
    expect(friendly(failed(coded('Proxy response (407) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED'))).text).toMatch(/^O proxy da rede pede login/)
    expect(friendly(failed(coded('Failed to establish tunnel to example.com:443 (status 502)', 'ERR_PROXY_TUNNEL'))).text).toMatch(/^O proxy da rede recusou a conexão/)
  })

  it('says the DNS, a refusal, a cut connection, real offline and a timeout each in its words', () => {
    const dns = connectProblem(failed(coded('getaddrinfo ENOTFOUND api.githubcopilot.com', 'ENOTFOUND', { hostname: 'api.githubcopilot.com' })))
    expect(dns.text).toMatch(/^Não achei o endereço \(api\.githubcopilot\.com\) na rede \(DNS\)/)
    // undici tries each address (IPv6, IPv4) and gives up with all of them
    const both = new AggregateError([coded('connect ECONNREFUSED ::1:443', 'ECONNREFUSED'), coded('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED')], '')
    expect(netProblem(failed(both))?.kind).toBe('refused')
    expect(friendly(failed(both)).text).toMatch(/recusou a conexão.*firewall/)
    expect(netProblem(failed(coded('Client network socket disconnected before secure TLS connection was established', 'ECONNRESET')))?.kind).toBe('reset')
    expect(netProblem(failed(coded('other side closed', 'UND_ERR_SOCKET')))?.kind).toBe('reset')
    expect(friendly(failed(coded('connect ENETUNREACH 140.82.112.21:443', 'ENETUNREACH'))).text).toBe('Sem conexão com a internet. Confira a rede e tente de novo.')
    expect(friendly(failed(coded('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'))).text).toMatch(/^Demorou demais/)
    // still offline for whoever only asks whether it's worth trying again
    expect(offline(failed(coded('connect ENETUNREACH 1.2.3.4:443', 'ENETUNREACH')))).toBe(true)
  })

  it('says our own guard refused the inside, even wrapped', () => {
    const wrapped = new Error('boom', { cause: new InsideNetworkError('Esse link aponta pra rede interna do servidor; não dá pra ler daqui.') })
    expect(netProblem(wrapped)?.kind).toBe('inside')
    expect(friendly(wrapped).text).toMatch(/rede interna/)
  })

  it('keeps "fetch failed" with no cause as not reached, not as offline, and says nothing it doesn\'t know', () => {
    expect(friendly(new TypeError('fetch failed'), { host: 'api.githubcopilot.com' }).text).toBe('Não consegui chegar ao servidor (api.githubcopilot.com). Confira a rede e tente de novo.')
    expect(netProblem(new Error('Servidor respondeu 500'))).toBeUndefined()
    expect(connectProblem(new Error('Servidor respondeu 500'))).toEqual({ text: 'Servidor respondeu 500' })
  })

  it('gives the agent the reason and what Node said on a failed call', () => {
    const why = callError(failed(coded('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN')))
    expect(why).toMatch(/^O certificado do servidor não foi aceito\./)
    expect(why).toContain('(fetch failed ← self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN))')
    expect(callError(new Error('fetch failed'))).toBe('fetch failed')
  })

  it('walks a cycle of causes without hanging', () => {
    const a: Error & { cause?: unknown } = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(causeText(a)).toBe('a ← b')
  })
})

// A server whose certificate no list trusts: what a company's HTTPS inspection looks like to Node.
const cert = readFileSync(join(import.meta.dirname, 'fixtures', 'test-root.crt'), 'utf8')
const key = readFileSync(join(import.meta.dirname, 'fixtures', 'test-root.key'), 'utf8')

describe('a certificate the system trusts', () => {
  let server: https.Server
  let url = ''
  beforeAll(async () => {
    server = https.createServer({ cert, key }, (_req, res) => res.end('ok'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('is refused by plain Node, and the error says it was the certificate', async () => {
    const e = await fetch(url).then(
      () => undefined,
      (x: unknown) => x
    )
    expect(netProblem(e)?.kind).toBe('tls')
    expect(connectProblem(e, url).text).toMatch(/^O certificado do servidor \(127\.0\.0\.1:\d+\) não foi aceito/)
  })

  it('is accepted once added to the system ones, and only then', async () => {
    const api = tls as unknown as { getCACertificates?: (t?: string) => string[]; setDefaultCACertificates?: (c: string[]) => void }
    if (!api.getCACertificates || !api.setDefaultCACertificates) return // a Node without the API: nothing to wire
    const before = api.getCACertificates('default')
    // The system's store, as the OS would answer with the company's root in it.
    const added = trustSystemCertificates({
      getCACertificates: (t) => (t === 'system' ? [cert, ...before.slice(0, 1)] : api.getCACertificates!(t as 'default')),
      setDefaultCACertificates: (c) => api.setDefaultCACertificates!(c)
    })
    try {
      expect(added).toBe(1) // the root already in Node's list isn't added twice
      expect(await (await fetch(url)).text()).toBe('ok')
    } finally {
      api.setDefaultCACertificates(before)
    }
  })

  it('never fails the core when the API is missing or the system says nothing', () => {
    expect(trustSystemCertificates({})).toBe(0)
    let set = 0
    expect(trustSystemCertificates({ getCACertificates: (t) => (t === 'system' ? [] : ['a']), setDefaultCACertificates: () => void set++ })).toBe(0)
    expect(set).toBe(0)
    expect(
      trustSystemCertificates({
        getCACertificates: () => {
          throw new Error('no store')
        },
        setDefaultCACertificates: () => {}
      })
    ).toBe(0)
  })
})

describe('the proxy', () => {
  it('reads the environment, then the system’s, and never sends this machine through it', () => {
    expect(proxyEnv({})).toBeUndefined()
    expect(proxyEnv({ HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: 'intranet.corp' })).toEqual({ HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: 'intranet.corp,localhost,127.0.0.1,::1' })
    expect(proxyEnv({ https_proxy: 'http://a:1', http_proxy: 'http://b:2' })).toEqual({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2', NO_PROXY: 'localhost,127.0.0.1,::1' })
    expect(proxyEnv({ ALL_PROXY: 'http://all:3' })).toMatchObject({ HTTPS_PROXY: 'http://all:3', HTTP_PROXY: 'http://all:3' })
    expect(proxyEnv({ ALL_PROXY: 'socks5://s:1080' })).toBeUndefined() // Node doesn't speak SOCKS
    expect(proxyEnv({ TUCANO_SYSTEM_PROXY: 'http://sys:3128' })).toMatchObject({ HTTPS_PROXY: 'http://sys:3128', HTTP_PROXY: 'http://sys:3128' })
    expect(proxyEnv({ TUCANO_SYSTEM_PROXY: 'http://sys:3128', HTTPS_PROXY: 'http://env:1' })?.['HTTPS_PROXY']).toBe('http://env:1')
  })

  it('takes what Chromium resolves (the system settings, a PAC) when it is an HTTP one', () => {
    expect(proxyFromPac('PROXY proxy.corp:8080; DIRECT')).toBe('http://proxy.corp:8080')
    expect(proxyFromPac('HTTPS secure.corp:443')).toBe('https://secure.corp:443')
    expect(proxyFromPac('DIRECT')).toBeUndefined()
    expect(proxyFromPac('SOCKS5 s:1080; PROXY p:1')).toBe('http://p:1')
    expect(proxyFromPac('')).toBeUndefined()
  })

  it('logs the proxy without its password, and does nothing without one', () => {
    const seen: Record<string, string>[] = []
    const api = { setGlobalProxyFromEnv: (e: Record<string, string>) => void seen.push(e) }
    expect(useProxy({}, api)).toBeUndefined()
    expect(seen).toEqual([])
    expect(useProxy({ HTTPS_PROXY: 'http://ana:segredo@proxy.corp:8080' }, api)).toBe('http://…@proxy.corp:8080')
    expect(seen[0]?.['HTTPS_PROXY']).toBe('http://ana:segredo@proxy.corp:8080')
    expect(useProxy({ HTTPS_PROXY: 'http://p:1' }, {})).toBeUndefined() // a Node without it
  })

  it('sends fetch through it, and a proxy that wants a login says so', async () => {
    const set = (http as unknown as { setGlobalProxyFromEnv?: (e: Record<string, string>) => () => void }).setGlobalProxyFromEnv
    if (!set) return // a Node without built-in proxy support
    const tunnels: string[] = []
    const proxy = http.createServer((_req, res) => res.writeHead(407).end())
    proxy.on('connect', (req, socket: net.Socket) => {
      tunnels.push(req.url ?? '')
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\n\r\n')
    })
    const local = http.createServer((_req, res) => res.end('local'))
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r))
    let restore: (() => void) | undefined
    try {
      useProxy({ HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` }, { setGlobalProxyFromEnv: (e) => (restore = set(e)) })
      const e = await fetch('https://tucano-proxy-test.invalid/').then(
        () => undefined,
        (x: unknown) => x
      )
      expect(tunnels).toEqual(['tucano-proxy-test.invalid:443'])
      expect(netProblem(e)).toMatchObject({ kind: 'proxy', status: 407 })
      // this machine never goes through it
      expect(await (await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/`)).text()).toBe('local')
      expect(tunnels).toHaveLength(1)
    } finally {
      restore?.()
      proxy.close()
      local.close()
    }
  })
})
