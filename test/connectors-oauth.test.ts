// A connector that signs in through OAuth keeps its credentials between launches.
// The gateway's callback port changes every launch, and re-registering the app on
// each one throws away the refresh token, which belongs to the client that got it.
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager, sameLoopbackRedirect } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { plainCipher, Secrets } from '../src/core/secrets'

let server: Server
let base: string
let db: Db
let secrets: Secrets
let opened: string[]
let registrations: number
let refreshes: string[]
let expireAccessToken: () => void
let revokeRefreshTokens: () => void
// How the authorization server behaves: rotating refresh tokens (each works once, like Linear's and
// Notion's), a slow token endpoint (so two refreshes overlap), and a token endpoint that's down.
let rotate: boolean
let tokenDelayMs: number
let tokenDown: number // the next refreshes answer 503
let calls: number
let offline: boolean // the authorization server offers offline_access, the MCP server lists only "openid" (Vercel's)
let registered: { scope?: string }[]

const body = async (req: import('node:http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString()
}

// An authorization server that registers apps on the fly (RFC 7591) and binds a
// refresh token to the client that got it, the way Atlassian's MCP server does.
beforeEach(async () => {
  opened = []
  registrations = 0
  refreshes = []
  rotate = false
  tokenDelayMs = 0
  tokenDown = 0
  calls = 0
  offline = false
  registered = []
  let current = '' // only the newest access token works, as if the older one had expired
  expireAccessToken = () => {
    current = ''
  }
  const owner = new Map<string, string>()
  revokeRefreshTokens = () => owner.clear()

  server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, payload: unknown): void =>
        void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
      const url = new URL(req.url ?? '/', base)
      if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base], ...(offline ? { scopes_supported: ['openid'] } : {}) })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          ...(offline ? { scopes_supported: ['openid', 'email', 'offline_access', 'profile'] } : {})
        })
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        registrations += 1
        const asked = JSON.parse(await body(req)) as { scope?: string }
        registered.push(asked)
        return json(201, { ...asked, client_id: `client-${registrations}` })
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await body(req))
        const clientId = form.get('client_id') ?? ''
        const refreshToken = form.get('refresh_token')
        if (refreshToken) {
          refreshes.push(`${clientId} (issued to ${owner.get(refreshToken) ?? 'nobody'})`)
          if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs))
          if (tokenDown > 0) {
            tokenDown -= 1
            res.writeHead(502, { 'content-type': 'text/html' }).end('<html>Bad Gateway</html>')
            return
          }
          if (owner.get(refreshToken) !== clientId) return json(400, { error: 'invalid_grant' })
          current = `at-${refreshes.length}-${Date.now()}`
          if (!rotate) return json(200, { access_token: current, token_type: 'Bearer', expires_in: 3600, refresh_token: refreshToken })
          owner.delete(refreshToken)
          const next = `rt-r${refreshes.length}`
          owner.set(next, clientId)
          return json(200, { access_token: current, token_type: 'Bearer', expires_in: 3600, refresh_token: next })
        }
        current = `at-${owner.size + 1}-${Date.now()}`
        const fresh = `rt-${owner.size + 1}`
        owner.set(fresh, clientId)
        return json(200, { access_token: current, token_type: 'Bearer', expires_in: 3600, refresh_token: fresh })
      }

      // The MCP endpoint: it turns away anything without a token it handed out.
      if (!current || (req.headers.authorization ?? '').replace(/^Bearer /, '') !== current) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end() // no server-sent stream: the client carries on without it
        return
      }
      const call = JSON.parse(await body(req)) as { id?: number; method?: string; params?: { protocolVersion?: string } }
      if (call.method === 'initialize') {
        return json(200, { jsonrpc: '2.0', id: call.id, result: { protocolVersion: call.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
      }
      if (call.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: call.id, result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } })
      if (call.method === 'tools/call') {
        calls += 1
        return json(200, { jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: 'ok' }] } })
      }
      res.writeHead(202).end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-oauth-')), 'test.db'))
  secrets = new Secrets(db, plainCipher)
})

afterEach(async () => {
  db.close()
  await new Promise((resolve) => server.close(resolve))
})

// One launch of the app, listening for the OAuth callback on its own port.
const launch = (callbackPort: number, withSecrets: Secrets = secrets): ConnectorManager =>
  new ConnectorManager({ db, secrets: withSecrets, emit: () => {}, openUrl: (u) => opened.push(u), oauthCallbackUrl: () => `http://127.0.0.1:${callbackPort}/oauth/callback` })

