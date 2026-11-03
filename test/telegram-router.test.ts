import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/shared/types'
import type { Engine, Turn } from '../src/core/engines/types'
import { routePhone, type PhoneChannel } from '../src/core/telegram-router'

const agent = (id: string, role: string): Agent => ({ id, name: id, handle: id, role, instructions: role, grants: {} } as Agent)
const channels: PhoneChannel[] = [
  { workspaceId: 'default', workspaceName: 'Personal', conversationId: 'general', name: 'general', default: true, agents: [agent('helper', 'General help')] },
  { workspaceId: 'default', workspaceName: 'Personal', conversationId: 'company', name: 'company x', topic: 'Company calendar', agents: [agent('calendar', 'Meetings'), agent('coder', 'Engineering')] }
]
function model(answer: unknown): Engine & { turns: Turn[] } {
  const turns: Turn[] = []
  return { id: 'claude', turns, async *run(t) { turns.push(t); yield { type: 'done', text: typeof answer === 'string' ? answer : JSON.stringify(answer), usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } } } }
}
const run = (engine: Engine, roster = channels, text = 'on company X, check the dates of next 3 meetings') => routePhone({ text, channels: roster, engine, model: 'haiku', cwd: '/tmp/opencode' })
const first = (result: PhoneChannel[] | { conversationId: string; text?: string; agentId?: string; workspaceId?: string }[]) => Array.isArray(result) ? result[0]! : result

describe('Telegram triage before channel posting', () => {
  it('sends the message, every channel, and each channel’s agents to AI', async () => {
    const engine = model({ targets: [{ conversationId: 'company', agentId: 'calendar', text: 'on company X, check the dates of next 3 meetings' }], default: 'general' })
    expect(await run(engine)).toHaveLength(1)
    const dest = first(await run(engine))
    expect(dest).toMatchObject({ workspaceId: 'default', conversationId: 'company', agentId: 'calendar', text: 'on company X, check the dates of next 3 meetings' })
    const prompt = JSON.parse(engine.turns[0]!.prompt)
    expect(prompt.message).toContain('next 3 meetings')
    expect(prompt.channels).toHaveLength(2)
    expect(prompt.channels[1].agents.map((a: { id: string }) => a.id)).toEqual(['calendar', 'coder'])
    expect(engine.turns[0]!.mcpUrl).toBeUndefined()
    expect(engine.turns[0]!.web).toBeUndefined()
  })

  it('bypasses AI for one channel with one agent', async () => {
    const engine = model('not called')
    const result = await run(engine, [channels[0]!])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ conversationId: 'general', agentId: 'helper' })
    expect(engine.turns).toHaveLength(0)
  })

  it('keeps a sole channel fixed but selects between its agents', async () => {
    const engine = model({ targets: [{ conversationId: 'company', agentId: 'calendar', text: 'on company X, check the dates of next 3 meetings' }], default: 'company' })
    const result = await run(engine, [channels[1]!])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ conversationId: 'company', agentId: 'calendar' })
    expect(engine.turns).toHaveLength(1)
  })

  it.each(['garbage', '{}', '{"workspaceId":"other","conversationId":"company","agentId":"calendar"}'])('falls back to default on invalid routing: %s', async (text) => {
    const result = await run(model(text), channels, text)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ workspaceId: 'default', conversationId: 'general', agentId: 'helper', text })
  })

  it('never accepts an agent from a different channel', async () => {
    const engine = model({ targets: [{ conversationId: 'company', agentId: 'calendar', text: 'on company X, check the dates of next 3 meetings' }], default: 'general' })
    const result = await run(engine)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ workspaceId: 'default', conversationId: 'company', agentId: 'calendar', text: 'on company X, check the dates of next 3 meetings' })
  })

  it('falls back when the engine fails and rejects an empty roster', async () => {
    const engine: Engine = { id: 'claude', async *run() { yield { type: 'error', message: 'offline' } } }
    const result = await run(engine)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ conversationId: 'general' })
    await expect(run(engine, [])).rejects.toThrow('Create a channel')
  })

  it('distinguishes identical channel IDs across future workspaces', async () => {
    const roster = [...channels, { ...channels[1]!, workspaceId: 'work', workspaceName: 'Work' }]
    const engine = model({ targets: [{ conversationId: 'company', agentId: 'calendar', text: 'on company X, check the dates of next 3 meetings' }], default: 'general' })
    const result = await run(engine, roster)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ workspaceId: 'work', conversationId: 'company', agentId: 'calendar', text: 'on company X, check the dates of next 3 meetings' })
  })

  it('picks a channel from its recent message history when the user does not name it', async () => {
    const roster: PhoneChannel[] = [
      { ...channels[0]!, recentMessages: [{ kind: 'me', name: 'Edu', text: 'revisar o código do checkout' }, { kind: 'agent', name: 'lia', text: 'vou olhar os bugs de login' }] },
      { ...channels[1]!, recentMessages: [{ kind: 'me', name: 'Edu', text: 'notas de lançamento do conteúdo' }, { kind: 'agent', name: 'nina', text: 'o post da semana está pronto' }] }
    ]
    const engine = model({ targets: [{ conversationId: 'company', agentId: 'calendar', text: 'about content' }], default: 'general' })
    const result = await run(engine, [...roster])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ conversationId: 'company', agentId: 'calendar' })
    const prompt = JSON.parse(engine.turns[0]!.prompt)
    expect(prompt.channels[1].history).toContain('lançamento do conteúdo')
    expect(prompt.channels[1].history).toContain('post da semana')
    expect(prompt.channels[0].history).toContain('código do checkout')
  })

  it('marks the first channel as the default when no named default exists', async () => {
    const engine = model('bad JSON')
    const roster = channels.map((c) => ({ ...c, default: false }))
    const result = await run(engine, roster)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ conversationId: 'general', agentId: 'helper' })
    expect(JSON.parse(engine.turns[0]!.prompt).channels.map((c: { default: boolean }) => c.default)).toEqual([true, false])
  })

  it('does not invoke an unavailable or disabled harness', async () => {
    const engine = model('not called')
    const result = await routePhone({ text: 'task', channels, engine, model: 'haiku', cwd: '/tmp/opencode', ready: false })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ conversationId: 'general', agentId: 'helper' })
    expect(engine.turns).toHaveLength(0)
  })

  it('splits one message into multiple channel targets', async () => {
    const engine = model(JSON.stringify({ targets: [
      { conversationId: 'general', agentId: 'helper', text: 'buy milk' },
      { conversationId: 'company', agentId: 'calendar', text: 'schedule meeting' }
    ], default: 'general' }))
    const result = await run(engine)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ conversationId: 'general', agentId: 'helper', text: 'buy milk' })
    expect(result[1]).toMatchObject({ conversationId: 'company', agentId: 'calendar', text: 'schedule meeting' })
  })
})
