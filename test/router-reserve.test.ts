// A channel's router whose model can't run (out of quota, signed out) picks with the channel agents'
// models instead, as their replies would move to their reserve: a channel doesn't go quiet while a DM
// to the same agent still answers.
import { describe, expect, it } from 'vitest'
import { routerReserves } from '../src/core/runs'
import type { Agent, Settings } from '../src/shared/types'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const ready = { installed: true, loggedIn: true }
const out = { installed: true, loggedIn: false }
const engines = { claude: ready, codex: out, opencode: out, pi: out, antigravity: out, cursor: out, grok: ready, cline: out, hermes: out, endpoint: out } as Settings['engines']

describe("the models that pick when the router's can't", () => {
  it("the agents' reserves first, once each, on another signed-in harness", () => {
    const members = [agent('a', { fallbackModelId: 'grok:grok-4.7' }), agent('b', { fallbackModelId: 'grok:grok-4.7' }), agent('c', { fallbackModelId: 'haiku' })]
    expect(routerReserves(members, { engines }, 'claude').map((m) => m.engine)).toEqual(['grok'])
  })

  it("the workspace's default reserve for an agent without its own", () => {
    expect(routerReserves([agent('a')], { engines, defaultFallbackModel: 'grok:grok-4.7' }, 'claude').map((m) => m.engine)).toEqual(['grok'])
    expect(routerReserves([agent('a', { fallbackModelId: 'gpt-5.6-luna' })], { engines: { ...engines, codex: ready }, defaultFallbackModel: 'grok:grok-4.7' }, 'claude').map((m) => m.engine)).toEqual(['codex'])
  })

  it("then the agents' main models; nothing on a harness that's signed out", () => {
    expect(routerReserves([agent('a')], { engines }, 'codex').map((m) => m.id)).toEqual(['sonnet'])
    expect(routerReserves([agent('a', { fallbackModelId: 'grok:grok-4.7' })], { engines: { ...engines, grok: out } }, 'claude')).toEqual([])
  })
})
