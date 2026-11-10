// Smart model routing (Settings › Routing): Jev reads the prompt and says what kind of work it
// is and how much capability it deserves; that judgment asks for a capability tier (1 to 5), and
// the person's setup walks from there — the free pool when they prefer it, the role's own
// specialists, the tier's chain, then the tiers below it, never above. A reply may land in the
// free pool; the tier the read asked for is kept regardless, so the trace can say "judged t3,
// free served it".
//
// The shapes — pools, chains, roles, what may be saved, the trace — live in
// src/shared/routing.ts, which the screen reads too. Everything here is pure except readPrompt,
// the one thing that talks to TypeSafe.
import { L } from '../shared/lang'
import {
  KIND_IMPORT,
  POOL_RANK,
  roleBars as bars,
  ROLE_KINDS,
  TIERS,
  tierAt,
  type FreePolicy,
  type Pool,
  type RoleCandidate,
  type RoleSetting,
  type RouteAttempt,
  type RouteTarget,
  type RouteTrace,
  type RoutingConfig,
  type SkipCode,
  type Tier
} from '../shared/routing'

export * from '../shared/routing'

// ---------- what Jev says ----------

export interface RouteJudgment {
  role: string
  /** 0..1 when TypeSafe said how sure it is; absent when it didn't. Unknown is not zero. */
  roleConfidence?: number
  roleProbabilities: Record<string, number>
  /** 0..3, probability-weighted over the four steps of the rubric. */
  complexity: number
  /** 0..3, how much capability the work deserves, price set aside. */
  capability: number
  /** 0..1, whether it hinges on extended reasoning rather than recall or a short edit. */
  deepReasoning: number
  ms: number
}

export type ReadResult = RouteJudgment | { error: string }

const API = 'https://api.typesafe.ai/v1'
const JEV = 'jev-latest'
const DEFAULT_TIMEOUT_MS = 4_000
/** A choice answer with more options than this is a broken payload, not a reading. */
const MAX_PROBABILITIES = 40

const noAnswer = (): string => L('o TypeSafe não respondeu', "TypeSafe didn't answer")
const badFormat = (): string => L('resposta do TypeSafe fora do formato', "TypeSafe's answer wasn't in the format")

