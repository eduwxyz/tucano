// An agent on "Este computador" with GitHub "Ler e escrever" (0.2.18, a person's report): it said
// "esta sessão permite apenas leitura" and didn't push or open the PR. What it's told and what it
// has, on Claude Code and on Codex: the GitHub tools that publish are there, the prompt names them
// and says what the computer adds and what waits for the person, and Codex no longer hears from its
// own sandbox that the session is read-only.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, Connector, EngineId, GrantLevel, Settings } from '../src/shared/types'
import type { Autonomy } from '../src/shared/actions'
import { classify } from '../src/shared/classify'
import { Db } from '../src/core/db'
import { codexAppArgs, codexArgs, codexInstructions, codexThread } from '../src/core/engines/codex'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
// Some of what GitHub's MCP server lists, with its annotations' effect: reads are read.
const GITHUB_TOOLS = ['get_file_contents', 'list_branches', 'search_pull_requests', 'create_branch', 'push_files', 'create_or_update_file', 'create_pull_request', 'merge_pull_request', 'delete_file', 'add_issue_comment']

let db: Db
let gateway: Gateway
let settings: Settings
let events: CoreEvent[]
let called: { name: string; args: Record<string, unknown> }[]
const github: Connector = { id: 'gh', name: 'GitHub', kind: 'remote', url: 'https://api.githubcopilot.com/mcp/', args: [], envKeys: [], auth: 'token', status: 'connected', tools: [] }
const connectors = {
  list: () => [{ ...github, tools: db.tools('gh') }],
  call: async (_id: string, name: string, args: Record<string, unknown>) => (called.push({ name, args }), textResult(`${name}: ok`))
}
const computers = {
  call: async () => ({ result: textResult('exit code 0') }),
  mac: { cwd: () => '/Users/edu/Library/Application Support/Tucano/computadores/lia' }
}

