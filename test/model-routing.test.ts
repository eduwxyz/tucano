import { describe, expect, it } from 'vitest'
import {
  defaultRouting,
  normalizeRouting,
  pickRoute,
  poolFor,
  readAnswer,
  readPrompt,
  readingBody,
  readingLine,
  roleBars,
  type RouteJudgment,
  type RoutingConfig
} from '../src/core/model-routing'

const judgment = (patch: Partial<RouteJudgment> = {}): RouteJudgment => ({
  role: 'code',
  roleConfidence: 0.8,
  roleProbabilities: { code: 0.8, review: 0.15, chat: 0.05 },
  complexity: 1,
  capability: 1,
  deepReasoning: 0.3,
  ms: 120,
  ...patch
})

// A configured setup: two models per pool, so availability has something to skip.
const config = (patch: Partial<RoutingConfig> = {}): RoutingConfig => {
  const base = defaultRouting()
  const pool = (model: string) => ({ descriptor: model, chain: [{ engine: 'codex' as const, model, effort: 'medium' as const }] })
  return {
    ...base,
    enabled: true,
    pools: { free: pool('free-1'), t1: pool('t1-1'), t2: pool('t2-1'), t3: pool('t3-1'), t4: pool('t4-1'), t5: pool('t5-1') },
    roles: { ...base.roles, plan: { descriptor: 'plan', chain: [{ engine: 'codex', model: 'planner', effort: 'high' }] } },
    ...patch
  }
}

describe('the default setup', () => {
  it('has the six pools and the four named roles, off until the person turns it on', () => {
    const c = defaultRouting()
    expect(Object.keys(c.pools)).toEqual(['free', 't1', 't2', 't3', 't4', 't5'])
    expect(Object.keys(c.roles)).toEqual(['code', 'review', 'plan', 'debug', 'research', 'write', 'explain', 'operate', 'chat'])
    expect(c.enabled).toBe(false)
    for (const p of Object.values(c.pools)) expect(p.chain).toEqual([])
    expect(c.roleFloor).toEqual({ plan: 't3', review: 't3' })
  })
})

describe('what is asked of Jev', () => {
  it('asks four questions, the roles being the options of the first', () => {
    const body = readingBody({ prompt: 'conserta o build', history: 'x'.repeat(9000), roles: config().roles }) as any
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions)).toEqual(['acao', 'complexidade', 'capacidade', 'raciocinio'])
    expect(body.questions.acao.type).toBe('choice')
    expect(Object.keys(body.questions.acao.criteria).sort()).toEqual(Object.keys(config().roles).sort())
    expect(body.questions.complexidade.criteria).toHaveLength(4)
    expect(body.questions.capacidade.criteria).toHaveLength(4)
    expect(body.questions.raciocinio.type).toBe('noul')
    expect(body.state.pedido).toBe('conserta o build')
    expect(body.state.conversa).toHaveLength(4000)
  })

  it('reads the answer: role, confidence, both scores and the reasoning bit', () => {
    const answer = {
      answers: {
        acao: { choice: 'code', confidence: 0.71, probabilities: { code: 0.71, plan: 0.29 } },
        complexidade: { score: 2, confidence: 0.6 },
        capacidade: { score: 3 },
        raciocinio: { noul: 0.9 }
      }
    }
    const j = readAnswer(answer, 210, config().roles)
    expect(j).toMatchObject({ role: 'code', roleConfidence: 0.71, complexity: 2, capability: 3, deepReasoning: 0.9, ms: 210 })
  })

  it('refuses a role nobody offered and a payload without answers', () => {
    expect(readAnswer({ answers: { acao: { choice: 'astrology' } } }, 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer({}, 1, config().roles)).toEqual({ error: expect.any(String) })
  })

  it('falls back to the chat role when Jev answers no choice, and clamps wild numbers', () => {
    const j = readAnswer({ answers: { complexidade: { score: 9 }, capacidade: { score: -4 }, raciocinio: { noul_score: 3 } } }, 5, {})
    expect(j).toMatchObject({ role: 'chat', complexity: 3, capability: 0, deepReasoning: 1 })
  })
})

