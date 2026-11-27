// The Tuca's changes inside the app, applied by themselves when his reply ends (Settings.tucaApplyNow,
// on by default), over the real core with fake engines: the card becomes a receipt with Desfazer, and
// Desfazer puts things back as they were (what was made goes, what was changed comes back, a routine
// it added is removed), refusing with why when something changed since or its time is up. What grants
// access (connectors, the month's limit) stays a card; a member gets for herself only what her click
// would apply; and turned off, everything waits for a click as before.
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
const snap = (c: Client = ana): Promise<Snap> => c.call<Snap>('snapshot')
const msg = async (id: string, c: Client = ana): Promise<Message> => (await snap(c)).messages.find((m) => m.id === id)!
const inConv = async (c: Client, id: string): Promise<Message[]> => (await snap(c)).messages.filter((m) => m.conversationId === id)
const agentNamed = async (name: string): Promise<Agent | undefined> => (await snap()).agents.find((a) => a.name === name)
// The Tuca's reply to what was just said there, once it's done (and what it proposed applied).
async function reply(c: Client, conv: string, said: string): Promise<Message> {
  const before = new Set((await inConv(c, conv)).map((m) => m.id))
  await c.call('sendMessage', { conversationId: conv, text: said })
  let found: Message | undefined
  await until(async () => {
    found = (await inConv(c, conv)).find((m) => !before.has(m.id) && m.author.kind === 'agent' && m.run?.status === 'done')
    return !!found
  }).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify((await inConv(c, conv)).map((m) => [m.author.kind, m.text.slice(0, 40), m.run?.status, m.run?.error, m.run?.errorDetail]))}`)
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

let tuca: Tuca
describe('A. a new agent: made when his reply ends, and taken back with Desfazer', () => {
  let card: Message
  it('is made at once, without a click, and its card is a receipt that can be undone', async () => {
    tuca = await ana.call<Tuca>('ensureTuca', {})
    // A first exchange with no proposal, as a person starts (and the core is all up by then).
    expect((await reply(ana, tuca.conversationId, 'quero planejar a semana do time')).text).toContain('Que tipo de tarefa')
    card = await reply(ana, tuca.conversationId, 'quero alguém pro suporte')
    expect(card.run?.agentDraft).toMatchObject({ name: 'Rafa', state: 'created', auto: true, undo: { until: expect.any(Number) } })
    const rafa = (await agentNamed('Rafa'))!
    expect(card.run!.agentDraft!.agentId).toBe(rafa.id)
    expect((await snap()).conversations.some((c) => c.kind === 'dm' && c.name === rafa.id)).toBe(true)
    // He was told it goes in by itself, and says what he did instead of asking.
    expect(card.text).toContain('Montei o Rafa')
  })

  it('Desfazer takes it back: the agent and its DM are gone, and the card says so', async () => {
    const rafa = (await agentNamed('Rafa'))!
    await ana.call('undoProposal', { messageId: card.id, draft: true })
    const s = await snap()
    expect(s.agents.some((a) => a.id === rafa.id)).toBe(false)
    expect(s.conversations.some((c) => c.kind === 'dm' && c.name === rafa.id)).toBe(false)
    expect((await msg(card.id)).run?.agentDraft?.state).toBe('undone')
    expect(ana.events.some((e) => e.type === 'agent_removed' && e.id === rafa.id)).toBe(true)
    // Twice is once.
    expect(await err(ana.call('undoProposal', { messageId: card.id, draft: true }))).toBe('ok')
  })

  it('is refused, saying why, once the agent started working', async () => {
    const again = await reply(ana, tuca.conversationId, 'quero alguém pro suporte de novo')
    const rafa = (await agentNamed('Rafa'))!
    const dm = (await snap()).conversations.find((c) => c.kind === 'dm' && c.name === rafa.id)!
    await reply(ana, dm.id, 'oi, tudo bem?')
    expect(await err(ana.call('undoProposal', { messageId: again.id, draft: true }))).toContain('já começou a trabalhar')
    expect(await agentNamed('Rafa')).toBeTruthy()
    expect((await msg(again.id)).run?.agentDraft?.state).toBe('created')
  })
})

let migration: Message
describe('B. several changes at once: what is inside the app applies, what spends money stays a card', () => {
  it('makes the agent, its routine and its channel; the new limits wait on their cards', async () => {
    migration = await reply(ana, tuca.conversationId, 'migra o time pro limite novo')
    const s = await snap()
    const leo = s.agents.find((a) => a.name === 'Léo')!
    expect(migration.run?.agentDraft).toMatchObject({ state: 'created', agentId: leo.id, auto: true })
    const ps = proposalsOf(migration.run)
    expect(ps.map((p) => p.state ?? null)).toEqual([null, null, null, 'applied', 'applied'])
    expect(ps.slice(3).every((p) => p.auto && p.undo)).toBe(true)
    // The limits: untouched until someone confirms them.
    expect(s.agents.filter((a) => ['lia', 'theo', 'nina'].includes(a.handle)).map((a) => a.limit)).not.toContain(345_000)
    const routine = s.routines.find((r) => r.name === 'Fechamento do dia')!
    expect(routine.agentId).toBe(leo.id)
    const channel = s.conversations.find((c) => c.kind === 'channel' && c.name === 'financeiro')!
    expect(channel.members).toEqual(expect.arrayContaining([leo.id, s.agents.find((a) => a.handle === 'nina')!.id]))
    // A limit card still applies by clicking, as before.
    await ana.call('applyProposal', { messageId: migration.id, index: 0 })
    expect((await snap()).agents.find((a) => a.handle === 'lia')?.limit).toBe(345_000)
  })

  it('Desfazer on the routine removes just the routine', async () => {
    await ana.call('undoProposal', { messageId: migration.id, index: 3 })
    const s = await snap()
    expect(s.routines.some((r) => r.name === 'Fechamento do dia')).toBe(false)
    expect(s.agents.some((a) => a.name === 'Léo')).toBe(true)
    expect(proposalsOf((await msg(migration.id)).run)[3]!.state).toBe('undone')
  })

  it('Desfazer on the agent takes back what was made for it in that reply too (its channel)', async () => {
    await ana.call('undoProposal', { messageId: migration.id, draft: true })
    const s = await snap()
    expect(s.agents.some((a) => a.name === 'Léo')).toBe(false)
    expect(s.conversations.some((c) => c.kind === 'channel' && c.name === 'financeiro')).toBe(false)
    const m = await msg(migration.id)
    expect(m.run?.agentDraft?.state).toBe('undone')
    expect(proposalsOf(m.run).map((p) => p.state ?? null)).toEqual(['applied', null, null, 'undone', 'undone'])
  })
})

describe('C. a change to an agent: the part inside the app applies, the limit is split off; Desfazer restores it', () => {
  let m: Message
  it('raises the effort now and leaves the new limit on a card of its own', async () => {
    const nina = (await snap()).agents.find((a) => a.handle === 'nina')!
    m = await reply(ana, tuca.conversationId, 'deixa a nina mais esperta')
    const ps = proposalsOf(m.run)
    expect(ps.map((p) => [p.kind, p.state ?? null])).toEqual([['agent', 'applied'], ['agent', null]])
    expect(ps[0]).toMatchObject({ changes: { effort: 'high' }, before: { effort: nina.effort }, auto: true })
    expect(ps[1]).toMatchObject({ agentId: nina.id, changes: { limit: 500_000 } })
    const now = (await snap()).agents.find((a) => a.handle === 'nina')!
    expect(now.effort).toBe('high')
    expect(now.limit).toBe(nina.limit)
  })

  it('is refused while someone changed that field since, and restores it once it is as applied again', async () => {
    const was = proposalsOf(m.run)[0]!.undo!.prior!.effort
    const nina = (await snap()).agents.find((a) => a.handle === 'nina')!
    const channelIds = (await snap()).conversations.filter((c) => c.kind === 'channel' && c.members.includes(nina.id)).map((c) => c.id)
    await ana.call('saveAgent', { agent: { ...nina, effort: 'low' }, channelIds })
    expect(await err(ana.call('undoProposal', { messageId: m.id, index: 0 }))).toContain('esforço de Nina')
    expect((await snap()).agents.find((a) => a.handle === 'nina')?.effort).toBe('low') // the later change stays
    await ana.call('saveAgent', { agent: { ...nina, effort: 'high' }, channelIds })
    await ana.call('undoProposal', { messageId: m.id, index: 0 })
    expect((await snap()).agents.find((a) => a.handle === 'nina')?.effort).toBe(was)
    expect(proposalsOf((await msg(m.id)).run).map((p) => p.state ?? null)).toEqual(['undone', null])
  })
})

// Access asked for on a card (here a browser; a computer and folders go the same way): it
// never applies by itself, and the person's click turns it on.
describe('C2. a browser asked on a card waits for the click, and the click turns it on', () => {
  it('stays a card, then applies, then Desfazer turns it off again', async () => {
    m2 = await reply(ana, tuca.conversationId, 'a nina precisa de navegador')
    const ps = proposalsOf(m2.run)
    expect(ps.map((p) => [p.kind, p.state ?? null])).toEqual([['agent', null]])
    expect(ps[0]).toMatchObject({ changes: { browser: true } })
    expect((await snap()).agents.find((a) => a.handle === 'nina')?.browser).toBeFalsy()
    await ana.call('applyProposal', { messageId: m2.id, index: 0 })
    expect((await snap()).agents.find((a) => a.handle === 'nina')?.browser).toBe(true)
    await ana.call('undoProposal', { messageId: m2.id, index: 0 })
    expect((await snap()).agents.find((a) => a.handle === 'nina')?.browser).toBeFalsy()
  })
})
let m2: Message

describe('D. a team with a connector: the team is made, the connector waits; "Desfazer tudo" takes it all back', () => {
  let m: Message
  let planilha: string
  it('makes both agents (no connector yet), the channel and the routine, and a card for the connector', async () => {
    planilha = await ana.call<string>('addConnector', { input: { name: 'Planilha', kind: 'remote', url: 'http://127.0.0.1:9/mcp' } })
    m = await reply(ana, tuca.conversationId, 'monta o time de conteúdo')
    const s = await snap()
    const escriba = s.agents.find((a) => a.name === 'Escriba')!
    const revisora = s.agents.find((a) => a.name === 'Revisora')!
    expect(escriba.grants).toEqual({})
    const ps = proposalsOf(m.run)
    expect(ps.map((p) => [p.kind, p.state ?? null])).toEqual([['team', 'applied'], ['routine', 'applied'], ['agent', null]])
    expect(ps[0]).toMatchObject({ agentIds: [escriba.id, revisora.id], auto: true })
    expect(ps[2]).toMatchObject({ agentId: escriba.id, changes: { grants: { [planilha]: 'read_write' } }, before: { grants: {} } })
    expect(s.conversations.find((c) => c.kind === 'channel' && c.name === 'redacao')?.members.sort()).toEqual([escriba.id, revisora.id].sort())
    expect(s.routines.find((r) => r.name === 'Revisão da manhã')?.agentId).toBe(revisora.id)
  })

  it('is refused once its channel has talk in it, and goes once it is taken back by hand', async () => {
    // The connector confirmed by a click: it goes with the agent.
    await ana.call('applyProposal', { messageId: m.id, index: 2 })
    expect((await agentNamed('Escriba'))?.grants).toEqual({ [planilha]: 'read_write' })
    const r = await ana.call<ProposalsResult>('undoProposals', { messageId: m.id })
    expect(r.failed).toEqual([])
    expect(r.applied.map((a) => a.index).sort()).toEqual([0, 1, 2]) // the routine, the connector, then the team
    const s = await snap()
    expect(s.agents.some((a) => a.name === 'Escriba' || a.name === 'Revisora')).toBe(false)
    expect(s.conversations.some((c) => c.kind === 'channel' && c.name === 'redacao')).toBe(false)
    expect(s.routines.some((x) => x.name === 'Revisão da manhã')).toBe(false)
    expect(proposalsOf((await msg(m.id)).run).map((p) => p.state)).toEqual(['undone', 'undone', 'undone'])
  })

  it('a channel someone already talked in is not deleted by Desfazer', async () => {
    m = await reply(ana, tuca.conversationId, 'monta o time de conteúdo de novo')
    const channel = (await snap()).conversations.find((c) => c.kind === 'channel' && c.name === 'redacao')!
    await ana.call('sendMessage', { conversationId: channel.id, text: 'bem-vindas!' })
    await until(async () => (await inConv(ana, channel.id)).length > 0)
    expect(await err(ana.call('undoProposal', { messageId: m.id, index: 0 }))).toMatch(/começou a trabalhar|Já tem conversa em #redacao/)
    expect((await snap()).conversations.some((c) => c.id === channel.id)).toBe(true)
  })
})

describe('E. Desfazer has a time', () => {
  it('after 24 hours it says so instead of undoing', async () => {
    const m = await reply(ana, tuca.conversationId, 'quero um resumo diário da nina')
    expect(proposalsOf(m.run)[0]).toMatchObject({ kind: 'routine', state: 'applied' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 25 * 3_600_000)
    try {
      expect(await err(ana.call('undoProposal', { messageId: m.id, index: 0 }))).toContain('Passou o prazo')
    } finally {
      vi.useRealTimers()
    }
    expect((await snap()).routines.some((r) => r.name === 'Resumo diário')).toBe(true)
    await ana.call('undoProposal', { messageId: m.id, index: 0 })
    expect((await snap()).routines.some((r) => r.name === 'Resumo diário')).toBe(false)
  })
})

describe('F. turned off: every card waits for a click, as before', () => {
  it('proposes, and nothing is made until it is applied', async () => {
    await ana.call('updateSettings', { patch: { tucaApplyNow: false } })
    const m = await reply(ana, tuca.conversationId, 'quero um resumo diário da nina')
    expect(proposalsOf(m.run)[0]!.state).toBeUndefined()
    expect((await snap()).routines.some((r) => r.name === 'Resumo diário')).toBe(false)
    await ana.call('applyProposal', { messageId: m.id, index: 0 })
    expect((await snap()).routines.some((r) => r.name === 'Resumo diário')).toBe(true)
    // A click's change can be taken back the same way.
    await ana.call('undoProposal', { messageId: m.id, index: 0 })
    expect((await snap()).routines.some((r) => r.name === 'Resumo diário')).toBe(false)
    await ana.call('updateSettings', { patch: { tucaApplyNow: null } })
  })
})

describe('G. a member: only what her own click would apply is applied for her', () => {
  let mine: Tuca
  let biaId: string
  it("her new agent stays a card (agents are the admins'), and nothing reaches the admins by itself", async () => {
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
    const j = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
    biaId = j.data.person!.id
    bia = core.connect(biaId)
    mine = await bia.call<Tuca>('ensureTuca', {})
    const before = (await snap()).agents.length
    const m = await reply(bia, mine.conversationId, 'quero alguém pro atendimento ao cliente')
    expect(m.run?.agentDraft?.state).toBeUndefined()
    expect((await snap()).agents.length).toBe(before)
    expect(((await ana.call<Inbox>('inbox')).proposals ?? []).some((p) => p.id === m.id)).toBe(false)
    // Her click goes to the admins, as it always did.
    const r = await bia.call<ProposalsResult>('applyProposals', { messageId: m.id, draft: true })
    expect(r.draft?.error).toContain('admin')
  })

  it('her own routine is applied for her, and she can take it back', async () => {
    const m = await reply(bia, mine.conversationId, 'quero um resumo diário da nina')
    const p = proposalsOf(m.run)[0]!
    expect(p).toMatchObject({ kind: 'routine', state: 'applied', auto: true })
    const routine = (await snap(bia)).routines.find((r) => r.id === p.appliedId)!
    expect(routine.owner).toBe(biaId)
    // Ana can't reach Bia's DM, so neither her card.
    expect(await err(ana.call('undoProposal', { messageId: m.id, index: 0 }))).not.toBe('ok')
    await bia.call('undoProposal', { messageId: m.id, index: 0 })
    expect((await snap(bia)).routines.some((r) => r.id === p.appliedId)).toBe(false)
  })

  it('a change to an agent stays a card for her, as her click would send it to the admins', async () => {
    const nina = (await snap()).agents.find((a) => a.handle === 'nina')!
    const m = await reply(bia, mine.conversationId, 'deixa a nina mais esperta')
    expect(proposalsOf(m.run).map((p) => p.state ?? null)).toEqual([null])
    expect((await snap()).agents.find((a) => a.handle === 'nina')?.effort).toBe(nina.effort)
  })
})
