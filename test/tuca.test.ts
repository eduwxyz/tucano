import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { agentFromDraft, draftFrom, freeHandle, tucaAgent } from '../src/core/tuca'

const linear: Connector = { id: 'c-lin', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth', status: 'connected', tools: [] }
const ctx = { usable: (id: string) => id === 'sonnet', fallbackModel: 'sonnet', connectors: [linear] }

describe('the Tuca proposals', () => {
  it('turns propor_agente into a draft with the least access', () => {
    const { draft } = draftFrom({ nome: ' Rafa ', funcao: 'Suporte', instrucoes: 'Você tria tickets.', modelo: 'opus', esforco: 'turbo', conectores: [{ conector: 'linear' }] }, ctx)
    expect(draft).toMatchObject({ name: 'Rafa', role: 'Suporte', modelId: 'sonnet', effort: 'medium', web: false, grants: { 'c-lin': 'read' } })
    expect(draftFrom({ nome: 'R', funcao: 'x', instrucoes: 'y', conectores: [{ conector: 'Linear', nivel: 'escrita' }] }, ctx).draft?.grants).toEqual({ 'c-lin': 'read_write' })
  })

  it('says what to fix', () => {
    expect(draftFrom({ nome: 'Rafa' }, ctx).error).toContain('instrucoes')
    expect(draftFrom({ nome: 'Rafa', instrucoes: 'x', conectores: [{ conector: 'Jira' }] }, ctx).error).toContain('"Jira"')
  })

  it('makes a free handle and a plain agent from a draft', () => {
    expect(freeHandle('Rafa', ['rafa'])).toBe('rafa-2')
    expect(freeHandle('Lúcia', [])).toBe('lucia')
    const a = agentFromDraft({ name: 'Rafa', role: 'Suporte', color: 'green', instructions: 'x', modelId: 'sonnet', effort: 'low', web: true, grants: {} }, ['rafa'], 1000)
    expect(a).toMatchObject({ handle: 'rafa-2', memory: 'auto', computer: false, web: true, limit: 1000 })
    expect(a.kind).toBeUndefined()
  })
})

describe('the Tuca in a conversation', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  let db: Db
  let gateway: Gateway
  let runner: Runner
  const systems: string[] = []

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
    gateway = new Gateway()
    await gateway.start()
    systems.length = 0
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', run: (t) => (systems.push(`${t.system}\n\n${t.prompt}`), base.run(t)) }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
    runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway, connectors: { list: () => [linear], call: async () => ({ content: [] }) } })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  it('proposes an agent as a card, and nothing is created', async () => {
    const tuca = tucaAgent('sonnet', [], 1000)
    db.saveAgent(tuca)
    db.createConversation({ id: 'd1', kind: 'dm', name: tuca.id, members: [tuca.id] })
    await runner.send('d1', 'quero alguém pra responder tickets de suporte')
    await runner.idle()
    expect(systems[0]).toContain('## Pra montar agentes')
    expect(systems[0]).toContain('Conectores (pra "conectores"): Linear')
    const reply = db.messages().find((m) => m.author.kind === 'agent')!
    expect(reply.run?.agentDraft).toMatchObject({ name: 'Rafa', role: 'Suporte', grants: {} })
    expect(reply.run?.steps.map((s) => s.label)).toContain('Propôs um agente')
    expect(db.agents().map((a) => a.name)).toEqual(['Tuca'])
  })

  it("any other agent can propose too, told when to, but isn't the one who explains Tucano", async () => {
    db.saveAgent({ ...tucaAgent('sonnet', [], 1000), id: 'a2', name: 'Lia', handle: 'lia', kind: undefined })
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a2', members: ['a2'] })
    await runner.send('d2', 'oi')
    await runner.idle()
    expect(systems[0]).not.toContain('## Pra montar agentes')
    expect(systems[0]).toContain('## Pra propor agentes, times, rotinas e canais')
    expect(systems[0]).toContain('Proponha quando Edu pedir')
    expect(systems[0]).not.toContain('## O guia do Tucano')
  })
})

// Leaving the Tuca's screen and coming back opens the same DM (ensureTuca without `fresh`): his kept
// session goes on from there, not only what's on screen. "Nova conversa" is another DM: a new session.
describe("the Tuca's session, when the person comes back", () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  let gateway: Gateway

  afterEach(async () => {
    await gateway.stop()
  })

  it('resumes his session in the same conversation, and starts one in a new conversation', async () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
    gateway = new Gateway()
    await gateway.start()
    const sessions: { id: string; resume: boolean; prompt: string }[] = []
    const base = fakeEngine('claude', { delayMs: 1, sessions: true })
    const claude: Engine = { ...base, run: (t) => (t.session && sessions.push({ id: t.session.id, resume: t.session.resume, prompt: t.prompt }), base.run(t)) }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
    const runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway, connectors: { list: () => [linear], call: async () => ({ content: [] }) } })
    const tuca = tucaAgent('sonnet', [], 10_000_000)
    db.saveAgent(tuca)
    db.createConversation({ id: 'd1', kind: 'dm', name: tuca.id, members: [tuca.id] })
    await runner.send('d1', 'quero planejar a semana do time')
    await runner.idle()
    // The person leaves his screen and comes back: the same conversation, and the plan goes on.
    await runner.send('d1', 'e o segundo passo?')
    await runner.idle()
    expect(sessions.length).toBe(2)
    expect(sessions[1]).toMatchObject({ id: sessions[0]!.id, resume: true })
    expect(sessions[1]!.prompt).not.toContain('quero planejar a migração') // only what's new: the rest is in the session
    // "Nova conversa": another DM, another session, from scratch.
    db.createConversation({ id: 'd2', kind: 'dm', name: tuca.id, members: [tuca.id] })
    await runner.send('d2', 'oi de novo')
    await runner.idle()
    expect(sessions[2]!.resume).toBe(false)
    expect(sessions[2]!.id).not.toBe(sessions[0]!.id)
  })
})
