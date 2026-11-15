import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainCipher } from '../src/core/secrets'
import { WhatsApp } from '../src/core/whatsapp'
import { metaError, parse, signed, verify } from '../src/core/whatsapp/cloud'
import { WhatsAppStore } from '../src/core/whatsapp/store'
import {
  accessFor,
  ALL_CHATS,
  clampSettings,
  cleanAccess,
  dayStart,
  defaultSettings,
  judgeSend,
  LIMITS,
  MAX_TEXT,
  phoneDigits,
  SERVICE_WINDOW_MS,
  type SendQuestion,
  type WhatsAppAccess
} from '../src/shared/whatsapp'

const NOW = 1_800_000_000_000
const reply: WhatsAppAccess = { agentId: 'a1', chat: 'c1', level: 'reply', send: 'auto' }

// A question every rule says yes to, which each test bends one way.
const question = (over: Partial<SendQuestion> = {}): SendQuestion => ({
  kind: 'qr',
  settings: defaultSettings('qr'),
  access: reply,
  sentToday: 0,
  newToday: 0,
  text: 'Oi!',
  template: false,
  chat: { inboundAt: NOW - 60_000, contactedToday: false },
  now: NOW,
  ...over
})

describe('judgeSend', () => {
  it('lets an answer to someone who wrote go alone when the conversation says so', () => {
    expect(judgeSend(question())).toEqual({ ok: true, ask: false, firstContact: false })
  })

  it('asks first when the conversation is set to ask', () => {
    expect(judgeSend(question({ access: { ...reply, send: 'ask' } }))).toEqual({ ok: true, ask: true, firstContact: false })
  })

  it('refuses without access, and with read-only access', () => {
    expect(judgeSend(question({ access: undefined }))).toEqual({ ok: false, why: 'no_access' })
    expect(judgeSend(question({ access: { ...reply, level: 'read' } }))).toEqual({ ok: false, why: 'read_only' })
  })

  it('refuses an empty message and one that is too long', () => {
    expect(judgeSend(question({ text: '   ' }))).toEqual({ ok: false, why: 'empty' })
    expect(judgeSend(question({ text: 'x'.repeat(MAX_TEXT + 1) }))).toEqual({ ok: false, why: 'too_long' })
    expect(judgeSend(question({ text: 'x'.repeat(MAX_TEXT) })).ok).toBe(true)
  })

  it('stops at the day limit', () => {
    const settings = { ...defaultSettings('qr'), dailyLimit: 5 }
    expect(judgeSend(question({ settings, sentToday: 4 })).ok).toBe(true)
    expect(judgeSend(question({ settings, sentToday: 5 }))).toEqual({ ok: false, why: 'daily_limit' })
  })

  it('always asks for someone who never wrote, and limits how many new conversations a day', () => {
    const first = question({ chat: { contactedToday: false } })
    expect(judgeSend(first)).toEqual({ ok: true, ask: true, firstContact: true })
    expect(judgeSend({ ...first, newToday: defaultSettings('qr').newChatsLimit })).toEqual({ ok: false, why: 'new_chats_limit' })
    // A conversation already started today does not count as a new one again.
    expect(judgeSend({ ...first, newToday: defaultSettings('qr').newChatsLimit, chat: { contactedToday: true } }).ok).toBe(true)
  })

  it('on the official API, free text only goes inside 24 hours of their last message', () => {
    const cloud = question({ kind: 'cloud', settings: defaultSettings('cloud') })
    expect(judgeSend(cloud).ok).toBe(true)
    expect(judgeSend({ ...cloud, chat: { inboundAt: NOW - SERVICE_WINDOW_MS - 1, contactedToday: false } })).toEqual({ ok: false, why: 'needs_template' })
    expect(judgeSend({ ...cloud, chat: { contactedToday: false } })).toEqual({ ok: false, why: 'needs_template' })
  })

  it('on the official API, a template goes outside the window and needs no text', () => {
    const cloud = question({ kind: 'cloud', settings: defaultSettings('cloud'), text: '', template: true, chat: { inboundAt: NOW - SERVICE_WINDOW_MS - 1, contactedToday: false } })
    expect(judgeSend(cloud).ok).toBe(true)
  })

  it('leaves a conversation a person took over (answered from the phone) to a person', () => {
    expect(judgeSend(question({ chat: { inboundAt: NOW - 1000, pausedUntil: NOW + 60_000, contactedToday: false } }))).toEqual({ ok: true, ask: true, firstContact: false })
    expect(judgeSend(question({ chat: { inboundAt: NOW - 1000, pausedUntil: NOW - 1, contactedToday: false } }))).toEqual({ ok: true, ask: false, firstContact: false })
  })
})

