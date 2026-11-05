import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { ConnectorManager, staleSession } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { plainCipher, Secrets } from '../src/core/secrets'

const sdk = pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm')).href
const tools = [{ name: 'ping', description: 'Responde pong.', inputSchema: { type: 'object' as const, properties: {} } }, { name: 'sair', description: 'Encerra o servidor.', inputSchema: { type: 'object' as const, properties: {} } }]

let db: Db
let connectors: ConnectorManager

const until = async (ok: () => boolean, ms = 8000): Promise<void> => {
  for (let i = 0; i < ms / 20 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
  expect(ok()).toBe(true)
}
const status = (id: string): string | undefined => connectors.get(id)?.status
const text = (r: { content: { type: string; text?: string }[] }): string => r.content.map((c) => c.text ?? '').join('')

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-reconnect-')), 'test.db'))
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => 'http://127.0.0.1:1/oauth/callback' })
})
afterEach(async () => {
  await connectors.closeAll()
  db.close()
})

describe('a local (stdio) connector whose process ends', () => {
  it('comes back by itself, and its tools work again', async () => {
    // A server that answers "ping" and ends its own process on "sair", like one that crashes or quits when idle.
    const script = join(mkdtempSync(join(tmpdir(), 'tucano-stdio-')), 'server.mjs')
    writeFileSync(
      script,
      `const { Server } = await import('${sdk}/server/index.js')
const { StdioServerTransport } = await import('${sdk}/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = await import('${sdk}/types.js')
const s = new Server({ name: 't', version: '1' }, { capabilities: { tools: {} } })
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ${JSON.stringify(tools)} }))
s.setRequestHandler(CallToolRequestSchema, async (r) => {
  if (r.params.name === 'sair') setTimeout(() => process.exit(0), 50)
  return { content: [{ type: 'text', text: r.params.name === 'ping' ? 'pong' : 'tchau' }] }
})
await s.connect(new StdioServerTransport())`
    )
    const id = await connectors.add({ name: 'Local', kind: 'stdio', command: process.execPath, args: [script] })
    await until(() => status(id) === 'connected')

    await connectors.call(id, 'sair', {})
    await until(() => status(id) === 'disconnected')
    await until(() => status(id) === 'connected') // about 2 s later, on its own
    expect(text((await connectors.call(id, 'ping', {})) as never)).toBe('pong')
  }, 20_000)
})

describe('a remote connector whose server forgets the session', () => {
  let server: Server
  let url: string
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  beforeEach(async () => {
    sessions.clear()
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const sid = req.headers['mcp-session-id'] as string | undefined
        let transport = sid ? sessions.get(sid) : undefined
        if (sid && !transport) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }))
          return
        }
        if (!transport) {
          const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, onsessioninitialized: (s) => void sessions.set(s, t) })
          const mcp = new McpServer({ name: 'r', version: '1' }, { capabilities: { tools: {} } })
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
          mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
          await mcp.connect(t)
          transport = t
        }
        await transport.handleRequest(req, res)
      })()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it('a call after the session expired opens a new one and goes through', async () => {
    const id = await connectors.add({ name: 'Remoto', kind: 'remote', url, auth: 'none' })
    await until(() => status(id) === 'connected')
    expect(text((await connectors.call(id, 'ping', {})) as never)).toBe('pong')

    sessions.clear() // idle too long: the server forgot it
    expect(text((await connectors.call(id, 'ping', {})) as never)).toBe('pong')
    expect(status(id)).toBe('connected')
    expect(sessions.size).toBe(1) // a new session, once
  })
})

describe('which failed calls go again on a new connection', () => {
  it("only those that never ran: a forgotten session, or no connection to send them on", () => {
    expect(staleSession(new StreamableHTTPError(404, 'Session not found'))).toBe(true)
    expect(staleSession(new Error('Bad Request: No valid session ID provided'))).toBe(true)
    expect(staleSession(new Error('Not connected'))).toBe(true)
  })

  it('not a call cut by a dropped connection: the server may have run it, and a write would go twice', () => {
    expect(staleSession(McpError.fromError(ErrorCode.ConnectionClosed, 'Connection closed'))).toBe(false)
    expect(staleSession(new StreamableHTTPError(500, 'Internal error'))).toBe(false)
  })
})
