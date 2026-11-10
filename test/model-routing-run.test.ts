import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { defaultRouting, type RoutingConfig } from '../src/shared/routing'
import { customModel, type Agent, type EngineId, type Message, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { decideRoute, unavailableTrace, readAnswer, walkRoute, type RouteJudgment } from '../src/core/model-routing'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const judgment = (patch: Partial<RouteJudgment> = {}): RouteJudgment => ({
  role: 'code',
  roleConfidence: 0.8,
  roleProbabilities: { code: 0.8, review: 0.15 },
  complexity: 1,
  capability: 1,
  deepReasoning: 0.3,
  ms: 90,
  ...patch
})

// Two pools filled, the rest empty: enough to watch the walk and the trace.
const config = (patch: Partial<RoutingConfig> = {}): RoutingConfig => {
  const base = defaultRouting()
  const pool = (model: string) => ({ descriptor: model, chain: [{ engine: 'codex' as const, model, effort: 'medium' as const }] })
  return { ...base, enabled: true, pools: { ...base.pools, t2: pool('t2-1'), t3: pool('t3-1') }, ...patch }
}

describe('the chain walked', () => {
  it('keeps every model it passed over, with the reason, and the one that ran', () => {
    const c = config()
    const w = walkRoute(judgment(), c, (t) => (t.model === 't2-1' ? 'não está logado' : undefined))
    expect(w.selected?.model).toBe('t3-1')
    expect(w.attempts).toEqual([
      { engine: 'codex', model: 't2-1', effort: 'medium', from: { kind: 'pool', pool: 't2' }, skip: 'não está logado' },
      { engine: 'codex', model: 't3-1', effort: 'medium', from: { kind: 'pool', pool: 't3' } }
    ])
  })

  it('says which chain each model came from: the role own first, then the pool', () => {
    const c = config({ roles: { ...defaultRouting().roles, code: { descriptor: 'code', chain: [{ engine: 'pi', model: 'openai-codex/gpt-6.1-sol', effort: 'high' }] } } })
    const w = walkRoute(judgment(), c, () => undefined)
    expect(w.selected?.model).toBe('openai-codex/gpt-6.1-sol')
    expect(w.roleSpecialised).toBe(true)
    expect(w.attempts[0]?.from).toEqual({ kind: 'role', role: 'code' })
  })
})

describe('the trace of a routed turn', () => {
  const baseline = { engine: 'claude' as const, model: 'sonnet', effort: 'low' as const }

  it('says changed when another model runs, with the reading, the pool and the demand', () => {
    const d = decideRoute(judgment({ complexity: 2, capability: 2, deepReasoning: 0.5 }), config(), () => undefined, baseline)
    expect(d?.trace.state).toBe('changed')
    expect(d?.trace.selected).toEqual({ engine: 'codex', model: 't3-1', effort: 'medium' })
    expect(d?.trace.pool).toBe('t3')
    expect(d?.trace.effective).toBe('t3')
    expect(d?.trace.reading).toMatchObject({ role: 'code', roleConfidence: 0.8, complexity: 2, capability: 2, deepReasoning: 0.5 })
    expect(d?.trace.baseline).toEqual(baseline)
    expect(d?.trace.attempts).toHaveLength(1)
    expect(d?.trace.attempts[0]?.skip).toBeUndefined()
  })

  it('says kept when the pool lands on the very model the agent already had', () => {
    const c = config({ pools: { ...defaultRouting().pools, t2: { descriptor: 't2', chain: [baseline] } } })
    const d = decideRoute(judgment(), c, () => undefined, baseline)
    expect(d?.trace.state).toBe('kept')
    expect(d?.trace.selected).toEqual(baseline)
  })

  it('says fallback when the first choice could not run, and names no effective pool for a role chain', () => {
    const d = decideRoute(judgment(), config(), (t) => (t.model === 't2-1' ? 'sem login' : undefined), baseline)
    expect(d?.trace.state).toBe('fallback')
    expect(d?.trace.attempts.map((a) => a.skip)).toEqual(['sem login', undefined])
  })

  it('has nothing to decide when no model in the pools can run', () => {
    expect(decideRoute(judgment(), config(), () => 'fora do ar', baseline)).toBeUndefined()
  })

  it('keeps what the config did to the read: the role floor and the confidence brake', () => {
    const floored = decideRoute(judgment({ role: 'plan', complexity: 0, capability: 0, deepReasoning: 0.1 }), config(), () => undefined, baseline)
    expect(floored?.trace.pool).toBe('t3')
    expect(floored?.trace.notes.join(' ')).toMatch(/plan.*t3/)
  })

  it('says why when routing could not decide at all, and leaves the baseline to run', () => {
    const t = unavailableTrace(undefined, config(), 'falta a chave do TypeSafe', baseline)
    expect(t.state).toBe('unavailable')
    expect(t.error).toContain('TypeSafe')
    expect(t.selected).toBeUndefined()
    expect(t.baseline).toEqual(baseline)
    expect(t.reading.role).toBe('chat')
  })
})

// ---------- the runner, with a fake TypeSafe ----------

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
  it('runs the reply on the pool the reading asks for, and keeps the trace on the message', async () => {
    settings.routing = { ...defaultRouting(), enabled: true, pools: { ...defaultRouting().pools, t2: { descriptor: 't2', chain: [{ engine: 'codex', model: 'gpt-5.6-luna', effort: 'high' }] } } }
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    const [reply] = replies()
    expect(reply?.run?.status).toBe('done')
    expect(turns.at(-1)).toMatchObject({ model: 'gpt-5.6-luna', effort: 'high' })
    expect(reply?.text).toContain('codex · gpt-5.6-luna')
    const trace = reply!.run!.route!
    expect(trace.state).toBe('changed')
    expect(trace.pool).toBe('t2')
    expect(trace.selected).toEqual({ engine: 'codex', model: 'gpt-5.6-luna', effort: 'high' })
    expect(trace.baseline).toEqual({ engine: 'claude', model: 'sonnet', effort: 'low' })
  })

  it('leaves an agent that has not opted in on its own model, with no trace', async () => {
    settings.routing = { ...defaultRouting(), enabled: true, pools: { ...defaultRouting().pools, t2: { descriptor: 't2', chain: [{ engine: 'codex', model: 'gpt-5.6-luna', effort: 'high' }] } } }
    db.saveAgent(agent('a1', 'lia'))
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
    expect(replies()[0]?.run?.route).toBeUndefined()
  })

  it('does nothing at all while routing is off, even for an agent that opted in', async () => {
    let asked = 0
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => (asked++, Response.json(answer()))) as unknown as typeof fetch } })
    await r.send('d1', 'oi')
    await r.idle()
    expect(asked).toBe(0)
    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
  })

  it('says routing was unavailable, and still replies, when TypeSafe does not answer', async () => {
    settings.routing = { ...defaultRouting(), enabled: true }
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    const [reply] = replies()
    expect(reply?.run?.status).toBe('done')
    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
    expect(reply!.run!.route!.state).toBe('unavailable')
    expect(reply!.run!.route!.error).toContain('TypeSafe')
  })

  it('falls back to the agent own model when no model in the pools can run', async () => {
    settings.routing = { ...defaultRouting(), enabled: true, pools: { ...defaultRouting().pools, t2: { descriptor: 't2', chain: [{ engine: 'pi', model: 'openai-codex/gpt-6.1-sol', effort: 'high' }] } } }
    settings.engines = { ...settings.engines, pi: { installed: false, loggedIn: false } }
    const r = runner({ jev: { key: async () => 'k-1', fetch: (async () => Response.json(answer())) as unknown as typeof fetch } })
    await r.send('d1', 'ajusta o readme')
    await r.idle()

    const [reply] = replies()
    expect(turns.at(-1)).toMatchObject({ model: 'sonnet' })
    expect(reply!.run!.route!.state).toBe('unavailable')
    expect(reply!.run!.route!.error).toMatch(/nenhum modelo|no model/)
  })
})

describe('the four questions, read back', () => {
  it('gives the same judgment the pools are walked with', () => {
    const j = readAnswer(answer('code', 3, 2), 12, defaultRouting().roles)
    expect('error' in j).toBe(false)
    expect(j).toMatchObject({ role: 'code', complexity: 3, capability: 2, ms: 12 })
    // And a custom model id stays what the harness takes.
    expect(customModel('pi', 'openai-codex/gpt-6.1-sol')).toBe('pi:openai-codex/gpt-6.1-sol')
  })
})
