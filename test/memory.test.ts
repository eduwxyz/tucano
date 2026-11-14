import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { personScope, type Agent, type Author, type EngineId, type Message, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { MAX_AFTER, Memories, memorySystem, parseConsolidation, THREAD_QUIET_MS, WINDOW } from '../src/core/memory'
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

function setup(sessions = false): void {
  const base = fakeEngine('claude', { delayMs: 1, sessions })
  const claude: Engine = { ...base, run: (t) => (turns.push(t), base.run(t)) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
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
function put(conversationId: string, author: Author, text: string, threadId?: string): Message {
  const m: Message = { id: `m${clock}`, conversationId, author, text, at: clock++, ...(threadId ? { threadId } : {}) }
  db.saveMessage(m)
  return m
}

const agentTurns = (handle: string): Turn[] => turns.filter((t) => t.system.startsWith(`Você é ${handle[0]!.toUpperCase()}${handle.slice(1)} (@${handle})`))
const active = (scope = personScope(db.ownerId())): string[] => db.memories({ scope, state: 'active' }).map((m) => m.text)

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
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
  it('folds what leaves the window into the summary, which a reply outside threads reads with every newer message', async () => {
    put('c1', { kind: 'person', id: db.ownerId() }, 'ZEBRA é o cupom da campanha')
    for (let i = 1; i < MAX_AFTER + 10; i++) put('c1', i % 2 ? { kind: 'agent', id: 'a1' } : { kind: 'person', id: db.ownerId() }, `mensagem ${i}`)
    const all = db.messagesAfter('c1', 0)

    await memory.consolidate('c1')
    const conv = db.conversation('c1')!
    expect(conv.summary).toContain('ZEBRA')
    expect(conv.summaryUntil).toBe(all[all.length - WINDOW - 1]!.at)

    // Outside threads (a routine's reply): the summary and what came after it.
    const outside = memory.window(conv, { id: 'x', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at: clock })
    expect(outside.summary).toContain('ZEBRA')
    expect(outside.messages.map((m) => m.text)).not.toContain('ZEBRA é o cupom da campanha') // it left the window
    expect(outside.messages.at(-1)?.text).toBe(`mensagem ${MAX_AFTER + 9}`)

    // A thread is a conversation of its own: neither the summary nor those messages.
    db.setThreads('c1', true)
    await runner.send('c1', '@lia qual é o cupom?')
    await settle()
    const prompt = agentTurns('lia')[0]!.prompt
    expect(prompt).not.toContain('ZEBRA')
    expect(prompt).not.toContain(`mensagem ${MAX_AFTER + 9}`)
  })

  it('consolidates on its own once more than MAX_AFTER messages follow the summary', async () => {
    for (let i = 0; i < MAX_AFTER; i++) put('d1', { kind: 'person', id: db.ownerId() }, `mensagem ${i}`)
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

describe('a thread\'s own summary', () => {
  it('a quiet thread gets its summary and the memories in it, once; a busy one waits', async () => {
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'qual café a gente compra?')
    put('c1', { kind: 'agent', id: 'a1' }, 'tem o de sempre e um novo', root.id)
    const last = put('c1', { kind: 'person', id: db.ownerId() }, 'eu prefiro café sem açúcar', root.id)
    const busy = put('c1', { kind: 'person', id: db.ownerId() }, 'faz o relatório')
    db.saveMessage({ ...put('c1', { kind: 'agent', id: 'a2' }, 'metade', busy.id), run: { status: 'working', depth: 1, steps: [] } })
    for (let i = 0; i < WINDOW; i++) put('c1', { kind: 'person', id: db.ownerId() }, `solta ${i}`) // outside threads, after both

    const later = clock + THREAD_QUIET_MS
    await memory.sweep(later)
    await memory.idle()
    expect(db.message(root.id)?.threadSummary).toMatchObject({ text: expect.stringContaining('Resumo de teste: qual café a gente') as string, until: last.at })
    expect(db.memories().map((m) => [m.text, m.state])).toEqual([['Prefere café sem açúcar', 'pending']])
    expect(db.message(busy.id)?.threadSummary).toBeUndefined() // a reply is still being written

    // Nothing new since: no second call. And the conversation's summary reads the thread
    // but doesn't learn from it again: that's the thread's.
    const calls = turns.filter((t) => t.system === memorySystem()).length
    await memory.sweep(later + 60_000)
    await memory.idle()
    expect(turns.filter((t) => t.system === memorySystem())).toHaveLength(calls)
    await memory.consolidate('c1', true)
    expect(db.memories()).toHaveLength(1)
  })

  it("not before it's quiet, nor for a question and its answer alone", async () => {
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'oi')
    put('c1', { kind: 'agent', id: 'a1' }, 'oi!', root.id)
    const busy = put('c1', { kind: 'person', id: db.ownerId() }, 'pergunta longa')
    put('c1', { kind: 'agent', id: 'a1' }, 'resposta', busy.id)
    put('c1', { kind: 'person', id: db.ownerId() }, 'e mais uma coisa', busy.id)
    await memory.sweep(clock + 60_000) // a minute later: not quiet yet
    await memory.sweep(clock + THREAD_QUIET_MS) // quiet: only the one with three messages
    await memory.idle()
    expect(db.message(root.id)?.threadSummary).toBeUndefined()
    expect(db.message(busy.id)?.threadSummary?.text).toContain('Resumo de teste')
  })

  it("past MAX_AFTER replies, a reply reads the thread's summary, the message that opened it and the newest replies", async () => {
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'RAIZ: ZEBRA é o cupom')
    for (let i = 0; i < MAX_AFTER + 5; i++) put('c1', i % 2 ? { kind: 'agent', id: 'a1' } : { kind: 'person', id: db.ownerId() }, `resposta ${i}`, root.id)
    await runner.send('c1', '@lia qual era o cupom?', [], root.id)
    await settle() // the thread grew past MAX_AFTER: it gets its summary
    expect(db.message(root.id)?.threadSummary?.text).toContain('ZEBRA')

    await runner.send('c1', '@lia e agora?', [], root.id)
    await settle()
    const prompt = agentTurns('lia').at(-1)!.prompt
    expect(prompt).toContain('Resumo do começo desta thread')
    expect(prompt).toContain('RAIZ: ZEBRA é o cupom') // the message that opened it always goes
    expect(prompt).not.toContain('\nresposta 0\n')
    expect(prompt).toContain('@lia e agora?')
  })

  it('a hand edit keeps what the summary covers, and the thread shows it', () => {
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'raiz')
    db.setThreadSummary(root.id, 'feito pelo modelo', root.at)
    memory.editThreadSummary(root.id, '  corrigido à mão  ')
    expect(db.message(root.id)?.threadSummary).toMatchObject({ text: 'corrigido à mão', until: root.at })
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
    const system = agentTurns('theo')[0]!.prompt
    expect(system).toContain('Sobre Edu (todos os agentes veem):')
    expect(system).toContain('eu prefiro PR pequeno')
  })

  it('a new memory goes on the kept session with only the new context, instead of starting over', async () => {
    setup(true)
    await runner.send('c1', '@theo oi')
    await settle()
    const before = agentTurns('theo')
    expect(before[0]!.session).toMatchObject({ resume: false })
    expect(before[0]!.prompt).not.toContain('PR pequeno')

    db.saveMemory({ id: 'mem1', scope: 'me', text: 'eu prefiro PR pequeno', state: 'active', origin: 'me', messageIds: [], createdAt: clock, confirmedAt: clock })
    await runner.send('c1', '@theo e agora?')
    await settle()
    const [first, second] = agentTurns('theo')
    expect(second!.system).toBe(first!.system) // the system prompt holds: the session and its cache go on
    expect(second!.session).toEqual({ id: first!.session!.id, resume: true, keep: true })
    expect(second!.blocks![0]).toMatch(/^# Contexto de agora/)
    expect(second!.blocks![0]).toContain('eu prefiro PR pequeno')
    expect(second!.blocks!.at(-1)).toContain('e agora?')

    await runner.send('c1', '@theo e mais?')
    await settle()
    expect(agentTurns('theo')[2]!.blocks!.some((b) => b.includes('# Contexto de agora'))).toBe(false) // unchanged: not again
  })

  it('with "pede aprovação" nothing reaches a prompt until I accept it', async () => {
    db.saveAgent(agent('a1', 'lia', { memory: 'approve' }))
    await runner.send('d1', 'lembra que eu prefiro PR pequeno')
    await settle()
    const [pending] = db.memories({ state: 'pending' })
    expect(pending?.text).toBe('eu prefiro PR pequeno')

    await runner.send('c1', '@theo oi')
    await settle()
    expect(agentTurns('theo')[0]!.prompt).not.toContain('PR pequeno')

    memory.decide(pending!.id, true)
    await runner.send('c1', '@theo e agora?')
    await settle()
    expect(agentTurns('theo')[1]!.prompt).toContain('PR pequeno')
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
    put('c1', { kind: 'person', id: db.ownerId() }, 'eu prefiro café sem açúcar')
    for (let i = 0; i < WINDOW; i++) put('c1', { kind: 'person', id: db.ownerId() }, `mensagem ${i}`)
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
    expect(agentTurns('theo')[0]!.prompt).not.toContain('PR pequeno')
  })
})
