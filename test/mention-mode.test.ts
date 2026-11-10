// Mention mode: an agent that stays in a channel, reads everything and answers only when it is
// mentioned — by a person, or by another agent. Over the real core, with fake engines.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Agent, Conversation, Message } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

let core: TestCore
let ana: Client
const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)

type Snap = { agents: Agent[]; conversations: Conversation[]; messages: Message[] }

const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const snap = (): Promise<Snap> => ana.call<Snap>('snapshot')
const agentOf = async (handle: string): Promise<Agent> => (await snap()).agents.find((a) => a.handle === handle)!
const conv = async (id: string): Promise<Conversation> => (await snap()).conversations.find((c) => c.id === id)!
const said = async (conversationId: string): Promise<Message[]> => (await snap()).messages.filter((m) => m.conversationId === conversationId)
const replies = async (conversationId: string): Promise<Message[]> =>
  (await said(conversationId)).filter((m) => m.author.kind === 'agent' && m.run?.status === 'done')
const from = (msgs: Message[], a: Agent): Message[] => msgs.filter((m) => m.author.kind === 'agent' && m.author.id === a.id)
// Waits for `n` more finished replies in the conversation than there were.
const answers = async (conversationId: string, n = 1): Promise<Message[]> => {
  const before = (await replies(conversationId)).length
  await until(async () => (await replies(conversationId)).length >= before + n)
  return replies(conversationId)
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
})

// The seed's channel with two agents (its name follows the workspace's language: found by its members).
let eng = ''
beforeAll(async () => {
  const s = await snap()
  eng = s.conversations.find((c) => c.kind === 'channel' && c.members.length === 2)!.id
})

describe('a channel with an agent in mention mode', () => {
  it('keeps the mode on the channel, and an agent taken out of it leaves the mode too', async () => {
    const [lia, theo, nina] = [await agentOf('lia'), await agentOf('theo'), await agentOf('nina')]
    await ana.call('setChannelMembers', { id: eng, agentIds: [lia.id, theo.id], mentionOnly: [lia.id] })
    expect((await conv(eng)).mentionOnly).toEqual([lia.id])

    // A caller that only says who is in it (a proposal adding an agent) doesn't wipe the mode.
    await ana.call('setChannelMembers', { id: eng, agentIds: [lia.id, theo.id, nina.id] })
    expect((await conv(eng)).mentionOnly).toEqual([lia.id])

    // An agent out of the channel can't stay in mention mode, and neither can one who isn't in it.
    await ana.call('setChannelMembers', { id: eng, agentIds: [theo.id], mentionOnly: [theo.id, lia.id] })
    expect((await conv(eng)).mentionOnly).toEqual([theo.id])
    expect((await conv(eng)).members).toEqual([theo.id])

    await ana.call('setChannelMembers', { id: eng, agentIds: [lia.id, theo.id], mentionOnly: [lia.id] })
    expect((await conv(eng)).mentionOnly).toEqual([lia.id])
  })

  it('is never the one picked for a message nobody was mentioned in', async () => {
    const [lia, theo] = [await agentOf('lia'), await agentOf('theo')]
    await ana.call('sendMessage', { conversationId: eng, text: 'o build quebrou ontem, alguém olha?' })
    await answers(eng)
    const done = await replies(eng)
    expect(from(done, theo)).toHaveLength(1)
    expect(from(done, lia)).toHaveLength(0) // Lia in mention mode: not even offered to the router
  })

  it('answers when a person mentions it', async () => {
    const lia = await agentOf('lia')
    await ana.call('sendMessage', { conversationId: eng, text: '@lia e o build, dá uma olhada?' })
    await answers(eng)
    expect(from(await replies(eng), lia)).toHaveLength(1)
  })

  it('answers when another agent mentions it', async () => {
    const [lia, theo] = [await agentOf('lia'), await agentOf('theo')]
    // Lia answers the room again, Theo waits to be called.
    await ana.call('setChannelMembers', { id: eng, agentIds: [lia.id, theo.id], mentionOnly: [theo.id] })
    const before = { lia: from(await replies(eng), lia).length, theo: from(await replies(eng), theo).length }
    await ana.call('sendMessage', { conversationId: eng, text: 'Peça pro theo revisar a arquitetura' })
    await answers(eng, 2)
    const done = await replies(eng)
    expect(from(done, lia).at(-1)!.text).toContain('@theo')
    expect(from(done, lia)).toHaveLength(before.lia + 1)
    expect(from(done, theo)).toHaveLength(before.theo + 1) // woken by another agent's mention
  })

  it("doesn't wake for an agent's thank-you that mentions it", async () => {
    const [lia, theo] = [await agentOf('lia'), await agentOf('theo')]
    const before = from(await replies(eng), theo).length
    await ana.call('sendMessage', { conversationId: eng, text: 'Agradeça ao theo pelo trabalho' })
    await answers(eng)
    await sleep(600) // the hand-off screen reads the reply once it has landed
    const done = await replies(eng)
    expect(from(done, lia).at(-1)!.text).toContain('@theo')
    expect(from(done, theo)).toHaveLength(before) // no new one: thanks isn't an ask
  })
})

describe('a channel where everyone is in mention mode', () => {
  it('says once why nothing answers, and answers as soon as someone is mentioned', async () => {
    // A channel of its own with a single agent: the case where "the only agent answers everything".
    await ana.call('createChannel', { name: 'sozinho' })
    const theo = await agentOf('theo')
    const one = (await snap()).conversations.find((c) => c.kind === 'channel' && c.name === 'sozinho')!.id
    await ana.call('setChannelMembers', { id: one, agentIds: [theo.id], mentionOnly: [theo.id] })
    expect((await conv(one)).mentionOnly).toEqual([theo.id])
    const hint = async (): Promise<Message[]> => (await said(one)).filter((m) => m.author.kind === 'system' && /modo menção|mention mode/.test(m.text))

    await ana.call('sendMessage', { conversationId: one, text: 'quanto vendemos ontem?' })
    await until(async () => (await hint()).length === 1)
    expect(await replies(one)).toHaveLength(0) // the only agent in the room waits to be called

    await ana.call('sendMessage', { conversationId: one, text: 'e na semana?' })
    await sleep(400)
    expect(await hint()).toHaveLength(1) // not repeated on the next message

    await ana.call('sendMessage', { conversationId: one, text: '@theo e na semana?' })
    await answers(one)
    expect(from(await replies(one), theo)).toHaveLength(1)

    // Back to normal: the agent answers everything again (the screen sends the empty list to clear it).
    await ana.call('setChannelMembers', { id: one, agentIds: [theo.id], mentionOnly: [] })
    expect((await conv(one)).mentionOnly).toBeUndefined()
    await ana.call('sendMessage', { conversationId: one, text: 'e no mês?' })
    await answers(one)
    expect(from(await replies(one), theo)).toHaveLength(2)
  })

  it('left no unhandled crash behind', () => expect(crashes).toEqual([]))
})