describe('settings and access', () => {
  it('brings any number inside what the kind allows', () => {
    const s = clampSettings('qr', { dailyLimit: 99_999, newChatsLimit: 500, pauseOnHumanMin: -4 })
    expect(s.dailyLimit).toBe(LIMITS.qr.dailyMax)
    expect(s.newChatsLimit).toBe(LIMITS.qr.newChatsMax)
    expect(s.pauseOnHumanMin).toBe(0)
    expect(clampSettings('cloud', { dailyLimit: 99_999 }).dailyLimit).toBe(99_999)
  })

  it('falls back to the defaults for what is missing or not a number', () => {
    expect(clampSettings('qr', undefined)).toEqual(defaultSettings('qr'))
    expect(clampSettings('qr', { dailyLimit: Number.NaN, inbound: 'nonsense' as never }).dailyLimit).toBe(LIMITS.qr.daily)
  })

  it('never lets new conversations exceed the day limit', () => {
    expect(clampSettings('qr', { dailyLimit: 3, newChatsLimit: 20 }).newChatsLimit).toBe(3)
  })

  it('uses the conversation row first, then the "every conversation" row', () => {
    const rows: WhatsAppAccess[] = [
      { agentId: 'a1', chat: ALL_CHATS, level: 'read', send: 'ask' },
      { agentId: 'a1', chat: 'c1', level: 'reply', send: 'auto' },
      { agentId: 'a2', chat: 'c1', level: 'read', send: 'ask' }
    ]
    expect(accessFor(rows, 'a1', 'c1')?.level).toBe('reply')
    expect(accessFor(rows, 'a1', 'c9')?.level).toBe('read')
    expect(accessFor(rows, 'a2', 'c9')).toBeUndefined()
    expect(accessFor(rows, 'a3', 'c1')).toBeUndefined()
  })

  it('keeps only rows of agents that exist, once each, with known values', () => {
    const rows = [
      { agentId: 'a1', chat: 'c1', level: 'reply', send: 'auto' },
      { agentId: 'a1', chat: 'c1', level: 'read', send: 'ask' },
      { agentId: 'gone', chat: 'c1', level: 'reply', send: 'auto' },
      { agentId: 'a1', chat: '', level: 'reply', send: 'auto' },
      { agentId: 'a1', chat: 'c2', level: 'read', send: 'auto' },
      { agentId: 'a1', chat: 'c3', level: 'weird', send: 'weird' },
      null
    ] as unknown as WhatsAppAccess[]
    expect(cleanAccess(rows, new Set(['a1']))).toEqual([
      { agentId: 'a1', chat: 'c1', level: 'reply', send: 'auto' },
      { agentId: 'a1', chat: 'c2', level: 'read', send: 'ask' }, // "send" only means something when answering
      { agentId: 'a1', chat: 'c3', level: 'read', send: 'ask' }
    ])
  })

  it('reads a phone number from how people write it', () => {
    expect(phoneDigits('+55 (11) 90000-0142')).toBe('5511900000142')
    expect(phoneDigits('123')).toBeUndefined()
    expect(phoneDigits('abc')).toBeUndefined()
  })
})

