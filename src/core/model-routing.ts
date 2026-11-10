// Smart model routing (Settings › Routing): Jev reads the prompt and says what
// kind of work it is and how much capability it deserves, and that judgment
// picks one of the person's pools — free, or tier 1 to 5 — where a pool is an
// ordered chain of harness · model · thinking to try, the first usable one
// winning. A role (code, review, plan, debug…) can own its own chain, so
// planning and review never land on whatever the water carrier got.
//
// The shapes — pools, chains, roles, what may be saved, the trace — live in
// src/shared/routing.ts, which the screen reads too. Everything here is pure
// except readPrompt, the one thing that talks to TypeSafe: the core decides
// with it, the renderer draws the reading from the trace it leaves behind.
import { L } from '../shared/lang'
import { normalizeRouting, POOLS, POOL_RANK, ROLE_KINDS, type Pool, type RouteAttempt, type RouteTarget, type RouteTrace, type RoleSetting, type RoutingConfig } from '../shared/routing'

export * from '../shared/routing'

const T5 = 5

// ---------- what Jev says ----------

export interface RouteJudgment {
  role: string
  roleConfidence: number
  roleProbabilities: Record<string, number>
  /** 0..3, probability-weighted over the four steps of the rubric. */
  complexity: number
  /** 0..3, how much capability the work deserves, price set aside. */
  capability: number
  /** 0..1, whether it hinges on extended reasoning rather than recall or a short edit. */
  deepReasoning: number
  ms: number
}

const API = 'https://api.typesafe.ai/v1'
const JEV = 'jev-latest'
const DEFAULT_TIMEOUT_MS = 4_000

const noAnswer = (): string => L('o TypeSafe não respondeu', "TypeSafe didn't answer")
const badFormat = (): string => L('resposta do TypeSafe fora do formato', "TypeSafe's answer wasn't in the format")

