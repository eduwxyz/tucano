// This computer as a "node" of a Tucano on a server (docs/plan-local-node.md): the server's agents
// reach this machine's terminal and files the way they reach any connector, so a Tucano on a VPS
// keeps every agent synced and still works on the computers where the person's apps and files are.
//
// It's an MCP server over HTTP, on a port of this computer, that answers only a bearer key the
// person copies into the server's connector (Settings › Servers › This computer as a node). It
// listens on 127.0.0.1 by default: the way in from the server is a private network in front of it
// (`tailscale serve`), never the open internet. The tools run as the person, with what's installed
// here, through the same MacComputer an agent "on your computer" uses; on the server, a command is
// judged like one on this computer (shellActions), so the autonomy and approvals are the same.
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../shared/lang'
import type { Agent, AgentApp, ConnectorStatus, ConnectorTool } from '../shared/types'
import type { AppOutcome } from './apps'
import type { BrowserOutcome } from './browser'
import { textResult, type ToolDef } from './gateway'
import { macPath, type MacComputer } from './mac'
import { systemName } from './platform'

// The node's tools, by name. `node_bash` is how the server recognizes a command on a node
// (runs.ts judges it with shellActions, like a command on this computer).
export const NODE_BASH = 'node_bash'
export const NODE_TOOLS = new Set([NODE_BASH, 'node_read_file', 'node_write_file', 'node_edit_file', 'node_list'])
// A risky click or key in a node's browser or apps waits for the person: the agent calls this, which the
// server classes as sensitive (so it asks, with the person's autonomy), and only an approved call runs it.
export const NODE_APPROVED = 'node_approved'

const MAX_LIST = 500

export function nodeTools(machine = systemName()): Tool[] {
  const path = { type: 'string', description: L('Caminho absoluto, com ~, ou relativo à pasta de trabalho do nó.', "Absolute path, with ~, or relative to the node's working folder.") }
  return [
    {
      name: NODE_BASH,
      description: L(
        `Roda um comando no computador da pessoa (${machine}), como ela, com o que ela tem instalado. Por padrão na pasta de trabalho do nó; use cd ou caminhos absolutos pros repositórios dela.`,
        `Runs a command on the person's computer (${machine}), as them, with what they have installed. In the node's working folder by default; use cd or absolute paths for their repositories.`
      ),
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'number', description: L('Até 600; padrão 120.', 'Up to 600; 120 by default.') } }, required: ['command'] },
      annotations: { readOnlyHint: false }
    },
    { name: 'node_read_file', description: L('Lê um arquivo de texto deste computador.', 'Reads a text file from this computer.'), inputSchema: { type: 'object', properties: { path }, required: ['path'] }, annotations: { readOnlyHint: true } },
    { name: 'node_list', description: L('Lista uma pasta deste computador (nome, se é pasta, tamanho).', 'Lists a folder of this computer (name, whether it is a folder, size).'), inputSchema: { type: 'object', properties: { path }, required: ['path'] }, annotations: { readOnlyHint: true } },
    { name: 'node_write_file', description: L('Cria ou sobrescreve um arquivo neste computador, criando as pastas que faltarem.', 'Creates or overwrites a file on this computer, creating any missing folders.'), inputSchema: { type: 'object', properties: { path, content: { type: 'string' } }, required: ['path', 'content'] }, annotations: { readOnlyHint: false } },
    {
      name: 'node_edit_file',
      description: L('Troca um trecho exato de um arquivo deste computador por outro.', 'Replaces an exact stretch of a file on this computer with another.'),
      inputSchema: { type: 'object', properties: { path, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'] },
      annotations: { readOnlyHint: false }
    }
  ]
}

// The agent the node's calls run as: one working folder, browser and apps of its own, this computer's tools.
const nodeAgent = (apps: AgentApp[] = []): Agent => ({ id: 'node', name: 'node', computer: true, computerKind: 'mac', browser: true, apps }) as Agent

