import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, Author, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { MAX_AFTER, Memories, memorySystem, parseConsolidation, WINDOW } from '../src/core/memory'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra
})

let db: Db
let settings: Settings
let gateway: Gateway
let turns: Turn[]
let memory: Memories
let runner: Runner

function setup(): void {
  const base = fakeEngine('claude', { delayMs: 1 })
  const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), base.run(t)) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') }
  const emit = (_: CoreEvent): void => {}
  const workDir = mkdtempSync(join(tmpdir(), 'ad-work-'))
  memory = new Memories({ db, engines, settings: async () => settings, emit, workDir })
  runner = new Runner({ db, engines, settings: async () => settings, emit, workDir, gateway, memory })
}

async function settle(): Promise<void> {
  await runner.idle()
  await memory.idle()
}

let clock = 1_000_000
function put(conversationId: string, author: Author, text: string): Message {
  const m: Message = { id: `m${clock}`, conversationId, author, text, at: clock++ }
  db.saveMessage(m)
  return m
}

const agentTurns = (handle: string): Turn[] => turns.filter((t) => t.system.startsWith(`Você é ${handle[0]!.toUpperCase()}${handle.slice(1)} (@${handle})`))
const active = (scope = 'me'): string[] => db.memories({ scope, state: 'active' }).map((m) => m.text)

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia'))
  db.saveAgent(agent('a2', 'theo'))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] })
  gateway = new Gateway()
  await gateway.start()
  setup()
})

afterEach(async () => {
  await gateway.stop()
})

describe('parseConsolidation', () => {
  it('reads JSON in a code fence and keeps only well-formed ops', () => {
    const r = parseConsolidation(
      '```json\n{"summary":"ok","memories":[{"op":"add","text":"Prefere PR pequeno","evidence":[1]},{"op":"update","text":"sem id"},{"op":"confirm","id":"ab12"},{"op":"nope"}]}\n```'
    )
    expect(r).toEqual({ summary: 'ok', ops: [{ op: 'add', text: 'Prefere PR pequeno', evidence: [1] }, { op: 'confirm', id: 'ab12' }] })
  })

  it('needs a summary', () => {
    expect(parseConsolidation('{"memories":[]}')).toBeNull()
    expect(parseConsolidation('não sei')).toBeNull()
  })
})

describe('summary (short term)', () => {
  it('folds what leaves the window into the summary, and the next turn sees it plus every newer message', async () => {
    put('c1', { kind: 'me' }, 'ZEBRA é o cupom da campanha')
    for (let i = 1; i < MAX_AFTER + 10; i++) put('c1', i % 2 ? { kind: 'agent', id: 'a1' } : { kind: 'me' }, `mensagem ${i}`)
    const all = db.messagesAfter('c1', 0)

    await memory.consolidate('c1')
    const conv = db.conversation('c1')!
    expect(conv.summary).toContain('ZEBRA')
    expect(conv.summaryUntil).toBe(all[all.length - WINDOW - 1]!.at)

    await runner.send('c1', '@lia qual é o cupom?')
    await settle()
    const prompt = agentTurns('lia')[0]!.prompt
    expect(prompt).toContain('Resumo do que veio antes em #engenharia:')
    expect(prompt).toContain('ZEBRA')
    expect(prompt).not.toContain('\nZEBRA é o cupom') // the message itself left the window
    expect(prompt).toContain(`mensagem ${MAX_AFTER + 9}`)
  })

  it('consolidates on its own once more than MAX_AFTER messages follow the summary', async () => {
    for (let i = 0; i < MAX_AFTER; i++) put('d1', { kind: 'me' }, `mensagem ${i}`)
    await runner.send('d1', 'oi')
    await settle()
    expect(db.conversation('d1')!.summary).toContain('Resumo de teste')
    expect(turns.filter((t) => t.system === memorySystem())).toHaveLength(1)
  })

  it('does nothing while the conversation fits the window', async () => {
    await runner.send('d1', 'oi')
    await settle()
    expect(db.conversation('d1')!.summary).toBeUndefined()
    expect(turns.some((t) => t.system === memorySystem())).toBe(false)
  })
})

