import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { plainCipher, Secrets } from '../src/core/secrets'

let server: Server
let base: string
let db: Db
let connectors: ConnectorManager

// An MCP server behind OAuth whose authorization server has no registration
// endpoint, like GitHub's: only apps registered ahead of time may sign in.
beforeEach(async () => {
  server = createServer((req, res) => {
    const json = (body: unknown): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base] })
    if (req.url?.startsWith('/.well-known/oauth-authorization-server')) {
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] })
    }
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-connectors-')), 'test.db'))
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => 'http://127.0.0.1:1/oauth/callback' })
})

afterEach(async () => {
  await connectors.closeAll()
  db.close()
  await new Promise((resolve) => server.close(resolve))
})

describe('OAuth on a server that takes no new apps', () => {
  it('says to add it with a token instead of the SDK error', async () => {
    const id = await connectors.add({ name: 'GitHub', kind: 'remote', url: `${base}/mcp`, auth: 'oauth' })
    await connectors.authorize(id)
    const c = connectors.get(id)!
    expect(c.status).toBe('error')
    expect(c.error).toMatch(/token/)
    expect(c.error).not.toMatch(/Incompatible/)
  })
})

// The same, with dynamic registration and a token endpoint: an app may sign in.
describe('OAuth signed in from a page on another machine (Tucano as a server)', () => {
  let auth: Server
  let authBase: string
  const tokenCalls: string[] = []

  beforeEach(async () => {
    tokenCalls.length = 0
    auth = createServer((req, res) => {
      const json = (body: unknown, status = 200): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (req.url?.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${authBase}/mcp`, authorization_servers: [authBase] })
      if (req.url?.startsWith('/.well-known/oauth-authorization-server'))
        return json({ issuer: authBase, authorization_endpoint: `${authBase}/authorize`, token_endpoint: `${authBase}/token`, registration_endpoint: `${authBase}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] })
      if (req.url === '/register') return json({ client_id: 'tucano-test', redirect_uris: ['http://127.0.0.1:1/oauth/callback'] }, 201)
      if (req.url === '/token') {
        let body = ''
        req.on('data', (c: Buffer) => (body += c))
        req.on('end', () => {
          tokenCalls.push(body)
          json({ access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 })
        })
        return
      }
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${authBase}/.well-known/oauth-protected-resource"` }).end()
    })
    await new Promise<void>((resolve) => auth.listen(0, '127.0.0.1', resolve))
    authBase = `http://127.0.0.1:${(auth.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => auth.close(resolve))
  })

  it('hands back the authorization page, and finishes from the pasted address', async () => {
    const id = await connectors.add({ name: 'Linear', kind: 'remote', url: `${authBase}/mcp`, auth: 'oauth' })
    await connectors.connect(id) // adding tries once on its own; the click comes after
    const page = await connectors.authorize(id)
    expect(page).toBeDefined()
    const state = new URL(page!).searchParams.get('state')
    expect(state).toBeTruthy()

    // What the person's browser ended on: the server's loopback, with the code.
    await connectors.finishOAuthFromUrl(`http://127.0.0.1:1/oauth/callback?code=abc&state=${state}`).catch(() => {})
    expect(tokenCalls).toHaveLength(1)
    expect(tokenCalls[0]).toContain('code=abc')

    // Pasted after it finished (the callback got there first): done, not expired, and not exchanged twice.
    expect(await connectors.finishOAuthFromUrl(`http://127.0.0.1:1/oauth/callback?code=abc&state=${state}`)).toBe(true)
    expect(tokenCalls).toHaveLength(1)
    // One it never asked for is no answer.
    expect(await connectors.finishOAuthFromUrl('http://127.0.0.1:1/oauth/callback?code=abc&state=nope')).toBe(false)
  })

  it('says what went wrong with an address that is no answer', async () => {
    await expect(connectors.finishOAuthFromUrl('não é um endereço')).rejects.toThrow()
    await expect(connectors.finishOAuthFromUrl('http://127.0.0.1:1/oauth/callback?error=access_denied')).rejects.toThrow(/access_denied/)
  })
})
