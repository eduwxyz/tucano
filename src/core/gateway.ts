// The gateway is a local MCP server and the only source of tools a CLI gets.
// Each turn opens a session with its own secret URL (a kept session's lasts
// as long as it does) and its own tool list;
// the gateway answers tools/list with exactly that list and refuses any call
// outside it. The CLI never talks to connectors directly.
import { randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../shared/lang'

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
  _meta?: Record<string, unknown> // goes out as is in tools/list
}

// Claude Code keeps an MCP server's tools behind tool search (by name only, loaded when the model
// looks one up). A tool listed with this stays in the prompt: the app's own, few and used often.
export const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true } as const

export interface Session {
  tools: ToolDef[]
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}

export const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], isError })

// Between two turns of a kept session: the process may list its tools again, but nothing runs.
const parked = (tools: ToolDef[]): Session => ({
  tools,
  call: async () => textResult(L('Nenhuma resposta está rodando agora.', 'No reply is running right now.'), true)
})

export class Gateway {
  private http: HttpServer | null = null
  private port = 0
  private sessions = new Map<string, Session>()
  // The URL token of an agent whose engine keeps the connection between turns (Hermes): the
  // CLI's own daemon caches the MCP transport, so a per-turn token would be revoked under it.
  private agents = new Map<string, string>()
  private routes = new Map<string, (url: URL) => Promise<string>>()

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        console.error('[gateway]', e)
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve))
    this.port = (this.http.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    this.http?.closeAllConnections() // don't wait for idle keep-alive sockets
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()))
    this.http = null
  }

  // Plain GET pages on the same local server (the OAuth callback); the handler returns the page text.
  route(path: string, handler: (url: URL) => Promise<string>): void {
    this.routes.set(path, handler)
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  // Returns the URL to hand to the CLI, and a function that revokes it.
  // With `token` (a kept session's), the URL stays the same from one turn to the next, since a
  // process kept open can't be given another: closing then only parks it, with the same tool list
  // and every call refused, until `release`.
  open(session: Session, token?: string): { url: string; close: () => void } {
    const t = token ?? randomBytes(24).toString('hex')
    this.sessions.set(t, session)
    const close = token
      ? () => {
          if (this.sessions.get(t) === session) this.sessions.set(t, parked(session.tools))
        }
      : () => this.sessions.delete(t)
    return { url: `http://127.0.0.1:${this.port}/mcp/${t}`, close }
  }

  // The token of an agent that keeps its connection from one turn to the next, made once and
  // handed to `open` on every turn: the URL the CLI was given stays the same, and between turns
  // the session is parked (its tools listed, every call refused).
  agentToken(agentKey: string): string {
    let t = this.agents.get(agentKey)
    if (!t) {
      t = randomBytes(24).toString('hex')
      this.agents.set(agentKey, t)
    }
    return t
  }

  // The agent is gone (deleted, or its workspace closed): its URL stops answering.
  agentForget(agentKey: string): void {
    const t = this.agents.get(agentKey)
    if (!t) return
    this.agents.delete(agentKey)
    this.sessions.delete(t)
  }

  release(token: string): void {
    this.sessions.delete(token)
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = req.method === 'GET' ? this.routes.get(url.pathname) : undefined
    if (route) {
      const text = await route(url).catch((e: unknown) => `Erro: ${e instanceof Error ? e.message : String(e)}`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset="utf-8"><title>Tucano</title><body style="font:16px system-ui;padding:48px;color:#222">${text.replace(/</g, '&lt;')}</body>`)
      return
    }

    const token = /^\/mcp\/([a-f0-9]{48})$/.exec(req.url ?? '')?.[1]
    const session = token ? this.sessions.get(token) : undefined
    if (!session) {
      res.writeHead(404).end()
      return
    }

    // Stateless: a fresh MCP server per request, bound to this session's tools.
    const server = new Server({ name: 'tucano', version: '0.1.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: session.tools }))
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const name = r.params.name
      // Defense in depth: a tool that was not listed for this turn never runs.
      if (!session.tools.some((t) => t.name === name)) return textResult(L(`Ferramenta não permitida: ${name}`, `Tool not allowed: ${name}`), true)
      return session.call(name, (r.params.arguments ?? {}) as Record<string, unknown>)
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}
