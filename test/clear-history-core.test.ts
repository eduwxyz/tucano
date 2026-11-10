// Clearing a history over the real core, as the screen's menu does it: the conversation stays and the
// rows stay, but nothing that was waiting in there outlives it — a pending approval's card would sit
// inside a message that is now off the screen, and an open question would show in Questions with
// nothing behind it.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Approval, Conversation, Inbox, Message } from '../src/shared/types'
import { Db } from '../src/core/db'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: 60_000 })

let core: TestCore
let ana: Client
let dm: string
type Snap = { you: string; agents: { id: string; handle: string }[]; conversations: Conversation[]; messages: Message[]; approvals: Approval[] }
const until = async (ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const snap = (): Promise<Snap> => ana.call<Snap>('snapshot')
const inbox = (): Promise<Inbox> => ana.call<Inbox>('inbox')
// A message in the conversation, then the reply to it, done.
const say = async (text: string): Promise<void> => {
  const before = (await snap()).messages.length
  await ana.call('sendMessage', { conversationId: dm, text })
  const asked = (await snap()).messages.filter((m) => m.conversationId === dm && m.text === text).at(-1)!
  await until(async () => (await snap()).messages.some((m) => m.author.kind === 'agent' && m.at >= asked.at && m.run && m.run.status !== 'working'))
  expect((await snap()).messages.length).toBeGreaterThan(before)
}

beforeAll(async () => {
  core = await bootCore()
  ana = core.connect()
  dm = await ana.call<string>('openDm', { agentId: (await snap()).agents.find((a) => a.handle === 'lia')!.id })
  // The gateway's port is open a moment after boot: a reply sent before it fails with "no internet".
  await new Promise((r) => setTimeout(r, 1_500))
}, 60_000)
afterAll(() => {
  try {
    rmSync(core.dataDir, { recursive: true, force: true })
  } catch {
    // Windows: still open
  }
})

describe('clearing a conversation that has things waiting in it', () => {
  it('takes the pending approval and the open question with the history, and keeps the conversation', async () => {
    // Two decisions asked in the DM, then a pending approval on the reply, left there by a run that
    // asked — written straight into the database, the way a held bash command leaves it.
    await say('me ajuda a decidir')
    await until(async () => (await inbox()).questions.some((q) => q.conversationId === dm))
    const at = (await snap()).messages.filter((m) => m.conversationId === dm).at(-1)!
    const side = new Db(join(core.dataDir, 'tucano.db'))
    side.createApproval({
      id: 'ap-parado',
      hash: 'h',
      agentId: at.author.kind === 'agent' ? at.author.id : (await snap()).agents[0]!.id,
      conversationId: dm,
      messageId: at.id,
      connectorId: 'computador',
      connectorName: 'Computer',
      tool: 'bash',
      args: { command: 'rm -rf ./velho' },
      why: 'apagar a pasta velha',
      highRisk: true,
      state: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000
    })
    side.close()

    const before = await snap()
    expect(before.approvals.filter((a) => a.conversationId === dm && a.state === 'pending')).toHaveLength(1)
    expect((await inbox()).questions.some((q) => q.conversationId === dm)).toBe(true)

    await ana.call('clearConversation', { id: dm })

    // The conversation is still there, in the same place, with its cut.
    const after = await snap()
    const c = after.conversations.find((x) => x.id === dm)!
    expect(c.kind).toBe('dm')
    expect(c.clearedAt).toBeGreaterThan(0)
    // Nothing waits in it any more, and nothing points at a message nobody can see.
    expect(after.approvals.filter((a) => a.conversationId === dm && a.state === 'pending')).toEqual([])
    expect(after.approvals.find((a) => a.conversationId === dm)!.state).toBe('expired')
    expect((await inbox()).questions.filter((q) => q.conversationId === dm)).toEqual([])
    // And no badge left over an empty screen.
    expect(c.unread).toBe(0)
  })

  it('answers the same on a channel, where the question went to everyone', async () => {
    const ch = await ana.call<string>('createChannel', { name: 'limpeza', threads: false })
    await ana.call('setChannelMembers', { id: ch, agentIds: (await snap()).agents.map((a) => a.id) })
    const keep = dm
    dm = ch
    await say('me ajuda a decidir')
    await until(async () => (await inbox()).questions.some((q) => q.conversationId === ch))
    await ana.call('clearConversation', { id: ch })
    expect((await inbox()).questions.filter((q) => q.conversationId === ch)).toEqual([])
    const c = (await snap()).conversations.find((x) => x.id === ch)!
    expect(c.kind).toBe('channel')
    expect(c.clearedAt).toBeGreaterThan(0)
    dm = keep
  })
})