// What else of this computer the node reaches, beside the terminal and files: the app's own connectors
// (Premiere, Figma desktop…), its browser and the apps the person lends it. Each optional (tests, a plain node).
export interface NodeReach {
  connectors?: {
    list(): { id: string; name: string; status: ConnectorStatus; kind?: 'remote' | 'stdio'; url?: string; command?: string }[]
    tools(id: string): (ConnectorTool & { inputSchema: Record<string, unknown> })[]
    call(id: string, name: string, args: Record<string, unknown>): Promise<CallToolResult>
  }
  browser?: {
    tools(): ToolDef[]
    call(agent: Agent, name: string, args: Record<string, unknown>, ctx: { conversationId: string; messageId: string }): Promise<BrowserOutcome>
    approved(agent: Agent, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>
  }
  apps?: {
    tools(agent: Agent): ToolDef[]
    call(agent: Agent, name: string, args: Record<string, unknown>): Promise<AppOutcome>
    approved(agent: Agent, args: Record<string, unknown>): { ok: boolean; text: string }
    lent(): AgentApp[] // the apps the person lends the node, each to read or to read and change
  }
}

// Whether a connector exists only on this computer, so only the node can lend it: one that runs a command
// here, or a server on this machine (Figma desktop's 127.0.0.1:3845). A remote one (Linear, Vercel…) the
// server reaches by itself, and lending it too would show the agent each tool twice. Nor the bridge that
// ships with Tucano: the server runs its own.
export function onlyHere(c: { kind?: 'remote' | 'stdio'; url?: string; command?: string }): boolean {
  if (c.kind === 'stdio') return c.command !== 'tucano'
  try {
    const host = new URL(c.url ?? '').hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host.startsWith('127.') || host.endsWith('.local')
  } catch {
    return false
  }
}

// A connector's tool as one of the node's: its name after the connector's (`premiere_pro__export`), its
// class carried as the annotation the server classes it by.
const slug = (name: string): string => name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'conector'
const annotate = (cls: ConnectorTool['cls']): Tool['annotations'] => (cls === 'read' ? { readOnlyHint: true } : cls === 'sensitive' ? { readOnlyHint: false, destructiveHint: true } : { readOnlyHint: false })
// The browser's and apps' reading tools only read; their actions change something.
const READS = /^(navegador_(ler|ver|esperar)|apps?_(listar|ver|ler))$/

const approvedTool = (): Tool => ({
  name: NODE_APPROVED,
  description: L(
    'Faz, depois da aprovação da pessoa, um clique ou tecla arriscado no navegador ou num app deste computador que a ferramenta recusou. Passe exatamente o que ela devolveu em "aprovar".',
    'Does, after the person approves, a risky click or key in this computer\'s browser or an app that the tool turned down. Pass exactly what it returned under "approve".'
  ),
  inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['browser', 'apps'] }, args: { type: 'object' } }, required: ['kind', 'args'] },
  annotations: { readOnlyHint: false, destructiveHint: true }
})

const sameKey = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface NodeOptions {
  port: number // 0: any free port (tests)
  host?: string // 127.0.0.1 unless the person chose a private address
  key: string
}

export class NodeServer {
  private http: HttpServer | null = null
  private listening = 0

  constructor(
    private mac: Pick<MacComputer, 'call'>,
    private reach: NodeReach = {}
  ) {}