function failure(status: number): string {
  if (status === 401 || status === 403) return L('a chave do TypeSafe não vale mais', 'the TypeSafe key is no longer valid')
  if (status === 429) return L('o TypeSafe pediu pra esperar (limite de uso)', 'TypeSafe asked to wait (usage limit)')
  return L(`o TypeSafe respondeu ${status}`, `TypeSafe answered ${status}`)
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype'])

export function readingBody(opts: { prompt: string; history?: string; roles: Record<string, RoleSetting> }): Record<string, unknown> {
  const criteria: Record<string, string> = {}
  for (const [kind, role] of Object.entries(opts.roles)) criteria[kind] = role.descriptor || ROLE_KINDS[kind] || kind
  return {
    model: JEV,
    state: { pedido: opts.prompt, conversa: opts.history?.slice(-4000) ?? null },
    questions: {
      acao: {
        type: 'choice',
        instructions: L(
          'Que tipo de trabalho o `pedido` pede? Julgue o trabalho que a pessoa quer feito, não o assunto que ela menciona. Leia `conversa` quando o pedido for uma continuação curta que só faz sentido no contexto. Escolha o mais próximo mesmo quando estiver em dúvida.',
          'Which kind of work does `pedido` ask for? Judge the work the person wants done, not the topic they mention. Read `conversa` when the request is a short follow-up that only makes sense in context. Pick the closest kind even when in doubt.'
        ),
        criteria
      },
      complexidade: {
        type: 'score',
        instructions: L(
          'Quão difícil é fazer bem o `pedido`, só pelo trabalho em si? Ignore quanto qualquer modelo custa.',
          'How hard is `pedido` to do well, judged only on the work itself? Ignore what any model costs.'
        ),
        criteria: [
          L('Trivial: um passo óbvio, nenhuma decisão de projeto, a resposta já se sabe ou é mecânica', 'Trivial: one obvious step, no design decisions, the answer is known or mechanical'),
          L('Moderado: alguns passos que dependem um do outro, padrões conhecidos, pouca ambiguidade', 'Moderate: a few dependent steps using familiar patterns, little ambiguity'),
          L('Complexo: vários arquivos ou restrições que se cruzam, escolhas de verdade a pesar', 'Complex: several files or interacting constraints, real tradeoffs to weigh'),
          L('Arquitetural: desenho que atravessa o sistema, risco alto, horizonte longo, fácil de errar em silêncio', 'Architectural: cross-cutting design, high stakes, long horizon, easy to get subtly wrong')
        ]
      },
      capacidade: {
        type: 'score',
        instructions: L(
          'Deixando o preço de lado, quanta capacidade de modelo este pedido merece para sair bom? Julgue por risco, dificuldade, e quanto um modelo mais forte melhoraria o resultado de fato.',
          'Price entirely aside, how much model capability does this request deserve to come out well? Judge by stakes, difficulty, and how much a stronger model would really improve the result.'
        ),
        criteria: [
          L('Mínima: qualquer modelo pequeno e rápido responde igual de bem', 'Minimal: any fast small model answers just as well'),
          L('Normal: um modelo médio competente basta', 'Standard: a competent mid-tier model is enough'),
          L('Alta: um modelo de fronteira melhora o resultado de fato', 'High: a strong frontier model materially improves the outcome'),
          L('Máxima: acertar importa mais que o custo; use o melhor que houver', 'Maximum: correctness matters more than cost; use the best available')
        ]
      },
      raciocinio: {
        type: 'noul',
        instructions: L(
          'Responder bem o `pedido` exige raciocínio estendido em vários passos (desenhar algoritmo, depurar algo sutil, provar, planejar um horizonte longo) em vez de memória, consulta ou uma edição curta?',
          'Does answering `pedido` well require extended multi-step reasoning (designing an algorithm, debugging something subtle, proving, planning a long horizon) rather than recall, lookup, or a short edit?'
        ),
        criteria: {
          true: L('O trabalho depende de raciocinar por passos não óbvios e casos de borda', 'The work hinges on reasoning through non-obvious steps and edge cases'),
          false: L('O trabalho é memória, consulta, formatação ou uma mudança curta e direta', 'The work is recall, lookup, formatting or a short direct change')
        }
      }
    }
  }
}

/** A 0..3 score, or the reason it can't be one. Nothing is assumed when the answer leaves it out. */
function score(where: Record<string, unknown>, what: string): { value: number } | { error: string } {
  const raw = num(where.score)
  if (raw === undefined) return { error: L(`o TypeSafe não deu nota de ${what}`, `TypeSafe didn't score ${what}`) }
  if (raw < 0 || raw > 3) return { error: L(`nota de ${what} fora de 0..3 (${raw})`, `${what} score outside 0..3 (${raw})`) }
  return { value: raw }
}

/**
 * Turns the answer into a judgment, or says why it can't. A required question that comes back
 * missing or impossible is an error: a made-up score would route real work on invented numbers,
 * and the fail-open path (`Routing unavailable · Using [model]`) is the honest answer instead.
 */
export function readAnswer(payload: unknown, ms: number, roles: Record<string, RoleSetting>): ReadResult {
  if (!isRecord(payload) || !isRecord(payload.answers)) return { error: badFormat() }
  const answers = payload.answers

  // What kind of work.
  const acao = isRecord(answers.acao) ? answers.acao : {}
  const choice = typeof acao.choice === 'string' ? acao.choice.trim() : ''
  if (!choice) return { error: L('o TypeSafe não disse que trabalho é', "TypeSafe didn't say what kind of work it is") }
  const role = KIND_IMPORT[choice] ?? choice
  if (Object.keys(roles).length > 0 && !Object.hasOwn(roles, role)) {
    return { error: L('o TypeSafe escolheu um papel que não existe', "TypeSafe picked a role that doesn't exist") }
  }

  // How sure it is: absent is unknown, and unknown is not zero — it just can't unlock the dearest pools.
  let confidence: number | undefined
  const rawConfidence = num(acao.confidence)
  if (rawConfidence !== undefined) {
    if (rawConfidence < 0 || rawConfidence > 1) return { error: L(`confiança fora de 0..1 (${rawConfidence})`, `confidence outside 0..1 (${rawConfidence})`) }
    confidence = rawConfidence
  }

  // The kind probabilities, when it gives them: real numbers, bounded, no prototype keys.
  const probabilities: Record<string, number> = {}
  if (acao.probabilities !== undefined) {
    if (!isRecord(acao.probabilities)) return { error: L('probabilidades ilegíveis', 'unreadable probabilities') }
    const entries = Object.entries(acao.probabilities)
    if (entries.length > MAX_PROBABILITIES) return { error: L('probabilidades demais', 'too many probabilities') }
    let broken = 0
    for (const [kind, value] of entries) {
      if (DANGEROUS.has(kind)) return { error: L('probabilidades ilegíveis', 'unreadable probabilities') }
      const p = num(value)
      if (p === undefined || p < 0 || p > 1) {
        broken += 1
        continue
      }
      probabilities[KIND_IMPORT[kind] ?? kind] = p
    }
    if (entries.length > 0 && broken === entries.length) return { error: L('probabilidades ilegíveis', 'unreadable probabilities') }
  }
  if (confidence === undefined) {
    const fromProbabilities = probabilities[role]
    if (fromProbabilities !== undefined) confidence = fromProbabilities
  }

  // The three judgments.
  const complexity = score(isRecord(answers.complexidade) ? answers.complexidade : {}, L('complexidade', 'complexity'))
  if ('error' in complexity) return { error: complexity.error }
  const capability = score(isRecord(answers.capacidade) ? answers.capacidade : {}, L('capacidade', 'capability'))
  if ('error' in capability) return { error: capability.error }

  const raciocinio = isRecord(answers.raciocinio) ? answers.raciocinio : {}
  const rawDeep = raciocinio.noul ?? raciocinio.noul_score
  let deep: number | undefined = typeof rawDeep === 'boolean' ? (rawDeep ? 1 : 0) : num(rawDeep)
  if (deep === undefined) return { error: L('o TypeSafe não disse se precisa de raciocínio longo', "TypeSafe didn't say whether it needs extended reasoning") }
  if (deep < 0 || deep > 1) return { error: L(`raciocínio fora de 0..1 (${deep})`, `deep reasoning outside 0..1 (${deep})`) }

  return {
    role,
    ...(confidence !== undefined ? { roleConfidence: confidence } : {}),
    roleProbabilities: probabilities,
    complexity: complexity.value,
    capability: capability.value,
    deepReasoning: deep,
    ms
  }
}

/** One TypeSafe call: four questions, answered together. This is the only network hop here. */
export async function readPrompt(opts: {
  key: string
  prompt: string
  history?: string
  roles: Record<string, RoleSetting>
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<ReadResult> {
  const started = Date.now()
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(readingBody(opts)),
      signal
    })
  } catch {
    return { error: noAnswer() }
  }
  if (!res.ok) return { error: failure(res.status) }
  const payload: unknown = await res.json().catch(() => null)
  return readAnswer(payload, Date.now() - started, opts.roles)
}

