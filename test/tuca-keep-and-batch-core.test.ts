// The Tuca over the real core (fake engines): his conversation is kept when the person leaves his
// screen and comes back, "Nova conversa" starts another, each person has their own; and a reply with
// several proposals is applied card by card or all at once, in order, one failing not stopping the rest.
// One core for the whole file: the describes run in order and build on each other.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Inbox, Message, Person, ProposalsResult, Routine } from '../src/shared/types'
import { proposalsOf } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
let bia: Client // a member
const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)
const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
type Snap = { agents: Agent[]; conversations: Conversation[]; messages: Message[]; routines: Routine[]; inbox: Inbox }
type Tuca = { agentId: string; conversationId: string }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const inConv = async (c: Client, id: string): Promise<Message[]> => (await c.call<Snap>('snapshot')).messages.filter((m) => m.conversationId === id)
// The Tuca's reply to what was just said there, once it's done.
async function reply(c: Client, conv: string, said: string): Promise<Message> {
  const before = new Set((await inConv(c, conv)).map((m) => m.id))
  await c.call('sendMessage', { conversationId: conv, text: said })
  let found: Message | undefined
  await until(async () => {
    found = (await inConv(c, conv)).find((m) => !before.has(m.id) && m.author.kind === 'agent' && m.run?.status === 'done')
    return !!found
  }).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify((await inConv(c, conv)).map((m) => [m.author.kind, m.text.slice(0, 40), m.run?.status]))}`)
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
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
  expect(crashes).toEqual([])
})

let first: Tuca
describe('A. leaving the Tuca and coming back keeps the conversation', () => {
  it('opening him again is the same conversation, with what was said and his replies', async () => {
    first = await ana.call<Tuca>('ensureTuca', {})
    const asked = await reply(ana, first.conversationId, 'quero planejar a semana do time')
    expect(asked.text).toContain('Que tipo de tarefa')
    // Leaving the screen and opening it again, from any way in: the same call, the same conversation.
    const again = await ana.call<Tuca>('ensureTuca', { modelId: 'sonnet' })
    expect(again.conversationId).toBe(first.conversationId)
    const kept = await inConv(ana, first.conversationId)
    expect(kept.map((m) => m.author.kind)).toEqual(['agent', 'person', 'agent']) // his hello, what she said, his question
  })

  it('a card stays with its state', async () => {
    const card = await reply(ana, first.conversationId, 'quero alguém pro suporte')
    expect(card.run?.agentDraft?.name).toBe('Rafa')
    await ana.call('settleDraft', { messageId: card.id })
    await ana.call<Tuca>('ensureTuca', {})
    expect((await inConv(ana, first.conversationId)).find((m) => m.id === card.id)?.run?.agentDraft?.state).toBe('dismissed')
  })

  it('"Nova conversa" starts another on purpose: the old one goes, the new one has only his hello', async () => {
    const fresh = await ana.call<Tuca>('ensureTuca', { fresh: true })
    expect(fresh.conversationId).not.toBe(first.conversationId)
    const snap = await ana.call<Snap>('snapshot')
    expect(snap.conversations.some((c) => c.id === first.conversationId)).toBe(false)
    expect(snap.messages.filter((m) => m.conversationId === fresh.conversationId).map((m) => m.author.kind)).toEqual(['agent'])
    // And from then on, that's the one he opens.
    expect((await ana.call<Tuca>('ensureTuca', {})).conversationId).toBe(fresh.conversationId)
    first = fresh
  })
})

let migration: Message
describe('B. several proposals in one reply', () => {
  it('a migration comes as one reply: a new agent and five cards, nothing changed yet', async () => {
    migration = await reply(ana, first.conversationId, 'migra o time pro limite novo')
    expect(migration.run?.agentDraft?.name).toBe('Léo')
    const ps = proposalsOf(migration.run)
    expect(ps.map((p) => p.kind)).toEqual(['agent', 'agent', 'agent', 'routine', 'channel'])
    expect(ps[3]).toMatchObject({ needs: ['Léo'], routine: { agentId: '' } })
    expect(ps[4]).toMatchObject({ name: 'financeiro', needs: ['Léo'] })
    const snap = await ana.call<Snap>('snapshot')
    expect(snap.agents.filter((a) => a.limit === 345_000)).toEqual([])
    expect(snap.agents.some((a) => a.name === 'Léo')).toBe(false)
  })

  it('one card applies on its own, by its index', async () => {
    await ana.call('applyProposal', { messageId: migration.id, index: 1 })
    const snap = await ana.call<Snap>('snapshot')
    expect(snap.agents.find((a) => a.handle === 'theo')?.limit).toBe(345_000)
    expect(snap.agents.find((a) => a.handle === 'lia')?.limit).not.toBe(345_000)
    const ps = proposalsOf(snap.messages.find((m) => m.id === migration.id)?.run)
    expect(ps.map((p) => p.state ?? null)).toEqual([null, 'applied', null, null, null])
    expect(await err(ana.call('applyProposal', { messageId: migration.id, index: 1 }))).toContain('já foi aplicada')
  })

  it('a card that needs an agent of the same reply says so, until that agent exists', async () => {
    expect(await err(ana.call('applyProposal', { messageId: migration.id, index: 3 }))).toContain('Antes, crie Léo')
    const ps = proposalsOf((await inConv(ana, first.conversationId)).find((m) => m.id === migration.id)?.run)
    expect(ps[3]).toMatchObject({ error: expect.stringContaining('crie Léo') })
    expect(ps[3]!.state).toBeUndefined()
  })

  it('"Aplicar todos": the new agent first, then the rest; one that fails is told and the others go on', async () => {
    // Someone made #financeiro in the meantime: that card can't be applied any more.
    await ana.call('createChannel', { name: 'financeiro' })
    const r = await ana.call<ProposalsResult>('applyProposals', { messageId: migration.id, draft: true })
    expect(r.draft?.agentId).toBeTruthy()
    expect(r.applied.map((a) => a.index)).toEqual([0, 2, 3]) // the changes, then the routine (after Léo)
    expect(r.failed).toEqual([{ index: 4, error: expect.stringContaining('#financeiro') }])
    expect(r.forwarded).toEqual([])
    const snap = await ana.call<Snap>('snapshot')
    expect(snap.agents.filter((a) => ['lia', 'theo', 'nina'].includes(a.handle)).map((a) => a.limit)).toEqual([345_000, 345_000, 345_000])
    const leo = snap.agents.find((a) => a.name === 'Léo')!
    const routine = snap.routines.find((x) => x.name === 'Fechamento do dia')!
    expect(routine.agentId).toBe(leo.id)
    expect(snap.conversations.find((c) => c.id === routine.conversationId)).toMatchObject({ kind: 'dm', name: leo.id })
    const m = snap.messages.find((x) => x.id === migration.id)!
    expect(m.run?.agentDraft).toMatchObject({ state: 'created', agentId: leo.id })
    expect(proposalsOf(m.run).map((p) => p.state ?? p.error?.slice(0, 15))).toEqual(['applied', 'applied', 'applied', 'applied', 'Já existe o can'])
    // Nothing left to do twice: applying all again touches only what's still open (the failed one).
    const again = await ana.call<ProposalsResult>('applyProposals', { messageId: migration.id, draft: true })
    expect(again.applied).toEqual([])
    expect(again.failed.map((f) => f.index)).toEqual([4])
  })

  it('"Descartar todos" settles what is left', async () => {
    await ana.call('dismissProposals', { messageId: migration.id, draft: true })
    const m = (await inConv(ana, first.conversationId)).find((x) => x.id === migration.id)!
    expect(proposalsOf(m.run)[4]!.state).toBe('dismissed')
  })
})

describe('C. with a team: each person has their own Tuca, and the admins apply agents', () => {
  let mine: Tuca
  it("Bia's Tuca is her own conversation, and Ana's stays where it was", async () => {
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
    const j = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
    bia = core.connect(j.data.person!.id)
    mine = await bia.call<Tuca>('ensureTuca', {})
    expect(mine.conversationId).not.toBe(first.conversationId)
    expect((await ana.call<Tuca>('ensureTuca', {})).conversationId).toBe(first.conversationId)
    // Neither reaches the other's.
    expect((await bia.call<Snap>('snapshot')).conversations.some((c) => c.id === first.conversationId)).toBe(false)
    expect(await err(bia.call('applyProposals', { messageId: migration.id }))).not.toBe('ok')
  })

  it("a member's \"Aplicar todos\" sends the agents' cards to the admins, once, and applies what's hers", async () => {
    // The limits back where they were, so there's something to change again.
    for (const handle of ['lia', 'theo', 'nina']) {
      const snap = await ana.call<Snap>('snapshot')
      const a = snap.agents.find((x) => x.handle === handle)!
      await ana.call('saveAgent', { agent: { ...a, limit: 2_000_000 }, channelIds: snap.conversations.filter((c) => c.kind === 'channel' && c.members.includes(a.id)).map((c) => c.id) })
    }
    const m = await reply(bia, mine.conversationId, 'migra pro limite de 345 mil')
    const ps = proposalsOf(m.run)
    expect(ps.slice(0, 3).map((p) => p.kind)).toEqual(['agent', 'agent', 'agent'])
    const r = await bia.call<ProposalsResult>('applyProposals', { messageId: m.id, draft: true })
    expect(r.forwarded).toEqual([0, 1, 2])
    expect(r.draft?.error).toContain('admin')
    expect((await ana.call<Snap>('snapshot')).agents.find((a) => a.handle === 'lia')?.limit).toBe(2_000_000)
    // Ana gets each card in her inbox, by its index, and applies one from there.
    const inbox = await ana.call<Inbox>('inbox')
    const sent = (inbox.proposals ?? []).filter((p) => p.id === m.id)
    expect(sent.map((p) => p.index ?? 0).sort()).toEqual([0, 1, 2])
    await ana.call('applyProposal', { messageId: m.id, index: 0 })
    expect((await ana.call<Snap>('snapshot')).agents.find((a) => a.handle === 'lia')?.limit).toBe(345_000)
    expect(((await ana.call<Inbox>('inbox')).proposals ?? []).filter((p) => p.id === m.id).map((p) => p.index ?? 0).sort()).toEqual([1, 2])
  })
})