describe('the TypeSafe call', () => {
  const ok = (payload: unknown): typeof fetch =>
    (async () => Response.json(payload)) as unknown as typeof fetch

  it('sends the key and the body, and judges what comes back', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return Response.json({ answers: { acao: { choice: 'plan', confidence: 0.9 }, complexidade: { score: 3 }, capacidade: { score: 2 }, raciocinio: { noul: 1 } } })
    }) as unknown as typeof fetch
    const j = await readPrompt({ key: 'k-1', prompt: 'planeja o módulo', roles: config().roles, fetch: f })
    expect(j).toMatchObject({ role: 'plan', complexity: 3, capability: 2 })
    expect(seen!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer k-1')
  })

  it('says what went wrong instead of throwing: a dead key, a busy API, an unreadable answer', async () => {
    expect(await readPrompt({ key: 'k', prompt: 'p', roles: config().roles, fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch })).toEqual({ error: expect.stringContaining('TypeSafe') })
    expect(await readPrompt({ key: 'k', prompt: 'p', roles: config().roles, fetch: (async () => new Response('', { status: 429 })) as unknown as typeof fetch })).toEqual({ error: expect.any(String) })
    expect(await readPrompt({ key: 'k', prompt: 'p', roles: config().roles, fetch: ok({}) })).toEqual({ error: expect.any(String) })
    expect(await readPrompt({ key: 'k', prompt: 'p', roles: config().roles, fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch })).toEqual({ error: expect.any(String) })
  })
})

describe('the pool a judgment asks for', () => {
  const c = config()

  it('sends cheap work to the free pool, and stops doing that when told to', () => {
    expect(poolFor(judgment({ complexity: 0, capability: 0, deepReasoning: 0.1 }), c).pool).toBe('free')
    expect(poolFor(judgment({ complexity: 0, capability: 0, deepReasoning: 0.1 }), { ...c, freeWhenCheap: false }).pool).toBe('t1')
  })

  it('climbs with the work: everyday to tier 2, real work to tier 3, hard to tier 4', () => {
    expect(poolFor(judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 }), c).pool).toBe('t2')
    expect(poolFor(judgment({ complexity: 2, capability: 2, deepReasoning: 0.5 }), c).pool).toBe('t3')
    expect(poolFor(judgment({ complexity: 3, capability: 2, deepReasoning: 0.5 }), c).pool).toBe('t4')
  })

  it('lets extended reasoning push the pool up, and recall push it down', () => {
    const base = judgment({ complexity: 1, capability: 1, deepReasoning: 0.5 })
    expect(poolFor({ ...base, deepReasoning: 1 }, c).pool).toBe('t3')
    expect(poolFor(judgment({ complexity: 0, capability: 1, deepReasoning: 0.1 }), c).pool).toBe('free')
  })

  it('keeps planning off the cheap pools', () => {
    const cheapPlan = judgment({ role: 'plan', complexity: 0, capability: 0, deepReasoning: 0.1 })
    expect(poolFor(cheapPlan, c).pool).toBe('t3')
    // The note is the person's language's; what matters is that it names the role and its pool.
    expect(poolFor(cheapPlan, c).notes.join(' ')).toMatch(/plan.*t3/)
  })

  it('spends tier 5 only on the hardest work it is sure about', () => {
    const hardest = judgment({ complexity: 3, capability: 3, deepReasoning: 1, roleConfidence: 0.9 })
    expect(poolFor(hardest, c).pool).toBe('t5')
    expect(poolFor({ ...hardest, roleConfidence: 0.2 }, c).pool).toBe('t2')
  })

  it('comes down a tier when the role is a guess', () => {
    const unsure = judgment({ complexity: 3, capability: 3, deepReasoning: 1, roleConfidence: 0.2 })
    const { pool, notes } = poolFor(unsure, c)
    expect(pool).toBe('t2')
    expect(notes.join(' ')).toMatch(/t2/)
  })
})

