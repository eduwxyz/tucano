import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { handoffSystem } from '../src/core/router'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, role: string): Agent => ({ id, name: id, handle: id, role, color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })

let db: Db
let gateway: Gateway
let settings: Settings
let turns: Turn[]
let gates: (() => void)[] // one per running turn, oldest first
let say: Record<string, string> = {} // what an agent says next, by name

// Every agent works until it's let go, then answers.
const slow: Engine = {
  id: 'claude',
  async *run(turn) {
    // The router's look at a reply's mentions answers as the fake one does.
    if (turn.system === handoffSystem()) {
      yield* fakeEngine('claude').run(turn)
      return
    }
    turns.push(turn)
    await new Promise<void>((resolve) => {
      gates.push(resolve)
      turn.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    if (turn.signal.aborted) return
    const text = say[who(turn)] ?? 'feito'
    delete say[who(turn)]
    yield { type: 'done', text, usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
  }
}
const releaseOldest = (): void => gates.shift()?.()
const who = (t: Turn): string => /^Você é (\w+)/.exec(t.system)?.[1] ?? '?'
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}
const of = (id: string): Message[] => db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === id)

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'aq-db-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('dev', 'Engenharia'))
  db.saveAgent(agent('ana', 'Dados'))
  db.createConversation({ id: 'c', kind: 'channel', name: 'geral', members: ['dev', 'ana'] })
  turns = []
  gates = []
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('an agent does one thing at a time', () => {
  it('what comes for a busy agent waits, shown as queued, and goes in order; others work meanwhile', async () => {
    const engines: Record<EngineId, Engine> = { claude: slow, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
    const r = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'aq-w-')), gateway })

    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    // Another subject, in another thread: work of its own for dev, not more of the same.
    db.saveMessage({ id: 'old', conversationId: 'c', author: { kind: 'me' }, text: 'o build de ontem', at: 1 })
    await r.send('c', '@dev depois olha o build', [], 'old')
    await r.send('c', '@ana quantos pedidos ontem?')
    await until(() => turns.length === 2)

    // Ana works at once; dev's second request waits, already in the conversation as queued.
    expect(turns.map(who)).toEqual(['dev', 'ana'])
    const queued = of('dev').find((m) => m.run?.steps[0]?.label === 'Na fila')
    expect(queued?.run?.status).toBe('working')

    releaseOldest() // dev's first is done: its second starts, in the reply that waited
    await until(() => turns.length === 3)
    expect(who(turns[2]!)).toBe('dev')
    releaseOldest()
    releaseOldest()
    await r.idle()
    expect(of('dev').map((m) => m.run?.status)).toEqual(['done', 'done'])
    expect(of('dev')[1]!.id).toBe(queued!.id) // the queued reply is the one that answered
  })

  it('stopping a reply that is still queued cancels it: it never starts', async () => {
    const engines: Record<EngineId, Engine> = { claude: slow, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
    const r = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'aq-w-')), gateway })
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    db.saveMessage({ id: 'old', conversationId: 'c', author: { kind: 'me' }, text: 'o build de ontem', at: 1 })
    await r.send('c', '@dev depois olha o build', [], 'old')
    const queued = of('dev').find((m) => m.run?.steps[0]?.label === 'Na fila')!
    r.stop(queued.id)
    expect(db.message(queued.id)!.run).toMatchObject({ status: 'stopped', steps: [{ label: 'Cancelado' }] })
    releaseOldest()
    await r.idle()
    expect(turns).toHaveLength(1) // dev's second never ran
    expect(db.message(queued.id)!.run?.status).toBe('stopped')
  })
})

