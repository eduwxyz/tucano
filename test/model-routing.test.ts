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
  validateRouting,
  decideRoute,
  demandOf,
  unavailableTrace,
  targetId,
  KIND_IMPORT,
  MAX_CHAIN,
  type RouteJudgment,
  type RoutingConfig
} from '../src/core/model-routing'

const target = (engine: 'codex' | 'pi' | 'claude', model: string, effort: 'low' | 'medium' | 'high' | 'xhigh' = 'medium', accountId?: string) => {
  const id = targetId({ engine, ...(accountId ? { accountId } : {}), model, effort })
  return { id, engine, ...(accountId ? { accountId } : {}), model, effort }
}

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

// A configured setup: one model per pool, so availability has something to skip.
const config = (patch: Partial<RoutingConfig> = {}): RoutingConfig => {
  const base = defaultRouting()
  const pool = (model: string) => ({ descriptor: model, chain: [target('codex', model)] })
  return {
    ...base,
    enabled: true,
    pools: { free: pool('free-1'), t1: pool('t1-1'), t2: pool('t2-1'), t3: pool('t3-1'), t4: pool('t4-1'), t5: pool('t5-1') },
    ...patch
  }
}

const answer = (patch: Record<string, unknown> = {}): unknown => ({
  answers: {
    acao: { choice: 'code', confidence: 0.9, probabilities: { code: 0.9, review: 0.1 } },
    complexidade: { score: 1 },
    capacidade: { score: 1 },
    raciocinio: { noul: 0.1 },
    ...patch
  }
})

describe('the default setup', () => {
  it('has six pools, ten roles and the free pool as a separate destination', () => {
    const c = defaultRouting()
    expect(Object.keys(c.pools)).toEqual(['free', 't1', 't2', 't3', 't4', 't5'])
    expect(Object.keys(c.roles)).toEqual(['code', 'review', 'plan', 'debug', 'refactor', 'research', 'write', 'explain', 'operate', 'chat'])
    expect(c.enabled).toBe(false)
    expect(c.allowTier5).toBe(false) // the dearest pool has to be switched on as well as filled
    expect(c.free.policy).toBe('prefer')
    expect(c.roleFloor).toEqual({ plan: 't3', review: 't3' })
    for (const p of Object.values(c.pools)) expect(p.chain).toEqual([])
  })

  it('keeps the plugin ten kinds, its implement being Code here', () => {
    expect(KIND_IMPORT.implement).toBe('code')
    expect(Object.keys(defaultRouting().roles)).toHaveLength(10)
  })
})

describe('what is asked of Jev', () => {
  it('asks four questions, the roles being the options of the first', () => {
    const body = readingBody({ prompt: 'conserta o build', history: 'x'.repeat(9000), roles: config().roles }) as any
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions)).toEqual(['acao', 'complexidade', 'capacidade', 'raciocinio'])
    expect(Object.keys(body.questions.acao.criteria).sort()).toEqual(Object.keys(config().roles).sort())
    expect(body.questions.raciocinio.type).toBe('noul')
    expect(body.state.conversa).toHaveLength(4000)
  })
})

