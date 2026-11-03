import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Approval, Message } from '../src/shared/types'
import { Telegram } from '../src/core/telegram'
import type { PhoneTarget } from '../src/core/telegram-router'

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
  let answered: [string, string][]
  let approvals: Map<string, Approval>
  let received: { text: string; reply?: PhoneTarget }[]
  let receiveError: boolean
  const makeBot = (): Telegram => new Telegram({
    secrets: { get: async (k) => store.get(k), set: async (k, v) => void (v === undefined ? store.delete(k) : store.set(k, v)) },
    decide: async (id, d, reason) => {
      decided.push([id, d, reason])
      approvals.set(id, { ...approvals.get(id)!, state: d })
    },
    approval: (id) => approvals.get(id),
    answer: (conv, text) => answered.push([conv, text]),
    receive: async (text, reply) => {
      received.push({ text, reply })
      if (receiveError) throw new Error('deleted channel')
      const destination = reply ?? { workspaceId: 'default', conversationId: 'company', agentId: 'calendar' }
      answered.push([destination.conversationId, text])
      return destination
    },
    changed: () => {},
    fetch: api.f
  })

  beforeEach(async () => {
    api = botApi()
    store = new Map()
    decided = []
    answered = []
    approvals = new Map()
    received = []
    receiveError = false
    tg = makeBot()
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

  it('accepts new tasks only from the paired chat and keeps acknowledgement replies on their destination', async () => {
    await pair()
    api.push({ message: { message_id: 10, chat: stranger, text: 'do not route this' } })
    api.push({ message: { message_id: 11, chat: me, text: 'company X meetings' } })
    await settle()
    expect(received).toEqual([{ text: 'company X meetings', reply: undefined }])
    const ack = api.sent.at(-1)!
    api.push({ message: { message_id: 12, chat: me, text: 'next week too', reply_to_message: { message_id: ack.id } } })
    await settle()
    expect(received.at(-1)?.reply).toEqual({ workspaceId: 'default', conversationId: 'company', agentId: 'calendar' })
  })

  it('sends full completed replies in replyable parts and restores destinations after restart', async () => {
    await pair()
    const msg: Message = { id: 'done', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: 'x'.repeat(8000), at: 0, run: { status: 'done', steps: [] } }
    const before = api.sent.length
    await tg.finished(msg, 'PM', '#company')
    const parts = api.sent.slice(before)
    expect(parts).toHaveLength(3)
    expect(parts.map((p) => p.body['text']).join('')).toBe(`PM (#company):\n\n${msg.text}`)
    tg.stop()
    tg = makeBot()
    await tg.start()
    api.push({ message: { message_id: 21, chat: me, text: 'continue', reply_to_message: { message_id: parts[1]!.id } } })
    await settle()
    expect(received.at(-1)?.reply).toEqual({ workspaceId: 'default', conversationId: 'c1', agentId: 'a1', messageId: 'done' })
  })

  it('does not reroute unknown reply IDs and reports dispatch failure without a success acknowledgement', async () => {
    await pair()
    api.push({ message: { message_id: 30, chat: me, text: 'reply', reply_to_message: { message_id: 99999 } } })
    await settle()
    expect(received).toHaveLength(0)
    receiveError = true
    api.push({ message: { message_id: 31, chat: me, text: 'new task' } })
    await settle()
    expect(api.sent.at(-1)!.body['text']).toContain('Não consegui enviar')
  })

  it('keeps emoji intact when splitting a long completed reply', async () => {
    await pair()
    const text = '📅'.repeat(4000)
    const before = api.sent.length
    await tg.finished({ id: 'emoji', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text, at: 0 }, 'PM', '#company')
    const parts = api.sent.slice(before).map((p) => String(p.body['text']))
    expect(parts.join('')).toBe(`PM (#company):\n\n${text}`)
    expect(parts.every((p) => p.length <= 3500 && !/[\uD800-\uDBFF]$/.test(p))).toBe(true)
  })

  it('clears stored destinations on unpair and token replacement', async () => {
    await pair()
    await tg.questionAsked({ id: 'q', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at: 0, run: { status: 'waiting_input', steps: [], question: 'When?' } }, 'PM', '#company')
    expect(store.has('telegram:replies')).toBe(true)
    await tg.unpair()
    expect(store.has('telegram:replies')).toBe(false)
    await pair()
    await tg.approvalAsked(ap(), 'PM')
    expect(store.has('telegram:replies')).toBe(true)
    await tg.setToken('NEW_TOKEN')
    expect(store.has('telegram:replies')).toBe(false)
  })
})
