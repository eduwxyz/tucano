import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import type { Agent } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'

let owner: Client
let member: Client
let db: Db
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: 'Pesquisa', color: 'sky', instructions: 'Preservar instruções', modelId: 'sonnet', effort: 'high', limit: 1234, used: 0, grants: { tool: 'read' }, memory: 'approve', computer: false, archived: false, ...extra })
beforeAll(async () => {
  const core = await bootCore({ server: true })
  owner = core.connect()
  db = new Db(join(core.dataDir, 'tucano.db'))
  db.addPerson({ id: 'member', name: 'Pessoa', role: 'member', about: '' })
  member = core.connect('member')
}, 30_000)

describe('changing agent models through the core', () => {
  it('updates one or several without changing other settings, channels or reserve', async () => {
    const a = agent('model-a', { accountId: 'claude-account', fallbackModelId: 'haiku', fallbackAccountId: 'reserve' })
    const b = agent('model-b', { archived: true, kind: 'tuca' })
    db.saveAgent(a); db.saveAgent(b)
    db.createConversation({ id: 'model-channel', kind: 'channel', name: 'model-channel', members: [a.id, b.id] })
    expect(await owner.call('setAgentModels', { agentIds: [a.id], modelId: 'opus' })).toBe(1)
    expect(db.agent(a.id)).toMatchObject({ ...a, modelId: 'opus' })
    expect(await owner.call('setAgentModels', { agentIds: [a.id, b.id, a.id], modelId: 'opencode:provider/model' })).toBe(2)
    expect(db.agent(a.id)).toMatchObject({ instructions: a.instructions, grants: a.grants, limit: a.limit, effort: a.effort, fallbackModelId: 'haiku', fallbackAccountId: 'reserve', modelId: 'opencode:provider/model' })
    expect(db.agent(a.id)?.accountId).toBeUndefined()
    expect(db.agent(b.id)).toMatchObject({ archived: true, kind: 'tuca', modelId: 'opencode:provider/model' })
    expect(db.conversation('model-channel')?.members).toEqual([a.id, b.id])
    expect(owner.events.filter((e) => e.type === 'agent' && e.agent.modelId === 'opencode:provider/model')).toHaveLength(2)
    expect(await owner.call('setAgentModels', { agentIds: [a.id, b.id], modelId: 'opencode:provider/model' })).toBe(0)
  })
  it('rejects missing agents or invalid models before updating anyone', async () => {
    db.saveAgent(agent('model-atomic'))
    await expect(owner.call('setAgentModels', { agentIds: ['model-atomic', 'missing'], modelId: 'opus' })).rejects.toThrow()
    for (const modelId of ['', 'unknown', 'codex:  ']) {
      await expect(owner.call('setAgentModels', { agentIds: ['model-atomic'], modelId })).rejects.toThrow()
    }
    expect(db.agent('model-atomic')?.modelId).toBe('sonnet')
  })
  it('changes the thinking alone, leaving the model and everything else as it was', async () => {
    const a = agent('model-effort', { effort: 'high', accountId: 'claude-account', fallbackModelId: 'haiku' })
    db.saveAgent(a)
    expect(await owner.call('setAgentModels', { agentIds: [a.id], effort: 'low' })).toBe(1)
    expect(db.agent(a.id)).toMatchObject({ modelId: 'sonnet', effort: 'low', accountId: 'claude-account', fallbackModelId: 'haiku', limit: 1234 })
    expect(await owner.call('setAgentModels', { agentIds: [a.id], effort: 'low' })).toBe(0)
    expect(owner.events.filter((e) => e.type === 'agent' && e.agent.effort === 'low')).toHaveLength(1)
  })
  it('changes the model and the thinking in the same call, and counts only the agents that moved', async () => {
    const a = agent('model-both', { effort: 'medium' })
    const b = agent('model-both-same', { effort: 'xhigh' })
    db.saveAgent(a); db.saveAgent(b)
    expect(await owner.call('setAgentModels', { agentIds: [a.id, b.id], modelId: 'opus', effort: 'xhigh' })).toBe(2)
    expect(db.agent(a.id)).toMatchObject({ modelId: 'opus', effort: 'xhigh' })
    expect(await owner.call('setAgentModels', { agentIds: [a.id, b.id], modelId: 'opus', effort: 'xhigh' })).toBe(0)
    const c = agent('model-effort-only', { effort: 'low' })
    const d = agent('model-effort-done', { effort: 'high' })
    db.saveAgent(c); db.saveAgent(d)
    expect(await owner.call('setAgentModels', { agentIds: [c.id, d.id], effort: 'high' })).toBe(1)
    expect(db.agent(c.id)?.modelId).toBe('sonnet')
  })
  it('refuses a call that names neither a model nor a thinking, or a thinking it does not know', async () => {
    db.saveAgent(agent('model-nothing', { effort: 'high' }))
    await expect(owner.call('setAgentModels', { agentIds: ['model-nothing'] })).rejects.toThrow()
    await expect(owner.call('setAgentModels', { agentIds: ['model-nothing'], modelId: '', effort: null as never })).rejects.toThrow()
    await expect(owner.call('setAgentModels', { agentIds: ['model-nothing'], effort: 'turbo' as never })).rejects.toThrow()
    expect(db.agent('model-nothing')?.effort).toBe('high')
  })
  it('does not allow a member to change models', async () => {
    await expect(member.call('setAgentModels', { agentIds: ['model-atomic'], modelId: 'opus' })).rejects.toThrow(/admin/i)
    expect(db.agent('model-atomic')?.modelId).toBe('sonnet')
  })
})