describe('reading the answer strictly', () => {
  it('reads a good answer: role, confidence, both scores and the reasoning bit', () => {
    const j = readAnswer(answer(), 210, config().roles)
    expect(j).toMatchObject({ role: 'code', roleConfidence: 0.9, complexity: 1, capability: 1, deepReasoning: 0.1, ms: 210 })
  })

  it('refuses an empty answer instead of inventing a chat with 1/1/0', () => {
    expect(readAnswer({ answers: {} }, 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer({}, 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer(null, 1, config().roles)).toEqual({ error: expect.any(String) })
  })

  it('refuses a missing or impossible score, and a missing reasoning answer', () => {
    expect(readAnswer(answer({ complexidade: {} }), 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer(answer({ capacidade: { score: 7 } }), 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer(answer({ complexidade: { score: -1 } }), 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer(answer({ raciocinio: {} }), 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer(answer({ raciocinio: { noul: 4 } }), 1, config().roles)).toEqual({ error: expect.any(String) })
  })

  it('refuses a role nobody offered and a confidence outside 0..1', () => {
    expect(readAnswer(answer({ acao: { choice: 'astrology', confidence: 0.9 } }), 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer(answer({ acao: { choice: 'code', confidence: 1.4 } }), 1, config().roles)).toEqual({ error: expect.any(String) })
  })

  it('treats a confidence that is not given as unknown, not as zero', () => {
    const j = readAnswer(answer({ acao: { choice: 'code' } }), 1, config().roles)
    expect('error' in j).toBe(false)
    expect((j as RouteJudgment).roleConfidence).toBeUndefined()
    // A probability for the winning role is a confidence too.
    const withProbabilities = readAnswer(answer({ acao: { choice: 'code', probabilities: { code: 0.62 } } }), 1, config().roles)
    expect((withProbabilities as RouteJudgment).roleConfidence).toBe(0.62)
  })

  it('refuses malformed probabilities rather than dropping them quietly', () => {
    expect(readAnswer(answer({ acao: { choice: 'code', confidence: 0.5, probabilities: { code: 'high' } } }), 1, config().roles)).toEqual({ error: expect.any(String) })
    expect(readAnswer(answer({ acao: { choice: 'code', confidence: 0.5, probabilities: ['code'] } }), 1, config().roles)).toEqual({ error: expect.any(String) })
  })

  it('maps the plugin naming into Tucano roles', () => {
    const j = readAnswer(answer({ acao: { choice: 'implement', confidence: 0.7 } }), 1, config().roles)
    expect((j as RouteJudgment).role).toBe('code')
  })
})

describe('the TypeSafe call', () => {
  it('sends the key and the body, and judges what comes back', async () => {
    let seen: RequestInit | undefined
    const j = await readPrompt({
      key: 'k-1',
      prompt: 'oi',
      roles: config().roles,
      fetch: (async (_url: string, init: RequestInit) => {
        seen = init
        return Response.json(answer())
      }) as unknown as typeof fetch
    })
    expect((seen?.headers as Record<string, string>).Authorization).toBe('Bearer k-1')
    expect((j as RouteJudgment).role).toBe('code')
  })

  it('says what went wrong instead of throwing: a dead key, an unreadable answer', async () => {
    const dead = await readPrompt({ key: 'k', prompt: 'oi', roles: config().roles, fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch })
    expect('error' in dead && dead.error).toContain('TypeSafe')
    const junk = await readPrompt({ key: 'k', prompt: 'oi', roles: config().roles, fetch: (async () => Response.json({ answers: {} })) as unknown as typeof fetch })
    expect('error' in junk).toBe(true)
  })
})

describe('the capability tier a reading asks for', () => {
  it('climbs with the work', () => {
    expect(poolFor(judgment({ complexity: 0, capability: 0, deepReasoning: 0.1 }), config()).requested).toBe('t1')
    expect(poolFor(judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 }), config()).requested).toBe('t2')
    expect(poolFor(judgment({ complexity: 2, capability: 2, deepReasoning: 0.3 }), config()).requested).toBe('t3')
    expect(poolFor(judgment({ complexity: 3, capability: 2, deepReasoning: 0.5 }), config()).requested).toBe('t4')
  })

  it('spends tier 5 only on the hardest work, only when it is switched on and filled, and only when sure', () => {
    const top = judgment({ complexity: 3, capability: 3, deepReasoning: 1, roleConfidence: 0.9 })
    const on = config({ allowTier5: true })
    expect(poolFor(top, on).requested).toBe('t5')
    // Switched off: tier 4, and the note says why.
    const off = poolFor(top, config())
    expect(off.requested).toBe('t4')
    expect(off.notes.join(' ')).toMatch(/tier 5/)
    // Switched on but empty: still tier 4.
    const empty = poolFor(top, config({ allowTier5: true, pools: { ...config().pools, t5: { descriptor: 't5', chain: [] } } }))
    expect(empty.requested).toBe('t4')
    expect(empty.notes.join(' ')).toMatch(/model/)
  })

  it('keeps the reading at tier 3 when tier 4 is switched off, and lets a floor lift it there', () => {
    const dear = judgment({ complexity: 3, capability: 2, deepReasoning: 0.5 }) // a t4 demand
    const off = poolFor(dear, config({ allowTier4: false }))
    expect(off.requested).toBe('t3')
    expect(off.notes.join(' ')).toMatch(/tier 4/)
    // A floor is the person's own call, so it still reaches tier 4 with the switch off.
    const floored = poolFor(judgment({ role: 'plan', complexity: 0, capability: 0, deepReasoning: 0.1 }), config({ allowTier4: false, roleFloor: { plan: 't4' } }))
    expect(floored.policy).toBe('t4')
    // The switch alone does not stop a floor, and it is the switch that is off, not the pool.
    expect(poolFor(dear, config()).requested).toBe('t4') // open by default
  })

  it('never spends tier 5 while tier 4 is switched off', () => {
    const top = judgment({ complexity: 3, capability: 3, deepReasoning: 1, roleConfidence: 0.9 })
    const both = config({ allowTier4: false, allowTier5: true })
    expect(poolFor(top, both).requested).toBe('t3')
    expect(poolFor(top, both).notes.join(' ')).toMatch(/tier 4/)
    // With tier 4 open, the same read and switch reach tier 5.
    expect(poolFor(top, config({ allowTier5: true })).requested).toBe('t5')
  })

  it('parses the tier 4 switch as open unless a setup says otherwise', () => {
    const base = defaultRouting()
    expect(base.allowTier4).toBe(true)
    expect(normalizeRouting({ ...base, allowTier4: false }).allowTier4).toBe(false)
    const { allowTier4: _drop, ...without } = base as unknown as Record<string, unknown>
    expect(normalizeRouting(without).allowTier4).toBe(true) // a setup written before the switch existed
    expect(validateRouting({ ...base, allowTier4: 'yes' }).ok).toBe(false)
  })

  it('caps an unsure read at tier 2, and an unknown confidence the same way', () => {
    const top = judgment({ complexity: 3, capability: 3, deepReasoning: 1 })
    expect(poolFor({ ...top, roleConfidence: 0.1 }, config({ allowTier5: true })).policy).toBe('t2')
    expect(poolFor({ ...top, roleConfidence: undefined }, config({ allowTier5: true })).policy).toBe('t2')
    // Unknown confidence cannot unlock tier 5 either, whatever the scores say.
    expect(poolFor({ ...top, roleConfidence: undefined }, config({ allowTier5: true })).requested).toBe('t4')
  })

  it('lets a role floor lift the tier but never unlock tier 5 on its own', () => {
    const cheap = judgment({ role: 'plan', complexity: 0, capability: 0, deepReasoning: 0.1 })
    const floored = poolFor(cheap, config({ roleFloor: { plan: 't3' } }))
    expect(floored.requested).toBe('t1')
    expect(floored.policy).toBe('t3')
    const greedy = poolFor(cheap, config({ roleFloor: { plan: 't5' }, allowTier5: true }))
    expect(greedy.requested).toBe('t1')
    expect(greedy.policy).toBe('t4') // a floor is not a qualification
    expect(greedy.notes.join(' ')).toMatch(/tier 5|t5/)
  })

  it('keeps the raw demand apart from what the policy policed', () => {
    const raw = judgment({ complexity: 3, capability: 3, deepReasoning: 1 })
    expect(demandOf(raw)).toBe(3)
    const capped = poolFor({ ...raw, roleConfidence: 0.05 }, config())
    expect(capped.rawDemand).toBe(3)
    expect(capped.policy).toBe('t2')
  })
})

describe('the chains walked', () => {
  it('never searches upward: a t2 reading does not reach the tier 5 chain', () => {
    const readable = judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 })
    const only = config({ pools: { ...defaultRouting().pools, t2: { descriptor: 't2', chain: [] }, t5: { descriptor: 't5', chain: [target('codex', 't5-1')] } } })
    const r = pickRoute(readable, only)
    expect(poolFor(readable, only).policy).toBe('t2')
    expect(r.target).toBeUndefined()
    expect(r.notes.join(' ')).toMatch(/no eligible|nenhum modelo elegível/)
  })

  it('walks the free pool first when the person prefers it, and keeps the tier the reading asked for', () => {
    const c = config({ free: { policy: 'prefer' } })
    const d = decideRoute(judgment({ complexity: 3, capability: 2, deepReasoning: 0.5 }), c, () => undefined, target('claude', 'sonnet', 'low'))
    expect(d.kind).toBe('selected')
    if (d.kind !== 'selected') return
    expect(d.trace.selected?.model).toBe('free-1')
    expect(d.trace.effective).toBe('free')
    expect(d.trace.requested).toBe('t4') // judged tier 4, served by free
  })

  it('walks down to the nearest tier that can run, and reports the tier it landed on', () => {
    const c = config({ free: { policy: 'off' }, pools: { ...config().pools, t4: { descriptor: 't4', chain: [] }, t3: { descriptor: 't3', chain: [target('codex', 't3-1')] } } })
    const d = decideRoute(judgment({ complexity: 3, capability: 2, deepReasoning: 0.5 }), c, () => undefined, target('claude', 'sonnet', 'low'))
    if (d.kind !== 'selected') throw new Error('expected a route')
    expect(d.trace.requested).toBe('t4')
    expect(d.trace.effective).toBe('t3')
    expect(d.trace.selected?.model).toBe('t3-1')
  })

  it('tries a role specialist before the tier, but only from the tier it is eligible for', () => {
    const planner = { ...target('pi', 'openai-codex/gpt-6.1-sol', 'high'), minTier: 't4' as const }
    const c = config({
      free: { policy: 'off' },
      roles: { ...defaultRouting().roles, plan: { descriptor: 'plan', chain: [planner] } },
      roleFloor: { plan: 't2' }
    })
    const high = pickRoute(judgment({ role: 'plan', complexity: 3, capability: 3, deepReasoning: 1 }), c)
    expect(high.target?.model).toBe('openai-codex/gpt-6.1-sol')
    expect(high.source).toBe('role')
    // A cheaper reading is not allowed to spend the t4 specialist.
    const low = pickRoute(judgment({ role: 'plan', complexity: 0, capability: 0, deepReasoning: 0.1 }), c)
    expect(low.target?.model).not.toBe('openai-codex/gpt-6.1-sol')
  })

  it('tries the free pool last when it is only a fallback', () => {
    const c = config({ free: { policy: 'fallback' }, pools: { ...config().pools, t3: { descriptor: 't3', chain: [] }, t2: { descriptor: 't2', chain: [] }, t1: { descriptor: 't1', chain: [] } } })
    const r = pickRoute(judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 }), c)
    expect(r.target?.model).toBe('free-1')
    expect(r.source).toBe('free')
  })

  it('keeps every candidate it passed over, with the reason, and never the same one twice', () => {
    const twice = target('codex', 'shared', 'medium')
    const c = config({ free: { policy: 'off' }, pools: { ...config().pools, t3: { descriptor: 't3', chain: [twice] }, t2: { descriptor: 't2', chain: [twice] } } })
    const w = decideRoute(judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 }), c, () => 'sem login', target('claude', 'sonnet', 'low'))
    expect(w.kind).toBe('exhausted')
    expect(w.trace.attempts.filter((a) => a.model === 'shared')).toHaveLength(1)
    expect(w.trace.attempts.every((a) => a.skip)).toBe(true)
  })
})

