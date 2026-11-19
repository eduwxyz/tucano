// Google's MCP servers as they answer today: the handshake and the tool list work for anyone, and only a tool
// call asks for the sign-in (a 401 that names the tool's own resource metadata). Without a saved sign-in the
// connector looked connected while every call failed with "Unauthorized", and Reconnect never opened the browser.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager, googleHint } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { plainCipher, Secrets } from '../src/core/secrets'

let google: Server
let base: string
let db: Db
let secrets: Secrets
let connectors: ConnectorManager
let opened: string[]
let calls: number
// How Google treats the tokens: it takes them ('ok'), turns every one away, even fresh ('refuse'), or finds
// the sign-in short of a permission ('scope'). Refresh tokens it no longer takes answer invalid_grant.
let mode: 'ok' | 'refuse' | 'scope'
let refreshRefused: boolean
let valid: Set<string>
let issued: number

const body = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString()
}

beforeEach(async () => {
  opened = []
  calls = 0
  mode = 'ok'
  refreshRefused = false
  valid = new Set()
  issued = 0
  google = createServer((req, res) => {
    void (async () => {
      const json = (status: number, payload: unknown, headers: Record<string, string> = {}): void =>
        void res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload))
      const url = new URL(req.url ?? '/', base)
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp/v1')
        return json(200, { resource: `${base}/mcp/v1`, authorization_servers: [base], scopes_supported: ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify'] })
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource/'))
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify'] })
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server'))
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/o/oauth2/v2/auth`,
          token_endpoint: `${base}/token`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic']
        })
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await body(req))
        if (form.get('grant_type') === 'refresh_token' && refreshRefused) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
        const access = `ya29.${++issued}`
        valid.add(access)
        return json(200, { access_token: access, refresh_token: form.get('refresh_token') ?? '1//r', token_type: 'Bearer', expires_in: 3599 })
      }
      if (url.pathname !== '/mcp/v1') return json(404, {})
      if (req.method !== 'POST') return void res.writeHead(405).end()
      const msg = JSON.parse(await body(req)) as { id?: number; method?: string; params?: { name?: string; protocolVersion?: string } }
      if (msg.method === 'initialize')
        return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'StatelessServer', version: 'ESF' } } })
      if (msg.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search_threads', inputSchema: { type: 'object' } }] } })
      if (msg.method === 'tools/call') {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        const text = (t: string): unknown => ({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: t }], isError: true } })
        if (!token)
          return json(401, text('Request is missing required authentication credential.'), {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/${msg.params?.name}"`
          })
        if (mode === 'refuse' || !valid.has(token))
          return json(401, text('Request had invalid authentication credentials.'), { 'www-authenticate': `Bearer realm="${base}/", error="invalid_token"` })
        if (mode === 'scope')
          return json(403, text('Request had insufficient authentication scopes.'), {
            'www-authenticate': `Bearer error="insufficient_scope", scope="https://www.googleapis.com/auth/gmail.modify"`
          })
        calls += 1
        return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'threads' }] } })
      }
      res.writeHead(202).end()
    })()
  })
  await new Promise<void>((resolve) => google.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(google.address() as AddressInfo).port}`
  db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-google-')), 'test.db'))
  secrets = new Secrets(db, plainCipher)
  connectors = new ConnectorManager({
    db,
    secrets,
    emit: () => {},
    openUrl: (u) => opened.push(u),
    oauthCallbackUrl: () => 'http://127.0.0.1:1/oauth/callback',
    ownAppOf: (u) => (u?.startsWith(base) ? { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.modify'] } : undefined)
  })
  await connectors.setOwnApp('google', { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-s' })
})

afterEach(async () => {
  await connectors.settled()
  await connectors.closeAll()
  db.close()
  await new Promise((resolve) => google.close(resolve))
})

// Adds Gmail, signs it in through Authorize, and comes back from Google's page with a code.
const signIn = async (id?: string): Promise<string> => {
  const gmail = id ?? (await connectors.add({ name: 'Gmail', kind: 'remote', url: `${base}/mcp/v1`, auth: 'oauth' }))
  await connectors.settled()
  const page = await connectors.authorize(gmail)
  expect(page).toBeTruthy()
  await connectors.finishOAuth(new URL(page!).searchParams.get('state')!, `code-${opened.length}`)
  return gmail
}

describe("Google's connectors, signed in only when a tool is called", () => {
  it("isn't connected without a sign-in: it asks for one, and Authorize opens Google's page", async () => {
    const id = await connectors.add({ name: 'Gmail', kind: 'remote', url: `${base}/mcp/v1`, auth: 'oauth' })
    await connectors.settled()
    expect(connectors.get(id)!.status).toBe('needs_auth') // not "connected" with every call bound to fail
    await connectors.connect(id) // Reconnect, in the background: still asks, opens nothing
    expect(connectors.get(id)!.status).toBe('needs_auth')
    expect(opened).toEqual([])

    const page = new URL((await connectors.authorize(id))!)
    expect(opened).toHaveLength(1)
    expect(page.pathname).toBe('/o/oauth2/v2/auth')
    expect(page.searchParams.get('client_id')).toBe('1-a.apps.googleusercontent.com')
    expect(page.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.modify')
    expect(page.searchParams.get('access_type')).toBe('offline')
    expect(page.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1/oauth/callback')

    await connectors.finishOAuth(page.searchParams.get('state')!, 'code-1')
    expect(connectors.get(id)!.status).toBe('connected')
    const r = await connectors.call(id, 'search_threads', {})
    expect(r.isError).toBeFalsy()
    expect(calls).toBe(1)
  })

  it('renews an expired access token on a call, without asking', async () => {
    const id = await signIn()
    valid.clear() // the access token expired
    const r = await connectors.call(id, 'search_threads', {})
    expect(r.isError).toBeFalsy()
    expect(connectors.get(id)!.status).toBe('connected')
  })

  it('a sign-in Google stopped renewing (an app in testing, after 7 days) asks for Authorize, not a bare "Unauthorized"', async () => {
    const id = await signIn()
    valid.clear()
    refreshRefused = true
    await expect(connectors.call(id, 'search_threads', {})).rejects.toThrow(/Falta autorizar o Gmail: em Conectores, clique em Autorizar/)
    expect(connectors.get(id)!.status).toBe('needs_auth')
    refreshRefused = false
    expect(await connectors.authorize(id)).toBeTruthy() // the browser, for a new sign-in
    expect(opened).toHaveLength(2)
  })

  it('a token Google turns away even renewed asks for a new sign-in in the browser, not another renewal', async () => {
    const id = await signIn()
    mode = 'refuse'
    const err = await connectors.call(id, 'search_threads', {}).catch((e: Error) => e)
    expect(String(err)).toMatch(/recusou o login do Gmail, mesmo renovado/)
    expect(String(err)).toMatch(/Usuários de teste/)
    expect(String(err)).not.toMatch(/^Error: Unauthorized$/)
    expect(connectors.get(id)!.status).toBe('needs_auth')
    expect(connectors.get(id)!.error).toMatch(/clique em Autorizar no Gmail/)

    await connectors.connect(id) // Reconnect: it doesn't pretend to be connected
    expect(connectors.get(id)!.status).toBe('needs_auth')
    mode = 'ok'
    await signIn(id) // Authorize opens the page (signIn checks it), and the new sign-in works
    expect(opened).toHaveLength(2)
    expect((await connectors.call(id, 'search_threads', {})).isError).toBeFalsy()
  })

  it('a sign-in short of a permission says to tick every box, and Authorize asks again in the browser', async () => {
    const id = await signIn()
    mode = 'scope'
    await expect(connectors.call(id, 'search_threads', {})).rejects.toThrow(/alguma caixa ficou desmarcada.*marque todas/)
    expect(connectors.get(id)!.status).toBe('needs_auth')
    mode = 'ok'
    await signIn(id)
    expect(opened).toHaveLength(2)
    expect(connectors.get(id)!.status).toBe('connected')
  })
})

describe('googleHint', () => {
  const gmail = 'https://gmailmcp.googleapis.com/mcp/v1'
  it('an API turned off in the project: which one, where to turn it on, and that signing in again won’t help', () => {
    const raw =
      'Gmail MCP API has not been used in project 123456789 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmailmcp.googleapis.com/overview?project=123456789 then retry. (SERVICE_DISABLED)'
    const hint = googleHint(gmail, raw)!
    expect(hint).toMatch(/gmailmcp\.googleapis\.com/)
    expect(hint).toMatch(/123456789/)
    expect(hint).toContain('https://console.developers.google.com/apis/api/gmailmcp.googleapis.com/overview?project=123456789')
    expect(hint).toMatch(/autorizar de novo não resolve/)
    expect(googleHint(gmail, '{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"reason":"accessNotConfigured"}]}}')).toMatch(/não está ativada/)
  })

  it('a missing permission, and a refused sign-in, each say what the person does', () => {
    expect(googleHint(gmail, 'Request had insufficient authentication scopes.')).toMatch(/marcar todas as caixas/)
    expect(googleHint(gmail, 'Request had invalid authentication credentials. Expected OAuth 2 access token')).toMatch(/Usuários de teste/)
  })

  it('still names the Developer Preview, and leaves other servers alone', () => {
    expect(googleHint(gmail, 'Access to this tool requires that your Google Cloud project (1) is enrolled in the Google Workspace Developer Preview Program')).toMatch(
      /Developer Preview Program/
    )
    expect(googleHint('https://mcp.linear.app/mcp', 'Request had insufficient authentication scopes.')).toBeUndefined()
    expect(googleHint(gmail, 'Requested entity was not found.')).toBeUndefined()
  })
})
