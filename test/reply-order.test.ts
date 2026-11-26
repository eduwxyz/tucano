import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asDisplayed, asSaid, saidAt, type Agent, type EngineId, type Message, type RunStatus, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

describe('asSaid', () => {
  const said = (id: string, at: number, status?: RunStatus, endedAt?: number): Message => ({
    id,
    conversationId: 'c',
    author: status ? { kind: 'agent', id: 'a' } : { kind: 'person', id: 'owner' },
    text: id,
    at,
    ...(status ? { run: { status, steps: [], ...(endedAt ? { endedAt } : {}) } } : {})
  })
  const ids = (messages: Message[]): string[] => asSaid(messages).map((m) => m.id)

  it('puts a reply where it ended, not where it started', () => {
    expect(ids([said('pedido', 1), said('lenta', 2, 'done', 9), said('rápida', 3, 'done', 4), said('depois', 5)])).toEqual(['pedido', 'rápida', 'depois', 'lenta'])
  })

  it('leaves whoever is still working at the end, in the order they started', () => {
    expect(ids([said('pedido', 1), said('b', 3, 'working'), said('a', 2, 'working'), said('pronta', 4, 'done', 5), said('depois', 6)])).toEqual(['pedido', 'pronta', 'depois', 'a', 'b'])
  })

  it('counts a reply as said however it ended, or that it asks something', () => {
    for (const status of ['done', 'failed', 'stopped', 'limit_reached', 'paused', 'waiting_input', 'waiting_approval'] as const) expect(ids([said('r', 1, status, 5), said('m', 3)])).toEqual(['m', 'r'])
  })

  it('leaves replies with no end where they started: older ones, and those cut when the app closed', () => {
    expect(ids([said('antiga', 1, 'done'), said('m', 2), said('cortada', 3, 'interrupted'), said('n', 4)])).toEqual(['antiga', 'm', 'cortada', 'n'])
    expect(saidAt(said('antiga', 1, 'done'))).toBe(1)
  })

  it('leaves the list it was given as it was', () => {
    const list = [said('lenta', 1, 'done', 9), said('m', 2)]
    asSaid(list)
    expect(list.map((m) => m.id)).toEqual(['lenta', 'm'])
  })
})

describe('the prompt a reply starts from, as the window draws it', () => {
  const prompt = (id: string, at: number, extra: Partial<Message> = {}): Message => ({ id, conversationId: 'c', author: { kind: 'person', id: 'owner' }, text: id, at, ...extra })
  const reply = (id: string, at: number, endedAt: number, replyTo?: string, extra: Partial<Message> = {}): Message => prompt(id, at, {
    author: { kind: 'agent', id: 'a' },
    run: { status: 'done', steps: [], endedAt, ...(replyTo ? { replyTo } : {}) },
    ...extra
  })
  const ids = (list: Message[]): string[] => asDisplayed(list).map((m) => m.id)

  it('shows a done reply at its later end, below prompts written after it first ended', () => {
    const first = prompt('first', 1)
    const original = reply('session', 2, 5, 'first')
    const later = prompt('later', 6)
    const other = reply('other', 7, 8, 'later')
    expect(ids([first, original, later, other])).toEqual(['first', 'session', 'later', 'other'])

    // Follow only changes the reply's end: the row moves below the prompt written at 6.
    const followed = reply('session', 2, 20, 'first')
    expect(ids([first, followed, later, other])).toEqual(['later', 'other', 'first', 'session'])
    // The stored rows stay in the order they were written.
    expect(asSaid([first, followed, later, other]).map((m) => m.id)).toEqual(['first', 'later', 'other', 'session'])
  })

  it('puts the originating prompt immediately before the session it started', () => {
    const list = [prompt('p', 1), reply('session', 2, 12, 'p'), prompt('unrelated', 9)]
    expect(ids(list)).toEqual(['unrelated', 'p', 'session'])

    const at = ids(list).indexOf('session')
    expect(ids(list)[at - 1]).toBe('p')
  })

  it('pulls a queued prompt written far earlier to right above the reply it waited for', () => {
    const list = [prompt('queued', 1, { sendMode: 'queue' }), prompt('a', 10), prompt('b', 20), reply('session', 101, 105, 'queued')]
    expect(ids(list)).toEqual(['a', 'b', 'queued', 'session'])
    // The core's own order still reads by the end of the reply, and the prompt's `at` is untouched.
    expect(asSaid(list).map((m) => m.id)).toEqual(['queued', 'a', 'b', 'session'])
    expect(list[0]!.at).toBe(1)
  })

  it('pairs inside a thread without pulling a prompt from another thread', () => {
    const root = prompt('root', 1)
    const threadPrompt = prompt('thread-prompt', 2, { threadId: 'root' })
    const threadReply = reply('thread-reply', 3, 20, 'thread-prompt', { threadId: 'root' })
    const channelPrompt = prompt('channel-prompt', 4)
    const channelReply = reply('channel-reply', 5, 8, 'channel-prompt')
    expect(ids([root, threadPrompt, threadReply, channelPrompt, channelReply])).toEqual(['root', 'channel-prompt', 'channel-reply', 'thread-prompt', 'thread-reply'])

    // A prompt that belongs to another thread stays where it was, with no reply pulling it.
    const elsewhere = prompt('elsewhere', 1, { threadId: 'another-root' })
    const orphan = reply('in-channel', 2, 9, 'elsewhere')
    expect(ids([elsewhere, prompt('between', 5), orphan])).toEqual(['elsewhere', 'between', 'in-channel'])
  })

  it('keeps unrelated rows in order, pairs a shared prompt once, and leaves the input as it was', () => {
    const shared = prompt('shared', 1)
    const earlierEnd = reply('earlier-end', 3, 4, 'shared')
    const laterEnd = reply('later-end', 2, 5, 'shared')
    const orphan = reply('orphan', 6, 7) // an old reply with no prompt keeps its place
    const working = prompt('working', 8, { author: { kind: 'agent', id: 'b' }, run: { status: 'working', steps: [] } })
    const list = [shared, earlierEnd, laterEnd, orphan, working]
    const before = [...list]

    expect(ids(list)).toEqual(['shared', 'earlier-end', 'later-end', 'orphan', 'working'])
    expect(new Set(ids(list)).size).toBe(list.length) // no prompt drawn twice
    expect(asDisplayed(list)).toHaveLength(list.length)
    expect(list).toEqual(before)
    expect(list.every((m, i) => m === before[i])).toBe(true)
  })
})

