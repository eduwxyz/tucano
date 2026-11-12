// The Tuca proposes the org chart over the real core (fake engines): the cards change nothing until
// applied, and applying them sets whom each agent answers to, for agents that exist and for a new team.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Message } from '../src/shared/types'
import { proposalsOf } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client
type Snap = { agents: Agent[]; messages: Message[] }
const until = async (ok: () => Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
async function reply(conv: string, said: string): Promise<Message> {
  const inConv = async (): Promise<Message[]> => (await ana.call<Snap>('snapshot')).messages.filter((m) => m.conversationId === conv)
  const before = new Set((await inConv()).map((m) => m.id))
  await ana.call('sendMessage', { conversationId: conv, text: said })
  let found: Message | undefined
  await until(async () => !!(found = (await inConv()).find((m) => !before.has(m.id) && m.author.kind === 'agent' && m.run?.status === 'done'))).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify((await inConv()).map((m) => [m.author.kind, m.text.slice(0, 60), m.run?.status, JSON.stringify(m.run ?? {}).slice(0, 700)]))}`)
  })
  return found!
}
const agents = async (): Promise<Agent[]> => (await ana.call<Snap>('snapshot')).agents
const byHandle = async (h: string): Promise<Agent> => (await agents()).find((a) => a.handle === h)!

beforeAll(async () => {
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
}, 30_000)
afterAll(() => {
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
})

describe('the Tuca organizes the team, with my yes', () => {
  it('proposes whom each agent answers to; nothing changes until applied', async () => {
    const { conversationId } = await ana.call<{ conversationId: string }>('ensureTuca', {})
    // The first turn only talks, as in tuca-keep-and-batch-core: here a first turn that calls a tool can't reach the gateway yet.
    await reply(conversationId, 'oi')
    const m = await reply(conversationId, 'organiza o time')
    const lia = await byHandle('lia')
    expect(proposalsOf(m.run).map((p) => (p.kind === 'agent' ? p.changes.reportsTo : undefined))).toEqual([lia.id, lia.id])
    expect((await byHandle('theo')).reportsTo).toBeUndefined()
    await ana.call('applyProposals', { messageId: m.id })
    expect((await byHandle('theo')).reportsTo).toBe(lia.id)
    expect((await byHandle('nina')).reportsTo).toBe(lia.id)
  })

  it('a team comes in with its own line: one answers to an agent that exists, the other to the first', async () => {
    const { conversationId } = await ana.call<{ conversationId: string }>('ensureTuca', {})
    const m = await reply(conversationId, 'monta um time de dados')
    const card = proposalsOf(m.run)[0]
    expect(card).toMatchObject({ kind: 'team', agents: [{ name: 'Duda' }, { name: 'Caio', reportsToName: 'Duda' }] })
    await ana.call('applyProposals', { messageId: m.id })
    const all = await agents()
    const duda = all.find((a) => a.name === 'Duda')!
    expect(duda.reportsTo).toBe(all.find((a) => a.handle === 'lia')!.id)
    expect(all.find((a) => a.name === 'Caio')!.reportsTo).toBe(duda.id)
  })

  it('the flag is an admin setting on the agent', async () => {
    const nina = await byHandle('nina')
    await ana.call('saveAgent', { agent: { ...nina, manager: true }, channelIds: [] })
    expect((await byHandle('nina')).manager).toBe(true)
  })
})
