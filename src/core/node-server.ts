// This computer as a "node" of a Tucano on a server (docs/local-node.md): the server's agents
// reach this machine's terminal and files the way they reach any connector, so a Tucano on a VPS
// keeps every agent synced and still works on the computers where the person's apps and files are.
//
// It's an MCP server over HTTP, on a port of this computer, that answers only a bearer key the
// person copies into the server's connector (Settings › Servers › This computer as a node). It
// listens on 127.0.0.1 by default: the way in from the server is a private network in front of it
// (`tailscale serve`), never the open internet. The tools run as the person, with what's installed
// here, through the same MacComputer an agent "on your computer" uses; on the server, a command is
// judged like one on this computer (shellActions), so the autonomy and approvals are the same.
//
// What the server can't loosen, the node says in each tool's _meta (META_FLOOR, META_HIGH_RISK): a
// command or a file write is at least a write, a tool the owner marked high risk here stays so there.
// The file tools reach only the folders the owner lends (and the node's own working folder), never a
// credentials folder or Tucano's data, and never write what runs later (.git, a shell profile). Every
// call is kept in a log here (NodeLog), for the owner to read what the server ran.
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../shared/lang'
import type { Agent, AgentApp, ConnectorStatus, ConnectorTool, NodeLogEntry, ToolClass } from '../shared/types'
import { META_FLOOR, META_HIGH_RISK } from '../shared/classify'
import { NEVER } from './local-paths'
import { maskSecrets } from './step-text'
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
const MAX_SUMMARY = 300

