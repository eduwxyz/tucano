import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { Agent, Message } from '../src/shared/types'
import { bootCore } from './helpers/core'

const until = async (ready: () => boolean | Promise<boolean>): Promise<void> => {
  const end = Date.now() + 15000
  while (!(await ready())) {
    if (Date.now() > end) throw new Error('The core did not reach the expected state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('does not start a queued thread reply after its parent session is deleted', async () => {
  const core = await bootCore({ server: true })
  const client = core.connect()
  await client.call('setMyName', { name: 'Ana' })
  const lia = (await client.call<{ agents: Agent[] }>('snapshot')).agents.find((a) => a.handle === 'lia')!
  const dm = await client.call<string>('openDm', { agentId: lia.id })
  const messages = async () => (await client.call<{ messages: Message[] }>('snapshot')).messages
  await client.call('sendMessage', { conversationId: dm, text: 'Hello.' })
  let parent: Message | undefined
  await until(async () => !!(parent = (await messages()).find((m) => m.conversationId === dm && m.author.kind === 'agent' && m.run?.status === 'done')))
  const before = core.toMain.length
  for (let n = 0; n < 6; n++) {
    const id = randomUUID()
    await client.call('saveAgent', { agent: { ...lia, id, handle: `worker${n}`, name: `Worker ${n}` }, channelIds: [] })
    const room = await client.call<string>('openDm', { agentId: id })
    await client.call('sendMessage', { conversationId: room, text: 'demore 3 s' })
  }
  await until(async () => (await messages()).filter((m) => m.run?.status === 'working').length === 6)
  await client.call('sendMessage', { conversationId: dm, threadId: parent!.id, text: 'This must not run after deletion.' })
  expect((await messages()).some((m) => m.threadId === parent!.id && m.author.kind === 'agent')).toBe(false)
  await client.call('deleteMessage', { messageId: parent!.id })
  await until(() => core.toMain.slice(before).some((event) => event.type === 'busy' && event.busy === false))
  expect((await messages()).some((m) => m.threadId === parent!.id)).toBe(false)
})
