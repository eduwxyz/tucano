import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { settingsPatchError } from '../src/core/settings-patch'
import { memoryEffort } from '../src/core/memory'
import { routerEffort, routerTurn } from '../src/core/router'
import { PROPOR_AJUSTE, proposalFrom } from '../src/core/tuca-help'
import { PROPOR_AGENTE } from '../src/core/tuca'
import { EFFORTS, EFFORT_IDS, isEffort, type Agent } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'

describe('one list of thinking levels', () => {
  it('is the same four, in the same order, wherever a level is offered', () => {
    expect(EFFORT_IDS).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(EFFORTS.map((e) => e.id)).toEqual(EFFORT_IDS)
    // The Tuca's two cards offer what the person's own pickers offer: no fifth name, none missing.
    for (const tool of [PROPOR_AGENTE, PROPOR_AJUSTE]) {
      const level = (tool.inputSchema.properties?.['esforco'] as { enum?: string[] } | undefined)?.enum
      expect(level).toEqual(EFFORT_IDS)
    }
  })
  it('tells a level from anything else', () => {
    for (const id of EFFORT_IDS) expect(isEffort(id)).toBe(true)
    for (const bad of ['', 'max', 'Low', 'x-high', null, undefined, 3, ['low']]) expect(isEffort(bad)).toBe(false)
  })
  it('defaults the router and the small memory model to low, and takes a raised one', () => {
    expect(routerEffort({})).toBe('low')
    expect(memoryEffort({})).toBe('low')
    expect(routerEffort({ routerEffort: 'high' })).toBe('high')
    expect(memoryEffort({ memoryEffort: 'xhigh' })).toBe('xhigh')
    // The warm turn carries the same level the actual call will use, or the process would start wrong.
    expect(routerTurn('haiku', '/tmp').effort).toBe('low')
    expect(routerTurn('haiku', '/tmp', 'xhigh').effort).toBe('xhigh')
  })
  it('is what a settings change may carry, and nothing else', () => {
    expect(settingsPatchError({ routerEffort: 'medium' })).toBeUndefined()
    expect(settingsPatchError({ memoryEffort: 'xhigh' })).toBeUndefined()
    expect(settingsPatchError({ routerEffort: null, memoryEffort: null })).toBeUndefined() // back to the default
    expect(settingsPatchError({ routerEffort: 'max' })).toBeDefined()
    expect(settingsPatchError({ memoryEffort: 2 })).toBeDefined()
  })
})

describe('setting an agent model carries its thinking level', () => {
  let owner: Client
  let db: Db
  const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: 'Pesquisa', color: 'sky', instructions: 'Fica como está', modelId: 'sonnet', effort: 'high', limit: 0, used: 0, grants: {}, memory: 'approve', computer: false, archived: false, ...extra })
  beforeAll(async () => {
    const core = await bootCore({ server: true })
    owner = core.connect()
    db = new Db(join(core.dataDir, 'tucano.db'))
  }, 30_000)

  it('sets the level with the model, and only when one is sent', async () => {
    db.saveAgent(agent('level-a'))
    expect(await owner.call('setAgentModels', { agentIds: ['level-a'], modelId: 'opus', effort: 'xhigh' })).toBe(1)
    expect(db.agent('level-a')).toMatchObject({ modelId: 'opus', effort: 'xhigh' })
    // No level sent: the agent keeps the one it had, even when the model changes.
    expect(await owner.call('setAgentModels', { agentIds: ['level-a'], modelId: 'sonnet' })).toBe(1)
    expect(db.agent('level-a')).toMatchObject({ modelId: 'sonnet', effort: 'xhigh' })
    // Same model, new level: still a change, and counted as one.
    expect(await owner.call('setAgentModels', { agentIds: ['level-a'], modelId: 'sonnet', effort: 'low' })).toBe(1)
    expect(db.agent('level-a')).toMatchObject({ modelId: 'sonnet', effort: 'low' })
    expect(await owner.call('setAgentModels', { agentIds: ['level-a'], modelId: 'sonnet', effort: 'low' })).toBe(0)
  })
  it('takes null or "default" as "leave the level alone"', async () => {
    db.saveAgent(agent('level-b', { effort: 'medium' }))
    expect(await owner.call('setAgentModels', { agentIds: ['level-b'], modelId: 'opus', effort: null })).toBe(1)
    expect(db.agent('level-b')).toMatchObject({ modelId: 'opus', effort: 'medium' })
    expect(await owner.call('setAgentModels', { agentIds: ['level-b'], modelId: 'sonnet', effort: 'default' })).toBe(1)
    expect(db.agent('level-b')).toMatchObject({ modelId: 'sonnet', effort: 'medium' })
  })
  it('moves only the level when no model is sent, each agent keeping its own', async () => {
    db.saveAgent(agent('level-e', { modelId: 'sonnet', effort: 'high' }))
    db.saveAgent(agent('level-f', { modelId: 'opus', effort: 'low' }))
    // The bulk change with a level and no model: the two agents run different models and both take the level.
    expect(await owner.call('setAgentModels', { agentIds: ['level-e', 'level-f'], modelId: '', effort: 'xhigh' })).toBe(2)
    expect(db.agent('level-e')).toMatchObject({ modelId: 'sonnet', effort: 'xhigh' })
    expect(db.agent('level-f')).toMatchObject({ modelId: 'opus', effort: 'xhigh' })
    expect(await owner.call('setAgentModels', { agentIds: ['level-e', 'level-f'], modelId: '', effort: 'xhigh' })).toBe(0)
    // Neither a model nor a level is nothing to do, and a level off the list is refused before any agent moves.
    await expect(owner.call('setAgentModels', { agentIds: ['level-e'], modelId: '' })).rejects.toThrow(/model/i)
    await expect(owner.call('setAgentModels', { agentIds: ['level-e'], modelId: '', effort: 'max' })).rejects.toThrow(/esfor|effort/i)
    expect(db.agent('level-e')).toMatchObject({ modelId: 'sonnet', effort: 'xhigh' })
  })
  it('refuses a level it does not know, before touching any agent', async () => {
    db.saveAgent(agent('level-c'))
    await expect(owner.call('setAgentModels', { agentIds: ['level-c'], modelId: 'opus', effort: 'max' })).rejects.toThrow(/esfor/i)
    expect(db.agent('level-c')).toMatchObject({ modelId: 'sonnet', effort: 'high' })
  })
  it('carries the level the Tuca proposes, and ignores one off the list', () => {
    const theo = agent('level-d')
    const ctx = { usable: () => true, connectors: [], conversations: [], agents: [theo] } as unknown as Parameters<typeof proposalFrom>[2]
    const raised = proposalFrom('propor_ajuste', { agente: 'level-d', esforco: 'xhigh' }, ctx).proposal
    expect(raised && 'changes' in raised ? raised.changes : undefined).toEqual({ effort: 'xhigh' })
    // The tool's schema already keeps a made-up name out; the code that reads the args must not take it either.
    expect(proposalFrom('propor_ajuste', { agente: 'level-d', esforco: 'max' }, ctx).proposal).toBeUndefined()
    expect(proposalFrom('propor_ajuste', { agente: 'level-d', esforco: 'high' }, ctx).proposal).toBeUndefined() // already high
  })
})
