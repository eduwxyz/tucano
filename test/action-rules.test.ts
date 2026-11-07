// The rules for actions that matter, end to end: the gateway reads a call (a command on the
// agent's computer, a connector tool), and by Settings and the agent's page it runs, waits
// for an approval or never runs. Only the model and the computer are fake.
import { mkdtempSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActionRules } from '../src/shared/actions'
import type { Agent, Message, Settings } from '../src/shared/types'
import type { Computers } from '../src/core/computer'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'

const DEMO = join(import.meta.dirname, '..', 'scripts', 'demo-mcp-server.mjs')
const ready = { installed: true, loggedIn: true }

type Plan = { tool: string; args: Record<string, unknown> } | null

// A "model" that, on each turn, lists its tools and makes at most one call.
function scripted(plan: (turn: Turn, tools: string[]) => Plan, seen: { turns: Turn[]; tools: Tool[][]; results: unknown[] }): Engine {
  return {
    id: 'claude',
    async *run(turn) {
      seen.turns.push(turn)
      let reply = 'ok'
      if (turn.mcpUrl) {
        const client = new Client({ name: 'scripted', version: '0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
        const tools = (await client.listTools()).tools
        seen.tools.push(tools)
        const p = plan(
          turn,
          tools.map((t) => t.name)
        )
        if (p) {
          seen.results.push(await client.callTool({ name: p.tool, arguments: p.args }))
          reply = `chamei ${p.tool}`
        }
        await client.close()
      }
      yield { type: 'text', delta: reply }
      yield { type: 'done', text: reply, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

let dir: string
let tasksFile: string
let db: Db
let gateway: Gateway
let connectors: ConnectorManager
let settings: Settings
let connectorId: string
let seen: { turns: Turn[]; tools: Tool[][]; results: unknown[] }
let ran: string[] // the commands the computer ran

const agent = (actionRules?: ActionRules): Agent => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: { [connectorId]: 'read_write' }, memory: 'auto', computer: true, archived: false, ...(actionRules ? { actionRules } : {})
})

// A computer that only says what it ran.
const computers = {
  call: async (_agent: Agent, name: string, args: Record<string, unknown>) => {
    if (name !== 'bash') return { result: textResult(`ok: ${name}`) }
    ran.push(String(args['command']))
    return { result: textResult(`exit 0\n[rodou] ${String(args['command'])}`) }
  }
} as unknown as Computers

function runner(plan: (turn: Turn, tools: string[]) => Plan): Runner {
  return new Runner({
    db,
    engines: { claude: scripted(plan, seen), codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok') },
    settings: async () => settings,
    emit: () => {},
    workDir: join(dir, 'work'),
    gateway,
    connectors,
    computers
  })
}

// One command per turn, in order (null: a turn that calls nothing, like the one after a decision).
const turns = (...commands: (string | null)[]) => (): Plan => {
  const command = commands.shift()
  return command ? { tool: 'bash', args: { command, _motivo: 'pra salvar o trabalho' } } : null
}
const runs = (command: string): (() => Plan) => turns(command)
const agentMessages = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')
const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '')
const tasks = (): { id: number }[] => {
  try {
    return JSON.parse(readFileSync(tasksFile, 'utf8')) as { id: number }[]
  } catch {
    return [{ id: 1 }, { id: 2 }, { id: 3 }] // not written yet: the server's built-in list
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ad-rules-'))
  tasksFile = join(dir, 'tasks.json')
  db = new Db(join(dir, 'test.db'))
  seen = { turns: [], tools: [], results: [] }
  ran = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready, grok: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  gateway = new Gateway()
  await gateway.start()
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
  connectorId = await connectors.add({ kind: 'stdio', name: 'Tarefas', command: process.execPath, args: [DEMO], env: { DEMO_TASKS_FILE: tasksFile } })
  await connectors.connect(connectorId)
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

afterEach(async () => {
  await connectors.closeAll()
  await gateway.stop()
})

describe('commands on the computer', () => {
  it('a commit asks first by default: it becomes a pending approval and nothing runs', async () => {
    const r = runner(runs('git add -A && git commit -m "primeira versão"'))
    await r.send('d1', 'faça o commit')
    await r.idle()

    const [ap] = db.approvals()
    expect(ap).toMatchObject({ state: 'pending', connectorId: 'computador', tool: 'bash', args: { command: 'git add -A && git commit -m "primeira versão"' }, why: 'pra salvar o trabalho', highRisk: false })
    expect(ap!.args).not.toHaveProperty('_motivo')
    expect(agentMessages()[0]?.run).toMatchObject({ status: 'waiting_approval', approvalId: ap!.id })
    expect(textOf(seen.results[0])).toContain('NÃO rodou')
    expect(ran).toEqual([])
  })

  it('approving runs exactly that command, once, and the agent gets its output', async () => {
    const r = runner(runs('git commit -m wip && git push'))
    await r.send('d1', 'faça o commit e suba')
    await r.idle()
    const ap = db.approvals()[0]!
    await Promise.all([r.decide(ap.id, 'approved'), r.decide(ap.id, 'refused', 'tarde')]) // the first decision wins
    await r.idle()

    expect(ran).toEqual(['git commit -m wip && git push'])
    expect(db.approval(ap.id)).toMatchObject({ state: 'approved', outcome: 'Executou.' })
    expect(seen.turns.at(-1)?.prompt).toContain('Edu aprovou rodar `git commit -m wip && git push`')
    expect(seen.turns.at(-1)?.prompt).toContain('[rodou] git commit -m wip && git push')
    expect(agentMessages()[0]?.run?.steps.at(-1)).toMatchObject({ label: 'Aprovado', status: 'done' })
  })

  it('refusing runs nothing and tells the agent why', async () => {
    const r = runner(runs('git push --force'))
    await r.send('d1', 'faça o push')
    await r.idle()
    const ap = db.approvals()[0]!
    await r.decide(ap.id, 'refused', 'ainda não revisei')
    await r.idle()

    expect(ran).toEqual([])
    expect(db.approval(ap.id)).toMatchObject({ state: 'refused', outcome: 'Nada foi rodado.' })
    expect(seen.turns.at(-1)?.prompt).toContain('recusou rodar `git push --force`: "ainda não revisei"')
  })

  it('a command with nothing that matters runs right away', async () => {
    const r = runner(runs('git status && npm test'))
    await r.send('d1', 'faça os testes')
    await r.idle()
    expect(ran).toEqual(['git status && npm test'])
    expect(db.approvals()).toEqual([])
  })

  it('"faz sozinho" in Settings lets it run without asking', async () => {
    settings = { ...settings, actionRules: { commit: 'auto' } }
    const r = runner(runs('git commit -m wip'))
    await r.send('d1', 'faça o commit')
    await r.idle()
    expect(ran).toEqual(['git commit -m wip'])
    expect(db.approvals()).toEqual([])
  })

  it("the agent's own rule wins over Settings, both ways", async () => {
    settings = { ...settings, actionRules: { commit: 'auto', push: 'ask' } }
    db.saveAgent(agent({ commit: 'ask', push: 'auto' }))
    const r = runner(turns('git commit -m x', null, 'git push'))
    await r.send('d1', 'faça o commit')
    await r.idle()
    expect(db.approvals()).toHaveLength(1)
    await r.decide(db.approvals()[0]!.id, 'refused')
    await r.idle()
    await r.send('d1', 'faça o push')
    await r.idle()
    expect(ran).toEqual(['git push'])
    expect(db.approvals()).toHaveLength(1)
  })

  it('a command with one "ask" kind among "auto" ones still waits', async () => {
    settings = { ...settings, actionRules: { commit: 'auto' } }
    const r = runner(runs('git commit -m x && git push'))
    await r.send('d1', 'faça tudo')
    await r.idle()
    expect(ran).toEqual([])
    expect(db.approvals()[0]).toMatchObject({ state: 'pending' })
  })

  it('"nunca" never runs it and asks nothing', async () => {
    db.saveAgent(agent({ push: 'off' }))
    const r = runner(runs('git push origin main'))
    await r.send('d1', 'faça o push')
    await r.idle()
    expect(ran).toEqual([])
    expect(db.approvals()).toEqual([])
    expect(seen.results[0]).toMatchObject({ isError: true })
    expect(textOf(seen.results[0])).toContain('subir commits (push) está desligado')
  })

  it('a rule changed while the turn runs takes effect on the next call', async () => {
    const next = turns('git commit -m x')
    const r = runner(() => {
      db.saveAgent(agent({ commit: 'auto' })) // changed on its page while it works
      return next()
    })
    await r.send('d1', 'faça o commit')
    await r.idle()
    expect(ran).toEqual(['git commit -m x'])
  })

  it("bash says which commands wait and which never run, and takes a reason", async () => {
    db.saveAgent(agent({ publish: 'off' }))
    const r = runner(() => null)
    await r.send('d1', 'oi')
    await r.idle()
    const bash = seen.tools[0]!.find((t) => t.name === 'bash')!
    expect(bash.description).toContain('pedem aprovação de Edu antes de rodar: fazer commit, subir commits (push), abrir pull request, fazer merge, apagar')
    expect(bash.description).toContain('Nunca rodam pra você: publicar ou colocar no ar.')
    expect(bash.inputSchema.properties).toHaveProperty('_motivo')
  })

  it('"Aprovar e sempre permitir" turns that kind to "faz sozinho" on the agent', async () => {
    const r = runner(turns('git commit -m x', null, 'git commit -m y'))
    await r.send('d1', 'faça o commit')
    await r.idle()
    await r.decide(db.approvals()[0]!.id, 'approved', undefined, true)
    await r.idle()
    expect(db.agent('a1')?.actionRules).toEqual({ commit: 'auto' })
    await r.send('d1', 'faça outro commit')
    await r.idle()
    expect(ran).toEqual(['git commit -m x', 'git commit -m y'])
    expect(db.approvals()).toHaveLength(1)
  })

  it('deleting is held to approve and never allowed for good from the card', async () => {
    const r = runner(runs('rm -rf src'))
    await r.send('d1', 'faça a limpeza')
    await r.idle()
    const ap = db.approvals()[0]!
    expect(ap).toMatchObject({ highRisk: true })
    await r.decide(ap.id, 'approved', undefined, true)
    await r.idle()
    expect(ran).toEqual(['rm -rf src'])
    expect(db.agent('a1')?.actionRules).toBeUndefined()
  })
})

describe('connector tools', () => {
  const deletes = (turn: Turn): Plan => (turn.prompt.includes('apaga') && !turn.prompt.includes('aprovou') ? { tool: 'tarefas__delete_task', args: { id: 2 } } : null)

  it('"faz sozinho" for deleting runs a sensitive delete without asking', async () => {
    settings = { ...settings, actionRules: { delete: 'auto' } }
    const r = runner(deletes)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    expect(db.approvals()).toEqual([])
    expect(tasks().map((t) => t.id)).toEqual([1, 3])
  })

  it('"nunca" takes the tool away from the agent', async () => {
    db.saveAgent(agent({ delete: 'off' }))
    const r = runner(deletes)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    expect(seen.tools[0]!.map((t) => t.name)).not.toContain('tarefas__delete_task')
    expect(seen.results[0]).toMatchObject({ isError: true })
    expect(tasks().map((t) => t.id)).toEqual([1, 2, 3])
  })

  it('by default a delete still asks, as before', async () => {
    const r = runner(deletes)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    expect(db.approvals()[0]).toMatchObject({ state: 'pending', tool: 'delete_task' })
  })
})

describe('saved rules', () => {
  it('an agent keeps its rules, only known kinds and modes', () => {
    db.saveAgent({ ...agent(), actionRules: { commit: 'auto', push: 'maybe', bogus: 'off' } as unknown as ActionRules })
    expect(db.agent('a1')?.actionRules).toEqual({ commit: 'auto' })
    db.saveAgent(agent())
    expect(db.agent('a1')?.actionRules).toBeUndefined()
  })

  it('a database another build already migrated further still gets the column', () => {
    const file = join(dir, 'other.db')
    new Db(file).close()
    const raw = new DatabaseSync(file)
    raw.exec('ALTER TABLE agents DROP COLUMN action_rules; PRAGMA user_version = 999')
    raw.close()
    const other = new Db(file)
    other.saveAgent({ ...agent({ push: 'off' }), grants: {} })
    expect(other.agent('a1')?.actionRules).toEqual({ push: 'off' })
    other.close()
  })
})
