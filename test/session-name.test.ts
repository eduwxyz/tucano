// A session's name (src/core/titles.ts): made once, when the reply starts, by the model picked in
// Settings › Models › Session names, kept on the reply's own run (src/core/db.ts) and shown beside the
// agent's name. The write goes through json_set on the run's JSON, so what the run did meanwhile stays.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Db } from '../src/core/db'
import { Titles, sessionNameSystem } from '../src/core/titles'
import type { Engine, EngineEvent } from '../src/core/engines/types'
import type { Message, Settings } from '../src/shared/types'

const request = (text: string, extra: Partial<Message> = {}): Message => ({ id: 'req', conversationId: 'dm', author: { kind: 'person', id: 'ana' }, text, at: 1, ...extra })
const reply = (run: Partial<NonNullable<Message['run']>> = {}, extra: Partial<Message> = {}): Message =>
  ({ id: 'r1', conversationId: 'dm', author: { kind: 'agent', id: 'lia' }, text: '', at: 2, run: { status: 'working', steps: [], ...run }, ...extra }) as Message

function setup(messages: Message[], opts: { answer?: string; settings?: Partial<Settings>; fail?: boolean } = {}) {
  const answer = opts.answer ?? 'Nomes das sessões'
  const rows = new Map(messages.map((m) => [m.id, m]))
  const db = {
    message: vi.fn((id: string) => rows.get(id)),
    setMessageTitle: vi.fn(),
    setRunSessionName: vi.fn((id: string, name: string) => {
      const m = rows.get(id)
      if (m) rows.set(id, { ...m, run: { ...m.run!, sessionName: name } })
    }),
    delegation: vi.fn(() => ({ rootId: 'req' })),
    addReceipt: vi.fn()
  } as unknown as Db
  const runs: { prompt: string; system: string; model: string; signal: AbortSignal }[] = []
  const engine = {
    async *run(turn: { prompt: string; system: string; model: string; signal: AbortSignal }): AsyncGenerator<EngineEvent> {
      runs.push({ prompt: turn.prompt, system: turn.system, model: turn.model, signal: turn.signal })
      if (opts.fail) {
        yield { type: 'error', message: 'sem modelo' } as EngineEvent
        return
      }
      yield { type: 'text', delta: answer } as EngineEvent
      yield { type: 'done', text: answer, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } } as EngineEvent
    }
  } as unknown as Engine
  const settings = { memoryModel: 'haiku', sessionNameModel: 'sonnet', engines: { claude: { installed: true, loggedIn: true } }, ...opts.settings } as unknown as Settings
  const emit = vi.fn()
  const titles = new Titles({ db, engines: { claude: engine } as never, settings: async () => settings, emit, workDir: mkdtempSync(join(tmpdir(), 'tucano-names-')) })
  return { titles, db, runs, emit }
}

const asked = 'Nomes das sessões no Tucano, ao lado do nome do agente e no cabeçalho da thread'
const opening = request(asked)

describe('session names', () => {
  it('a reply that starts gets its session named, once, from the request under it', async () => {
    const { titles, db, runs, emit } = setup([opening, reply()])
    expect(await titles.nameSession(reply({ replyTo: 'req' }), 'req')).toBe('Nomes das sessões')
    expect(runs[0]).toMatchObject({ system: sessionNameSystem(), model: 'sonnet' })
    expect(runs[0]!.prompt).toContain('Nomes das sessões')
    expect(db.setRunSessionName).toHaveBeenCalledWith('r1', 'Nomes das sessões')
    expect(emit).toHaveBeenCalledWith({ type: 'message', message: expect.objectContaining({ id: 'r1' }) })
  })

  it('forReply names the session of a reply that starts, without being asked', async () => {
    const { titles, runs } = setup([opening, reply()])
    titles.forReply(reply({ replyTo: 'req' }))
    await vi.waitFor(() => expect(runs.some((r) => r.system === sessionNameSystem())).toBe(true))
  })

  it('a session already named is not named again', async () => {
    const { titles, runs } = setup([opening, reply({ sessionName: 'Já nomeada' })])
    expect(await titles.nameSession(reply({ sessionName: 'Já nomeada' }), 'req')).toBeUndefined()
    expect(runs).toHaveLength(0)
  })

  it('"off" leaves sessions unnamed and calls no model', async () => {
    const { titles, runs, db } = setup([opening, reply()], { settings: { sessionNameModel: 'off' } })
    expect(await titles.nameSession(reply(), 'req')).toBeUndefined()
    expect(runs).toHaveLength(0)
    expect(db.setRunSessionName).not.toHaveBeenCalled()
  })

  it('with no model picked it uses the memory model, and a long request is capped at 1500 characters', async () => {
    const long = request('x'.repeat(2000))
    const { titles, runs } = setup([long, reply()], { settings: { sessionNameModel: undefined } })
    await titles.nameSession(reply(), 'req')
    expect(runs[0]!.model).toBe('haiku')
    expect(runs[0]!.prompt).toHaveLength(1500)
    expect(runs[0]!.signal.aborted).toBe(false)
  })

  it('the name is written into the run without touching what the run is doing', () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-runs-')), 'test.db'))
    try {
      db.saveAgent({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
      db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'], owner: db.ownerId() })
      db.saveMessage({ id: 'c1', conversationId: 'dm', author: { kind: 'person', id: db.ownerId() }, text: 'oi', at: 1 })
      db.saveMessage(reply({ steps: [{ id: 's1', label: 'Lendo', status: 'running' }], replyTo: 'req' }))
      db.setRunSessionName('r1', 'Nomes das sessões')
      const saved = db.message('r1')!
      expect(saved.run?.sessionName).toBe('Nomes das sessões')
      expect(saved.run?.status).toBe('working')
      expect(saved.run?.steps).toHaveLength(1)
      expect(saved.run?.steps[0]?.status).toBe('running')
    } finally {
      db.close()
    }
  })

  it('a naming failure costs the name and leaves the reply as it was', async () => {
    const { titles, db, emit, runs } = setup([opening, reply()], { fail: true })
    expect(await titles.nameSession(reply(), 'req')).toBeUndefined()
    expect(runs).toHaveLength(1)
    expect(db.setRunSessionName).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})
