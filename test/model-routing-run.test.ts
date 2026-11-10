import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { defaultRouting, targetId, type RoutingConfig } from '../src/shared/routing'
import { customModel, type Agent, type EngineId, type Message, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { readAnswer } from '../src/core/model-routing'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

const target = (engine: EngineId, model: string, effort: 'low' | 'medium' | 'high' | 'xhigh' = 'medium') => {
  const id = targetId({ engine, model, effort })
  return { id, engine, model, effort }
}

// A setup with one model in the everyday tier, and the free pool out of the way.
const routed = (patch: Partial<RoutingConfig> = {}): RoutingConfig => {
  const base = defaultRouting()
  return {
    ...base,
    enabled: true,
    free: { policy: 'off' },
    pools: { ...base.pools, t2: { descriptor: 't2', chain: [target('codex', 'gpt-5.6-luna', 'high')] } },
    ...patch
  }
}

function agent(id: string, handle: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }
}

let db: Db
let events: CoreEvent[]
let settings: Settings
let turns: Turn[]

// The four questions, answered: a plain everyday coding request.
const answer = (role = 'code', complexity = 1, capability = 1): unknown => ({
  answers: { acao: { choice: role, confidence: 0.9, probabilities: { [role]: 0.9 } }, complexidade: { score: complexity }, capacidade: { score: capability }, raciocinio: { noul: 0.1 } }
})

function runner(opts: { jev?: { key(): Promise<string | undefined>; fetch?: typeof fetch } } = {}): Runner {
  turns = []
  const wrap = (id: EngineId): Engine => {
    const e = fakeEngine(id, { delayMs: 1 })
    return { id: e.id, run: (t) => (turns.push(t), e.run(t)) }
  }
  const engines = { claude: wrap('claude'), codex: wrap('codex'), opencode: wrap('opencode'), pi: wrap('pi'), antigravity: wrap('antigravity'), cursor: wrap('cursor'), grok: wrap('grok'), cline: wrap('cline') } as Record<EngineId, Engine>
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), ...(opts.jev ? { jev: opts.jev } : {}) })
}

const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia', { smartRouting: true }))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