// ---------- what the person's setup makes of it ----------

/** demand 0..3: how much model this work deserves, the same scale the plugin uses. */
export function demandOf(j: RouteJudgment): number {
  let demand = 0.55 * j.complexity + 0.45 * j.capability
  if (j.deepReasoning >= 0.65) demand += 0.75
  else if (j.deepReasoning <= 0.2) demand -= 0.25
  return Math.min(3, Math.max(0, demand))
}

/** The tier a demand asks for, before floors and the confidence cap: t1 at 0, t4 at 3. */
export function tierOfDemand(demand: number): Tier {
  const step = Math.min(4, Math.max(1, Math.round(demand) + 1))
  return `t${step}` as Tier
}

export interface PoolDecision {
  /** 0..3, the reading's own demand, before anything the setup does to it. */
  rawDemand: number
  /** 0..3, what the tiers actually policed after the role floor and the confidence cap. */
  demand: number
  /** The capability tier the raw demand asks for, kept even when something else serves the reply. */
  requested: Tier
  /** The tier the walk starts from: the request after the role floor and the confidence cap. */
  policy: Tier
  /** 0..1 when TypeSafe said how sure it is; absent when it didn't. */
  confidence?: number
  /** What the setup did to the raw read, in the person's language. */
  notes: string[]
}

/**
 * Which capability tier the reading asks for, and what the person's policy does with it. Free is
 * never the answer here: it is a destination, not a tier, and the requested tier survives it.
 */