describe('the model to run', () => {
  const c = config()

  it('takes the first model of the chosen pool', () => {
    const r = pickRoute(judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 }), c)
    expect(r.target).toEqual({ engine: 'codex', model: 't2-1', effort: 'medium' })
    expect(r.roleSpecialised).toBe(false)
  })

  it('prefers the role own chain when the pool is high enough', () => {
    const r = pickRoute(judgment({ role: 'plan', complexity: 3, capability: 3, deepReasoning: 1, roleConfidence: 0.9 }), c)
    expect(r.target).toEqual({ engine: 'codex', model: 'planner', effort: 'high' })
    expect(r.roleSpecialised).toBe(true)
  })

  it('does not consult the role chain once an unsure read has brought the pool below its floor', () => {
    // Planning floors at t3, but a guess is a guess: t2, and the planner is not spent on it.
    const r = pickRoute(judgment({ role: 'plan', complexity: 3, capability: 3, deepReasoning: 1, roleConfidence: 0.3 }), c)
    expect(r.pool).toBe('t2')
    expect(r.roleSpecialised).toBe(false)
    expect(r.target?.model).toBe('t2-1')
  })

  it('walks to the next pool when a model is missing or unusable', () => {
    const r = pickRoute(judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 }), c, (t) => t.model !== 't2-1')
    expect(r.target?.model).toBe('t1-1')
    const up = pickRoute(judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 }), c, (t) => t.model !== 't2-1' && t.model !== 't1-1' && t.model !== 'free-1')
    expect(up.target?.model).toBe('t3-1')
  })

  it('says so when nothing in the pools can run', () => {
    const r = pickRoute(judgment(), c, () => false)
    expect(r.target).toBeUndefined()
    expect(r.notes).toHaveLength(1)
  })
})

describe('the line the person reads', () => {
  it('names the role, the two scores and the pool, and bars come best first', () => {
    const c = config()
    const j = judgment({ role: 'review', roleProbabilities: { code: 0.1, review: 0.7, plan: 0.2 }, complexity: 2, capability: 3, deepReasoning: 0.8 })
    expect(readingLine(j, c)).toContain('review')
    expect(readingLine(j, c)).toContain('→ t5')
    expect(roleBars(j, 2)).toEqual([{ role: 'review', p: 0.7 }, { role: 'plan', p: 0.2 }])
  })
})

describe('what may be saved', () => {
  it('keeps a good config and drops the rest', () => {
    const saved = {
      enabled: true,
      pools: { t2: { descriptor: 'everyday', chain: [{ engine: 'pi', model: 'openai-codex/gpt-6-sol', effort: 'high' }, { engine: 'nope', model: 'x' }, { engine: 'codex', model: '' }] } },
      roles: { code: { descriptor: 'code', chain: [{ engine: 'claude', model: 'sonnet', effort: 'max' }] }, 'bad key!': { chain: [] } },
      roleFloor: { plan: 't4', ghost: 't2' },
      confidenceFloor: 4,
      extra: 'ignored'
    }
    const c = normalizeRouting(saved)
    expect(c.enabled).toBe(true)
    expect(c.pools.t2.chain).toEqual([{ engine: 'pi', model: 'openai-codex/gpt-6-sol', effort: 'high' }])
    expect(c.pools.t1.chain).toEqual([])
    expect(c.roles.code!.chain).toEqual([{ engine: 'claude', model: 'sonnet', effort: 'medium' }]) // 'max' is not a level here
    expect(c.roles['bad key!']).toBeUndefined()
    expect(c.roleFloor).toEqual({ plan: 't4' })
    expect(c.confidenceFloor).toBe(1)
  })

  it('takes anything at all and still gives a usable setup', () => {
    expect(normalizeRouting(null).roles.code).toBeDefined()
    expect(normalizeRouting('rubbish').enabled).toBe(false)
    expect(normalizeRouting({ pools: { t1: { chain: Array.from({ length: 99 }, () => ({ engine: 'codex', model: 'm', effort: 'low' })) } } }).pools.t1.chain).toHaveLength(40)
  })
})
