// How far an agent goes on its own, over the real core's API, as the app's screens send it: an agent's
// level, its rules and its guard are kept, Settings take theirs, and nothing unknown gets in.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Settings } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client
let lia: Agent
type Snap = { agents: Agent[]; settings: Settings }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const agentNow = async (): Promise<Agent> => (await ana.call<Snap>('snapshot')).agents.find((a) => a.id === lia.id)!

beforeAll(async () => {
  core = await bootCore()
  ana = core.connect()
  lia = (await ana.call<Snap>('snapshot')).agents.find((a) => a.handle === 'lia')!
}, 30_000)
afterAll(() => {
  try {
    rmSync(core.dataDir, { recursive: true, force: true })
  } catch {
    // Windows: still open
  }
})

describe("an agent's autonomy, saved from its page", () => {
  it('starts with nothing of its own: Settings decide', async () => {
    const a = await agentNow()
    expect(a.autonomy).toBeUndefined()
    expect(a.outsideGuard).toBeUndefined()
    expect(a.actionRules ?? {}).toEqual({})
  })

  it('keeps the level, the rules and the guard it was saved with, and gives them back', async () => {
    // What the page sends: the whole agent with the patch over it (store.ts patchAgent).
    await ana.call('saveAgent', { agent: { ...(await agentNow()), autonomy: 'free', outsideGuard: false, actionRules: { pay: 'off', send: 'ask' } }, channelIds: [] })
    const a = await agentNow()
    expect(a).toMatchObject({ autonomy: 'free', outsideGuard: false, actionRules: { pay: 'off', send: 'ask' } })
  })

  it('"Padrão" takes its own level away again, and the guard back to Settings', async () => {
    const { autonomy: _a, outsideGuard: _g, ...rest } = await agentNow()
    await ana.call('saveAgent', { agent: rest, channelIds: [] })
    const a = await agentNow()
    expect(a.autonomy).toBeUndefined()
    expect(a.outsideGuard).toBeUndefined()
  })

  it('drops what it doesn\'t know: a level, a kind or a mode that isn\'t one', async () => {
    await ana.call('saveAgent', { agent: { ...(await agentNow()), autonomy: 'yolo', outsideGuard: 'no', actionRules: { pay: 'maybe', rm: 'off', push: 'auto' } } as unknown as Agent, channelIds: [] })
    const a = await agentNow()
    expect(a.autonomy).toBeUndefined()
    expect(a.outsideGuard).toBeUndefined()
    expect(a.actionRules).toEqual({ push: 'auto' })
  })
})

describe("the introduction's agent", () => {
  it('is created with the level its answer gave, and left on "Padrão" for Normal', async () => {
    const { autonomy: _a, ...plain } = lia
    const make = async (handle: string, autonomy?: 'careful' | 'free'): Promise<Agent | undefined> => {
      // What the introduction sends: a new agent, its answer as the agent's own level (Normal: none).
      await ana.call('saveAgent', { agent: { ...plain, id: `intro-${handle}`, name: handle, handle, ...(autonomy ? { autonomy } : {}) }, channelIds: [] })
      return (await ana.call<Snap>('snapshot')).agents.find((a) => a.id === `intro-${handle}`)
    }
    expect((await make('cuidadosa', 'careful'))?.autonomy).toBe('careful')
    expect((await make('livre', 'free'))?.autonomy).toBe('free')
    expect((await make('normal'))?.autonomy).toBeUndefined()
  })
})

describe('autonomy for every agent, in Settings', () => {
  it('takes a level, rules and the guard', async () => {
    expect(await err(ana.call('updateSettings', { patch: { autonomy: 'careful', outsideGuard: false, actionRules: { delete: 'off' } } }))).toBe('ok')
    const s = (await ana.call<Snap>('snapshot')).settings
    expect(s).toMatchObject({ autonomy: 'careful', outsideGuard: false, actionRules: { delete: 'off' } })
  })

  it('refuses a level that isn\'t one, and keeps only known rules', async () => {
    expect(await err(ana.call('updateSettings', { patch: { autonomy: 'yolo' } }))).toMatch(/inválido/)
    await ana.call('updateSettings', { patch: { actionRules: { delete: 'auto', rm: 'off', pay: 'maybe' } } })
    expect((await ana.call<Snap>('snapshot')).settings.actionRules).toEqual({ delete: 'auto' })
  })
})