describe('replies that overlap', () => {
  const ready = { installed: true, loggedIn: true }
  const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

  let db: Db
  let turns: Turn[]
  let broken: boolean

  // Lia takes much longer than Theo, so she starts first and ends last. Her turns can fail on demand.
  function runner(): Runner {
    turns = []
    broken = false
    const fast = fakeEngine('claude', { delayMs: 1, sessions: true })
    const slow = fakeEngine('claude', { delayMs: 40, sessions: true })
    const isLia = (t: Turn): boolean => t.system.startsWith('Você é lia')
    const claude: Engine = {
      ...fast,
      async *run(t: Turn): AsyncIterable<EngineEvent> {
        if (isLia(t)) turns.push(t)
        if (isLia(t) && broken) {
          yield { type: 'error', message: 'quebrou' }
          return
        }
        yield* (isLia(t) ? slow : fast).run(t)
      }
    }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') }
    const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ro-work-')) })
  }

  // A person's message reads as 'me': the single person of the desktop app.
  const whose = (m: Message): string => (m.author.kind === 'agent' ? m.author.id : m.author.kind === 'person' ? 'me' : m.author.kind)
  const of = (id: string): Message => db.messages().find((m) => whose(m) === id)!

  // Lia is asked first and is at work when Theo is asked: two messages, since agents called in one may take turns.
  const overlap = async (r: Runner): Promise<void> => {
    await r.send('c', '@lia bom dia')
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    await r.send('c', '@theo bom dia')
    await r.idle()
  }

  beforeEach(() => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ro-db-')), 'test.db'))
    db.saveAgent(agent('lia', 'lia'))
    db.saveAgent(agent('theo', 'theo'))
    db.createConversation({ id: 'c', kind: 'channel', name: 'geral', members: ['lia', 'theo'] })
  })

  it('shows the one that ended last below the other, with the time it ended', async () => {
    await overlap(runner())

    expect(of('lia').at).toBeLessThan(of('theo').at) // she started first…
    expect(of('lia').run!.endedAt!).toBeGreaterThan(of('theo').run!.endedAt!) // …and ended last
    expect(asSaid(db.messages()).map(whose)).toEqual(['me', 'me', 'theo', 'lia'])
    expect(saidAt(of('lia'))).toBe(of('lia').run!.endedAt)
  })

  it('goes on with the session it had: what the other said while it worked is simply new to it', async () => {
    const r = runner()
    await overlap(r)
    await r.send('c', '@lia e agora?')
    await r.idle()

    const [first, second] = turns
    expect(second!.session).toEqual({ id: first!.session!.id, resume: true, keep: true })
    expect(second!.blocks).toHaveLength(3)
    expect(second!.blocks![0]).toMatch(/theo bom dia$/)
    expect(second!.blocks![1]).toMatch(/^\[theo · agente/)
    expect(second!.blocks![2]).toMatch(/e agora\?$/)
    expect(db.messages().map(whose)).toEqual(['me', 'lia', 'me', 'theo', 'me', 'lia']) // agents read in the order they started
  })

  it('marks the end of a reply that failed, and a new end when it is tried again', async () => {
    const r = runner()
    broken = true
    await r.send('c', '@lia bom dia')
    await r.idle()
    const failed = of('lia')
    expect(failed.run).toMatchObject({ status: 'failed', endedAt: expect.any(Number) })

    await r.send('c', '@theo oi')
    await r.idle()
    expect(asSaid(db.messages()).map(whose)).toEqual(['me', 'lia', 'me', 'theo'])

    broken = false
    r.retry(failed.id)
    await r.idle()
    expect(of('lia').run!.status).toBe('done')
    expect(asSaid(db.messages()).map(whose)).toEqual(['me', 'me', 'theo', 'lia'])
  })

  it('marks the end of a reply that never got to run', async () => {
    // Past the limit is a ceiling it really has and use it really made: a limit of 0 is no limit.
    db.saveAgent(agent('lia', 'lia', { limit: 1_000 }))
    db.addReceipt({ messageId: 'before', agentId: 'lia', engine: 'claude', model: 'sonnet', inputTokens: 1_000, cacheReadTokens: 0, outputTokens: 0, ms: 1, at: Date.now() })
    const r = runner()
    await r.send('c', '@lia bom dia')
    await r.idle()
    expect(of('lia').run).toMatchObject({ status: 'limit_reached', endedAt: expect.any(Number) })
  })
})
