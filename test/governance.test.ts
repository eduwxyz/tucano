// End to end through the real pieces: the demo MCP server (stdio), the
// connector manager, the gateway and the runner. Only the model is fake: a
// scripted engine that calls tools through the gateway like a CLI would.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, GrantLevel, Message, Settings } from '../src/shared/types'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { LATE_GRACE_MS, MAX_AGENT_ROUTINES, Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'

import { plainCipher, Secrets } from '../src/core/secrets'

const DEMO = join(import.meta.dirname, '..', 'scripts', 'demo-mcp-server.mjs')
const ready = { installed: true, loggedIn: true }

type Plan = { tool: string; args: Record<string, unknown> } | null

// A "model" that, on each turn, lists its tools and makes at most one call.
function scripted(plan: (turn: Turn, tools: string[]) => Plan, seen: { turns: Turn[]; tools: string[][]; results: unknown[]; alwaysLoad: string[][] }): Engine {
  return {
    id: 'claude',
    async *run(turn) {
      seen.turns.push(turn)
      let reply = 'ok'
      if (turn.mcpUrl) {
        const client = new Client({ name: 'scripted', version: '0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
        const listed = (await client.listTools()).tools
        const tools = listed.map((t) => t.name)
        seen.tools.push(tools)
        seen.alwaysLoad.push(listed.filter((t) => t._meta?.['anthropic/alwaysLoad'] === true).map((t) => t.name))
        const p = plan(turn, tools)
        if (p) {
          const r = await client.callTool({ name: p.tool, arguments: p.args })
          seen.results.push(r)
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
let events: CoreEvent[]
let settings: Settings
let connectorId: string
let seen: { turns: Turn[]; tools: string[][]; results: unknown[]; alwaysLoad: string[][] }
let runnerRef = { current: undefined as Runner | undefined }

const agent = (grant: GrantLevel): Agent => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: { [connectorId]: grant }, memory: 'auto', computer: false, archived: false
})

function runner(plan: (turn: Turn, tools: string[]) => Plan, onDb: Db = db): Runner {
  const r = new Runner({
    db: onDb,
    engines: { claude: scripted(plan, seen), codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') },
    settings: async () => settings,
    emit: (e) => events.push(e),
    workDir: join(dir, 'work'),
    gateway,
    connectors,
    routines
  })
  runnerRef.current = r
  return r
}

const tasks = (): { id: number; title: string; done: boolean }[] => {
  try {
    return JSON.parse(readFileSync(tasksFile, 'utf8')) as { id: number; title: string; done: boolean }[]
  } catch {
    return [] // not written yet: the server starts from its built-in list
  }
}
const agentMessages = (d: Db = db): Message[] => d.messages().filter((m) => m.author.kind === 'agent')
const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '')
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
let clock = at(2026, 10, 19, 8, 0)
const posted = (conv = 'c1') => db.messages().filter((m) => m.conversationId === conv)
let routines: Routines

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ad-gov-'))
  tasksFile = join(dir, 'tasks.json')
  db = new Db(join(dir, 'test.db'))
  events = []
  seen = { turns: [], tools: [], results: [], alwaysLoad: [] }
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  gateway = new Gateway()
  await gateway.start()
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: (e) => events.push(e), openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
  connectorId = await connectors.add({ kind: 'stdio', name: 'Tarefas', command: process.execPath, args: [DEMO], env: { DEMO_TASKS_FILE: tasksFile } })
  await connectors.connect(connectorId)
  routines = new Routines({ db, runner: { runRoutine: (r, when) => runnerRef.current!.runRoutine(r, when), retryRoutine: (r, when, id) => runnerRef.current!.retryRoutine(r, when, id) }, emit: () => {}, now: () => clock, wait: async () => {}, notify: () => {} })
  db.saveAgent(agent('none'))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

afterEach(async () => {
  await connectors.closeAll()
  await gateway.stop()
})

describe('connectors', () => {
  it('classifies the server tools on first sync and keeps the env value encrypted', async () => {
    const c = connectors.get(connectorId)!
    expect(c.status).toBe('connected')
    expect(c.envKeys).toEqual(['DEMO_TASKS_FILE'])
    expect(Object.fromEntries(c.tools.map((t) => [t.name, [t.cls, t.enabled]]))).toEqual({
      list_tasks: ['read', true],
      create_task: ['write', true],
      complete_task: ['write', true],
      delete_task: ['sensitive', true]
    })
    expect(db.getSecret(`connector:${connectorId}:env`)).toMatch(/^plain:/) // went through the cipher
  })

  it('a tool published later comes in disabled and flagged until reviewed', async () => {
    await connectors.call(connectorId, 'list_tasks', {})
    await expect.poll(() => connectors.get(connectorId)!.tools.find((t) => t.name === 'export_tasks')).toMatchObject({ enabled: false, isNew: true })
    connectors.updateTool(connectorId, 'export_tasks', { enabled: true })
    expect(connectors.get(connectorId)!.tools.find((t) => t.name === 'export_tasks')).toMatchObject({ enabled: true, isNew: false })
  })
})

describe('grants', () => {
  it('lists the connector tools the agent called lately as loaded, the others behind tool search', async () => {
    db.saveAgent(agent('read'))
    let first = true
    const r = runner((_, tools) => (first ? ((first = false), { tool: tools.find((t) => t.endsWith('__list_tasks'))!, args: {} }) : null))
    await r.send('d1', 'quais tarefas?')
    await r.idle()
    expect(seen.alwaysLoad[0]).not.toContain('tarefas__list_tasks') // never called yet
    await r.send('d1', 'e agora?')
    await r.idle()
    expect(seen.alwaysLoad[1]).toContain('tarefas__list_tasks')
  })

  it('read: the agent sees only read tools, and a forced call to another is refused without running', async () => {
    db.saveAgent(agent('read'))
    const r = runner((_, tools) => ({ tool: tools.find((t) => t.endsWith('__create_task')) ?? 'tarefas__create_task', args: { title: 'invasora' } }))
    await r.send('d1', 'oi')
    await r.idle()
    expect(seen.tools[0]).toEqual(['ask_user', 'pedir_acesso', 'propor_agente', 'propor_time', 'propor_ajuste', 'propor_rotina', 'propor_canal', 'agendar_rotina', 'cancelar_rotina', 'tarefas__list_tasks']) // it can ask for more, not take it
    // Claude Code keeps the app's own tools in the prompt; the connector's wait behind tool search.
    expect(seen.alwaysLoad[0]).toEqual(seen.tools[0]!.filter((t) => !t.startsWith('tarefas__')))
    expect(seen.results[0]).toMatchObject({ isError: true })
    expect(textOf(seen.results[0])).toContain('não permitida')
    expect(tasks().some((t) => t.title === 'invasora')).toBe(false)
  })

  it('read_write: write tools run right away and show up as steps', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner((turn) => (turn.prompt.includes('cria') ? { tool: 'tarefas__create_task', args: { title: 'Nova' } } : null))
    await r.send('d1', 'cria uma tarefa')
    await r.idle()
    expect(textOf(seen.results[0])).toContain('Criada')
    expect(tasks().some((t) => t.title === 'Nova')).toBe(true)
    expect(agentMessages()[0]?.run?.steps.map((s) => [s.label, s.detail ?? ''])).toContainEqual(['Executou', 'Tarefas · create_task'])
  })

  it('removing the grant before a call takes effect immediately', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner((turn, tools) => {
      if (!turn.prompt.includes('cria')) return null
      db.saveAgent(agent('none')) // revoked while the turn runs
      return { tool: tools.find((t) => t.endsWith('__create_task'))!, args: { title: 'tarde demais' } }
    })
    await r.send('d1', 'cria')
    await r.idle()
    expect(textOf(seen.results[0])).toContain('não permitida')
    expect(tasks().some((t) => t.title === 'tarde demais')).toBe(false)
  })
})

describe('approvals', () => {
  const askDelete = (turn: Turn): Plan => (turn.prompt.includes('apaga') && !turn.prompt.includes('aprovou') && !turn.prompt.includes('recusou') ? { tool: 'tarefas__delete_task', args: { id: 2, _motivo: 'está duplicada' } } : null)

  it('a sensitive call becomes a pending approval and nothing runs', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()

    const [ap] = db.approvals()
    expect(ap).toMatchObject({ state: 'pending', tool: 'delete_task', args: { id: 2 }, why: 'está duplicada', connectorName: 'Tarefas' })
    expect(agentMessages()[0]?.run).toMatchObject({ status: 'waiting_approval', approvalId: ap!.id })
    expect(textOf(seen.results[0])).toContain('NÃO foi executada')
    expect(tasks().some((t) => t.id === 2) || tasks().length === 0).toBe(true) // untouched
  })

  it('refusing hands the reason to the agent in a new turn and runs nothing', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    const ap = db.approvals()[0]!
    await r.decide(ap.id, 'refused', 'ainda vou usar')
    await r.idle()

    expect(db.approval(ap.id)).toMatchObject({ state: 'refused', reason: 'ainda vou usar', outcome: 'Nada foi executado.' })
    expect(seen.turns.at(-1)?.prompt).toContain('Edu recusou o seu pedido "delete_task"')
    expect(seen.turns.at(-1)?.prompt).toContain('Motivo: "ainda vou usar"')
    expect(agentMessages()).toHaveLength(2)
    expect(tasks().length === 0 || tasks().some((t) => t.id === 2)).toBe(true)
  })

  it('approving runs exactly the stored call, once, and the agent gets the result', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    const ap = db.approvals()[0]!
    await Promise.all([r.decide(ap.id, 'approved'), r.decide(ap.id, 'refused', 'tarde')]) // the first decision wins
    await r.idle()

    expect(db.approval(ap.id)).toMatchObject({ state: 'approved', outcome: 'Executou.' })
    expect(tasks().map((t) => t.id)).toEqual([1, 3])
    expect(seen.turns.at(-1)?.prompt).toContain('Resultado:\nApagada: #2')
    expect(agentMessages()[0]?.run?.steps.at(-1)).toMatchObject({ label: 'Aprovado', status: 'done' })
  })

  it('a pending approval survives a restart and still runs when approved', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    const ap = db.approvals()[0]!

    // "Restart": a new database handle on the same file, a new connector manager and runner.
    await connectors.closeAll()
    db.close()
    db = new Db(join(dir, 'test.db'))
    connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => '' })
    const r2 = runner(askDelete, db)
    expect(db.approval(ap.id)?.state).toBe('pending')
    await r2.decide(ap.id, 'approved')
    await r2.idle()
    expect(db.approval(ap.id)?.outcome).toBe('Executou.')
    expect(tasks().map((t) => t.id)).toEqual([1, 3])
  })

  it('does not run an approved call if the grant was removed meanwhile', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    db.saveAgent(agent('read'))
    await r.decide(db.approvals()[0]!.id, 'approved')
    await r.idle()
    expect(db.approvals()[0]?.outcome).toContain('Não executou')
    expect(tasks().length === 0 || tasks().some((t) => t.id === 2)).toBe(true)
  })

  it('expired approvals are closed and the agent is told', async () => {
    db.saveAgent(agent('read_write'))
    settings.approvalTtlHours = -1 // already expired
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    await r.expireApprovals()
    await r.idle()
    expect(db.approvals()[0]).toMatchObject({ state: 'expired', outcome: 'Expirou sem decisão.' })
    expect(seen.turns.at(-1)?.prompt).toContain('expirou sem decisão')
  })

  it("approved while the reply is still being written: the reply's last save keeps the decision (#121)", async () => {
    db.saveAgent(agent('read_write'))
    // A "model" that asks, then goes on writing; I approve before it ends.
    let r!: Runner
    let asked = false
    const engine: Engine = {
      id: 'claude',
      async *run(turn) {
        seen.turns.push(turn)
        if (turn.mcpUrl && !asked) {
          asked = true
          const client = new Client({ name: 'scripted', version: '0' })
          await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
          await client.callTool({ name: 'tarefas__delete_task', arguments: { id: 2, _motivo: 'duplicada' } })
          await client.close()
          await r.decide(db.approvals()[0]!.id, 'approved')
        }
        yield { type: 'text', delta: 'pedi pra apagar e sigo escrevendo' }
        yield { type: 'done', text: 'pedi pra apagar e sigo escrevendo', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
      }
    }
    r = new Runner({
      db,
      engines: { claude: engine, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') },
      settings: async () => settings,
      emit: (e) => events.push(e),
      workDir: join(dir, 'work'),
      gateway,
      connectors
    })
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()

    expect(db.approvals()[0]).toMatchObject({ state: 'approved', outcome: 'Executou.' })
    const reply = agentMessages()[0]!
    expect(reply.run?.status).toBe('done') // not waiting for an approval that was given
    expect(reply.run?.steps.map((s) => s.label)).toEqual(expect.arrayContaining(['Pediu aprovação', 'Aprovado']))
  })
})