function failure(status: number): string {
  if (status === 401 || status === 403) return L('a chave do TypeSafe não vale mais', 'the TypeSafe key is no longer valid')
  if (status === 429) return L('o TypeSafe pediu pra esperar (limite de uso)', 'TypeSafe asked to wait (usage limit)')
  return L(`o TypeSafe respondeu ${status}`, `TypeSafe answered ${status}`)
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

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

/** Turns the answer into a judgment, or says why it can't. */
export function readAnswer(payload: unknown, ms: number, roles: Record<string, RoleSetting>): RouteJudgment | { error: string } {
  if (!isRecord(payload) || !isRecord(payload.answers)) return { error: badFormat() }
  const answers = payload.answers
  const acao = isRecord(answers.acao) ? answers.acao : {}
  const complexidade = isRecord(answers.complexidade) ? answers.complexidade : {}
  const capacidade = isRecord(answers.capacidade) ? answers.capacidade : {}
  const raciocinio = isRecord(answers.raciocinio) ? answers.raciocinio : {}
  const role = typeof acao.choice === 'string' ? acao.choice : 'chat'
  if (Object.keys(roles).length > 0 && !Object.hasOwn(roles, role)) {
    return { error: L('o TypeSafe escolheu um papel que não existe', "TypeSafe picked a role that doesn't exist") }
  }
  const probabilities = isRecord(acao.probabilities) ? (acao.probabilities as Record<string, number>) : {}
  const deep = num(raciocinio.noul) ?? num(raciocinio.noul_score) ?? 0
  return {
    role,
    roleConfidence: num(acao.confidence) ?? probabilities[role] ?? 0,
    roleProbabilities: probabilities,
    complexity: Math.min(3, Math.max(0, num(complexidade.score) ?? 1)),
    capability: Math.min(3, Math.max(0, num(capacidade.score) ?? 1)),
    deepReasoning: Math.min(1, Math.max(0, deep)),
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
}): Promise<RouteJudgment | { error: string }> {
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

// ---------- what the person's pools make of it ----------

/** demand 0..3: how much model this work deserves, the same scale the plugin uses. */
export function demandOf(j: RouteJudgment): number {
  let demand = 0.55 * j.complexity + 0.45 * j.capability
  if (j.deepReasoning >= 0.65) demand += 0.75
  else if (j.deepReasoning <= 0.2) demand -= 0.25
  return Math.min(3, Math.max(0, demand))
}

/** The pool the judgment asks for, before availability. */
export function poolFor(j: RouteJudgment, config: RoutingConfig): { pool: Pool; demand: number; notes: string[] } {
  const notes: string[] = []
  let demand = demandOf(j)
  const floor = config.roleFloor[j.role]
  if (floor && demand < POOL_RANK[floor] - 1) {
    notes.push(L(`${j.role} não desce de ${floor}`, `${j.role} floors at ${floor}`))
    demand = POOL_RANK[floor] - 1
  }
  if (config.confidenceFloor > 0 && j.roleConfidence > 0 && j.roleConfidence < config.confidenceFloor && demand > 1) {
    notes.push(L(`papel incerto (${j.roleConfidence.toFixed(2)}) → t2`, `unsure role (${j.roleConfidence.toFixed(2)}) → t2`))
    demand = 1
  }
  const top = demand >= 2.75 && j.roleConfidence >= config.confidenceFloor
  const pool: Pool =
    config.freeWhenCheap && demand < 0.6
      ? 'free'
      : top
        ? 't5'
        : (`t${Math.min(4, Math.round(demand) + 1)}` as Pool)
  return { pool, demand, notes }
}

/** Why a model can't run now, in the person's language; undefined when it can. */
export type Availability = (t: RouteTarget) => string | undefined

/**
 * The whole chain walked: every model in the order it was tried, each with why it was passed
 * over, and the one that ran. The pools next door are consulted nearest first, downwards before
 * upwards, so a missing model never blocks a reply.
 */
export function walkRoute(
  j: RouteJudgment,
  config: RoutingConfig,
  can: Availability
): { pool: Pool; demand: number; notes: string[]; attempts: RouteAttempt[]; selected?: RouteTarget; roleSpecialised: boolean } {
  const { pool, demand, notes } = poolFor(j, config)
  const rank = POOL_RANK[pool]
  const floor = POOL_RANK[config.roleFloor[j.role] ?? 't1']
  const order: { target: RouteTarget; from: RouteAttempt['from']; specialist: boolean }[] = []
  if (rank >= floor) {
    for (const target of config.roles[j.role]?.chain ?? []) order.push({ target, from: { kind: 'role', role: j.role }, specialist: true })
  }
  for (const target of config.pools[pool].chain) order.push({ target, from: { kind: 'pool', pool }, specialist: false })
  for (let distance = 1; distance <= T5; distance += 1) {
    const down = POOLS[rank - distance]
    const up = POOLS[rank + distance]
    for (const p of [down, up]) if (p) for (const target of config.pools[p].chain) order.push({ target, from: { kind: 'pool', pool: p }, specialist: false })
  }
  const attempts: RouteAttempt[] = []
  for (const entry of order) {
    const skip = can(entry.target)
    attempts.push({ ...entry.target, from: entry.from, ...(skip ? { skip } : {}) })
    if (!skip) return { pool, demand, notes, attempts, selected: entry.target, roleSpecialised: entry.specialist }
  }
  return { pool, demand, notes, attempts, roleSpecialised: false }
}

/** The target to run, trying the role's chain, the pool's, then the pools next door. */
export function pickRoute(
  j: RouteJudgment,
  config: RoutingConfig,
  available: (t: RouteTarget) => boolean = () => true
): { pool: Pool; target?: RouteTarget; roleSpecialised: boolean; notes: string[] } {
  const w = walkRoute(j, config, (t) => (available(t) ? undefined : L('não está disponível', "isn't available")))
  return w.selected
    ? { pool: w.pool, target: w.selected, roleSpecialised: w.roleSpecialised, notes: w.notes }
    : { pool: w.pool, roleSpecialised: false, notes: [...w.notes, L('nenhum modelo dos pools está disponível', 'no model in the pools is available')] }
}

/** The judgment walked over the config, with the trace one routed turn leaves behind. */
export function decideRoute(
  j: RouteJudgment,
  config: RoutingConfig,
  can: Availability,
  baseline: RouteTarget
): { selected: RouteTarget; trace: RouteTrace } | undefined {
  const w = walkRoute(j, config, can)
  if (!w.selected) return undefined
  const hit = w.attempts.find((a) => !a.skip)
  const same = w.selected.engine === baseline.engine && w.selected.model === baseline.model && w.selected.effort === baseline.effort
  // A first choice that couldn't run makes it a fallback, whether or not the one that did run is the baseline.
  const trace: RouteTrace = {
    at: Date.now(),
    reading: {
      role: j.role,
      roleConfidence: j.roleConfidence,
      ...(Object.keys(j.roleProbabilities).length > 0 ? { probabilities: j.roleProbabilities } : {}),
      complexity: j.complexity,
      capability: j.capability,
      deepReasoning: j.deepReasoning,
      ms: j.ms
    },
    demand: w.demand,
    pool: w.pool,
    ...(w.roleSpecialised ? { roleSpecialised: true } : {}),
    ...(hit && hit.from.kind === 'pool' ? { effective: hit.from.pool } : {}),
    notes: w.notes,
    attempts: w.attempts,
    selected: w.selected,
    baseline,
    state: same ? 'kept' : w.attempts.length > 1 ? 'fallback' : 'changed'
  }
  return { selected: w.selected, trace }
}

/** The trace of a turn routing couldn't decide for: the baseline ran, and the line says why. */
export function unavailableTrace(j: RouteJudgment | undefined, config: RoutingConfig, error: string, baseline: RouteTarget): RouteTrace {
  const w = j ? walkRoute(j, config, () => error) : undefined
  return {
    at: Date.now(),
    reading: j
      ? {
          role: j.role,
          roleConfidence: j.roleConfidence,
          ...(Object.keys(j.roleProbabilities).length > 0 ? { probabilities: j.roleProbabilities } : {}),
          complexity: j.complexity,
          capability: j.capability,
          deepReasoning: j.deepReasoning,
          ms: j.ms
        }
      : { role: 'chat', roleConfidence: 0, complexity: 0, capability: 0, deepReasoning: 0, ms: 0 },
    demand: w?.demand ?? 0,
    pool: w?.pool ?? 't1',
    notes: w?.notes ?? [],
    attempts: w?.attempts ?? [],
    baseline,
    state: 'unavailable',
    error
  }
}

// ---------- the line the person reads ----------

/** The reading as short, drawn text — the bars themselves are the renderer's. */
export function readingLine(j: RouteJudgment, config: RoutingConfig): string {
  const { pool, demand } = poolFor(j, config)
  const parts = [
    j.role,
    L(`complexidade ${j.complexity.toFixed(1)}/3`, `complexity ${j.complexity.toFixed(1)}/3`),
    L(`capacidade ${j.capability.toFixed(1)}/3`, `capability ${j.capability.toFixed(1)}/3`),
    L(`raciocínio ${demand.toFixed(1)}/3`, `demand ${demand.toFixed(1)}/3`)
  ]
  return `${parts.join(' · ')} → ${pool}`
}

/** The role choices with their probabilities, best first: the bars for the role criterion. */
export function roleBars(j: RouteJudgment, limit = 3): { role: string; p: number }[] {
  return Object.entries(j.roleProbabilities)
    .filter(([role]) => !!role)
    .map(([role, p]) => ({ role, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, limit)
}

