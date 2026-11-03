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
const run = (engine: Engine, roster = channels) => routePhone({ text: 'on company X, check the dates of next 3 meetings', channels: roster, engine, model: 'haiku', cwd: '/tmp/opencode' })

describe('Telegram triage before channel posting', () => {
  it('sends the message, every channel, and each channel’s agents to AI', async () => {
    const engine = model({ workspaceId: 'default', conversationId: 'company', agentId: 'calendar' })
    expect(await run(engine)).toEqual({ workspaceId: 'default', conversationId: 'company', agentId: 'calendar' })
    const prompt = JSON.parse(engine.turns[0]!.prompt)
    expect(prompt.message).toContain('next 3 meetings')
    expect(prompt.channels).toHaveLength(2)
    expect(prompt.channels[1].agents.map((a: { id: string }) => a.id)).toEqual(['calendar', 'coder'])
    expect(engine.turns[0]!.mcpUrl).toBeUndefined()
    expect(engine.turns[0]!.web).toBeUndefined()
  })

  it('bypasses AI for one channel with one agent', async () => {
    const engine = model('not called')
    expect(await run(engine, [channels[0]!])).toMatchObject({ conversationId: 'general', agentId: 'helper' })
    expect(engine.turns).toHaveLength(0)
  })

  it('keeps a sole channel fixed but selects between its agents', async () => {
    const engine = model({ workspaceId: 'unknown', conversationId: 'unknown', agentId: 'calendar' })
    expect(await run(engine, [channels[1]!])).toMatchObject({ conversationId: 'company', agentId: 'calendar' })
    expect(engine.turns).toHaveLength(1)
  })

  it.each(['garbage', '{}', '{"workspaceId":"other","conversationId":"company","agentId":"calendar"}'])('falls back to default on invalid routing: %s', async (text) => {
    expect(await run(model(text))).toEqual({ workspaceId: 'default', conversationId: 'general', agentId: 'helper' })
  })

  it('never accepts an agent from a different channel', async () => {
    expect(await run(model({ workspaceId: 'default', conversationId: 'company', agentId: 'helper' }))).toEqual({ workspaceId: 'default', conversationId: 'company', agentId: 'calendar' })
  })

  it('falls back when the engine fails and rejects an empty roster', async () => {
    const engine: Engine = { id: 'claude', async *run() { yield { type: 'error', message: 'offline' } } }
    expect(await run(engine)).toMatchObject({ conversationId: 'general' })
    await expect(run(engine, [])).rejects.toThrow('Create a channel')
  })

  it('distinguishes identical channel IDs across future workspaces', async () => {
    const roster = [...channels, { ...channels[1]!, workspaceId: 'work', workspaceName: 'Work' }]
    expect(await run(model({ workspaceId: 'work', conversationId: 'company', agentId: 'calendar' }), roster)).toEqual({ workspaceId: 'work', conversationId: 'company', agentId: 'calendar' })
  })

  it('marks the first channel as the default when no named default exists', async () => {
    const engine = model('bad JSON')
    const roster = channels.map((c) => ({ ...c, default: false }))
    expect(await run(engine, roster)).toMatchObject({ conversationId: 'general', agentId: 'helper' })
    expect(JSON.parse(engine.turns[0]!.prompt).channels.map((c: { default: boolean }) => c.default)).toEqual([true, false])
  })

  it('does not invoke an unavailable or disabled harness', async () => {
    const engine = model('not called')
    expect(await routePhone({ text: 'task', channels, engine, model: 'haiku', cwd: '/tmp/opencode', ready: false })).toMatchObject({ conversationId: 'general', agentId: 'helper' })
    expect(engine.turns).toHaveLength(0)
  })
})
