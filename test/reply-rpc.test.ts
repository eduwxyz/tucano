import { beforeAll, expect, it } from 'vitest'
import type { Snapshot } from '../src/shared/rpc'
import { bootCore, type Client } from './helpers/core'

let owner: Client
let conversationId: string
beforeAll(async () => {
  owner = (await bootCore({ server: true })).connect()
  const snapshot = await owner.call<Snapshot>('snapshot')
  conversationId = snapshot.conversations.find((c) => c.kind === 'channel')!.id
}, 30_000)

it('returns rejected reply validation to the caller without saving their message', async () => {
  await expect(owner.call('sendMessage', { conversationId, text: 'Keep this draft.', reply: { messageId: 'missing' } })).rejects.toThrow(/mensagem desta conversa/)
  const snapshot = await owner.call<Snapshot>('snapshot')
  expect(snapshot.messages.some((m) => m.text === 'Keep this draft.')).toBe(false)
})

it('returns malformed and excessive excerpt errors instead of silently accepting them', async () => {
  await owner.call('sendMessage', { conversationId, text: 'Original message.' })
  const snapshot = await owner.call<Snapshot>('snapshot')
  const original = snapshot.messages.find((m) => m.text === 'Original message.')!
  for (const quote of [42, '', 'x'.repeat(32_001)]) {
    await expect(owner.call('sendMessage', { conversationId, text: 'Keep this too.', reply: { messageId: original.id, quote } })).rejects.toThrow(/32.000/)
  }
  expect((await owner.call<Snapshot>('snapshot')).messages.some((m) => m.text === 'Keep this too.')).toBe(false)
})