describe('pause and resume', () => {
  it('a message while paused gets the note and starts nothing', async () => {
    const r = runner(() => null)
    r.setPaused(true)
    await r.send('d1', 'oi')
    await r.idle()
    expect(agentMessages()).toHaveLength(0)
    expect(db.messages().at(-1)!.text).toContain('Os agentes estão pausados')
    expect(seen.turns).toHaveLength(0)
    r.setPaused(false)
    await r.send('d1', 'oi de novo')
    await r.idle()
    expect(agentMessages()).toHaveLength(1)
    expect(seen.turns).toHaveLength(1)
  })

  it('a failed reply keeps its retry note while paused and retries after resume', async () => {
    db.saveAgent(agent('read_write'))
    let shouldFail = true
    const failing: Engine = {
      id: 'claude',
      async *run(turn) {
        seen.turns.push(turn)
        if (shouldFail) yield { type: 'error', message: 'provider down' }
        else yield { type: 'done', text: 'feito', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const r = new Runner({ db, engines: { claude: failing, codex: failing, opencode: failing, pi: failing, antigravity: failing, cursor: failing, grok: failing, cline: failing, hermes: failing }, settings: async () => settings, emit: (e) => events.push(e), workDir: join(dir, 'work'), gateway, connectors, routines })
    runnerRef.current = r
    await r.send('d1', 'oi')
    await r.idle()
    expect(seen.turns).toHaveLength(1)
    const failed = db.messages().filter((m) => m.author.kind === 'agent' && m.run?.status === 'failed').at(-1)
    expect(failed).toBeDefined()
    shouldFail = false
    r.setPaused(true)
    r.retry(failed!.id)
    await r.idle()
    expect(seen.turns).toHaveLength(1) // no retry while paused
    r.setPaused(false)
    r.retry(failed!.id)
    await r.idle()
    expect(seen.turns).toHaveLength(2) // retry ran after resume
  })

  it('a due routine does not run while paused', async () => {
    const r = runner(() => null)
    db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a1'] })
    const routine = routines.save({ name: 'Bom dia', agentId: 'a1', conversationId: 'c1', prompt: 'hi', schedule: { days: [1, 2, 3, 4, 5], time: '09:00' }, enabled: true })
    clock = at(2026, 10, 19, 9, 0) + 10_000
    routines.tick()
    expect(posted('c1').filter((m) => m.author.kind === 'routine')).toHaveLength(0)
    r.setPaused(true)
    routines.tick()
    expect(posted('c1').filter((m) => m.author.kind === 'routine')).toHaveLength(0)
    r.setPaused(false)
    routines.tick()
    await r.idle()
    expect(posted('c1').filter((m) => m.author.kind === 'routine')).toHaveLength(1)
    db.deleteConversation(routine.conversationId)
  })
})

describe('always allow and asking for access', () => {
  const askDelete = (turn: Turn): Plan => (turn.prompt.includes('apaga') && !turn.prompt.includes('aprovou') ? { tool: 'tarefas__delete_task', args: { id: 2, _motivo: 'duplicada' } } : null)

  it('"Sempre permitir" turns one approval into a rule: the same tool runs without asking from then on', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a 2')
    await r.idle()
    const [ap] = db.approvals()
    await r.decide(ap!.id, 'approved', undefined, true)
    await r.idle()
    expect(db.agent('a1')!.autoApprove).toEqual([`${connectorId}:delete_task`])

    await r.send('d1', 'apaga a 2 de novo')
    await r.idle()
    expect(db.approvals()).toHaveLength(1) // no new request
    const last = agentMessages().find((m) => m.run?.steps.some((s) => s.label === 'Executou (sempre permitido)'))
    expect(last).toBeDefined()
  })

  it('a high-risk tool never becomes a rule', async () => {
    db.saveAgent(agent('read_write'))
    db.updateTool(connectorId, 'delete_task', { highRisk: true })
    const r = runner(askDelete)
    await r.send('d1', 'apaga a 2')
    await r.idle()
    await r.decide(db.approvals()[0]!.id, 'approved', undefined, true)
    await r.idle()
    expect(db.agent('a1')!.autoApprove).toEqual([])
  })

  it('an agent without access asks for it; approving grants it and it goes on', async () => {
    const r = runner((turn, tools) =>
      tools.includes('pedir_acesso') && !turn.prompt.includes('liberou') ? { tool: 'pedir_acesso', args: { conector: 'Tarefas', nivel: 'read', motivo: 'pra ver as tarefas abertas' } } : null
    )
    await r.send('d1', 'quais tarefas estão abertas?')
    await r.idle()
    const [ap] = db.approvals()
    expect(ap).toMatchObject({ tool: 'pedir_acesso', connectorName: 'Tarefas', args: { nivel: 'read' }, why: 'pra ver as tarefas abertas' })
    await r.decide(ap!.id, 'approved')
    await r.idle()
    expect(db.agent('a1')!.grants[connectorId]).toBe('read')
    expect(seen.turns.at(-1)!.prompt).toContain('Edu liberou o seu acesso ao Tarefas (ler)')
    expect(seen.tools.at(-1)).toContain('tarefas__list_tasks')
  })
})

describe('pausing and attributing work', () => {
  it('"Pausar tudo": a message gets a note instead of a reply', async () => {
    const r = runner(() => null)
    r.setPaused(true)
    await r.send('d1', 'oi')
    await r.idle()
    expect(agentMessages()).toHaveLength(0)
    expect(db.messages().at(-1)!.text).toContain('Os agentes estão pausados')
    r.setPaused(false)
    await r.send('d1', 'oi de novo')
    await r.idle()
    expect(agentMessages()).toHaveLength(1)
  })

  it('a reply about an issue counts toward it, and so do the replies it hands off to', async () => {
    db.saveAgent(agent('none'))
    db.saveAgent({ ...agent('none'), id: 'a2', name: 'Theo', handle: 'theo' })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'eng', members: ['a1', 'a2'] })
    const r = new Runner({
      db,
      engines: { claude: fakeEngine('claude', { delayMs: 1, reply: (t) => (t.prompt.includes('Theo · agente') ? 'feito' : '@theo dá uma olhada') }), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') },
      settings: async () => settings,
      emit: () => {},
      workDir: join(dir, 'work')
    })
    await r.send('c1', '@lia olha a OAB-65, o lembrete duplica')
    await r.idle()
    const work = db.costByWork(0)
    expect(work).toEqual([expect.objectContaining({ work: 'OAB-65', replies: 2, agents: expect.arrayContaining(['a1', 'a2']) as string[] })])
    expect(agentMessages().every((m) => m.run?.work === 'OAB-65')).toBe(true)
  })
})