describe('the trace of a routed turn', () => {
  const baseline = target('claude', 'sonnet', 'low')

  it('says changed when another model runs, with the reading and the tiers', () => {
    const d = decideRoute(judgment({ complexity: 2, capability: 2, deepReasoning: 0.5 }), config({ free: { policy: 'off' } }), () => undefined, baseline)
    if (d.kind !== 'selected') throw new Error('expected a route')
    expect(d.trace.state).toBe('changed')
    expect(d.trace.selected).toEqual(target('codex', 't3-1'))
    expect(d.trace.requested).toBe('t3')
    expect(d.trace.effective).toBe('t3')
    expect(d.trace.reading).toMatchObject({ role: 'code', confidence: 0.8, complexity: 2, capability: 2, deepReasoning: 0.5 })
    expect(d.trace.baseline).toEqual(baseline)
  })

  it('says kept, with the reason, when the walk lands on the model the agent already had', () => {
    const c = config({ free: { policy: 'off' }, pools: { ...config().pools, t2: { descriptor: 't2', chain: [baseline] } } })
    const d = decideRoute(judgment({ complexity: 1, capability: 1, deepReasoning: 0.3 }), c, () => undefined, baseline)
    if (d.kind !== 'selected') throw new Error('expected a route')
    expect(d.trace.state).toBe('kept')
    expect(d.trace.notes.join(' ')).toMatch(/baseline|base/)
  })

  it('says fallback when the first choice could not run', () => {
    const d = decideRoute(judgment(), config(), (t) => (t.model === 'free-1' ? 'sem login' : undefined), baseline)
    if (d.kind !== 'selected') throw new Error('expected a route')
    expect(d.trace.state).toBe('fallback')
    expect(d.trace.attempts.map((a) => a.skip)).toEqual(['sem login', undefined])
  })

  it('reports exhaustion, and does not pretend a reserve ran', () => {
    const d = decideRoute(judgment(), config(), () => 'fora do ar', baseline)
    expect(d.kind).toBe('exhausted')
    expect(d.trace.state).toBe('exhausted')
    expect(d.trace.selected).toBeUndefined()
    expect(d.trace.error).toMatch(/not sent|não foi enviada/)
  })

  it('uses the configured reserve, but only from inside the ceiling the reading asked for', () => {
    const c = config({ free: { policy: 'off' }, fallbackTargetId: 'reserve' })
    const withReserve = config({ free: { policy: 'off' }, pools: { ...c.pools, t1: { descriptor: 't1', chain: [target('codex', 'reserve', 'low')] } }, fallbackTargetId: 'reserve' })
    const ok = decideRoute(judgment({ complexity: 3, capability: 3, deepReasoning: 1 }), withReserve, (t) => (t.model === 'reserve' ? undefined : 'fora do ar'), baseline)
    if (ok.kind !== 'selected') throw new Error('expected the reserve')
    expect(ok.trace.selected?.model).toBe('reserve')
    expect(ok.trace.effective).toBe('t1')
    // The same reserve above the ceiling is not eligible: a t1 reading never reaches it.
    const above = config({
      free: { policy: 'off' },
      pools: { ...c.pools, t1: { descriptor: 't1', chain: [] }, t5: { descriptor: 't5', chain: [target('codex', 'reserve', 'low')] } },
      fallbackTargetId: 'reserve',
      allowTier5: true
    })
    const blocked = decideRoute(judgment({ complexity: 0, capability: 0, deepReasoning: 0.1 }), above, () => undefined, baseline)
    expect(blocked.kind).toBe('exhausted')
  })

  it('holds the reading even when routing could not decide, and leaves the baseline to run', () => {
    const t = unavailableTrace(undefined, config(), 'falta a chave do TypeSafe', baseline)
    expect(t.state).toBe('unavailable')
    expect(t.error).toContain('TypeSafe')
    expect(t.selected).toBeUndefined()
    expect(t.baseline).toEqual(baseline)
    expect(t.reading.role).toBe('chat')
  })
})

