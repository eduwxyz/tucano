// A team-up for a member who sees only part of the team (PersonAccess): the room never carries an agent
// they can't see, and the room it opens is one they can read — the source's audience, as 0.2.38's access
// rule reads it (access-policy.ts: a channel someone makes is theirs to see).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import type { Agent, Conversation, Message, Person, PersonAccess } from '../src/shared/types'
import { setLang } from '../src/shared/lang'
import { bootCore, type Client, type TestCore } from './helpers/core'

type Snap = { agents: Agent[]; conversations: Conversation[]; messages: Message[] }
const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

// One core per file (the module runs once): the two members join it in turn, each with their own invite.
describe('team-up: a member who sees part of the team', () => {
  let core: TestCore
  let ana: Client
  let dados: Conversation
  let lia: Agent
  let theo: Agent
  const snap = (c: Client): Promise<Snap> => c.call<Snap>('snapshot')
  const said = (s: Snap, from: string): Conversation | undefined => s.conversations.find((c) => c.teamUp?.from === from)

  // #dados has Theo in it; Lia isn't in the room, so a reply that calls her is what opens a team-up.
  const member = async (name: string, agents: string[]): Promise<Client> => {
    const access: PersonAccess = { mode: 'picked', sectors: [], agents, channels: [dados.id] }
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member', access })
    const joined = await core.ask<{ data: { person: Person } }>({ type: 'join', code, name }, 'join-result')
    return core.connect(joined.data.person.id)
  }

  beforeAll(async () => {
    setLang('en')
    core = await bootCore({ server: true })
    ana = core.connect()
    await ana.call('setMyName', { name: 'Ana' })
    const start = await snap(ana)
    dados = start.conversations.find((c) => c.kind === 'channel' && (c.name === 'dados' || c.name === 'data'))!
    lia = start.agents.find((a) => a.handle === 'lia')!
    theo = start.agents.find((a) => a.handle === 'theo')!
  }, 30_000)
  afterAll(() => {
    try {
      rmSync(core.dataDir, { recursive: true, force: true })
    } catch {
      // Windows: still open
    }
  })

  it('opens no room for an agent the member cannot see', async () => {
    const bia = await member('Bia', [theo.id])
    await bia.call('sendMessage', { conversationId: dados.id, text: 'peça pra lia ajudar com o painel' })
    // Theo's reply names Lia; the member sees only Theo, so she is no guest of theirs and no room opens.
    await until(async () => (await snap(ana)).messages.some((m) => m.conversationId === dados.id && m.author.kind === 'agent' && m.run?.status === 'done'))
    expect(said(await snap(ana), dados.id)).toBeUndefined()
    expect((await snap(bia)).conversations.filter((c) => c.teamUp)).toEqual([])
  }, 60_000)

  it('opens a room the member who asked can read, carrying the work', async () => {
    const bia = await member('Caio', [lia.id, theo.id])
    await bia.call('sendMessage', { conversationId: dados.id, text: 'peça pra lia ajudar com o painel' })
    let team: Conversation | undefined
    await until(async () => !!(team = said(await snap(ana), dados.id)))
    expect(team!.name).toBe('team-up-lia')
    // The member asked for the work: the room it went on in is one they read, like a channel they made.
    const hers = await snap(bia)
    expect(hers.conversations.some((c) => c.id === team!.id)).toBe(true)
    expect(hers.messages.some((m) => m.conversationId === dados.id && m.author.kind === 'system' && m.text.includes(team!.name))).toBe(true)
    // Only the agents that member sees are in the room with Theo.
    const everyone = await snap(ana)
    expect(team!.members.map((id) => everyone.agents.find((a) => a.id === id)?.handle).sort()).toEqual(['lia', 'theo'])
  }, 60_000)
})