  // Everything the node offers now: its own tools, then the browser's and the lent apps', then each
  // connected connector's enabled tools. A connector that comes or goes shows on the server's next refresh.
  tools(): Tool[] {
    const own = nodeTools()
    const agent = nodeAgent(this.reach.apps?.lent())
    const fromDefs = (defs: ToolDef[]): Tool[] => defs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Tool['inputSchema'], annotations: READS.test(t.name) ? { readOnlyHint: true } : { readOnlyHint: false } }))
    const browser = this.reach.browser ? fromDefs(this.reach.browser.tools()) : []
    const apps = this.reach.apps && agent.apps?.length ? fromDefs(this.reach.apps.tools(agent)) : []
    const risky = browser.length || apps.length ? [approvedTool()] : []
    return [...own, ...browser, ...apps, ...risky, ...this.connectorTools().map((t) => t.tool)]
  }

  private connectorTools(): { tool: Tool; connectorId: string; name: string }[] {
    const c = this.reach.connectors
    if (!c) return []
    const taken = new Set<string>()
    return c
      .list()
      .filter((x) => x.status === 'connected' && onlyHere(x))
      .flatMap((x) => {
        let prefix = slug(x.name)
        for (let i = 2; taken.has(prefix); i++) prefix = `${slug(x.name)}_${i}`
        taken.add(prefix)
        return c
          .tools(x.id)
          .filter((t) => t.enabled)
          .map((t) => ({
            connectorId: x.id,
            name: t.name,
            tool: { name: `${prefix}__${t.name}`.slice(0, 64), description: `[${x.name}] ${t.description}`, inputSchema: { type: 'object', ...t.inputSchema } as Tool['inputSchema'], annotations: annotate(t.cls) }
          }))
      })
  }

  get port(): number {
    return this.listening
  }

  get running(): boolean {
    return !!this.http
  }

  async start(opts: NodeOptions): Promise<number> {
    await this.stop()
    const http = createServer((req, res) => {
      void this.handle(req, res, opts.key).catch((e: unknown) => {
        console.error('[node]', e)
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve())
    })
    this.http = http
    this.listening = (http.address() as AddressInfo).port
    return this.listening
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = null
    this.listening = 0
    if (!http) return
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://node')
    if (url.pathname !== '/mcp') return void res.writeHead(404).end()
    const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
    if (!key || !sameKey(given, key)) return void res.writeHead(401, { 'www-authenticate': 'Bearer' }).end()
    const server = new Server({ name: 'tucano-node', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools() }))
    server.setRequestHandler(CallToolRequestSchema, async (r) => this.call(r.params.name, (r.params.arguments ?? {}) as Record<string, unknown>))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const ctx = { conversationId: 'node', messageId: 'node' }
    const agent = nodeAgent(this.reach.apps?.lent())
    switch (name) {
      case NODE_BASH:
        return (await this.mac.call(agent, 'bash', args, ctx)).result
      case 'node_read_file':
        return (await this.mac.call(agent, 'read_file', args, ctx)).result
      case 'node_write_file':
        return (await this.mac.call(agent, 'write_file', args, ctx)).result
      case 'node_edit_file':
        return (await this.mac.call(agent, 'edit_file', args, ctx)).result
      case 'node_list':
        return list(macPath(String(args['path'] ?? '~'), homedir()))
      case NODE_APPROVED:
        return this.approved(agent, args)
    }
    if (this.reach.browser && name.startsWith('navegador_')) return asked('browser', await this.reach.browser.call(agent, name, args, ctx))
    if (this.reach.apps && /^apps?_/.test(name)) return asked('apps', await this.reach.apps.call(agent, name, args))
    const hit = this.connectorTools().find((t) => t.tool.name === name)
    if (hit && this.reach.connectors) return this.reach.connectors.call(hit.connectorId, hit.name, args)
    return textResult(L(`Ferramenta desconhecida: ${name}`, `Unknown tool: ${name}`), true)
  }

  // An approved risky action: the browser does it now; an app gets a one-time permit and the agent does it again.
  private async approved(agent: Agent, args: Record<string, unknown>): Promise<CallToolResult> {
    const kind = args['kind']
    const inner = (args['args'] ?? {}) as Record<string, unknown>
    if (kind === 'browser' && this.reach.browser) {
      const r = await this.reach.browser.approved(agent, inner)
      return textResult(r.ok ? r.text || L('Feito.', 'Done.') : r.text, !r.ok)
    }
    if (kind === 'apps' && this.reach.apps) {
      const r = this.reach.apps.approved(agent, inner)
      return r.ok ? textResult(L('Aprovado: faça a mesma ação de novo no app, agora ela passa.', 'Approved: do the same action again in the app; now it goes through.')) : textResult(r.text, true)
    }
    return textResult(L('Nada a aprovar aqui.', 'Nothing to approve here.'), true)
  }
}

// A browser's or app's answer through the node: a risky action it turned down says how to ask for it.
function asked(kind: 'browser' | 'apps', out: BrowserOutcome | AppOutcome): CallToolResult {
  if (!out.approval) return out.result
  const approve = JSON.stringify({ kind, args: out.approval.args })
  return textResult(
    L(
      `Isso precisa da aprovação da pessoa (${out.approval.why}): ${out.approval.detail}. Chame ${NODE_APPROVED} com exatamente ${approve} (aprovar), que pede a aprovação dela.`,
      `This needs the person's approval (${out.approval.why}): ${out.approval.detail}. Call ${NODE_APPROVED} with exactly ${approve} (approve), which asks for it.`
    ),
    true
  )
}

function list(dir: string): CallToolResult {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const lines = entries.slice(0, MAX_LIST).map((e) => {
      if (e.isDirectory()) return `${e.name}/`
      try {
        return `${e.name}  ${statSync(join(dir, e.name)).size} B`
      } catch {
        return e.name
      }
    })
    const more = entries.length > MAX_LIST ? `\n${L(`… e mais ${entries.length - MAX_LIST}`, `… and ${entries.length - MAX_LIST} more`)}` : ''
    return textResult(`${dir}\n${lines.join('\n')}${more}`)
  } catch (e) {
    return textResult(L(`Não deu pra listar ${dir}: ${(e as Error).message}`, `Couldn't list ${dir}: ${(e as Error).message}`), true)
  }
}
