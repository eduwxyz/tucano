// A person has several conversations with the Tuca, one per request: "Nova conversa" starts another and
// keeps the rest, each is named after what was first asked there, and every way to him opens the one
// last talked in. Over the real core with fake engines; the describes build on each other.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)
const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
type Snap = { agents: Agent[]; conversations: Conversation[]; messages: Message[] }
type Tuca = { agentId: string; conversationId: string }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const snap = (c: Client = ana): Promise<Snap> => c.call<Snap>('snapshot')
const conv = async (id: string, c: Client = ana): Promise<Conversation | undefined> => (await snap(c)).conversations.find((x) => x.id === id)
const withTuca = async (c: Client = ana): Promise<Conversation[]> => {
  const s = await snap(c)
  const tuca = s.agents.find((a) => a.kind === 'tuca')!
  return s.conversations.filter((x) => x.kind === 'dm' && x.name === tuca.id)
}
async function say(c: Client, id: string, text: string): Promise<Message> {
  const before = new Set((await snap(c)).messages.filter((m) => m.conversationId === id).map((m) => m.id))
  await c.call('sendMessage', { conversationId: id, text })
  let found: Message | undefined
  await until(async () => {
    found = (await snap(c)).messages.find((m) => m.conversationId === id && !before.has(m.id) && m.author.kind === 'agent' && m.run?.status === 'done')
    return !!found
  })
  return found!
}

beforeAll(async () => {
  process.on('unhandledRejection', onCrash)
  process.on('uncaughtException', onCrash)
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
}, 30_000)
afterAll(() => {
  process.off('unhandledRejection', onCrash)
  process.off('uncaughtException', onCrash)
  vi.useRealTimers()
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
  expect(crashes).toEqual([])
})

let first: Tuca
let second: Tuca
describe('several conversations with the Tuca', () => {
  it('the first one is made with his hello, and coming back opens the same', async () => {
    first = await ana.call<Tuca>('ensureTuca', {})
    expect(await withTuca()).toHaveLength(1)
    expect((await ana.call<Tuca>('ensureTuca', {})).conversationId).toBe(first.conversationId)
    const s = await snap()
    expect(s.messages.filter((m) => m.conversationId === first.conversationId).map((m) => m.author.kind)).toEqual(['agent'])
    expect((await conv(first.conversationId))!.title).toBeUndefined()
  })

  it('"Nova conversa" on one nobody wrote in yet is that same one: empty ones do not pile up', async () => {
    expect((await ana.call<Tuca>('ensureTuca', { fresh: true })).conversationId).toBe(first.conversationId)
    expect(await withTuca()).toHaveLength(1)
  })

  it('is named after what was first asked there', async () => {
    await say(ana, first.conversationId, 'Oi Tuca, quero planejar a semana do time de vendas')
    // Its own words at once, then the title the (fake) cheap model gives the request: shorter.
    await until(async () => (await conv(first.conversationId))!.title === 'Quero planejar a semana do time de…')
    // What is said after doesn't rename it.
    await say(ana, first.conversationId, 'e o segundo passo?')
    expect((await conv(first.conversationId))!.title).toBe('Quero planejar a semana do time de…')
  })

  it('"Nova conversa" starts another and keeps the first, with everything said there', async () => {
    second = await ana.call<Tuca>('ensureTuca', { fresh: true })
    expect(second.conversationId).not.toBe(first.conversationId)
    expect((await withTuca()).map((c) => c.id).sort()).toEqual([first.conversationId, second.conversationId].sort())
    const s = await snap()
    expect(s.messages.filter((m) => m.conversationId === first.conversationId && m.author.kind === 'person')).toHaveLength(2)
    expect(s.messages.filter((m) => m.conversationId === second.conversationId).map((m) => m.author.kind)).toEqual(['agent'])
    await say(ana, second.conversationId, 'quero alguém pro suporte')
    await until(async () => (await conv(second.conversationId))!.title === 'Quero alguém pro suporte')
  })

  it('every way to him opens the one last talked in', async () => {
    expect((await ana.call<Tuca>('ensureTuca', {})).conversationId).toBe(second.conversationId)
    expect(await ana.call<string>('openDm', { agentId: second.agentId })).toBe(second.conversationId)
    await say(ana, first.conversationId, 'voltando ao plano da semana')
    expect((await ana.call<Tuca>('ensureTuca', {})).conversationId).toBe(first.conversationId)
    expect(await ana.call<string>('openDm', { agentId: first.agentId })).toBe(first.conversationId)
    const both = await withTuca()
    expect(both.every((c) => (c.lastAt ?? 0) >= (c.createdAt ?? 0) && !!c.createdAt)).toBe(true)
  })

  it('its person names it, and an empty name goes back to what was first asked', async () => {
    await ana.call('setConversationTitle', { id: first.conversationId, title: '  Plano de vendas  ' })
    expect((await conv(first.conversationId))!.title).toBe('Plano de vendas')
    await ana.call('setConversationTitle', { id: first.conversationId, title: '' })
    expect((await conv(first.conversationId))!.title).toBe('Quero planejar a semana do time de…')
    // Only conversations with him take a title.
    const rafa = (await snap()).agents.find((a) => a.name === 'Rafa')
    if (rafa) expect(await err(ana.call('setConversationTitle', { id: await ana.call<string>('openDm', { agentId: rafa.id }), title: 'x' }))).toContain('Tuca')
  })

  it('deleting one leaves the other, and he opens what is left', async () => {
    await ana.call('deleteConversation', { id: first.conversationId })
    expect((await withTuca()).map((c) => c.id)).toEqual([second.conversationId])
    expect((await ana.call<Tuca>('ensureTuca', {})).conversationId).toBe(second.conversationId)
  })

  it("each person has their own: someone else's are not theirs to see, open or name", async () => {
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
    const j = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
    const bia = core.connect(j.data.person!.id)
    const hers = await bia.call<Tuca>('ensureTuca', {})
    expect(hers.conversationId).not.toBe(second.conversationId)
    expect((await withTuca(bia)).map((c) => c.id)).toEqual([hers.conversationId])
    expect(await err(bia.call('setConversationTitle', { id: second.conversationId, title: 'x' }))).not.toBe('ok')
    expect((await conv(second.conversationId))!.title).toBe('Quero alguém pro suporte')
    // And hers is hers: "Nova conversa" for her makes nothing in the owner's list.
    await say(bia, hers.conversationId, 'quero planejar o mês')
    const more = await bia.call<Tuca>('ensureTuca', { fresh: true })
    expect((await withTuca(bia)).map((c) => c.id).sort()).toEqual([hers.conversationId, more.conversationId].sort())
    expect((await withTuca()).map((c) => c.id)).toEqual([second.conversationId])
  })
})