export function poolFor(j: RouteJudgment, config: RoutingConfig): PoolDecision {
  const notes: string[] = []
  const raw = demandOf(j)
  const confidence = j.roleConfidence
  const known = confidence !== undefined
  const unsure = known && config.confidenceFloor > 0 && confidence! < config.confidenceFloor

  // Tier 5 is only ever unlocked by the reading itself, and only when it is a real install.
  const wantsTop = Math.round(raw) >= 3
  const t5Ready = config.allowTier5 && config.pools.t5.chain.length > 0
  let requested = tierOfDemand(raw)
  if (wantsTop) {
    // Known, positive, sure confidence is part of qualifying for the dearest pool.
    const sure = known && !unsure && confidence! > 0
    if (t5Ready && sure) requested = 't5'
    else {
      requested = 't4'
      if (!config.allowTier5) notes.push(L('o tier 5 está desligado', 'tier 5 is switched off'))
      else if (!config.pools.t5.chain.length) notes.push(L('o tier 5 não tem modelos', 'tier 5 has no models'))
      else notes.push(L('papel incerto não chega ao tier 5', 'an unsure read never reaches tier 5'))
    }
  }

  // The role's floor lifts the tier; it never lowers it.
  let policy = requested
  const floor = config.roleFloor[j.role]
  if (floor && POOL_RANK[policy] < POOL_RANK[floor]) {
    notes.push(L(`${j.role} não desce de ${floor}`, `${j.role} floors at ${floor}`))
    policy = floor
  }

  // A floor reaches as high as tier 4. Tier 5 is only ever unlocked by the reading itself, so a
  // role that floors at t5 still stops at t4 when the work didn't ask for the dearest pool.
  if (policy === 't5' && requested !== 't5') {
    notes.push(L('um piso não abre o tier 5: só a leitura abre', 'a floor never opens tier 5: only the reading does'))
    policy = 't4'
  }

  // A guess doesn't cost: unknown or low confidence caps at tier 2 and never reaches tier 5.
  if (!known || unsure) {
    if (POOL_RANK[policy] > POOL_RANK.t2) {
      notes.push(
        known
          ? L(`papel incerto (${confidence!.toFixed(2)}) → t2`, `unsure role (${confidence!.toFixed(2)}) → t2`)
          : L('o TypeSafe não disse a confiança → t2', "TypeSafe didn't say how sure it is → t2")
      )
      policy = 't2'
    }
  }

  const demand = Math.max(raw, POOL_RANK[policy] - 1)
  return { rawDemand: raw, demand, requested, policy, ...(known ? { confidence } : {}), notes }
}

/** Why a model can't run now, in the person's language; undefined when it can. */
export type Availability = (t: RouteTarget) => string | undefined

interface Candidate {
  target: RoleCandidate
  from: RouteAttempt['from']
}

/**
 * The chains walked, in the order the contract fixes and never upward: the free pool when the
 * person prefers it, the role's own specialists (each only from the tier they're eligible for),
 * the tier the read asked for, then the tiers below it, then free as a fallback. Two candidates
 * with the same execution identity are one candidate.
 */
export function chainFor(j: RouteJudgment, config: RoutingConfig, decision: PoolDecision): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const push = (target: RoleCandidate, from: RouteAttempt['from']): void => {
    if (seen.has(target.id)) return
    seen.add(target.id)
    out.push({ target, from })
  }

  const free: FreePolicy = config.free?.policy ?? 'off'
  if (free === 'prefer') for (const t of config.pools.free?.chain ?? []) push(t, { kind: 'free' })

  const floor = config.roleFloor[j.role]
  const consulted = !floor || POOL_RANK[decision.policy] >= POOL_RANK[floor]
  for (const t of config.roles[j.role]?.chain ?? []) {
    const eligible = consulted && (!t.minTier || POOL_RANK[decision.policy] >= POOL_RANK[t.minTier])
    if (eligible) push(t, { kind: 'role', role: j.role })
  }

  const startRank = POOL_RANK[decision.policy]
  for (const t of config.pools[decision.policy]?.chain ?? []) push(t, { kind: 'tier', tier: decision.policy })
  for (let rank = startRank - 1; rank >= 1; rank -= 1) {
    const tier = tierAt(rank)!
    for (const t of config.pools[tier]?.chain ?? []) push(t, { kind: 'tier', tier })
  }
  if (free === 'fallback') for (const t of config.pools.free?.chain ?? []) push(t, { kind: 'free' })

  return out
}