describe('the line the person reads', () => {
  it('names the role, the scores and the requested tier, bars best first', () => {
    const c = config({ allowTier5: true })
    const j = judgment({ role: 'review', roleProbabilities: { code: 0.1, review: 0.7, plan: 0.2 }, complexity: 3, capability: 3, deepReasoning: 1 })
    expect(readingLine(j, c)).toContain('review')
    expect(readingLine(j, c)).toContain('→ t5')
    expect(roleBars(j, 2)).toEqual([{ role: 'review', p: 0.7 }, { role: 'plan', p: 0.2 }])
  })
})

describe('what may be saved', () => {
  it('reads an old setup tolerantly, giving every entry its identity', () => {
    const saved = {
      enabled: true,
      pools: {
        t2: { descriptor: 'everyday', chain: [{ engine: 'pi', model: 'openai-codex/gpt-6-sol', effort: 'high' }, { engine: 'nope', model: 'x', effort: 'low' }, { engine: 'codex', model: '', effort: 'low' }] }
      },
      roles: { code: { descriptor: 'code', chain: [{ engine: 'claude', model: 'sonnet', effort: 'low', minTier: 't3' }] }, 'bad key!': { chain: [] } },
      roleFloor: { plan: 't4', ghost: 't2' },
      confidenceFloor: 4,
      freeWhenCheap: false,
      extra: 'ignored'
    }
    const c = normalizeRouting(saved)
    expect(c.enabled).toBe(true)
    expect(c.pools.t2.chain).toEqual([target('pi', 'openai-codex/gpt-6-sol', 'high')])
    expect(c.pools.t1.chain).toEqual([])
    expect(c.roles.code!.chain[0]).toMatchObject({ model: 'sonnet', minTier: 't3' })
    expect(c.roles['bad key!']).toBeUndefined()
    expect(c.roleFloor).toEqual({ plan: 't4' })
    expect(c.confidenceFloor).toBe(1)
    expect(c.free.policy).toBe('off') // the old boolean, read for what it meant
  })

  it('drops what it cannot run instead of turning it into something else', () => {
    const c = normalizeRouting({ roles: { code: { chain: [{ engine: 'claude', model: 'sonnet', effort: 'max' }] } } })
    expect(c.roles.code!.chain).toEqual([]) // 'max' is not a level here, and no Medium is invented
  })

  it('takes anything at all and still gives a usable setup, bounded', () => {
    expect(normalizeRouting(null).roles.code).toBeDefined()
    expect(normalizeRouting('rubbish').enabled).toBe(false)
    expect(normalizeRouting({ pools: { t1: { chain: Array.from({ length: 99 }, (_, i) => ({ engine: 'codex', model: `m${i}`, effort: 'low' })) } } }).pools.t1.chain).toHaveLength(MAX_CHAIN)
    const dangerous = normalizeRouting({ roles: JSON.parse('{"__proto__":{"descriptor":"x","chain":[]}}') })
    expect(Object.hasOwn(dangerous.roles, '__proto__')).toBe(false)
    expect(KIND_IMPORT.implement).toBe('code')
  })

  it('refuses a save it cannot run, naming where it is, instead of silently fixing it', () => {
    const bad = validateRouting({ pools: { t2: { descriptor: 'x', chain: [{ engine: 'claude', model: 'sonnet', effort: 'max' }] } } })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.problems[0]?.path).toBe('pools.t2.chain[0].effort')
    expect(validateRouting({ confidenceFloor: 3 }).ok).toBe(false)
    expect(validateRouting({ roles: { code: { chain: [{ engine: 'nope', model: 'x', effort: 'low' }] } } }).ok).toBe(false)
  })

  it('accepts a save that only uses what this build has', () => {
    const good = validateRouting({ enabled: true, pools: { t2: { descriptor: 'everyday', chain: [{ engine: 'pi', model: 'openai-codex/gpt-6-sol', effort: 'xhigh', accountId: 'acc-1' }] } }, confidenceFloor: 0.5, allowTier5: true })
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.value.pools.t2.chain[0]).toMatchObject({ model: 'openai-codex/gpt-6-sol', effort: 'xhigh', accountId: 'acc-1' })
  })
})