describe('routing a reply', () => {
  it('runs the reply on the tier the reading asks for, and keeps the trace on the message', async () => {
    settings.routing = routed()
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    const [reply] = replies()
    expect(reply?.run?.status).toBe('done')
    expect(turns.at(-1)).toMatchObject({ model: 'gpt-5.6-luna', effort: 'high' })
    const trace = reply!.run!.route!
    expect(trace.state).toBe('changed')
    expect(trace.requested).toBe('t2')
    expect(trace.effective).toBe('t2')
    expect(trace.selected).toEqual(target('codex', 'gpt-5.6-luna', 'high'))
    expect(trace.baseline).toEqual(target('claude', 'sonnet', 'low'))
  })

  it('makes no classifier call at all for an agent set to off by itself', async () => {
    settings.routing = routed()
    db.saveAgent(agent('a1', 'lia', { smartRouting: false }))
    let asked = 0
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => (asked++, Response.json(answer()))) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    expect(asked).toBe(0)
    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
    expect(replies()[0]?.run?.route).toBeUndefined()
  })

  it('does nothing at all when there is no routing setup, even for an agent set to on', async () => {
    let asked = 0
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => (asked++, Response.json(answer()))) as unknown as typeof fetch } })
    await r.send('d1', 'oi')
    await r.idle()
    expect(asked).toBe(0)
    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
  })

  it('routes for an agent set to on by itself with the global switch off', async () => {
    settings.routing = routed({ enabled: false })
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    expect(turns.at(-1)).toMatchObject({ model: 'gpt-5.6-luna', effort: 'high' })
    expect(replies()[0]?.run?.route?.state).toBe('changed')
  })

  it('follows the global switch for an agent that chose neither', async () => {
    settings.routing = routed()
    db.saveAgent(agent('a1', 'lia')) // no smartRouting: inherit
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()
    expect(turns.at(-1)).toMatchObject({ model: 'gpt-5.6-luna' })

    // …and the same agent stays on its baseline once the global switch goes off.
    settings.routing = routed({ enabled: false })
    db.saveAgent({ ...db.agent('a1')!, modelId: 'claude:sonnet' })
    await r.send('d1', 'outra vez')
    await r.idle()
    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
    expect(replies()[1]?.run?.route).toBeUndefined()
  })

  it('keeps on and off on the agent, and reads a cleared switch as following the global one', () => {
    db.saveAgent(agent('a1', 'lia', { smartRouting: true }))
    expect(db.agent('a1')?.smartRouting).toBe(true)
    db.saveAgent(agent('a1', 'lia', { smartRouting: false }))
    expect(db.agent('a1')?.smartRouting).toBe(false)
    db.saveAgent(agent('a1', 'lia')) // the switch cleared: inherit, not an off
    expect(db.agent('a1')?.smartRouting).toBeUndefined()
  })

  it('keeps the agent on its own model while no pool has one, as the tab promises', async () => {
    settings.routing = routed({ pools: { ...routed().pools, t2: { descriptor: 't2', chain: [] } } })
    let asked = 0
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => (asked++, Response.json(answer()))) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()
    expect(asked).toBe(0)
    expect(replies()[0]?.run?.status).toBe('done')
    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
    expect(replies()[0]?.run?.route).toBeUndefined()
  })

  it('says routing was unavailable, and still replies, when TypeSafe does not answer', async () => {
    settings.routing = routed()
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    const [reply] = replies()
    expect(reply?.run?.status).toBe('done')
    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
    expect(reply!.run!.route!.state).toBe('unavailable')
    expect(reply!.run!.route!.error).toContain('TypeSafe')
  })

  it('does not send the reply when a good reading leaves nothing eligible', async () => {
    // A t2 reading, and the only model is in tier 5: routing never searches upward.
    settings.routing = routed({ pools: { ...routed().pools, t2: { descriptor: 't2', chain: [] }, t5: { descriptor: 't5', chain: [target('pi', 'openai-codex/gpt-6.1-sol', 'high')] } } })
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    const [reply] = replies()
    expect(turns).toHaveLength(0) // no engine was launched
    expect(reply?.run?.status).toBe('failed')
    expect(reply!.run!.route!.state).toBe('exhausted')
    expect(reply!.run!.error).toMatch(/not sent|não foi enviada/)
  })

  it('runs a routed reply on the login the chain entry names', async () => {
    settings.accounts = [{ id: 'acc-2', engine: 'codex', name: 'work', loggedIn: true } as unknown as NonNullable<Settings['accounts']>[number]]
    settings.routing = routed({ pools: { ...routed().pools, t2: { descriptor: 't2', chain: [{ ...target('codex', 'gpt-5.6-luna', 'high'), accountId: 'acc-2' }] } } })
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    const trace = replies()[0]!.run!.route!
    expect(trace.selected?.accountId).toBe('acc-2')
    expect(turns.at(-1)).toMatchObject({ model: 'gpt-5.6-luna' })
  })

  it('keeps the bars of a finished turn in the saved message, without recomputing them', async () => {
    settings.routing = routed()
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()
    const saved = db.messages().find((m) => m.author.kind === 'agent')!
    // Settings change after the fact: what happened stays what happened.
    settings.routing = routed({ enabled: false })
    const again = db.message(saved.id)!
    expect(again.run?.route?.reading).toMatchObject({ role: 'code', confidence: 0.9, complexity: 1, capability: 1 })
    expect(again.run?.route?.requested).toBe('t2')
    expect(again.run?.route?.selected).toEqual(target('codex', 'gpt-5.6-luna', 'high'))
  })
})

describe('the four questions, read back', () => {
  it('gives the same judgment the tiers are walked with', () => {
    const j = readAnswer(answer('code', 3, 2), 12, defaultRouting().roles)
    expect('error' in j).toBe(false)
    expect(j).toMatchObject({ role: 'code', complexity: 3, capability: 2, ms: 12 })
    expect(customModel('pi', 'openai-codex/gpt-6.1-sol')).toBe('pi:openai-codex/gpt-6.1-sol')
  })
})