export interface WalkOutcome extends PoolDecision {
  attempts: RouteAttempt[]
  selected?: RouteTarget
  source?: 'free' | 'role' | 'tier'
  /** The pool the winner came from, when it came from one (a role's own specialist has none). */
  effective?: Pool
  /** Set when the walk ended because nothing eligible was left and a configured reserve stepped in. */
  reserve?: boolean
}

/** The pool a chain entry came from: the free pool, or its tier; a role specialist has none. */
const poolOf = (from: RouteAttempt['from']): Pool | undefined => (from.kind === 'free' ? 'free' : from.kind === 'tier' ? from.tier : undefined)

/** Every candidate, in order, with why it wasn't run — and the one that was. */
export function walkRoute(j: RouteJudgment, config: RoutingConfig, can: Availability): WalkOutcome {
  const decision = poolFor(j, config)
  const candidates = chainFor(j, config, decision)
  const attempts: RouteAttempt[] = []

  for (const c of candidates) {
    const skip = can(c.target as RouteTarget)
    const attempt: RouteAttempt = {
      id: c.target.id,
      engine: c.target.engine,
      ...(c.target.accountId ? { accountId: c.target.accountId } : {}),
      model: c.target.model,
      effort: c.target.effort,
      from: c.from,
      ...(skip ? { skip } : {})
    }
    attempts.push(attempt)
    if (!skip) {
      const { id, engine, accountId, model, effort } = c.target
      return {
        ...decision,
        attempts,
        selected: { id, engine, ...(accountId ? { accountId } : {}), model, effort },
        source: c.from.kind,
        ...(poolOf(c.from) ? { effective: poolOf(c.from)! } : {})
      }
    }
  }

  // Nothing in the chains. A reserve the person configured is the only thing allowed to answer,
  // and only from inside the ceiling the reading asked for.
  const reserve = reserveFor(config, decision)
  if (reserve) {
    const skip = can(reserve.target)
    attempts.push({
      id: reserve.target.id,
      engine: reserve.target.engine,
      ...(reserve.target.accountId ? { accountId: reserve.target.accountId } : {}),
      model: reserve.target.model,
      effort: reserve.target.effort,
      from: reserve.from,
      ...(skip ? { skip, skipCode: 'unavailable' as SkipCode } : {})
    })
    if (!skip)
      return {
        ...decision,
        attempts,
        selected: { ...reserve.target },
        source: reserve.from.kind,
        ...(poolOf(reserve.from) ? { effective: poolOf(reserve.from)! } : {}),
        reserve: true
      }
  }
  return { ...decision, attempts }
}

/** The configured reserve, when it sits at or below the tier the reading asked for. */
function reserveFor(config: RoutingConfig, decision: PoolDecision): { target: RouteTarget; from: RouteAttempt['from'] } | undefined {
  const wanted = config.fallbackTargetId
  if (!wanted) return undefined
  const ceiling = POOL_RANK[decision.policy]
  const spots: ({ kind: 'free' } | { kind: 'tier'; tier: Tier })[] = []
  if ((config.free?.policy ?? 'off') !== 'off') spots.push({ kind: 'free' })
  for (let rank = 1; rank <= ceiling; rank += 1) spots.push({ kind: 'tier', tier: tierAt(rank)! })
  for (const from of spots) {
    const pool = from.kind === 'free' ? config.pools.free : config.pools[from.tier]
    const hit = pool?.chain.find((t) => t.id === wanted || t.model === wanted)
    if (hit) return { target: hit, from }
  }
  return undefined
}

/** The model to run, or why nothing ran. */
export function pickRoute(
  j: RouteJudgment,
  config: RoutingConfig,
  available: (t: RouteTarget) => boolean = () => true
): { requested: Tier; policy: Tier; target?: RouteTarget; source?: 'free' | 'role' | 'tier'; notes: string[] } {
  const w = walkRoute(j, config, (t) => (available(t) ? undefined : L('não está disponível', "isn't available")))
  return {
    requested: w.requested,
    policy: w.policy,
    ...(w.selected ? { target: w.selected, source: w.source } : {}),
    notes: w.selected ? w.notes : [...w.notes, L('nenhum modelo elegível', 'no eligible model')]
  }
}

export type RouteDecision =
  | { kind: 'selected'; selected: RouteTarget; trace: RouteTrace }
  /** A good read, nothing eligible, and no reserve: the reply is not sent. */
  | { kind: 'exhausted'; trace: RouteTrace }

