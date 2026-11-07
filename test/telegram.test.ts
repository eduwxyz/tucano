import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Approval, Message } from '../src/shared/types'
import { splitIntoChunks, Telegram } from '../src/core/telegram'

// A stand-in for Telegram's Bot API: updates are queued by the test; what the bot sends is recorded.
function botApi() {
  const queue: object[] = []
  const sent: { method: string; body: Record<string, unknown>; id: number }[] = []
  let nextId = 100
  let waiting: (() => void) | undefined
  const f = (async (url: string, init?: RequestInit) => {
    const method = /\/bot[^/]+\/(\w+)/.exec(url)![1]!
    if (url.includes('/botBAD/')) return Response.json({ ok: false, description: 'Unauthorized' }, { status: 401 })
    if (method === 'getMe') return Response.json({ ok: true, result: { username: 'eduardo_agentes_bot' } })
    if (method === 'getUpdates') {
      if (!queue.length) await new Promise<void>((r) => ((waiting = r), init?.signal?.addEventListener('abort', () => r())))
      if (init?.signal?.aborted) throw new Error('aborted')
      return Response.json({ ok: true, result: queue.splice(0) })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const id = nextId++
    sent.push({ method, body, id })
    return Response.json({ ok: true, result: { message_id: id } })
  }) as unknown as typeof fetch
  let updateId = 1
  return {
    f,
    sent,
    push: (u: object) => {
      queue.push({ update_id: updateId++, ...u })
      waiting?.()
    }
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30))
const me = { id: 42, first_name: 'Eduardo' }
const stranger = { id: 7, first_name: 'Alguém' }

describe('Telegram', () => {
  let api: ReturnType<typeof botApi>
  let store: Map<string, string>
  let tg: Telegram
  let decided: [string, string, string | undefined][]
  let answered: [string, string, string?][]
  let approvals: Map<string, Approval>

  beforeEach(async () => {
    api = botApi()
    store = new Map()
    decided = []
    answered = []
    approvals = new Map()
    tg = new Telegram({
      secrets: { get: async (k) => store.get(k), set: async (k, v) => void (v === undefined ? store.delete(k) : store.set(k, v)) },
      decide: async (id, d, reason) => {
        decided.push([id, d, reason])
        approvals.set(id, { ...approvals.get(id)!, state: d })
      },
      approval: (id) => approvals.get(id),
      answer: (conv, text, thread) => answered.push(thread ? [conv, text, thread] : [conv, text]),
      changed: () => {},
      fetch: api.f
    })
  })
  afterEach(() => tg.stop())

  const pair = async (): Promise<void> => {
    await tg.setToken('TOKEN')
    api.push({ message: { message_id: 1, chat: me, text: `/start ${tg.info().code}` } })
    await settle()
  }

  it('checks the token, and pairs only with whoever sends the code shown in the app', async () => {
    await expect(tg.setToken('BAD')).rejects.toThrow('O Telegram recusou esse token.')
    await tg.setToken('TOKEN')
    expect(tg.info()).toMatchObject({ bot: '@eduardo_agentes_bot', code: expect.stringMatching(/^\d{6}$/) })
    api.push({ message: { message_id: 1, chat: stranger, text: '/start 000000' } })
    await settle()
    expect(tg.info().chat).toBeUndefined()
    api.push({ message: { message_id: 2, chat: me, text: `/start ${tg.info().code}` } })
    await settle()
    expect(tg.info()).toMatchObject({ chat: 'Eduardo', code: undefined })
    expect(api.sent.at(-1)!.body).toMatchObject({ chat_id: 42 })
  })

  const ap = (extra: Partial<Approval> = {}): Approval => {
    const a: Approval = { id: 'ap1', hash: 'h', agentId: 'a1', conversationId: 'c1', messageId: 'm1', connectorId: 'lin', connectorName: 'Linear', tool: 'delete_issue', args: { id: 'SIM-2' }, why: 'duplicada', highRisk: false, state: 'pending', createdAt: 0, expiresAt: 1, ...extra }
    approvals.set(a.id, a)
    return a
  }

  it('sends an approval with buttons, and a tap decides it', async () => {
    await pair()
    await tg.approvalAsked(ap(), 'PM')
    const msg = api.sent.at(-1)!
    expect(msg.body['text']).toContain('PM pede aprovação\n\nLinear · delete_issue\nMotivo: duplicada')
    expect(JSON.stringify(msg.body['reply_markup'])).toContain('ap:ap1:ok')
    api.push({ callback_query: { id: 'q1', data: 'ap:ap1:ok', message: { message_id: 100, chat: me } } })
    await settle()
    expect(decided).toEqual([['ap1', 'approved', undefined]])
    expect(api.sent.find((s) => s.method === 'editMessageText')!.body['text']).toContain('✅ Aprovado pelo Telegram')
  })

  it('a high-risk action needs a second tap; taps from another chat or on a decided request do nothing', async () => {
    await pair()
    await tg.approvalAsked(ap({ highRisk: true }), 'PM')
    api.push({ callback_query: { id: 'q0', data: 'ap:ap1:ok', message: { message_id: 100, chat: stranger } } })
    api.push({ callback_query: { id: 'q1', data: 'ap:ap1:ok', message: { message_id: 100, chat: me } } })
    await settle()
    expect(decided).toEqual([])
    api.push({ callback_query: { id: 'q2', data: 'ap:ap1:sure', message: { message_id: 100, chat: me } } })
    await settle()
    expect(decided).toEqual([['ap1', 'approved', undefined]])
    api.push({ callback_query: { id: 'q3', data: 'ap:ap1:no', message: { message_id: 100, chat: me } } })
    await settle()
    expect(decided).toHaveLength(1)
  })

  it("a reply to an agent's question goes to its conversation", async () => {
    await pair()
    const question: Message = { id: 'm1', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at: 0, run: { status: 'waiting_input', steps: [], question: 'Qual o prazo da v2?' } }
    await tg.questionAsked(question, 'PM', '#simula-oab')
    const asked = api.sent.at(-1)!
    expect(asked.body['text']).toContain('PM pergunta (#simula-oab):\n\nQual o prazo da v2?')
    api.push({ message: { message_id: 5, chat: me, text: 'Sexta que vem', reply_to_message: { message_id: asked.id } } })
    api.push({ message: { message_id: 6, chat: stranger, text: 'hackeado', reply_to_message: { message_id: asked.id } } })
    await settle()
    expect(answered).toEqual([['c1', 'Sexta que vem']])
  })

  it('shows every decision as text, and a reply still answers', async () => {
    await pair()
    const questions = [{ question: 'Paginação no menu?', kind: 'single' as const, options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] }, { question: 'Pra quando?', kind: 'text' as const }]
    const question: Message = { id: 'm3', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at: 0, run: { status: 'waiting_input', steps: [], questions } }
    await tg.questionAsked(question, 'PM', '#simula-oab')
    const asked = api.sent.at(-1)!
    expect(asked.body['text']).toContain('PM pergunta (#simula-oab):\n\n1. Paginação no menu? (Busca remota | Scroll infinito)\n2. Pra quando?')
    api.push({ message: { message_id: 8, chat: me, text: 'busca remota, sexta', reply_to_message: { message_id: asked.id } } })
    await settle()
    expect(answered).toEqual([['c1', 'busca remota, sexta']])
  })

  it("a reply to a question asked in a thread goes back to that thread", async () => {
    await pair()
    const question: Message = { id: 'm2', conversationId: 'c1', threadId: 'root', author: { kind: 'agent', id: 'a1' }, text: '', at: 0, run: { status: 'waiting_input', steps: [], question: 'Qual o prazo?' } }
    await tg.questionAsked(question, 'PM', '#simula-oab')
    api.push({ message: { message_id: 7, chat: me, text: 'Amanhã', reply_to_message: { message_id: api.sent.at(-1)!.id } } })
    await settle()
    expect(answered).toEqual([['c1', 'Amanhã', 'root']])
  })

  it("a long notice arrives whole, in as many messages as it takes, split between lines", async () => {
    await pair()
    const lines = Array.from({ length: 120 }, (_, i) => `- Item ${i + 1}: ${'texto '.repeat(8).trim()}`)
    await tg.notice('Lia · Bom dia', lines.join('\n'))
    const texts = api.sent.slice(1).filter((s) => s.method === 'sendMessage').map((s) => String(s.body['text']))
    expect(texts.length).toBeGreaterThan(1)
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(4096)
    expect(texts[0]!.startsWith('Lia · Bom dia\n\n- Item 1:')).toBe(true)
    expect(texts.join('\n')).toBe(`Lia · Bom dia\n\n${lines.join('\n')}`)
  })

  it('a line longer than a message is cut at the limit', () => {
    expect(splitIntoChunks('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(splitIntoChunks('ab\ncdefgh', 4)).toEqual(['ab', 'cdef', 'gh'])
  })

  it('a short notice is one message', async () => {
    await pair()
    await tg.notice('Lia · Bom dia', 'Linha 1\nLinha 2')
    expect(api.sent.at(-1)!.body['text']).toBe('Lia · Bom dia\n\nLinha 1\nLinha 2')
  })
})