// A launch whose system key won't open what was saved (the Keychain said no, or the key changed).
const lockedOut = (): Secrets =>
  new Secrets(db, {
    encrypt: plainCipher.encrypt,
    decrypt: async () => {
      throw new Error("I couldn't open the saved credentials (the system's key changed).")
    }
  })

describe('OAuth credentials across launches', () => {
  it('signs in once and refreshes on the next launch, when only the callback port changed', async () => {
    const first = launch(51001)
    const id = await first.add({ name: 'Atlassian', kind: 'remote', url: `${base}/mcp`, auth: 'oauth' })
    await first.connect(id) // the background connect from add()
    const authorization = await first.authorize(id)
    expect(authorization).toBeTruthy()
    expect(registrations).toBe(1)
    const state = new URL(authorization!).searchParams.get('state')!
    expect(await first.finishOAuth(state, 'code-1')).toBe(true)
    expect(first.get(id)!.status).toBe('connected')
    await first.closeAll()
    expireAccessToken() // the access token grew old while the app was closed

    // Next launch: same connector, another callback port.
    const second = launch(51002)
    await second.connect(id)
    expect(second.get(id)!.status).toBe('connected')
    expect(opened).toHaveLength(1) // no browser again
    expect(registrations).toBe(1) // and no registration again
    expect(refreshes).toEqual(['client-1 (issued to client-1)'])
    await second.closeAll()
  })

  it('registers again for a new sign-in, so a server that wants the exact address still takes it', async () => {
    const first = launch(51001)
    const id = await first.add({ name: 'Atlassian', kind: 'remote', url: `${base}/mcp`, auth: 'oauth' })
    await first.connect(id)
    const state = new URL((await first.authorize(id))!).searchParams.get('state')!
    await first.finishOAuth(state, 'code-1')
    await first.closeAll()
    expireAccessToken()
    revokeRefreshTokens() // signed out on the server's side while the app was closed

    const second = launch(51002)
    await second.connect(id) // in the background: no browser, it waits to be signed in
    expect(second.get(id)!.status).toBe('needs_auth')
    expect(opened).toHaveLength(1)
    const again = new URL((await second.authorize(id))!)
    expect(registrations).toBe(2) // a registration with this launch's address
    expect(again.searchParams.get('client_id')).toBe('client-2')
    expect(again.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51002/oauth/callback')
    await second.closeAll()
  })
})

// Signs a new connector in on a first launch, then closes that launch with the access token gone stale.
const signedIn = async (): Promise<string> => {
  const first = launch(51001)
  const id = await first.add({ name: 'Linear', kind: 'remote', url: `${base}/mcp`, auth: 'oauth' })
  await first.connect(id)
  const state = new URL((await first.authorize(id))!).searchParams.get('state')!
  await first.finishOAuth(state, 'code-1')
  expect(first.get(id)!.status).toBe('connected')
  await first.closeAll()
  expireAccessToken()
  return id
}

describe('renewing the sign-in', () => {
  it('asks to stay signed in when the authorization server offers it, though the server lists only its own scopes', async () => {
    offline = true
    const m = launch(51001)
    const id = await m.add({ name: 'Vercel', kind: 'remote', url: `${base}/mcp`, auth: 'oauth' })
    await m.connect(id)
    const page = new URL((await m.authorize(id))!)
    // Without it the sign-in has no refresh token and asks again when the access token expires, every day.
    expect(page.searchParams.get('scope')?.split(' ').sort()).toEqual(['offline_access', 'openid'])
    expect(page.searchParams.get('prompt')).toBe('consent')
    expect(registered.at(-1)?.scope?.split(' ')).toContain('offline_access')
    expect(await m.finishOAuth(page.searchParams.get('state')!, 'code-1')).toBe(true)
    expect(m.get(id)!.status).toBe('connected')
    await m.closeAll()
  })

  it('asks for nothing more of a server that does not offer it', async () => {
    const m = launch(51001)
    const id = await m.add({ name: 'Atlassian', kind: 'remote', url: `${base}/mcp`, auth: 'oauth' })
    await m.connect(id)
    const page = new URL((await m.authorize(id))!)
    expect(page.searchParams.get('scope') ?? '').not.toContain('offline_access')
    expect(registered.at(-1)?.scope ?? '').not.toContain('offline_access')
    await m.closeAll()
  })

  it('renews once when two calls find the access token expired together, and keeps the new refresh token', async () => {
    rotate = true
    tokenDelayMs = 50
    const id = await signedIn()
    const second = launch(51002)
    await second.connect(id)
    expect(second.get(id)!.status).toBe('connected')
    expireAccessToken() // it grows old again while the app is open
    const results = await Promise.allSettled([second.call(id, 'search', {}), second.call(id, 'search', {})])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await secrets.getJson(`connector:${id}:oauth_tokens`)).toMatchObject({ refresh_token: expect.stringMatching(/^rt-r/) })
    await second.closeAll()

    // And the next launch still renews on its own.
    expireAccessToken()
    const third = launch(51003)
    await third.connect(id)
    expect(third.get(id)!.status).toBe('connected')
    expect(opened).toHaveLength(1)
    await third.closeAll()
  })

  it("doesn't ask to sign in when the token endpoint is down at launch, and connects when it's back", async () => {
    const id = await signedIn()
    tokenDown = 1
    const second = launch(51002)
    await second.connect(id)
    expect(second.get(id)!.status).toBe('error')
    expect(second.get(id)!.error).toMatch(/renovar/)
    expect(await secrets.getJson(`connector:${id}:oauth_tokens`)).toMatchObject({ refresh_token: 'rt-1' })
    await second.connect(id) // the retry
    expect(second.get(id)!.status).toBe('connected')
    expect(opened).toHaveLength(1)
    await second.closeAll()
  })

  it('renews with the saved sign-in when Authorize is clicked, instead of signing in again', async () => {
    const id = await signedIn()
    tokenDown = 1
    const second = launch(51002)
    await second.connect(id) // fails for now
    expect(await second.authorize(id)).toBeUndefined()
    expect(second.get(id)!.status).toBe('connected')
    expect(opened).toHaveLength(1)
    expect(registrations).toBe(1)
    await second.closeAll()
  })
})

