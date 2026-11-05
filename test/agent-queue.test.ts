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

const ready = { installed: true, loggedIn: true }
const agent = (id: string, role: string): Agent => ({ id, name: id, handle: id, role, color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })

let db: Db
let gateway: Gateway
let settings: Settings
let turns: Turn[]
let gates: (() => void)[] // one per running turn, oldest first

// Every agent works until it's let go, then answers.
const slow: Engine = {
  id: 'claude',
  async *run(turn) {
    turns.push(turn)
    await new Promise<void>((resolve) => {
      gates.push(resolve)
      turn.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    if (turn.signal.aborted) return
    yield { type: 'done', text: 'feito', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
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
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready, grok: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
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
    const engines: Record<EngineId, Engine> = { claude: slow, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok') }
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
    const engines: Record<EngineId, Engine> = { claude: slow, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok') }
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