const meta = (floor: ToolClass, highRisk = false): Record<string, unknown> => ({ [META_FLOOR]: floor, ...(highRisk ? { [META_HIGH_RISK]: true } : {}) })

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
      annotations: { readOnlyHint: false },
      _meta: meta('write')
    },
    { name: 'node_read_file', description: L('Lê um arquivo de texto de uma pasta que a pessoa emprestou neste computador.', 'Reads a text file from a folder the person lent on this computer.'), inputSchema: { type: 'object', properties: { path }, required: ['path'] }, annotations: { readOnlyHint: true } },
    { name: 'node_list', description: L('Lista uma pasta emprestada deste computador (nome, se é pasta, tamanho). Com "~" ou vazio, diz quais pastas estão emprestadas.', 'Lists a lent folder of this computer (name, whether it is a folder, size). With "~" or empty, says which folders are lent.'), inputSchema: { type: 'object', properties: { path }, required: ['path'] }, annotations: { readOnlyHint: true } },
    { name: 'node_write_file', description: L('Cria ou sobrescreve um arquivo numa pasta emprestada deste computador, criando as pastas que faltarem.', 'Creates or overwrites a file in a lent folder of this computer, creating any missing folders.'), inputSchema: { type: 'object', properties: { path, content: { type: 'string' } }, required: ['path', 'content'] }, annotations: { readOnlyHint: false }, _meta: meta('write') },
    {
      name: 'node_edit_file',
      description: L('Troca um trecho exato de um arquivo numa pasta emprestada deste computador por outro.', 'Replaces an exact stretch of a file in a lent folder of this computer with another.'),
      inputSchema: { type: 'object', properties: { path, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'] },
      annotations: { readOnlyHint: false },
      _meta: meta('write')
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
  // The folders the person lends: the file tools reach only these and the node's own working folder.
  // `dataDir`: Tucano's data, never reached (but for that working folder). Unset: only the working folder.
  folders?: () => string[]
  dataDir?: string
  log?: NodeLog // where each call is kept, for the owner
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
// The class set on this computer is the floor the server can't go below; the owner's high-risk mark goes along.
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
  annotations: { readOnlyHint: false, destructiveHint: true },
  _meta: meta('sensitive')
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
    private mac: Pick<MacComputer, 'call' | 'cwd'>,
    private reach: NodeReach = {}
  ) {}

  // Everything the node offers now: its own tools, then the browser's and the lent apps', then each
  // connected connector's enabled tools. A connector that comes or goes shows on the server's next refresh.
  tools(): Tool[] {
    const own = nodeTools()
    const agent = nodeAgent(this.reach.apps?.lent())
    const fromDefs = (defs: ToolDef[]): Tool[] =>
      defs.map((t) => (READS.test(t.name) ? { name: t.name, description: t.description, inputSchema: t.inputSchema as Tool['inputSchema'], annotations: { readOnlyHint: true } } : { name: t.name, description: t.description, inputSchema: t.inputSchema as Tool['inputSchema'], annotations: { readOnlyHint: false }, _meta: meta('write') }))
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
            tool: { name: `${prefix}__${t.name}`.slice(0, 64), description: `[${x.name}] ${t.description}`, inputSchema: { type: 'object', ...t.inputSchema } as Tool['inputSchema'], annotations: annotate(t.cls), _meta: meta(t.cls, t.highRisk) }
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

  // Each call the server makes, kept in the log here with what it asked and how it ended.
  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const at = Date.now()
    let r: CallToolResult
    try {
      r = await this.run(name, args)
    } catch (e) {
      this.reach.log?.add({ at, tool: name, summary: summary(name, args), ok: false, ms: Date.now() - at, error: clipText((e as Error).message) })
      throw e
    }
    this.reach.log?.add({ at, tool: name, summary: summary(name, args), ok: !r.isError, ms: Date.now() - at, ...(r.isError ? { error: clipText(firstText(r)) } : {}) })
    return r
  }

  // Where a file tool may go: a lent folder or the node's own working folder, as the real path.
  private reachable(raw: unknown, write: boolean): { path: string } | { error: string } {
    const cwd = this.mac.cwd(nodeAgent())
    return nodePath(String(raw ?? ''), { cwd, folders: this.reach.folders?.() ?? [], dataDir: this.reach.dataDir }, write)
  }

  private async run(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const ctx = { conversationId: 'node', messageId: 'node' }
    const agent = nodeAgent(this.reach.apps?.lent())
    const file = async (tool: 'read_file' | 'write_file' | 'edit_file', write: boolean): Promise<CallToolResult> => {
      const at = this.reachable(args['path'], write)
      if ('error' in at) return textResult(at.error, true)
      return (await this.mac.call(agent, tool, { ...args, path: at.path }, ctx)).result
    }
    switch (name) {
      case NODE_BASH:
        return (await this.mac.call(agent, 'bash', args, ctx)).result
      case 'node_read_file':
        return file('read_file', false)
      case 'node_write_file':
        return file('write_file', true)
      case 'node_edit_file':
        return file('edit_file', true)
      case 'node_list': {
        const raw = String(args['path'] ?? '').trim()
        if (!raw || raw === '~') return textResult(lentList(this.reach.folders?.() ?? [], this.mac.cwd(nodeAgent())))
        const at = this.reachable(raw, false)
        return 'error' in at ? textResult(at.error, true) : list(at.path)
      }
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


// ---------- the folders a node lends ----------

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
// The real path of what may not exist yet (a file about to be written): the nearest folder that does, resolved, and the rest.
// A link that points nowhere yet is followed by hand: writing through it would create its target.
function realish(p: string, depth = 0): string {
  let head = p
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest.reverse())
    } catch {
      try {
        if (depth < 20 && lstatSync(head).isSymbolicLink()) return realish(join(resolve(dirname(head), readlinkSync(head)), ...rest.reverse()), depth + 1)
      } catch {
        // not there at all: go up
      }
      const up = dirname(head)
      if (up === head) return p
      rest.push(basename(head))
      head = up
    }
  }
}
// What runs later if written: git's own folder (hooks, config), a shell profile, direnv. A command could,
// but a command is judged as one; a file write is only a write.
const RUNS_LATER = new Set(['.git', '.husky', '.envrc', '.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile', 'LaunchAgents', 'LaunchDaemons'])

export function nodePath(raw: string, o: { cwd: string; folders: string[]; dataDir?: string; home?: string }, write: boolean): { path: string } | { error: string } {
  const asked = raw.trim()
  if (!asked || asked.includes('\0')) return { error: L('Faltou o caminho.', 'Missing the path.') }
  const s = asked === '~' || asked.startsWith('~/') ? join(o.home ?? homedir(), asked.slice(1)) : asked
  const path = realish(macPath(s, o.cwd))
  const roots = [o.cwd, ...o.folders].map(realish)
  const root = roots.find((r) => inside(path, r))
  const lent = o.folders.length ? o.folders.join(', ') : L('nenhuma', 'none')
  if (!root) return { error: L(`Fora das pastas emprestadas deste computador (${lent}). Peça à pessoa pra emprestar a pasta em Configurações › Servidores.`, `Outside the folders lent on this computer (${lent}). Ask the person to lend the folder in Settings › Servers.`) }
  if (path.split(sep).some((part) => NEVER.has(part))) return { error: L('Essa pasta guarda chaves e credenciais; o nó não alcança.', 'That folder holds keys and credentials; the node does not reach it.') }
  if (o.dataDir && root !== realish(o.cwd) && inside(path, realish(o.dataDir))) return { error: L('Esses são os dados do próprio Tucano; o nó não alcança.', "That's Tucano's own data; the node does not reach it.") }
  if (write && relative(root, path).split(sep).some((part) => RUNS_LATER.has(part))) return { error: L('Isso roda depois, sozinho (git, perfil do terminal): o nó não grava aí por ferramenta de arquivo. Se precisar, use um comando, que passa pelas aprovações.', "That runs later on its own (git, the shell profile): the node doesn't write there with a file tool. If needed, use a command, which goes through the approvals.") }
  return { path }
}

function lentList(folders: string[], cwd: string): string {
  const lines = folders.length ? folders : [L('(nenhuma: só a pasta de trabalho do nó)', "(none: only the node's working folder)")]
  return `${L('Pastas emprestadas deste computador:', 'Folders lent on this computer:')}\n${lines.join('\n')}\n${L('Pasta de trabalho do nó:', "The node's working folder:")} ${cwd}`
}

// ---------- what the server ran here ----------

const firstText = (r: CallToolResult): string => (r.content.find((b) => b.type === 'text') as { text?: string } | undefined)?.text ?? ''
const clipText = (t: string): string => {
  const m = maskSecrets(t.replace(/\s+/g, ' ').trim())
  return m.length > MAX_SUMMARY ? `${m.slice(0, MAX_SUMMARY)}…` : m
}
// Text typed into a page, an app or a local connector (a password, a message) never goes into the log as it
// was: only how long it was. The field it went into stays, to tell what happened.
const TYPED = new Set(['texto', 'text', 'value', 'valor', 'content', 'conteudo', 'password', 'senha', 'input', 'message', 'mensagem', 'body', 'query'])
function untyped(v: unknown, key = ''): unknown {
  if (typeof v === 'string') return TYPED.has(key.toLowerCase()) ? L(`(${v.length} caracteres)`, `(${v.length} characters)`) : v
  if (Array.isArray(v)) return v.map((x) => untyped(x, key))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, untyped(x, k)]))
  return v
}