describe("a saved sign-in the system key won't open", () => {
  it('keeps it, says so once per connector without retrying, and works again once the key is back', async () => {
    const id = await signedIn()
    const before = db.getSecret(`connector:${id}:oauth_tokens`)
    const locked = launch(51002, lockedOut())
    await locked.connect(id)
    const c = locked.get(id)!
    expect(c.status).toBe('needs_auth')
    expect(c.error).toMatch(/Nada foi apagado|Nothing was deleted/)
    expect(db.getSecret(`connector:${id}:oauth_tokens`)).toBe(before)
    expect(db.getSecret(`connector:${id}:oauth_client`)).toBeDefined()
    expect(opened).toHaveLength(1)
    expect(refreshes).toEqual([]) // nothing went to the server
    await locked.closeAll()

    const back = launch(51003)
    await back.connect(id)
    expect(back.get(id)!.status).toBe('connected')
    expect(registrations).toBe(1)
    await back.closeAll()
  })

  it('signs in again when Authorize is clicked, in place of what it could not open', async () => {
    const id = await signedIn()
    const locked = launch(51002, lockedOut())
    await locked.connect(id)
    const page = await locked.authorize(id)
    expect(page).toBeTruthy()
    expect(opened).toHaveLength(2)
    await locked.closeAll()
  })
})

describe('the loopback redirect, port aside', () => {
  it('ignores only the port, and only on an http loopback address', () => {
    expect(sameLoopbackRedirect('http://127.0.0.1:51001/oauth/callback', 'http://127.0.0.1:52002/oauth/callback')).toBe(true)
    expect(sameLoopbackRedirect('http://[::1]:1/oauth/callback', 'http://[::1]:2/oauth/callback')).toBe(true)
    expect(sameLoopbackRedirect('http://localhost:1/oauth/callback', 'http://localhost:2/oauth/callback')).toBe(true)
    expect(sameLoopbackRedirect('http://127.0.0.1:1/oauth/callback', 'http://127.0.0.1:2/other')).toBe(false)
    expect(sameLoopbackRedirect('http://127.0.0.1:1/oauth/callback', 'http://localhost:2/oauth/callback')).toBe(false)
    expect(sameLoopbackRedirect('https://app.example.com:1/oauth/callback', 'https://app.example.com:2/oauth/callback')).toBe(false)
    expect(sameLoopbackRedirect('https://127.0.0.1:1/oauth/callback', 'https://127.0.0.1:2/oauth/callback')).toBe(false)
  })
})
