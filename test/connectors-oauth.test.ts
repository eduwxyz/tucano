// A connector that signs in through OAuth keeps its credentials between launches.
// The gateway's callback port changes every launch, and re-registering the app on
// each one throws away the refresh token, which belongs to the client that got it.
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
let secrets: Secrets
let opened: string[]
let registrations: number
let refreshes: string[]
let expireAccessToken: () => void

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
  let current = '' // only the newest access token works, as if the older one had expired
  expireAccessToken = () => {
    current = ''
  }
  const owner = new Map<string, string>()

  server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, payload: unknown): void =>
        void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
      const url = new URL(req.url ?? '/', base)
      if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base] })
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
          token_endpoint_auth_methods_supported: ['none']
        })
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        registrations += 1
        return json(201, { ...JSON.parse(await body(req)), client_id: `client-${registrations}` })
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await body(req))
        const clientId = form.get('client_id') ?? ''
        const refreshToken = form.get('refresh_token')
        if (refreshToken) {
          refreshes.push(`${clientId} (issued to ${owner.get(refreshToken) ?? 'nobody'})`)
          if (owner.get(refreshToken) !== clientId) return json(400, { error: 'invalid_grant' })
          current = `at-${owner.size + 1}-${Date.now()}`
          return json(200, { access_token: current, token_type: 'Bearer', expires_in: 3600, refresh_token: refreshToken })
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
      if (call.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: call.id, result: { tools: [] } })
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
const launch = (callbackPort: number): ConnectorManager =>
  new ConnectorManager({ db, secrets, emit: () => {}, openUrl: (u) => opened.push(u), oauthCallbackUrl: () => `http://127.0.0.1:${callbackPort}/oauth/callback` })

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
})