// What a call asked, in a line: the command, the path, or the arguments (typed text only as its length).
export function summary(name: string, args: Record<string, unknown>): string {
  if (name === NODE_BASH) return clipText(String(args['command'] ?? ''))
  if (name === 'node_write_file') return clipText(`${String(args['path'] ?? '')} (${String(args['content'] ?? '').length} B)`)
  if (name === 'node_read_file' || name === 'node_edit_file' || name === 'node_list') return clipText(String(args['path'] ?? ''))
  return clipText(JSON.stringify(untyped(args)))
}

const MAX_LOG = 2000
const SLACK = 200 // lines over MAX_LOG before it's cut back, so a call doesn't rewrite the file each time
// The node's log: one JSON line per call, in Tucano's data; kept at the last MAX_LOG (up to MAX_LOG + SLACK).
// The count starts from what the file has when the app opens, so a restart doesn't let it grow past that.
export class NodeLog {
  private lines: number | undefined
  constructor(private file: string) {}

  add(e: NodeLogEntry): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      this.lines ??= this.count()
      appendFileSync(this.file, `${JSON.stringify(e)}\n`)
      if (++this.lines > MAX_LOG + SLACK) this.trim()
    } catch (err) {
      console.error('[node] log', err)
    }
  }

  private count(): number {
    return existsSync(this.file) ? readFileSync(this.file, 'utf8').split('\n').filter(Boolean).length : 0
  }

  private trim(): void {
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
    if (lines.length > MAX_LOG) writeFileSync(this.file, `${lines.slice(-MAX_LOG).join('\n')}\n`)
    this.lines = Math.min(lines.length, MAX_LOG)
  }

  // Newest first.
  read(limit = 100): NodeLogEntry[] {
    if (!existsSync(this.file)) return []
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
    const n = Math.max(1, Math.min(500, Math.round(limit)))
    return lines
      .slice(-n)
      .reverse()
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as NodeLogEntry]
        } catch {
          return []
        }
      })
  }
}