const readingOf = (j: RouteJudgment) => ({
  role: j.role,
  ...(j.roleConfidence !== undefined ? { confidence: j.roleConfidence } : {}),
  ...(Object.keys(j.roleProbabilities).length > 0 ? { probabilities: j.roleProbabilities } : {}),
  complexity: j.complexity,
  capability: j.capability,
  deepReasoning: j.deepReasoning,
  ms: j.ms
})

const sameExecution = (a: RouteTarget, b: RouteTarget): boolean => a.id === b.id

/** The judgment walked over the setup, with the trace one routed turn leaves behind. */
export function decideRoute(j: RouteJudgment, config: RoutingConfig, can: Availability, baseline: RouteTarget): RouteDecision {
  const w = walkRoute(j, config, can)
  const skips = w.attempts.filter((a) => a.skip).length
  const base: RouteTrace = {
    at: Date.now(),
    reading: readingOf(j),
    rawDemand: w.rawDemand,
    demand: w.demand,
    requested: w.requested,
    policy: w.policy,
    notes: w.notes,
    attempts: w.attempts,
    baseline,
    state: 'exhausted'
  }
  if (!w.selected) {
    return {
      kind: 'exhausted',
      trace: {
        ...base,
        state: 'exhausted',
        error: L(
          'Nenhum modelo elegível nas rotas: a resposta não foi enviada.',
          'No eligible model in the routes: the reply was not sent.'
        )
      }
    }
  }
  const same = sameExecution(w.selected, baseline)
  const notes = [...w.notes]
  if (same) notes.push(L('a rota caiu no modelo de base: ninguém mudou', 'the route landed on the baseline: nothing changed'))
  if (w.reserve) notes.push(L('entrou o modelo de reserva configurado', 'the configured reserve stepped in'))
  const trace: RouteTrace = {
    ...base,
    ...(w.effective ? { effective: w.effective } : {}),
    ...(w.source ? { source: w.source } : {}),
    notes,
    selected: w.selected,
    state: same ? 'kept' : skips > 0 ? 'fallback' : 'changed'
  }
  return { kind: 'selected', selected: w.selected, trace }
}

/** The trace of a turn routing couldn't decide for: the baseline ran, and the line says why. */
export function unavailableTrace(j: RouteJudgment | undefined, config: RoutingConfig, error: string, baseline: RouteTarget): RouteTrace {
  const w = j ? walkRoute(j, config, () => error) : undefined
  return {
    at: Date.now(),
    reading: j ? readingOf(j) : { role: 'chat', complexity: 0, capability: 0, deepReasoning: 0, ms: 0 },
    rawDemand: w?.rawDemand ?? 0,
    demand: w?.demand ?? 0,
    requested: w?.requested ?? 't1',
    policy: w?.policy ?? 't1',
    notes: w?.notes ?? [],
    attempts: w?.attempts ?? [],
    baseline,
    state: 'unavailable',
    error
  }
}

/** Is there anything at all to route with? No chains anywhere: routing has nothing to decide with. */
export function configured(config: RoutingConfig): boolean {
  const pools = Object.values(config.pools).some((p) => p.chain.length > 0)
  const roles = Object.values(config.roles).some((r) => r.chain.length > 0)
  return pools || roles
}

// ---------- the line the person reads ----------

/** The reading as short, drawn text — the bars themselves are the renderer's. */
export function readingLine(j: RouteJudgment, config: RoutingConfig): string {
  const { requested, demand } = poolFor(j, config)
  const parts = [
    j.role,
    L(`complexidade ${j.complexity.toFixed(1)}/3`, `complexity ${j.complexity.toFixed(1)}/3`),
    L(`capacidade ${j.capability.toFixed(1)}/3`, `capability ${j.capability.toFixed(1)}/3`),
    L(`exigência ${demand.toFixed(1)}/3`, `demand ${demand.toFixed(1)}/3`)
  ]
  return `${parts.join(' · ')} → ${requested}`
}

/** The role choices of a judgment, best first: the bars for the role criterion. */
export function roleBars(j: RouteJudgment, limit = 3): { role: string; p: number }[] {
  return bars(j.roleProbabilities, limit)
}

/** Every tier a person can put a model in, in order: for a select's options. */
export const TIER_CHOICES: readonly Tier[] = TIERS
