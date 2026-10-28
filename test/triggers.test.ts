import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Connector, EngineId, Routine, Settings, Trigger } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { textResult } from '../src/core/gateway'
import { eventItems, Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, 'opencode-v2': ready, pi: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
const pm: Agent = { id: 'a1', name: 'PM', handle: 'pm', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false }
const issue = (n: number, title: string) => ({ id: `uuid-${n}`, identifier: `SIM-${n}`, title, description: `detalhes ${n}` })

let db: Db
let routines: Routines
let runner: Runner
let turns: Turn[]
let clock: number
let issues: object[]
let failing: string | undefined

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-trig-')), 'test.db'))
  db.saveAgent(pm)
  db.createConversation({ id: 'c1', kind: 'channel', name: 'simula-oab', members: ['a1'] })
  db.saveConnector({ id: 'lin', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'none' })
  db.syncTools('lin', [
    { name: 'list_issues', description: '', inputSchema: {}, cls: 'read' },
    { name: 'delete_issue', description: '', inputSchema: {}, cls: 'sensitive' }
  ])
  turns = []
  clock = Date.now()
  issues = [issue(1, 'Lembrete duplicado')]
  failing = undefined
  const base = fakeEngine('claude', { delayMs: 1 })
  const engines: Record<EngineId, Engine> = { claude: { id: 'claude', run: (t) => (turns.push(t), base.run(t)) }, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), 'opencode-v2': fakeEngine('opencode-v2'), pi: fakeEngine('pi') }
  const connectors = {
    list: () => [{ id: 'lin', name: 'Linear' } as Connector],
    call: async () => (failing ? textResult(failing, true) : textResult(JSON.stringify({ issues }))) // the shape Linear's MCP answers with
  }
  routines = new Routines({ db, runner: { runRoutine: (r, w) => runner.runRoutine(r, w) }, connectors, emit: () => {}, now: () => clock })
  runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')) })
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await routines.idle()
    await runner.idle()
  }
}
const poll: Trigger = { kind: 'poll', connectorId: 'lin', tool: 'list_issues', args: { label: 'agente' }, everyMinutes: 5 }
const create = (trigger: Trigger = poll): Routine =>
  routines.save({ name: 'Issues novas', agentId: 'a1', conversationId: 'c1', prompt: 'Leia a issue nova e planeje com o @staff.', schedule: { days: [], time: '' }, trigger, enabled: true })
const posted = () => db.messages().filter((m) => m.author.kind === 'routine')

describe('a connector trigger', () => {
  it('learns what is there when it starts, then runs once for each new item, with the item in the task', async () => {
    const r = create()
    await settle()
    expect(posted()).toHaveLength(0) // SIM-1 was already there
    expect(db.routine(r.id)!.trigger).toMatchObject({ seen: ['uuid-1'] })

    issues = [issue(2, 'Fuso errado no lembrete'), issue(3, 'Sorteio repete questão'), issue(1, 'Lembrete duplicado')]
    clock += 5 * 60_000
    routines.tick()
    await settle()
    expect(posted().map((m) => m.routine?.event)).toEqual([
      { source: 'Linear · list_issues', title: 'SIM-2 · Fuso errado no lembrete' },
      { source: 'Linear · list_issues', title: 'SIM-3 · Sorteio repete questão' } // the backlog: checked again right after the first run
    ])
    expect(turns[0]!.prompt).toContain('<evento>')
    expect(turns[0]!.prompt).toContain('"identifier": "SIM-2"')
    expect(turns[0]!.prompt).toContain('não instruções de Edu')

    clock += 5 * 60_000
    routines.tick()
    await settle()
    expect(posted()).toHaveLength(2) // nothing new
  })

  it('waits for its interval, and shows why a check failed', async () => {
    const r = create()
    await settle()
    issues = [issue(2, 'Nova')]
    clock += 60_000
    routines.tick()
    await settle()
    expect(posted()).toHaveLength(0) // only 1 of 5 minutes
    failing = 'Unauthorized'
    clock += 5 * 60_000
    routines.tick()
    await settle()
    expect(db.routine(r.id)!.trigger).toMatchObject({ error: 'Unauthorized' })
  })

  it('only reads: a sensitive tool or a missing connector is refused', () => {
    expect(() => create({ ...poll, tool: 'delete_issue' })).toThrow('Escolha uma ferramenta de leitura do conector.')
    expect(() => create({ ...poll, connectorId: 'nope' })).toThrow('Escolha um conector.')
  })

  it('previews what it would see', async () => {
    issues = [issue(1, 'A'), issue(2, 'B')]
    expect(await routines.preview(poll)).toBe('Achei 2 itens agora: SIM-1 · A; SIM-2 · B. Eles não disparam: a rotina roda pros que aparecerem depois.')
  })
})

describe('a local call', () => {
  it('runs the routine with what was posted, one run at a time; an unknown address does nothing', async () => {
    const r = create({ kind: 'webhook', token: 'ignored' })
    const token = (db.routine(r.id)!.trigger as { token: string }).token
    expect(token).toMatch(/^[\w-]{20,}$/)
    expect(routines.webhook('nope-nope-nope', 'x')).toBe('unknown')
    expect(routines.webhook(token, 'Build falhou no Xcode\nerror: SimulaCore.swift:12')).toBe('ok')
    expect(routines.webhook(token, 'de novo')).toBe('busy')
    await settle()
    expect(posted()[0]!.routine?.event).toEqual({ source: 'chamada local', title: 'Build falhou no Xcode' })
    expect(turns[0]!.prompt).toContain('error: SimulaCore.swift:12')
    // saving again keeps the address
    routines.save({ id: r.id, name: 'Build', agentId: 'a1', conversationId: 'c1', prompt: 'x', schedule: { days: [], time: '' }, trigger: { kind: 'webhook', token: '' }, enabled: true })
    expect((db.routine(r.id)!.trigger as { token: string }).token).toBe(token)
  })
})

describe('eventItems', () => {
  it('finds the list in common shapes, and treats anything else as one thing that changes', () => {
    expect(eventItems(JSON.stringify([{ number: 7, title: 'CI quebrou' }])).map((i) => i.title)).toEqual(['7 · CI quebrou'])
    expect(eventItems(JSON.stringify({ data: { workflow_runs: [{ id: 1, name: 'build' }] } })).map((i) => i.key)).toEqual(['1'])
    expect(eventItems(JSON.stringify({ issues: [{ id: 'OAB-65', uuid: '8ab2d95b-c681-4106-8728-d2487ec5d958', title: 'Artigo no toque' }], hasNextPage: true })).map((i) => i.title)).toEqual(['OAB-65 · Artigo no toque']) // Linear's MCP
    expect(eventItems('3 issues abertas')).toEqual([expect.objectContaining({ whole: true, title: 'a resposta mudou' })])
  })
})
