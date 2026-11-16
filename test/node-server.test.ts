// This computer as a node of a server's Tucano: an MCP server over HTTP that only answers its key, and
// runs the server's calls here, as the person (docs/plan-local-node.md). Through a real MCP client.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { MacComputer } from '../src/core/mac'
import { NODE_APPROVED, NODE_BASH, NODE_TOOLS, NodeServer, onlyHere, type NodeReach } from '../src/core/node-server'
import { shellActions } from '../src/shared/actions'
import { ConnectorManager } from '../src/core/connectors'
import { plainCipher, Secrets } from '../src/core/secrets'

let dir: string
let db: Db
let node: NodeServer
const KEY = 'k'.repeat(48)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tucano-node-'))
  db = new Db(join(dir, 'test.db'))
  node = new NodeServer(new MacComputer({ db, dataDir: dir, emit: () => {}, env: async () => process.env }))
})
afterEach(async () => {
  await node.stop()
  db.close()
})

const client = async (port: number, key: string): Promise<Client> => {
  const c = new Client({ name: 'server', version: '1' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }))
  return c
}
const text = (r: unknown): string => ((r as { content: { type: string; text?: string }[] }).content.find((b) => b.type === 'text')?.text ?? '')

describe('this computer as a node', () => {
  it("lists its tools and runs the server's calls here: a command, a file written and read back", async () => {
    const port = await node.start({ port: 0, key: KEY })
    const c = await client(port, KEY)
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...NODE_TOOLS].sort())
    expect(tools.find((t) => t.name === 'node_read_file')?.annotations?.readOnlyHint).toBe(true)

    const ran = await c.callTool({ name: NODE_BASH, arguments: { command: 'echo oi-do-no' } })
    expect(ran.isError).toBeFalsy()
    expect(text(ran)).toContain('oi-do-no')

    const file = join(dir, 'pasta', 'nota.txt')
    expect((await c.callTool({ name: 'node_write_file', arguments: { path: file, content: 'linha um' } })).isError).toBeFalsy()
    expect(text(await c.callTool({ name: 'node_read_file', arguments: { path: file } }))).toContain('linha um')
    expect(text(await c.callTool({ name: 'node_list', arguments: { path: join(dir, 'pasta') } }))).toContain('nota.txt')
    await c.close()
  })

  it('answers only its key, and stops answering when turned off', async () => {
    const port = await node.start({ port: 0, key: KEY })
    await expect(client(port, 'wrong')).rejects.toThrow()
    await expect(client(port, '')).rejects.toThrow()
    await node.stop()
    expect(node.running).toBe(false)
    await expect(client(port, KEY)).rejects.toThrow()
  })

  it('a command on a node is judged like one on this computer: reading asks nothing, a push is a push', () => {
    expect(shellActions('git status && ls -la')).toEqual([])
    expect(shellActions('git push origin main')).toContain('push')
  })

  it("is a connector like any other for a server's Tucano: added with its key, its tools listed, a command run", async () => {
    const port = await node.start({ port: 0, key: KEY })
    const server = new Db(join(dir, 'server.db'))
    const connectors = new ConnectorManager({ db: server, secrets: new Secrets(server, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => 'http://127.0.0.1:1/cb' })
    const id = await connectors.add({ name: 'Windows do Jaques', kind: 'remote', url: `http://127.0.0.1:${port}/mcp`, auth: 'token', token: KEY })
    await connectors.connect(id)
    expect(connectors.get(id)!.status).toBe('connected')
    expect(connectors.get(id)!.tools.map((t) => t.name)).toContain(NODE_BASH)
    const r = await connectors.call(id, NODE_BASH, { command: 'echo pelo-servidor' })
    expect(text(r)).toContain('pelo-servidor')
    await connectors.closeAll()
    server.close()
  })

  it("offers this computer's connectors, browser and lent apps, each tool in the class the server asks by", async () => {
    const calls: string[] = []
    const approved: Record<string, unknown>[] = []
    const reach: NodeReach = {
      connectors: {
        list: () => [
          { id: 'p', name: 'Premiere Pro', status: 'connected', kind: 'stdio', command: 'node' },
          { id: 'x', name: 'Off', status: 'error', kind: 'stdio', command: 'node' },
          { id: 'l', name: 'Linear', status: 'connected', kind: 'remote', url: 'https://mcp.linear.app/mcp' }, // the server has it already
          { id: 'f', name: 'Figma desktop', status: 'connected', kind: 'remote', url: 'http://127.0.0.1:3845/mcp' }
        ],
        tools: () => [
          { name: 'export_sequence', description: 'Exports', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, cls: 'write', enabled: true, highRisk: false, isNew: false },
          { name: 'project_info', description: 'Reads', inputSchema: { type: 'object' }, cls: 'read', enabled: true, highRisk: false, isNew: false },
          { name: 'delete_project', description: 'Deletes', inputSchema: { type: 'object' }, cls: 'sensitive', enabled: true, highRisk: false, isNew: false },
          { name: 'hidden', description: 'Off', inputSchema: { type: 'object' }, cls: 'read', enabled: false, highRisk: false, isNew: false }
        ],
        call: async (id, name) => (calls.push(`${id}:${name}`), { content: [{ type: 'text', text: `ran ${name}` }] })
      },
      browser: {
        tools: () => [
          { name: 'navegador_ler', description: 'Reads the page', inputSchema: { type: 'object' } },
          { name: 'navegador_clicar', description: 'Clicks', inputSchema: { type: 'object' } }
        ],
        call: async (_a, name) =>
          name === 'navegador_clicar'
            ? { result: { content: [{ type: 'text', text: 'waits' }] }, approval: { args: { alvo: 'Comprar' }, why: 'compra', detail: 'Comprar' } }
            : { result: { content: [{ type: 'text', text: 'page text' }] } },
        approved: async (_a, args) => (approved.push(args), { ok: true, text: 'Clicou em Comprar.' })
      },
      apps: { tools: () => [], call: async () => ({ result: { content: [] } }), approved: () => ({ ok: true, text: '' }), lent: () => [] }
    }
    const rich = new NodeServer(new MacComputer({ db, dataDir: dir, emit: () => {}, env: async () => process.env }), reach)
    const port = await rich.start({ port: 0, key: KEY })
    const c = await client(port, KEY)
    const { tools } = await c.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('premiere_pro__export_sequence')?.annotations).toEqual({ readOnlyHint: false })
    expect(byName.get('premiere_pro__project_info')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('premiere_pro__delete_project')?.annotations?.destructiveHint).toBe(true)
    expect(byName.has('premiere_pro__hidden')).toBe(false) // turned off on this computer
    expect([...byName.keys()].some((n) => n.startsWith('off__'))).toBe(false) // not connected
    expect([...byName.keys()].some((n) => n.startsWith('linear__'))).toBe(false) // remote: the server reaches it itself
    expect(byName.has('figma_desktop__export_sequence')).toBe(true) // a server on this machine: only the node has it
    expect(byName.get('navegador_ler')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('navegador_clicar')?.annotations?.readOnlyHint).toBe(false)
    expect(byName.get(NODE_APPROVED)?.annotations?.destructiveHint).toBe(true) // the server asks before it
    expect(byName.has('apps_listar')).toBe(false) // no app lent

    expect(text(await c.callTool({ name: 'premiere_pro__export_sequence', arguments: { id: 'seq1' } }))).toBe('ran export_sequence')
    expect(calls).toEqual(['p:export_sequence'])

    // A risky click waits: the agent is told how to ask, and only the approved call clicks.
    const risky = await c.callTool({ name: 'navegador_clicar', arguments: { alvo: 'Comprar' } })
    expect(risky.isError).toBe(true)
    expect(text(risky)).toContain(NODE_APPROVED)
    expect(approved).toEqual([])
    const done = await c.callTool({ name: NODE_APPROVED, arguments: { kind: 'browser', args: { alvo: 'Comprar' } } })
    expect(text(done)).toBe('Clicou em Comprar.')
    expect(approved).toEqual([{ alvo: 'Comprar' }])
    await c.close()
    await rich.stop()
  })

  it('lends only what exists on this computer alone', () => {
    expect(onlyHere({ kind: 'stdio', command: 'uvx' })).toBe(true)
    expect(onlyHere({ kind: 'stdio', command: 'tucano' })).toBe(false) // the Figma bridge: the server runs its own
    expect(onlyHere({ kind: 'remote', url: 'http://127.0.0.1:3845/mcp' })).toBe(true)
    expect(onlyHere({ kind: 'remote', url: 'http://localhost:9000/mcp' })).toBe(true)
    expect(onlyHere({ kind: 'remote', url: 'https://mcp.vercel.com/' })).toBe(false)
  })
})
