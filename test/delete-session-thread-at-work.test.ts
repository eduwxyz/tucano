import { expect, it } from 'vitest'
import type { Agent, Message } from '../src/shared/types'
import { bootCore } from './helpers/core'

const until = async (ready: () => boolean | Promise<boolean>): Promise<void> => {
  const end = Date.now() + 12000
  while (!(await ready())) {
    if (Date.now() > end) throw new Error('The core did not reach the expected state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('stops an active thread reply when its completed parent session is deleted', async () => {
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
  await client.call('sendMessage', { conversationId: dm, threadId: parent!.id, text: 'demore 3 s' })
  let child: Message | undefined
  await until(async () => !!(child = (await messages()).find((m) => m.threadId === parent!.id && m.author.kind === 'agent' && m.run?.status === 'working')))
  expect(await client.call<string[]>('deleteMessage', { messageId: parent!.id })).toContain(child!.id)
  await until(() => core.toMain.slice(before).some((event) => event.type === 'busy' && event.busy === false))
  expect((await messages()).some((m) => m.id === child!.id || m.threadId === parent!.id)).toBe(false)
})