describe('a reply waiting its turn', () => {
  const run = (): { r: Runner; events: Message[] } => {
    const events: Message[] = []
    const engines: Record<EngineId, Engine> = { claude: slow, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
    const r = new Runner({ db, engines, settings: async () => settings, emit: (e) => e.type === 'message' && events.push(e.message), workDir: mkdtempSync(join(tmpdir(), 'aq-w-')), gateway })
    return { r, events }
  }
  const waitingReply = (id: string): Message | undefined => of(id).find((m) => m.run?.steps[0]?.label === 'Na fila')
  const finish = async (r: Runner): Promise<void> => {
    let done = false
    void r.idle().then(() => (done = true))
    for (let i = 0; i < 400 && !done; i++) {
      releaseOldest()
      await new Promise((go) => setTimeout(go, 5))
    }
    expect(done).toBe(true)
  }

  it('an agent calling a busy agent: its reply waits over the field and goes in when it starts, after what came meanwhile', async () => {
    const { r, events } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    say['ana'] = '@dev pode olhar o build também?'
    await r.send('c', '@ana olha os números')
    await until(() => turns.length === 2)
    gates[1]!() // Ana answers and calls Dev, who is busy
    gates.splice(1, 1)
    await until(() => !!waitingReply('dev'))
    const waiting = waitingReply('dev')!
    expect(events.findLast((m) => m.id === waiting.id)?.queued).toBe('dev')
    expect(turns).toHaveLength(2) // Dev hasn't started it

    await r.send('c', '@ana e os de ontem?') // comes in while Dev's reply waits
    await until(() => turns.length === 3)
    const meanwhile = db.messages().findLast((m) => m.text === '@ana e os de ontem?')!

    releaseOldest() // Dev is done with the PR: the waiting reply starts
    await until(() => turns.filter((x) => who(x) === 'dev').length === 2)
    const started = events.findLast((m) => m.id === waiting.id)!
    expect(started.queued).toBeUndefined()
    expect(started.at).toBeGreaterThan(meanwhile.at) // in the conversation after it, not where it was asked
    expect(db.message(waiting.id)!.at).toBe(started.at)
    await finish(r)
  })

  it('cancelled while it waits: it never runs, and shows in the conversation as cancelled', async () => {
    const { r, events } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    db.saveMessage({ id: 'old', conversationId: 'c', author: { kind: 'me' }, text: 'o build de ontem', at: 1 })
    await r.send('c', '@dev depois olha o build', [], 'old')
    const waiting = waitingReply('dev')!
    r.stop(waiting.id)
    const last = events.findLast((m) => m.id === waiting.id)!
    expect(last.queued).toBeUndefined()
    expect(last.run?.status).toBe('stopped')
    await finish(r)
    expect(turns).toHaveLength(1)
  })

  it('busy in another conversation: my two messages in a DM wait, and get one reply and one follow-up', async () => {
    db.createConversation({ id: 'd', kind: 'dm', name: 'dev', members: ['dev'] })
    const { r, events } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('d', 'teste')
    await r.send('d', 'teste 2')
    const second = db.messages().find((m) => m.text === 'teste 2')!
    expect(events.findLast((m) => m.id === second.id)?.queued).toBe('dev') // in the queue, not a reply of its own
    expect(of('dev').filter((m) => m.conversationId === 'd')).toHaveLength(1)
    releaseOldest()
    await until(() => turns.length === 2)
    expect(turns[1]!.prompt).toContain('teste')
    releaseOldest()
    await until(() => turns.length === 3)
    expect(turns[2]!.prompt).toContain('teste 2')
    await finish(r)
    expect(turns).toHaveLength(3)
    expect(db.messages().filter((m) => m.conversationId === 'd').map((m) => m.text)).toEqual(['teste', 'feito', 'teste 2', 'feito'])
  })

  it('reading everything again (a window reload) keeps what waits out of the conversation', async () => {
    db.createConversation({ id: 'd', kind: 'dm', name: 'dev', members: ['dev'] })
    const { r } = run()
    await r.send('c', '@dev revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('d', 'teste')
    await r.send('d', 'teste 2')
    const seen = r.withQueue(db.messages())
    expect(seen.find((m) => m.text === 'teste 2')?.queued).toBe('dev')
    expect(seen.find((m) => m.text === 'teste')?.queued).toBeUndefined() // it reached the agent's line of work
    expect(seen.find((m) => m.conversationId === 'd' && m.author.kind === 'agent')?.queued).toBe('dev')
    expect(seen.find((m) => m.text === '@dev revisa o PR 12')?.queued).toBeUndefined()
    await finish(r)
    expect(r.withQueue(db.messages()).some((m) => m.queued)).toBe(false)
  })
})
