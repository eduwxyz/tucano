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
import { routerSystem } from '../src/core/router'
import { ROUTING } from '../src/shared/types'

const ready = { installed: true, loggedIn: true }

let db: Db
let gateway: Gateway
let settings: Settings
let turns: Turn[]
let gates: (() => void)[] // one per turn: lets it finish
let routerGates: (() => void)[] // the router's picks, held until let go
const pick = (): void => routerGates.splice(0).forEach((go) => go())
const release = (): void => gates.splice(0).forEach((go) => go())
let events: Message[]
let removed: string[]

// An agent that works until it's let go (or stopped), then answers.
const slow: Engine = {
  id: 'claude',
  async *run(turn) {
    // The router answers as the fake one does, once let go.
    if (turn.system === routerSystem()) {
      await new Promise<void>((resolve) => routerGates.push(resolve))
      yield* fakeEngine('claude').run(turn)
      return
    }
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
  removed = []
  routerGates = []
  gates = []
  const engines: Record<EngineId, Engine> = { claude: slow, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => (e.type === 'message' ? events.push(e.message) : e.type === 'message_removed' ? removed.push(e.id) : 0), workDir: mkdtempSync(join(tmpdir(), 'mq-w-')), gateway })
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
  it('wait where that reply is, and go together in one follow-up', async () => {
    const r = runner()
    await r.send('dm', 'conectei no gitlab')
    await until(() => turns.length === 1)
    await r.send('dm', 'ah, e olha as threads da Ingridy')
    await r.send('dm', 'e as 4 do Remy')
    expect(turns).toHaveLength(1) // no reply of their own

    // In the conversation, where the DM answers by default, marked as waiting for Teo.
    const [, second, third] = mine()
    expect(second!.threadId).toBeUndefined()
    expect(third!.threadId).toBeUndefined()
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
    expect(replies().every((m) => m.threadId === undefined)).toBe(true)
  })


  it('with threads on, wait in that reply’s thread', async () => {
    db.setThreads('dm', true)
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
    await until(() => turns.length === 2) // a reply of its own, at once
    expect(mine().at(-1)!.threadId).toBe('outra')
    release()
    await r.idle()
    expect(turns).toHaveLength(2)
  })
})

describe('the queue over the field', () => {
  it('a waiting message goes in the conversation when the agent reads it: after its reply, just before the next', async () => {
    const r = runner()
    await r.send('dm', 'revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('dm', 'e olha os testes')
    // Waiting: not delivered yet, so the app keeps it over the field.
    expect(events.at(-1)!.queued).toBe('teo')
    release()
    await until(() => turns.length === 2)
    release()
    await r.idle()
    // In the conversation, in the order things reached the agent: my first message, its reply, then the waiting one.
    expect(db.messages().map((m) => m.text)).toEqual(['revisa o PR 12', 'resposta 1', 'e olha os testes', 'resposta 2'])
    const [, , waited] = db.messages()
    expect(waited!.at).toBeGreaterThan(replies()[0]!.at)
    expect(events.findLast((m) => m.id === waited!.id)?.queued).toBeUndefined()
  })

  it('changed while it waits: the agent reads the new text', async () => {
    const r = runner()
    await r.send('dm', 'revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('dm', 'e olha os testes')
    const waiting = mine()[1]!
    r.editQueued(waiting.id, 'e olha os testes de integração')
    expect(db.message(waiting.id)?.text).toBe('e olha os testes de integração')
    expect(events.at(-1)).toMatchObject({ id: waiting.id, queued: 'teo' })
    release()
    await until(() => turns.length === 2)
    expect(turns[1]!.prompt).toContain('testes de integração')
    release()
    await r.idle()
  })

  it('taken back while it waits: gone, and with nothing left in line there is no follow-up', async () => {
    const r = runner()
    await r.send('dm', 'revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('dm', 'esquece, era outra coisa')
    const waiting = mine()[1]!
    r.cancelQueued(waiting.id)
    expect(db.message(waiting.id)).toBeUndefined()
    expect(removed).toEqual([waiting.id])
    release()
    await r.idle()
    expect(turns).toHaveLength(1)
    // A message no longer in line can't be changed or taken back.
    r.cancelQueued(mine()[0]!.id)
    expect(db.message(mine()[0]!.id)).toBeDefined()
  })
})

describe('the queue in a channel', () => {
  const channel = (): void => {
    db.saveAgent({ id: 'ana', name: 'Ana', handle: 'ana', role: '', color: 'rose', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'eng', members: ['teo', 'ana'] })
  }

  it('with no one named, my next message waits for the agent answering me there', async () => {
    channel()
    const r = runner()
    await r.send('ch', '@teo revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('ch', 'e olha os testes')
    expect(events.at(-1)).toMatchObject({ text: 'e olha os testes', queued: 'teo' })
    expect(turns).toHaveLength(1) // no router, no reply of its own
    release()
    await until(() => turns.length === 2)
    expect(turns[1]!.prompt).toContain('olha os testes')
    release()
    await r.idle()
    expect(turns).toHaveLength(2)
  })

  it('while the router still picks, my next message waits for its pick and goes in that line', async () => {
    channel()
    const r = runner()
    await r.send('ch', 'revisa o PR 12')
    await until(() => routerGates.length === 1)
    await r.send('ch', 'e olha os testes')
    // Held: no second "picking who answers", and the app keeps it over the field.
    expect(events.at(-1)).toMatchObject({ text: 'e olha os testes', queued: ROUTING })
    expect(routerGates).toHaveLength(1)
    pick()
    await until(() => turns.length === 1)
    const picked = (replies()[0]!.author as { id: string }).id
    expect(events.findLast((m) => m.text === 'e olha os testes')?.queued).toBe(picked)
    release()
    await until(() => turns.length === 2)
    expect(turns[1]!.prompt).toContain('olha os testes')
    release()
    await r.idle()
    expect(turns).toHaveLength(2)
    expect(db.messages().filter((m) => m.author.kind === 'system')).toHaveLength(1)
  })

  it('naming someone else is another request: it gets its own answer', async () => {
    channel()
    const r = runner()
    await r.send('ch', '@teo revisa o PR 12')
    await until(() => turns.length === 1)
    await r.send('ch', '@ana e você, olha os números')
    await until(() => turns.length === 2)
    expect(events.findLast((m) => m.text.includes('olha os números'))?.queued).toBeUndefined()
    release()
    await r.idle()
  })
})
