import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { OpError } from '../src/core/onepassword'
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
    await expect(connectors.finishOAuthFromUrl('http://127.0.0.1:1/oauth/callback?error=access_denied')).rejects.toThrow(/recusou o acesso.*Permitir/)
    await expect(connectors.finishOAuthFromUrl('http://127.0.0.1:1/oauth/callback?error=server_error')).rejects.toThrow(/server_error/)
  })
})

// Google's sign-in takes no app it hasn't met: its connectors sign in with the person's own.
describe("Google's connectors", () => {
  let google: Server
  let gBase: string
  const calls: string[] = []
  const tokenBodies: string[] = []
  let gConnectors: ConnectorManager
  let secrets: Secrets

  beforeEach(async () => {
    calls.length = 0
    tokenBodies.length = 0
    google = createServer((req, res) => {
      calls.push(req.url ?? '')
      const json = (body: unknown, status = 200): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (req.url?.startsWith('/.well-known/oauth-protected-resource'))
        return json({ resource: `${gBase}/mcp/v1`, authorization_servers: [gBase], scopes_supported: ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify'] })
      if (req.url?.startsWith('/.well-known/oauth-authorization-server'))
        return json({ issuer: gBase, authorization_endpoint: `${gBase}/o/oauth2/v2/auth`, token_endpoint: `${gBase}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] })
      if (req.url === '/token') {
        let body = ''
        req.on('data', (c: Buffer) => (body += c))
        req.on('end', () => {
          tokenBodies.push(`${body}&auth=${req.headers.authorization ?? ''}`)
          json({ access_token: 'ya29.x', refresh_token: '1//r', token_type: 'Bearer', expires_in: 3600 })
        })
        return
      }
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${gBase}/.well-known/oauth-protected-resource"` }).end()
    })
    await new Promise<void>((resolve) => google.listen(0, '127.0.0.1', resolve))
    gBase = `http://127.0.0.1:${(google.address() as AddressInfo).port}`
    secrets = new Secrets(db, plainCipher)
    gConnectors = new ConnectorManager({
      db,
      secrets,
      emit: () => {},
      openUrl: () => {},
      oauthCallbackUrl: () => 'http://127.0.0.1:1/oauth/callback',
      fixedCallbackUrl: () => 'http://localhost:47717/oauth/callback',
      ownAppOf: (url) =>
        url === `${gBase}/mcp/v1/slack`
          ? { provider: 'slack', scopes: ['chat:write', 'search:read.public'] }
          : url?.startsWith(gBase)
            ? { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.modify'] }
            : undefined
    })
  })

  afterEach(async () => {
    await gConnectors.settled() // a connect under way would outlive the database
    await gConnectors.closeAll()
    await new Promise((resolve) => google.close(resolve))
  })

  it('says to make the Google app first when there is none', async () => {
    const id = await gConnectors.add({ name: 'Gmail', kind: 'remote', url: `${gBase}/mcp/v1`, auth: 'oauth' })
    await gConnectors.authorize(id)
    expect(gConnectors.get(id)!.error).toMatch(/app do Google/)
    expect(calls).toEqual([]) // it didn't even try
  })

  it("takes only a Google client ID, and never shows the secret back", async () => {
    await expect(gConnectors.setOwnApp('google', { clientId: 'abc', clientSecret: 's' })).rejects.toThrow(/googleusercontent/)
    await expect(gConnectors.setOwnApp('google', { clientId: '1-a.apps.googleusercontent.com', clientSecret: ' ' })).rejects.toThrow(/chave secreta/)
    await gConnectors.setOwnApp('google', { clientId: ' 1-a.apps.googleusercontent.com ', clientSecret: 'GOCSPX-s' })
    expect(await gConnectors.ownApp('google')).toEqual({ clientId: '1-a.apps.googleusercontent.com', redirectUrl: 'http://127.0.0.1:1/oauth/callback' })
  })

  it('signs in with that app, asking for its scopes and a refresh token, and renews with its secret', async () => {
    await gConnectors.setOwnApp('google', { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-s' })
    const id = await gConnectors.add({ name: 'Gmail', kind: 'remote', url: `${gBase}/mcp/v1`, auth: 'oauth' })
    await gConnectors.connect(id)
    const page = new URL((await gConnectors.authorize(id))!)
    expect(page.pathname).toBe('/o/oauth2/v2/auth')
    expect(page.searchParams.get('client_id')).toBe('1-a.apps.googleusercontent.com')
    expect(page.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.modify') // not the full mail.google.com the server lists
    expect(page.searchParams.get('access_type')).toBe('offline')
    expect(page.searchParams.get('prompt')).toBe('consent')
    expect(calls.some((u) => u.startsWith('/register'))).toBe(false)

    await gConnectors.finishOAuthFromUrl(`http://127.0.0.1:1/oauth/callback?code=c1&state=${page.searchParams.get('state')}`).catch(() => {})
    // The code, then a renewal: this fake server turns every token away, so the connector renews at once.
    const bodies = tokenBodies.map((b) => new URLSearchParams(b))
    expect(bodies[0]!.get('code')).toBe('c1')
    expect(bodies.some((b) => b.get('grant_type') === 'refresh_token' && b.get('refresh_token') === '1//r')).toBe(true)
    // Basic, as Google lists first: the ID and the secret in the header.
    for (const b of bodies) expect(b.get('auth')).toBe(`Basic ${Buffer.from('1-a.apps.googleusercontent.com:GOCSPX-s').toString('base64')}`)
    expect(await secrets.getJson(`connector:${id}:oauth_tokens`)).toMatchObject({ refresh_token: '1//r' })
    expect(await secrets.getJson(`connector:${id}:oauth_client`)).toBeUndefined() // the app is kept once, for all of them
  })

  it('signs the Google connectors out when the app changes, and keeps them with the same one', async () => {
    await gConnectors.setOwnApp('google', { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-s' })
    const gmail = await gConnectors.add({ name: 'Gmail', kind: 'remote', url: `${gBase}/mcp/v1`, auth: 'oauth' })
    const other = await gConnectors.add({ name: 'Linear', kind: 'remote', url: `${base}/mcp`, auth: 'oauth' })
    await secrets.setJson(`connector:${gmail}:oauth_tokens`, { access_token: 'a', token_type: 'Bearer' })
    await secrets.setJson(`connector:${other}:oauth_tokens`, { access_token: 'b', token_type: 'Bearer' })
    await gConnectors.setOwnApp('google', { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-new' })
    expect(await secrets.getJson(`connector:${gmail}:oauth_tokens`)).toBeDefined()
    await gConnectors.setOwnApp('google', { clientId: '2-b.apps.googleusercontent.com', clientSecret: 'GOCSPX-b' })
    expect(await secrets.getJson(`connector:${gmail}:oauth_tokens`)).toBeUndefined()
    expect(await secrets.getJson(`connector:${other}:oauth_tokens`)).toBeDefined()
  })

  it("signs Slack in with the person's app, back to the fixed address its app registered", async () => {
    await expect(gConnectors.setOwnApp('slack', { clientId: '1-a.apps.googleusercontent.com', clientSecret: 's' })).rejects.toThrow(/Slack/)
    const id = await gConnectors.add({ name: 'Slack', kind: 'remote', url: `${gBase}/mcp/v1/slack`, auth: 'oauth' })
    await gConnectors.authorize(id)
    expect(gConnectors.get(id)!.error).toMatch(/app do Slack/)

    await gConnectors.setOwnApp('slack', { clientId: '123.456', clientSecret: 'shh' })
    expect(await gConnectors.ownApp('slack')).toEqual({ clientId: '123.456', redirectUrl: 'http://localhost:47717/oauth/callback' })
    expect(await gConnectors.ownApp('google')).toEqual({ redirectUrl: 'http://127.0.0.1:1/oauth/callback' }) // apart from Google's
    await gConnectors.settled() // saving the app tried the connector again, on its own
    expect(gConnectors.get(id)!.status).toBe('needs_auth')
    const page = new URL((await gConnectors.authorize(id))!)
    expect(page.searchParams.get('client_id')).toBe('123.456')
    expect(page.searchParams.get('redirect_uri')).toBe('http://localhost:47717/oauth/callback')
    expect(page.searchParams.get('scope')).toBe('chat:write search:read.public')
    expect(page.searchParams.has('access_type')).toBe(false) // Google's alone
    await gConnectors.finishOAuthFromUrl(`http://localhost:47717/oauth/callback?code=s1&state=${page.searchParams.get('state')}`).catch(() => {})
    expect(new URLSearchParams(tokenBodies[0]).get('redirect_uri')).toBe('http://localhost:47717/oauth/callback')
  })
})

describe('a connector with a token', () => {
  it('asks for the token, not for a browser, and takes it without being removed', async () => {
    let seen: string | undefined
    const srv = createServer((req, res) => {
      seen = req.headers.authorization
      res.writeHead(401).end()
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const id = await connectors.add({ kind: 'remote', name: 'Demo', url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`, auth: 'token' })
    await connectors.connect(id)
    expect(connectors.get(id)).toMatchObject({ status: 'error' })
    await connectors.setToken(id, ' abc ')
    expect(seen).toBe('Bearer abc')
    await expect(connectors.setToken(id, '  ')).rejects.toThrow()
    srv.close()
  })

  it("says the token was refused whatever the server writes with its 401, like Linear's", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_token","error_description":"Missing or invalid access token"}')
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`
    const withToken = await connectors.add({ kind: 'remote', name: 'Linear', url, auth: 'token' })
    await connectors.connect(withToken)
    expect(connectors.get(withToken)).toMatchObject({ status: 'error', error: expect.stringMatching(/recusou o token|refused the token/) })
    const withNone = await connectors.add({ kind: 'remote', name: 'Other', url })
    await connectors.connect(withNone)
    expect(connectors.get(withNone)).toMatchObject({ status: 'error', error: expect.stringMatching(/pede autorização|asks for authorization/) })
    srv.close()
  })

  it('a token saved during a connection attempt is the one tried next', async () => {
    const seen: (string | undefined)[] = []
    const srv = createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.writeHead(401).end()
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const id = await connectors.add({ kind: 'remote', name: 'Demo', url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`, auth: 'token' })
    void connectors.connect(id)
    await connectors.setToken(id, 'new')
    expect(seen.at(-1)).toBe('Bearer new')
    srv.close()
  })
})

describe('a secret kept in 1Password', () => {
  it('keeps only the reference, and reads the value on each connection', async () => {
    const seen: (string | undefined)[] = []
    const srv = createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.writeHead(401).end()
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const reads: string[] = []
    const secrets = new Secrets(db, plainCipher)
    const mine = new ConnectorManager({
      db,
      secrets,
      emit: () => {},
      openUrl: () => {},
      oauthCallbackUrl: () => '',
      readOp: async (ref) => (reads.push(ref), 'from-1password')
    })
    const id = await mine.add({ kind: 'remote', name: 'GitHub', url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`, auth: 'token', token: ' op://Dev/GitHub/token ' })
    await mine.connect(id)
    expect(seen.at(-1)).toBe('Bearer from-1password')
    expect(reads).toEqual(['op://Dev/GitHub/token'])
    expect(await secrets.get(`connector:${id}:token`)).toBe('op://Dev/GitHub/token') // never the value
    await mine.closeAll()
    srv.close()
  })

  it("says what to do when 1Password doesn't give it, and doesn't try again by itself", async () => {
    const mine = new ConnectorManager({
      db,
      secrets: new Secrets(db, plainCipher),
      emit: () => {},
      openUrl: () => {},
      oauthCallbackUrl: () => '',
      readOp: async () => {
        throw new OpError('O 1Password não foi desbloqueado a tempo.')
      }
    })
    const id = await mine.add({ kind: 'stdio', name: 'AWS', command: 'node', args: ['-e', ''], env: { AWS_SECRET_ACCESS_KEY: 'op://Dev/AWS/secret', AWS_REGION: 'us-east-1' } })
    await mine.connect(id)
    expect(mine.get(id)).toMatchObject({ status: 'error', error: 'O 1Password não foi desbloqueado a tempo.' })
    await mine.closeAll()
  })
})

// A server added by hand wore a terminal or a globe: the mark came from the store's entry, and it has
// none. Now it can wear a picture of its own, kept in the database as a data URL so a backup carries it.
describe('the picture a connector wears', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('keeps an image on the connector and gives it back, and takes it away again', async () => {
    const id = await connectors.add({ name: 'Google Services', kind: 'remote', url: `${base}/mcp`, auth: 'none' })
    await connectors.connect(id) // the add already started one: this waits for the server's answer
    await connectors.setIcon(id, png)
    expect(connectors.get(id)!.icon).toBe(png)
    await connectors.setIcon(id, '') // back to the store's mark, or the icon of its kind
    expect(connectors.get(id)!.icon).toBeUndefined()
  })

  it('refuses what is not an image, and a picture too big to be a tile', async () => {
    const id = await connectors.add({ name: 'Google Services', kind: 'remote', url: `${base}/mcp`, auth: 'none' })
    await connectors.connect(id)
    await expect(connectors.setIcon(id, 'https://example.com/logo.png')).rejects.toThrow(/imagem|image/)
    await expect(connectors.setIcon(id, 'data:text/html;base64,PHNjcmlwdD4=')).rejects.toThrow(/imagem|image/)
    await expect(connectors.setIcon(id, `data:image/png;base64,${'A'.repeat(32_001)}`)).rejects.toThrow(/grande|big/)
    expect(connectors.get(id)!.icon).toBeUndefined()
  })
})