describe('official API: webhook pieces', () => {
  const body = JSON.stringify({ entry: [] })
  const sign = (secret: string, raw: string): string => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`

  it('accepts only a body signed with the app secret', () => {
    expect(signed('secret', body, sign('secret', body))).toBe(true)
    expect(signed('secret', body, sign('other', body))).toBe(false)
    expect(signed('secret', `${body} `, sign('secret', body))).toBe(false)
    expect(signed('secret', body, undefined)).toBe(false)
    expect(signed('secret', body, 'sha256=short')).toBe(false)
    expect(signed('secret', body, sign('secret', body).replace('sha256=', ''))).toBe(false)
    expect(signed('', body, sign('', body))).toBe(false)
  })

  it('answers Meta\'s handshake only for our token', () => {
    expect(verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '12345' }, 'tok')).toEqual({ status: 200, body: '12345' })
    expect(verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '12345' }, 'tok').status).toBe(403)
    expect(verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '<script>' }, 'tok').status).toBe(403)
    expect(verify({}, 'tok').status).toBe(403)
    expect(verify({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, '').status).toBe(403)
  })

  const hook = (messages: object[], contacts: object[] = [{ wa_id: '5511900000001', profile: { name: 'Ana' } }]) => ({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P1' }, contacts, messages } }] }]
  })

  it('reads texts, and gives the other kinds a short label', () => {
    const got = parse(
      hook([
        { from: '5511900000001', id: 'm1', timestamp: '1800000000', type: 'text', text: { body: 'Oi' } },
        { from: '5511900000001', id: 'm2', timestamp: '1800000001', type: 'image', image: { caption: 'minha foto' } },
        { from: '5511900000001', id: 'm3', timestamp: '1800000002', type: 'audio' },
        { from: '5511900000001', id: 'm4', timestamp: '1800000003', type: 'interactive', interactive: { button_reply: { title: 'Sim' } } }
      ])
    )
    expect(got.map((m) => m.text)).toEqual(['Oi', '[imagem] minha foto', '[áudio]', 'Sim'])
    expect(got[0]).toEqual({ phoneId: 'P1', from: '5511900000001', name: 'Ana', id: 'm1', at: 1_800_000_000_000, text: 'Oi' })
  })

  it('skips reactions, statuses and anything shaped differently, without failing', () => {
    expect(parse(hook([{ from: '1', id: 'r1', type: 'reaction', reaction: { emoji: '👍' } }]))).toEqual([])
    expect(parse({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P1' }, statuses: [{ id: 'x' }] } }] }] })).toEqual([])
    for (const junk of [null, undefined, 42, 'text', [], {}, { entry: 'x' }, { entry: [null, { changes: 'x' }, { changes: [null, { value: null }] }] }]) expect(parse(junk)).toEqual([])
  })

  it('turns Meta\'s refusals into what to do next', () => {
    expect(metaError(400, { error: { code: 131047 } }).message).toContain('modelo')
    expect(metaError(401, { error: { code: 190 } }).message).toContain('chave')
    expect(metaError(400, { error: { code: 131026 } }).message).toContain('não está no WhatsApp')
    expect(metaError(429, null).message).toContain('devagar')
    expect(metaError(500, { error: { message: 'boom' } }).message).toContain('boom')
  })
})

describe('store', () => {
  let dir: string
  let store: WhatsAppStore
  const T = NOW
  const num = (id: string) => ({ id, name: `Número ${id}`, description: '', kind: 'qr' as const, settings: defaultSettings('qr'), createdAt: 1 })
  const msg = (chat: string, id: string, at: number, agentId?: string) => ({ id, chat, fromMe: !!agentId, text: `m ${id}`, at, ...(agentId ? { agentId } : {}) })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-store-'))
    store = new WhatsAppStore(dir, plainCipher)
    store.addNumber(num('n1'))
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('counts what agents sent today, the new conversations among them, and who was already written to', () => {
    store.upsertChat('n1', { id: 'ana', name: 'Ana', kind: 'contact', inboundAt: T - 5_000 })
    store.upsertChat('n1', { id: 'bia', name: 'Bia', kind: 'contact' })
    store.upsertChat('n1', { id: 'caio', name: 'Caio', kind: 'contact' })
    store.addMessage('n1', msg('ana', 'a1', T - 5_000)) // theirs, not an agent's
    store.addMessage('n1', msg('ana', 'a2', T, 'ag'))
    store.addMessage('n1', { ...msg('bia', 'b1', T, 'ag'), first: true }) // the first message to Bia: a new conversation
    store.addMessage('n1', msg('bia', 'b2', T + 1, 'ag'))
    store.addMessage('n1', msg('caio', 'c1', T - 2 * 86_400_000, 'ag')) // two days ago
    const since = T - 1_000
    expect(store.sentToday('n1', since)).toBe(3)
    expect(store.newToday('n1', since)).toBe(1) // Bia; Ana had written first, Caio was yesterday
    expect(store.contactedToday('n1', 'bia', since)).toBe(true)
    expect(store.contactedToday('n1', 'caio', since)).toBe(false)
    expect(store.sentToday('n1', T + 2)).toBe(0)
  })

  it('counts a day from this computer\'s midnight', () => {
    const start = dayStart(T)
    store.upsertChat('n1', { id: 'x', kind: 'contact' })
    store.addMessage('n1', msg('x', 'm1', start - 1, 'ag'))
    store.addMessage('n1', msg('x', 'm2', start, 'ag'))
    expect(store.sentToday('n1', start)).toBe(1)
  })

  it('keeps a message once, even when it arrives twice', () => {
    expect(store.addMessage('n1', msg('ana', 'm1', T))).toBe(true)
    expect(store.addMessage('n1', msg('ana', 'm1', T))).toBe(false)
    expect(store.messages('n1', 'ana', 10)).toHaveLength(1)
  })

  it('returns the latest messages, oldest first', () => {
    for (let i = 0; i < 5; i++) store.addMessage('n1', msg('ana', `m${i}`, T + i))
    expect(store.messages('n1', 'ana', 3).map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
  })

  it('merges what is known about a conversation: a name is never lost and times only move forward', () => {
    store.upsertChat('n1', { id: 'ana', name: 'Ana Souza', kind: 'contact', lastAt: T, inboundAt: T })
    store.upsertChat('n1', { id: 'ana', kind: 'contact', lastAt: T - 100, softName: '~ana' })
    expect(store.chat('n1', 'ana')).toMatchObject({ name: 'Ana Souza', lastAt: T, inboundAt: T })
    store.upsertChat('n1', { id: 'novo', kind: 'contact', softName: 'Fulano', phone: '5511900000001' })
    expect(store.chat('n1', 'novo')?.name).toBe('Fulano')
    expect(store.chat('n1', 'sem-nome' )).toBeUndefined()
    store.upsertChat('n1', { id: 'sem-nome', kind: 'contact', phone: '5511900000002' })
    expect(store.chat('n1', 'sem-nome')?.name).toBe('5511900000002') // the phone stands in for a missing name
  })

  it('knows which conversations an agent may read', () => {
    store.setAccess('n1', [{ agentId: 'ag', chat: 'ana', level: 'read', send: 'ask' }])
    expect(store.readable('n1', 'ana')).toBe(true)
    expect(store.readable('n1', 'bia')).toBe(false)
    store.setAccess('n1', [{ agentId: 'ag', chat: ALL_CHATS, level: 'read', send: 'ask' }])
    expect(store.readable('n1', 'bia')).toBe(true)
    expect(store.hasAgent('ag')).toBe(true)
    store.dropAgent('ag')
    expect(store.hasAgent('ag')).toBe(false)
    expect(store.readable('n1', 'bia')).toBe(false)
  })

  it('seals values and gives them back; undefined erases one', async () => {
    await store.authSet('n1', [['creds', '{"a":1}'], ['session:x', 'abc']])
    expect(await store.authGet('n1', 'creds')).toBe('{"a":1}')
    await store.authSet('n1', [['session:x', undefined]])
    expect(await store.authGet('n1', 'session:x')).toBeUndefined()
    expect(store.hasAuth('n1', 'creds')).toBe(true)
  })

  it('deletes everything of a number with it, and nothing of the others', async () => {
    store.addNumber(num('n2'))
    for (const id of ['n1', 'n2']) {
      store.upsertChat(id, { id: 'ana', name: 'Ana', kind: 'contact' })
      store.setAccess(id, [{ agentId: 'ag', chat: 'ana', level: 'reply', send: 'ask' }])
      store.addMessage(id, msg('ana', 'm1', T, 'ag'))
      await store.authSet(id, [['creds', 'x']])
    }
    await store.authSet('', [['verify_token', 'tok']])
    store.removeNumber('n1')
    expect(store.number('n1')).toBeUndefined()
    expect(store.chats('n1')).toEqual([])
    expect(store.access('n1')).toEqual([])
    expect(store.messages('n1', 'ana', 10)).toEqual([])
    expect(store.hasAuth('n1', 'creds')).toBe(false)
    expect(store.number('n2')).toBeDefined()
    expect(store.chats('n2')).toHaveLength(1)
    expect(store.sentToday('n2', 0)).toBe(1)
    expect(await store.authGet('', 'verify_token')).toBe('tok')
  })

  it('drops messages older than 90 days when it opens again', () => {
    store.addMessage('n1', msg('ana', 'old', Date.now() - 91 * 86_400_000))
    store.addMessage('n1', msg('ana', 'new', Date.now() - 1_000))
    store.close()
    store = new WhatsAppStore(dir, plainCipher)
    expect(store.messages('n1', 'ana', 10).map((m) => m.id)).toEqual(['new'])
  })

  it('reads a number\'s settings back inside the limits even if the row was edited by hand', () => {
    store.updateNumber('n1', { settings: { ...defaultSettings('qr'), dailyLimit: 5 } })
    expect(store.number('n1')?.settings.dailyLimit).toBe(5)
  })
})

describe('WhatsApp service: bad input is a sentence, never a crash', () => {
  let dir: string
  let wa: WhatsApp
  let changes: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-service-'))
    changes = 0
    wa = new WhatsApp({ dir, cipher: plainCipher, agents: () => [{ id: 'ag', name: 'Vendas' }], changed: () => void changes++, wake: () => {} })
  })
  afterEach(() => {
    wa.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a number without a name, a name too long, and an unknown way to link', async () => {
    await expect(wa.add({ name: '  ', description: '', kind: 'qr' })).rejects.toThrow('Escreva o nome')
    await expect(wa.add({ name: 'x'.repeat(200), description: '', kind: 'qr' })).rejects.toThrow('passa de')
    await expect(wa.add({ name: 'Ok', description: '', kind: 'sms' as never })).rejects.toThrow('Escolha como ligar')
  })

  it('says the official API needs a server with https', async () => {
    await expect(wa.add({ name: 'Oficial', description: '', kind: 'cloud', cloud: { phoneId: '1', wabaId: '2', token: 't', appSecret: 's' } })).rejects.toThrow('https')
    expect((await wa.state()).cloud).toMatchObject({ available: false })
  })

  it('answers every call about a number that does not exist with the same sentence', async () => {
    const gone = 'não existe mais'
    await expect(wa.update('nope', { name: 'x' })).rejects.toThrow(gone)
    await expect(wa.remove('nope')).rejects.toThrow(gone)
    await expect(wa.connect('nope')).rejects.toThrow(gone)
    await expect(wa.disconnect('nope')).rejects.toThrow(gone)
    await expect(wa.chats('nope')).rejects.toThrow(gone)
    await expect(wa.setAccess('nope', [])).rejects.toThrow(gone)
    await expect(wa.templates('nope')).rejects.toThrow(gone)
    await expect(wa.update(undefined as never, {})).rejects.toThrow(gone)
  })

  it('answers Meta\'s webhook without ever throwing', async () => {
    const state = await wa.state()
    expect(state.cloud.available).toBe(false)
    expect((await wa.webhook({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }, body: '' })).status).toBe(403)
    expect((await wa.webhook({ method: 'POST', query: {}, body: '{}', signature: 'sha256=00' })).status).toBe(401)
    expect((await wa.webhook({ method: 'POST', query: {}, body: 'not json' })).status).toBe(401)
    expect((await wa.webhook({ method: 'POST', query: undefined as never, body: undefined as never })).status).toBe(401)
  })

  it('tells an agent with no number that nothing is open to it, and refuses the rest in words', async () => {
    const agent = { id: 'ag', name: 'Vendas' }
    expect(wa.has('ag')).toBe(false)
    const none = await wa.call(agent, 'whatsapp_conversas', {})
    expect(none.isError).toBeUndefined()
    expect(none.text).toContain('Nenhum número')
    const read = await wa.call(agent, 'whatsapp_ler', { numero: 'x', conversa: 'y' })
    expect(read).toMatchObject({ isError: true })
    const send = await wa.call(agent, 'whatsapp_enviar', { numero: 'x', conversa: 'y', texto: 'oi' })
    expect(send).toMatchObject({ isError: true })
    expect(send.approval).toBeUndefined()
    expect((await wa.call(agent, 'whatsapp_enviar', undefined as never)).isError).toBe(true)
    expect((await wa.approved('ag', { numero_id: 'nope', conversa_id: 'x', texto: 'oi' })).ok).toBe(false)
  })
})
