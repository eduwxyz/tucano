// A reserve model for the whole team: the Tuca sets an agent's with propor_ajuste (he couldn't, and a
// person with a dozen agents asked him for all of them), and Settings › Models has a default for every
// agent without one of its own.
import { describe, expect, it } from 'vitest'
import { proposalFrom, workspaceState } from '../src/core/tuca-help'
import { changedSince } from '../src/core/tuca-apply'
import { settingsPatchError } from '../src/core/settings-patch'
import { setLang } from '../src/shared/lang'
import type { Agent, Settings } from '../src/shared/types'

setLang('pt')
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const lia = agent('lia')
const ctx = { agents: [lia], conversations: [], connectors: [], usable: (id: string) => ['sonnet', 'haiku', 'grok:grok-4.7'].includes(id) }

describe('the Tuca sets a reserve model', () => {
  it('on propor_ajuste, and "nenhum" takes it away', () => {
    expect(proposalFrom('propor_ajuste', { agente: 'lia', modelo_reserva: 'grok:grok-4.7' }, ctx).proposal).toMatchObject({ changes: { fallbackModelId: 'grok:grok-4.7' } })
    const has = agent('lia', { fallbackModelId: 'grok:grok-4.7' })
    expect(proposalFrom('propor_ajuste', { agente: 'lia', modelo_reserva: 'nenhum' }, { ...ctx, agents: [has] }).proposal).toMatchObject({ changes: { fallbackModelId: '' } })
    expect(proposalFrom('propor_ajuste', { agente: 'lia', modelo_reserva: 'gpt-9' }, ctx).error).toMatch(/não dá pra usar/)
    expect(proposalFrom('propor_ajuste', { agente: 'lia', modelo_reserva: 'nenhum' }, ctx).error).toContain('Nada mudaria')
  })

  it('Desfazer reads "none" the same whether stored as empty or unset', () => {
    expect(changedSince(lia, { fallbackModelId: '' })).toEqual([])
  })

  it("the state he reads shows each agent's reserve and the workspace's", () => {
    const ready = { installed: true, loggedIn: true }
    const s = { workspaceName: 'X', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 0, approvalTtlHours: 24, theme: 'system', language: 'pt', defaultFallbackModel: 'grok:grok-4.7' } as unknown as Settings
    const text = workspaceState(undefined, { agents: [agent('lia', { fallbackModelId: 'haiku' })], conversations: [], routines: [], connectors: [], approvals: [], settings: s, failures: [], lastRun: () => undefined, now: Date.now() } as unknown as Parameters<typeof workspaceState>[1])
    expect(text).toMatch(/reserva .*haiku/)
    expect(text).toMatch(/reserva padrão dos agentes: .*grok-4\.7/)
  })
})

describe('the default reserve in the settings', () => {
  it('takes a model id, and null turns it off', () => {
    expect(settingsPatchError({ defaultFallbackModel: "grok:grok-4.7" })).toBeUndefined()
    expect(settingsPatchError({ defaultFallbackModel: null })).toBeUndefined()
    expect(settingsPatchError({ defaultFallbackModel: 3 })).toMatch(/inválido/)
  })
})
