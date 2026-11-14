import { expect, it } from 'vitest'
import type { Agent, Conversation, Message, Person } from '../src/shared/types'
import { bootCore } from './helpers/core'

const until = async (ready: () => boolean | Promise<boolean>): Promise<void> => {
  const end = Date.now() + 15000
  while (!(await ready())) {
    if (Date.now() > end) throw new Error('The core did not reach the expected state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
type Snapshot = { agents: Agent[]; conversations: Conversation[]; messages: Message[] }

it('does not expose a private DM through the team-up room it creates', async () => {
  const core = await bootCore({ server: true })
  const ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
  const joined = await core.ask<{ data: { person: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
  const bia = core.connect(joined.data.person.id)
  const lia = (await ana.call<Snapshot>('snapshot')).agents.find((a) => a.handle === 'lia')!
  const dm = await ana.call<string>('openDm', { agentId: lia.id })
  await ana.call('sendMessage', { conversationId: dm, text: 'Private project code: CASE-73921.' })
  await until(async () => (await ana.call<Snapshot>('snapshot')).messages.some((m) => m.conversationId === dm && m.author.kind === 'agent' && m.run?.status === 'done'))
  expect((await bia.call<Snapshot>('snapshot')).conversations.some((c) => c.id === dm)).toBe(false)
  await ana.call('sendMessage', { conversationId: dm, text: 'chame @theo num time chamado projeto-privado' })
  let team: Conversation | undefined
  await until(async () => !!(team = (await ana.call<Snapshot>('snapshot')).conversations.find((c) => c.teamUp?.from === dm)))
  const other = await bia.call<Snapshot>('snapshot')
  expect.soft(other.conversations.some((c) => c.id === team!.id)).toBe(false)
  expect(JSON.stringify(other.messages)).not.toContain('CASE-73921')
})