describe('lembrar (long term)', () => {
  it('a memory saved in a DM reaches another agent in a channel', async () => {
    await runner.send('d1', 'lembra que eu prefiro PR pequeno')
    await settle()
    expect(active()).toEqual(['eu prefiro PR pequeno'])
    const reply = db.messages().find((m) => m.author.kind === 'agent')!
    expect(reply.run?.memoryIds).toHaveLength(1)
    expect(reply.run?.steps.map((s) => s.label)).toContain('Guardou na memória')

    await runner.send('c1', '@theo oi')
    await settle()
    const system = agentTurns('theo')[0]!.system
    expect(system).toContain('Sobre Edu (todos os agentes veem):')
    expect(system).toContain('eu prefiro PR pequeno')
  })

  it('with "pede aprovação" nothing reaches a prompt until I accept it', async () => {
    db.saveAgent(agent('a1', 'lia', { memory: 'approve' }))
    await runner.send('d1', 'lembra que eu prefiro PR pequeno')
    await settle()
    const [pending] = db.memories({ state: 'pending' })
    expect(pending?.text).toBe('eu prefiro PR pequeno')

    await runner.send('c1', '@theo oi')
    await settle()
    expect(agentTurns('theo')[0]!.system).not.toContain('PR pequeno')

    memory.decide(pending!.id, true)
    await runner.send('c1', '@theo e agora?')
    await settle()
    expect(agentTurns('theo')[1]!.system).toContain('PR pequeno')
  })

  it('an agent set to "só lê" does not get the tool', async () => {
    db.saveAgent(agent('a1', 'lia', { memory: 'read' }))
    await runner.send('d1', 'lembra que eu prefiro PR pequeno')
    await settle()
    expect(db.memories()).toHaveLength(0)
  })

  it('updating keeps the old version archived', async () => {
    await runner.send('d1', 'lembra que eu uso o projeto Checkout no Linear')
    await settle()
    const [old] = db.memories({ state: 'active' })
    const r = memory.remember(db.agent('a1')!, db.conversation('d1')!, { texto: 'usa o projeto Pagamentos no Linear', sobre: 'usuario', substitui: old!.id })
    expect(r.memory?.state).toBe('active')
    expect(db.memory(old!.id)?.state).toBe('archived')
    expect(active()).toEqual(['usa o projeto Pagamentos no Linear'])
  })
})

describe('extraction', () => {
  function chat(): void {
    put('c1', { kind: 'agent', id: 'a1' }, 'eu prefiro tabs, aliás')
    put('c1', { kind: 'me' }, 'eu prefiro café sem açúcar')
    for (let i = 0; i < WINDOW; i++) put('c1', { kind: 'me' }, `mensagem ${i}`)
  }

  it('only learns about me from what I said, and suggests by default', async () => {
    chat()
    await memory.consolidate('c1', true)
    expect(db.memories().map((m) => [m.text, m.state])).toEqual([['Prefere café sem açúcar', 'pending']])
  })

  it('with "gravar sozinho" it becomes active right away', async () => {
    settings.memoryLearning = 'auto'
    chat()
    await memory.consolidate('c1', true)
    expect(active()).toEqual(['Prefere café sem açúcar'])
  })

  it('a forgotten memory is not learned again from the same messages, nor saved by an agent', async () => {
    settings.memoryLearning = 'auto'
    chat()
    await memory.consolidate('c1', true)
    const [m] = db.memories({ state: 'active' })
    memory.forget(m!.id, 'não é mais verdade')

    db.setSummary('c1', '', 0) // replay the same messages
    await memory.consolidate('c1', true)
    expect(active()).toEqual([])
    expect(db.memories({ state: 'forgotten' })).toHaveLength(1)

    const r = memory.remember(db.agent('a1')!, db.conversation('c1')!, { texto: 'prefere café sem açúcar!', sobre: 'usuario' })
    expect(r.memory).toBeUndefined()
    expect(active()).toEqual([])

    memory.purge(m!.id) // gone for good, so it can be learned again
    db.setSummary('c1', '', 0)
    await memory.consolidate('c1', true)
    expect(active()).toEqual(['Prefere café sem açúcar'])
  })

  it('forgotten memories leave the prompt right away', async () => {
    await runner.send('d1', 'lembra que eu prefiro PR pequeno')
    await settle()
    memory.forget(db.memories()[0]!.id)
    await runner.send('c1', '@theo oi')
    await settle()
    expect(agentTurns('theo')[0]!.system).not.toContain('PR pequeno')
  })
})
