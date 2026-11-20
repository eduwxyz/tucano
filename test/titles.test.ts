// A request's short title (src/core/titles.ts): made once, by the memory's model, when a reply starts on it.
import { describe, expect, it, vi } from 'vitest'
import { Titles } from '../src/core/titles'
import type { Db } from '../src/core/db'
import type { Engine, EngineEvent } from '../src/core/engines/types'
import type { Message, Settings } from '../src/shared/types'

const request = (text: string, extra: Partial<Message> = {}): Message => ({ id: 'req', conversationId: 'dm', author: { kind: 'person', id: 'ana' }, text, at: 1, ...extra })
const reply = (run: Partial<NonNullable<Message['run']>>): Message => ({ id: 'r1', conversationId: 'dm', author: { kind: 'agent', id: 'lia' }, text: '', at: 2, run: { status: 'working', steps: [], ...run } }) as Message

function setup(stored: Message, answer = 'Título: "Notas da versão 0.2.37."') {
  let msg = stored
  const db = {
    message: vi.fn((id: string) => (id === msg.id ? msg : undefined)),
    setMessageTitle: vi.fn((_id: string, title: string) => (msg = { ...msg, title })),
    setRunSessionName: vi.fn(),
    delegation: vi.fn(() => ({ rootId: 'req' })),
    addReceipt: vi.fn()
  } as unknown as Db
  const runs: string[] = []
  const engine = {
    async *run(turn: { prompt: string }): AsyncGenerator<EngineEvent> {
      runs.push(turn.prompt)
      yield { type: 'text', delta: answer } as EngineEvent
      yield { type: 'done', text: answer, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } } as EngineEvent
    }
  } as unknown as Engine
  const settings = { memoryModel: 'haiku', engines: { claude: { installed: true, loggedIn: true } } } as unknown as Settings
  const emit = vi.fn()
  const titles = new Titles({ db, engines: { claude: engine } as never, settings: async () => settings, emit, workDir: '/tmp/tucano-titles-test' })
  return { titles, db, runs, emit }
}

describe('request titles', () => {
  it('a long request gets a short title once, kept on it and sent out', async () => {
    const { titles, db, runs, emit } = setup(request('Otto, publique a v0.2.35 do Tucano (desktop), com o OK do Eduardo.\nDepois escreva as notas da versão e avise o time.'))
    expect(await titles.title('req')).toBe('Notas da versão 0.2.37')
    expect(db.setMessageTitle).toHaveBeenCalledWith('req', 'Notas da versão 0.2.37')
    expect(emit).toHaveBeenCalledWith({ type: 'message', message: expect.objectContaining({ title: 'Notas da versão 0.2.37' }) })
    expect(await titles.title('req')).toBeUndefined()
    expect(runs).toHaveLength(1)
  })

  it('a short request is its own title: no model call', async () => {
    const { titles, runs } = setup(request('Revise o PR #531'))
    expect(await titles.title('req')).toBeUndefined()
    expect(runs).toHaveLength(0)
  })

  it('a reply that starts on a request, or on a part handed on, titles that request', async () => {
    const { titles, runs } = setup(request('Veja por que o app fecha quando eu arquivo um agente que ainda tem uma rotina ligada, e me diga'))
    titles.forReply(reply({ replyTo: 'req' }))
    await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(1))
    const other = setup(request('Escreva o post do lançamento no X, curto, com a imagem que o Juno fez ontem à tarde'))
    other.titles.forReply(reply({ handed: 'd1' }))
    await vi.waitFor(() => expect(other.runs.length).toBeGreaterThanOrEqual(1))
    expect(other.db.delegation).toHaveBeenCalledWith('d1')
  })
})