type Seen = { turn?: Turn; tools: string[]; results: string[] }
// A turn like a CLI's: lists the tools and makes the calls it's given, each by the name it sees.
function scripted(id: EngineId, seen: Seen, calls: { tool: string; args: Record<string, unknown> }[]): Engine {
  return {
    id,
    async *run(turn) {
      seen.turn = turn
      const client = new Client({ name: 'scripted', version: '0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl!)))
      seen.tools = (await client.listTools()).tools.map((t) => t.name)
      for (const c of calls) {
        const r = (await client.callTool({ name: c.tool, arguments: c.args })) as { content: { text: string }[] }
        seen.results.push(r.content[0]?.text ?? '')
      }
      await client.close()
      yield { type: 'text', delta: 'ok' }
      yield { type: 'done', text: 'ok', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

async function turn(engine: EngineId, o: { grant?: GrantLevel; kind?: 'mac' | 'linux' | 'none'; autonomy?: Autonomy; calls?: { tool: string; args: Record<string, unknown> }[] } = {}): Promise<Seen> {
  const kind = o.kind ?? 'mac'
  const lia: Agent = {
    ...db.agent('lia')!,
    modelId: engine === 'codex' ? 'gpt-5.6-luna' : 'sonnet',
    grants: { gh: o.grant ?? 'read_write' },
    computer: kind !== 'none',
    computerKind: kind === 'mac' ? 'mac' : 'linux',
    ...(o.autonomy ? { autonomy: o.autonomy } : {})
  }
  db.saveAgent(lia)
  const seen: Seen = { tools: [], results: [] }
  const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok'] as EngineId[]).map((e) => [e, e === engine ? scripted(e, seen, o.calls ?? []) : fakeEngine(e)])) as Record<EngineId, Engine>
  const runner = new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'gh-w-')), gateway, connectors, computers: computers as never })
  await runner.send('dm', 'sobe a branch fix-login e abre a PR')
  await runner.idle()
  return seen
}

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'gh-db-')), 'test.db'))
  events = []
  called = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveConnector(github)
  db.syncTools('gh', GITHUB_TOOLS.map((name) => ({ name, description: name, inputSchema: { type: 'object' }, cls: /^(get|list|search)_/.test(name) ? 'read' : classify({ name }) })))
  db.saveAgent({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe.each(['claude', 'codex'] as EngineId[])('on %s, an agent on this computer with GitHub "Ler e escrever"', (engine) => {
  it('has the tools that publish, and the prompt names them and says what the computer adds', async () => {
    const seen = await turn(engine)
    for (const t of ['github__create_branch', 'github__push_files', 'github__create_or_update_file', 'github__create_pull_request', 'bash', 'write_file']) expect(seen.tools).toContain(t)
    const system = seen.turn!.system
    expect(system).toContain('## GitHub')
    expect(system).toContain('Você lê e escreve no GitHub pelo conector GitHub. Pra publicar (criar uma branch, mandar arquivos num commit, abrir uma PR), use as ferramentas dele: github__create_branch, github__push_files, github__create_or_update_file, github__create_pull_request.')
    expect(system).toContain('No computador de Edu, git push também roda, com as credenciais do git de Edu')
    expect(system).toContain('Não diga que a sessão é só leitura nem que não pode publicar')
    expect(system).not.toContain('github__merge_pull_request') // a merge isn't publishing a branch
    expect(system).not.toContain('Pedem aprovação') // at the normal level, a push and a PR don't wait
  })

  it('pushes the files and opens the PR through the connector, without asking', async () => {
    const seen = await turn(engine, {
      calls: [
        { tool: 'github__push_files', args: { owner: 'o', repo: 'r', branch: 'fix-login', files: [], message: 'fix' } },
        { tool: 'github__create_pull_request', args: { owner: 'o', repo: 'r', head: 'fix-login', base: 'main', title: 'Fix login' } }
      ]
    })
    expect(called.map((c) => c.name)).toEqual(['push_files', 'create_pull_request'])
    expect(seen.results).toEqual(['push_files: ok', 'create_pull_request: ok'])
    expect(db.approvals()).toHaveLength(0)
  })

  it('careful: the push and the PR wait for me, and the prompt says so', async () => {
    const seen = await turn(engine, { autonomy: 'careful', calls: [{ tool: 'github__create_pull_request', args: { owner: 'o', repo: 'r', head: 'fix-login', base: 'main', title: 'Fix login' } }] })
    expect(seen.turn!.system).toContain('Pedem aprovação de Edu antes de rodar: subir commits (push), abrir pull request.')
    expect(called).toEqual([])
    expect(db.approvals()).toHaveLength(1)
  })

  it('reading only: no tools that publish, and it is told to ask for access, not that the session is read-only', async () => {
    const seen = await turn(engine, { grant: 'read' })
    expect(seen.tools).not.toContain('github__push_files')
    expect(seen.tools).toContain('pedir_acesso')
    expect(seen.turn!.system).toContain('Você só lê o GitHub pelo conector GitHub')
    expect(seen.turn!.system).toContain('peça com pedir_acesso (nivel read_write)')
  })

  it('on Linux: no credentials there, so it publishes through the connector', async () => {
    const seen = await turn(engine, { kind: 'linux' })
    expect(seen.turn!.system).toContain('Seu computador Linux não tem credenciais: git push não funciona nele, então publique pelo conector.')
    expect(seen.turn!.system).not.toContain('git push também roda')
  })

  it('a rule that turns pushing off: the tool is gone and the prompt says why', async () => {
    db.saveAgent({ ...db.agent('lia')!, actionRules: { push: 'off' } })
    const seen = await turn(engine)
    expect(seen.tools).not.toContain('github__push_files')
    expect(seen.tools).toContain('github__create_pull_request')
    expect(seen.turn!.system).toContain('Desligado pra você: subir commits (push)')
  })
})

describe('Codex, for an agent with the app tools', () => {
  it("leaves out its own sandbox's read-only text, in exec and in the app-server", () => {
    expect(codexArgs({ model: 'm', effort: 'low', system: 'x', cwd: '/tmp/x' })).toContain('include_permissions_instructions=false')
    expect(codexAppArgs()).toContain('include_permissions_instructions=false')
  })

  it('is told never to call the session read-only, and on a computer, to run git with bash', async () => {
    const seen = await turn('codex')
    const dev = codexInstructions(seen.turn!)
    expect(dev).toContain('Nunca diga que a sessão é só leitura')
    expect(dev).toContain('comandos (git, instalar, rede) rodam com bash')
    expect(codexThread(seen.turn!).developerInstructions).toBe(dev)
    // No computer, still the app's tools: the first part, not the one about files.
    const none = codexInstructions({ system: 'Você é Lia.', mcpUrl: 'http://127.0.0.1:1/mcp/t' })
    expect(none).toContain('Nunca diga que a sessão é só leitura')
    expect(none).not.toMatch(/apply_patch/)
  })
})
