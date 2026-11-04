import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

let db: Db
let gateway: Gateway
let settings: Settings
let turns: Turn[]
let gates: (() => void)[] // one per turn: lets it finish
const release = (): void => gates.splice(0).forEach((go) => go())
let events: Message[]

// An agent that works until it's let go (or stopped), then answers.
const slow: Engine = {
  id: 'claude',
  async *run(turn) {
    turns.push(turn)
    await new Promise<void>((resolve) => {
      gates.push(resolve)
      turn.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    if (turn.signal.aborted) return
    yield { type: 'text', delta: `resposta ${turns.length}` }
    yield { type: 'done', text: `resposta ${turns.length}`, usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
  }
}

function runner(): Runner {
  turns = []
  events = []
  gates = []
  const engines: Record<EngineId, Engine> = { claude: slow, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => e.type === 'message' && events.push(e.message), workDir: mkdtempSync(join(tmpdir(), 'mq-w-')), gateway })
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}
const mine = (): Message[] => db.messages().filter((m) => m.author.kind === 'me')
const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'mq-db-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent({ id: 'teo', name: 'Teo', handle: 'teo', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'teo', members: ['teo'] })
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('messages sent while the agent is still answering', () => {
  it('wait in that reply’s thread, and go together in one follow-up', async () => {
    const r = runner()
    await r.send('dm', 'conectei no gitlab')
    await until(() => turns.length === 1)
    await r.send('dm', 'ah, e olha as threads da Ingridy')
    await r.send('dm', 'e as 4 do Remy')
    expect(turns).toHaveLength(1) // no reply of their own

    // In the first message's thread, marked as waiting for Teo.
    const [first, second, third] = mine()
    expect(second!.threadId).toBe(first!.id)
    expect(third!.threadId).toBe(first!.id)
    expect(events.find((m) => m.id === second!.id)?.queued).toBe('teo')

    release()
    await until(() => turns.length === 2)
    expect(turns[1]!.prompt).toContain('mandou 2 mensagens')
    expect(turns[1]!.prompt).toContain('olha as threads da Ingridy')
    expect(turns[1]!.prompt).toContain('as 4 do Remy')
    release()
    await r.idle()
    expect(turns).toHaveLength(2) // two replies for three messages, not three
    expect(replies().map((m) => m.run?.status)).toEqual(['done', 'done'])
    expect(replies().every((m) => m.threadId === first!.id)).toBe(true)
  })

  it('"Orientar agora" stops the reply and starts again with the new message in hand', async () => {
    const r = runner()
    await r.send('dm', 'revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('dm', 'na verdade é o PR 13')
    const waiting = mine()[1]!
    r.steer(waiting.id)
    await until(() => turns.length === 2)
    const cut = replies()[0]!
    expect(cut.run?.status).toBe('stopped')
    // Not a failure: no failed step, and no "Try again" (the reply after it carries on).
    expect(cut.run?.steered).toBe(true)
    expect(cut.run?.steps.some((s) => s.status === 'error')).toBe(false)
    r.retry(cut.id)
    expect(turns[1]!.prompt).toContain('te interrompeu')
    expect(turns[1]!.prompt).toContain('na verdade é o PR 13')
    release()
    await r.idle()
    expect(replies().at(-1)!.run?.status).toBe('done')
    expect(turns).toHaveLength(2) // "Try again" on the cut reply did nothing
  })

  it('a message in another thread is another subject: it gets its own reply', async () => {
    const r = runner()
    await r.send('dm', 'primeiro assunto')
    await until(() => turns.length === 1)
    const other = { id: 'outra', conversationId: 'dm', author: { kind: 'me' as const }, text: 'assunto velho', at: 1 }
    db.saveMessage(other)
    await r.send('dm', 'sobre aquilo', [], 'outra')
    expect(mine().at(-1)!.threadId).toBe('outra') // not moved into the busy reply's thread
    expect(events.find((m) => m.id === mine().at(-1)!.id)?.queued).toBeUndefined()
    // Teo does one thing at a time: it's a reply of its own, once the first is done.
    release()
    await until(() => turns.length === 2)
    expect(turns[1]!.prompt).toContain('sobre aquilo')
    expect(turns[1]!.prompt).not.toContain('Enquanto você respondia')
    release()
    await r.idle()
    expect(turns).toHaveLength(2)
    expect(replies().map((m) => m.threadId)).toEqual([mine().find((m) => m.text === 'primeiro assunto')!.id, 'outra'])
  })
})

describe('a message waiting for an agent on a task someone handed it', () => {
  it('goes with the follow-up, which stays that task: the answer goes back to the manager', async () => {
    db.saveAgent({ id: 'chefe', name: 'Chefe', handle: 'chefe', role: 'Manager', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    db.createConversation({ id: 'dm-chefe', kind: 'dm', name: 'chefe', members: ['chefe'] })
    turns = []
    events = []
    gates = []
    // Chefe is the usual fake (it delegates); Teo works until it's let go.
    const fast = fakeEngine('claude', { delayMs: 1 })
    const mixed: Engine = { id: 'claude', run: (t) => (t.system.startsWith('Você é Teo') ? slow.run(t) : fast.run(t)) }
    const engines: Record<EngineId, Engine> = { claude: mixed, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
    const r = new Runner({ db, engines, settings: async () => settings, emit: (e) => e.type === 'message' && events.push(e.message), workDir: mkdtempSync(join(tmpdir(), 'mq-w-')), gateway })

    await r.send('dm-chefe', 'delegue a @teo: revisar o PR 12')
    await until(() => turns.length === 1) // Teo on the task, in the DM between the two
    const pairDm = db.conversations().find((c) => c.kind === 'agents')!.id
    const ask = db.messages().find((m) => m.conversationId === pairDm && m.author.kind === 'agent')!
    await r.send(pairDm, 'na verdade é o PR 13', [], ask.id)
    expect(turns).toHaveLength(1) // it waits

    release()
    await until(() => turns.length === 2)
    expect(turns[1]!.prompt).toContain('<tarefa>\nrevisar o PR 12\n</tarefa>') // still the task
    expect(turns[1]!.prompt).toContain('na verdade é o PR 13')
    release()
    await r.idle()
    const teo = db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === 'teo')
    expect(teo.at(-1)!.run?.delegation).toMatchObject({ by: 'chefe', reported: true })
    // Chefe heard back twice: the first answer, then the corrected one.
    const chefe = db.messages().filter((m) => m.conversationId === 'dm-chefe' && m.author.kind === 'agent')
    expect(chefe.filter((m) => m.run?.reportOf)).toHaveLength(2)
  })
})
