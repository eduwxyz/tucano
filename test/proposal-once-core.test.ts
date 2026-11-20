// A card an agent puts under its reply is applied once. Reported on 0.2.41: a team card from a regular
// agent ("A team of 2 · proposed by Tinker") went back to "Create team" after it was created, and a
// second click made the same agents again. The card was applied while the reply was still working,
// and the reply's next save, from its own copy of the message, put the card back as it was proposed.
// Over the real core with fake engines; one core for the whole file, the describes build on each other.
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message } from '../src/shared/types'
import { proposalsOf } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client
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
const snap = (): Promise<Snap> => ana.call<Snap>('snapshot')
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const named = async (name: string): Promise<Agent[]> => (await snap()).agents.filter((a) => a.name === name)
const msg = async (id: string): Promise<Message> => (await snap()).messages.find((m) => m.id === id)!

let dm: string
// Nina's reply to what was just said in her DM, once its team card is there and she's still working.
async function cardWhileWorking(said: string): Promise<Message> {
  const before = new Set((await snap()).messages.map((m) => m.id))
  await ana.call('sendMessage', { conversationId: dm, text: said })
  let found: Message | undefined
  await until(async () => {
    found = (await snap()).messages.find((m) => !before.has(m.id) && m.conversationId === dm && m.author.kind === 'agent' && proposalsOf(m.run).length > 0)
    return !!found
  }).catch(async (e: Error) => {
    throw new Error(`${e.message}: ${JSON.stringify((await snap()).messages.filter((m) => m.conversationId === dm).map((m) => [m.author.kind, m.text.slice(0, 300), m.run?.status, m.run?.error, m.run?.errorDetail, m.run?.steps?.map((s) => s.label)]))}`)
  })
  expect(found!.run?.status).toBe('working')
  return found!
}
const done = (id: string): Promise<void> => until(async () => (await msg(id)).run?.status === 'done')

beforeAll(async () => {
  process.on('unhandledRejection', onCrash)
  process.on('uncaughtException', onCrash)
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  const nina = (await snap()).agents.find((a) => a.handle === 'nina')!
  dm = await ana.call<string>('openDm', { agentId: nina.id })
  // A first exchange with no card: the core is all up by then (its tools' gateway too).
  await ana.call('sendMessage', { conversationId: dm, text: 'oi' })
  await until(async () => (await snap()).messages.some((m) => m.conversationId === dm && m.author.kind === 'agent' && m.run?.status === 'done'))
}, 30_000)
afterAll(() => {
  process.off('unhandledRejection', onCrash)
  process.off('uncaughtException', onCrash)
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
  expect(crashes).toEqual([])
})

let applied: Message
describe('a card applied while its reply is still working', () => {
  it('stays applied once the reply ends, and applying it again makes nothing', async () => {
    const card = await cardWhileWorking('proponha o time Critic e Shipper, demore 3 s')
    expect(proposalsOf(card.run)[0]).toMatchObject({ kind: 'team', id: expect.any(String) })
    expect(proposalsOf(card.run)[0]!.state).toBeUndefined()
    await ana.call('applyProposal', { messageId: card.id, index: 0 })
    await done(card.id)
    applied = await msg(card.id)
    const p = proposalsOf(applied.run)[0]!
    expect(p.state).toBe('applied')
    expect(p.kind === 'team' && p.agentIds).toHaveLength(2)
    expect(await err(ana.call('applyProposal', { messageId: card.id, index: 0 }))).toMatch(/já foi aplicada|already applied/)
    expect(await named('Critic')).toHaveLength(1)
    expect(await named('Shipper')).toHaveLength(1)
  })

  it('the same team proposed again in that reply is refused, instead of a second card to click', async () => {
    const card = await cardWhileWorking('proponha o time Ferro e Brasa de novo em 3 s')
    await ana.call('applyProposal', { messageId: card.id, index: 0 })
    await done(card.id)
    const m = await msg(card.id)
    expect(proposalsOf(m.run).map((p) => p.state)).toEqual(['applied'])
    expect(m.text).toMatch(/já aplicou esse card|already applied that card/)
    expect(await named('Ferro')).toHaveLength(1)
  })
})

describe('the core applies a card once, whatever the message says', () => {
  it('a card that lost its state on the message (as 0.2.41 saved it) is put back, and makes nothing twice', async () => {
    // The stored message as the stale save left it: the card back to how it was proposed.
    const db = new DatabaseSync(join(core.dataDir, 'tucano.db'))
    const run = JSON.parse((db.prepare('SELECT run FROM messages WHERE id = ?').get(applied.id) as { run: string }).run) as Message['run']
    const { state: _s, appliedId: _a, agentIds: _i, undo: _u, ...asProposed } = proposalsOf(run)[0] as Record<string, unknown>
    db.prepare('UPDATE messages SET run = ? WHERE id = ?').run(JSON.stringify({ ...run, proposals: [asProposed] }), applied.id)
    db.close()
    expect(proposalsOf((await msg(applied.id)).run)[0]!.state).toBeUndefined()

    expect(await err(ana.call('applyProposal', { messageId: applied.id, index: 0 }))).toMatch(/já foi aplicada|already applied/)
    expect(await named('Critic')).toHaveLength(1)
    // The card says again what it did, with what it made.
    expect(proposalsOf((await msg(applied.id)).run)[0]).toEqual(proposalsOf(applied.run)[0])
    // "Apply all" skips it too.
    const all = await ana.call<{ applied: unknown[]; failed: unknown[] }>('applyProposals', { messageId: applied.id })
    expect(all).toMatchObject({ applied: [], failed: [] })
    expect(await named('Shipper')).toHaveLength(1)
  })
})
