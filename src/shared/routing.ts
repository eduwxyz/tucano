// Smart model routing, the part both the core and the screen need: the pools a person
// keeps (free, and tiers 1 to 5, cheapest to dearest), each an ordered chain of
// harness · model · thinking to try until one is usable; the roles a prompt can be
// read as, and their own chains; what a saved setup may carry; and the trace one
// routed turn leaves behind, which the conversation draws as a thin line.
//
// The judgment itself (what Jev answers, and the math that turns it into a pool) lives
// in src/core/model-routing.ts: this file is pure shape, safe on both sides of the wire.
import { L } from './lang'
import type { Effort, EngineId } from './types'

export type Pool = 'free' | 't1' | 't2' | 't3' | 't4' | 't5'
export const POOLS: readonly Pool[] = ['free', 't1', 't2', 't3', 't4', 't5'] as const
/** Where each pool sits: the free one below every paid tier, tiers 1 (cheap) to 5 (dearest). */
export const POOL_RANK: Record<Pool, number> = { free: 0, t1: 1, t2: 2, t3: 3, t4: 4, t5: 5 }

/** One entry of a chain: the harness, the model id its own --model takes, and how hard it thinks. */
export interface RouteTarget {
  engine: EngineId
  model: string
  effort: Effort
}

export interface PoolSetting {
  descriptor: string // the person's own words for what this pool is for ("quick looks, no thinking")
  chain: RouteTarget[]
}

export interface RoleSetting {
  descriptor: string
  chain: RouteTarget[]
}

export interface RoutingConfig {
  enabled: boolean
  pools: Record<Pool, PoolSetting>
  roles: Record<string, RoleSetting>
  /** The pool below which a role's own chain stops being consulted; unset: the role always is. */
  roleFloor: Record<string, Pool>
  /** Under this confidence about the role, the pool comes down to tier 2: an unsure read shouldn't cost. */
  confidenceFloor: number
  /** Cheap work may go to the free pool, when that pool has a chain. */
  freeWhenCheap: boolean
}

// The four roles Apo named first; the rest are the kinds the plugin routes on, so a
// person can add one without a new release.
export const ROLE_KINDS: Record<string, string> = {
  code: 'Writing or changing code, scripts or configuration until it works',
  review: 'Auditing code, a diff, a document or a plan for problems and risks',
  plan: 'Deciding what to build, sequencing work, designing an approach before any edit',
  debug: 'Diagnosing a failure, an error or odd behaviour, and finding its cause',
  research: 'Searching, reading and pulling together external information or unfamiliar APIs',
  write: 'Producing prose, documentation or other non-code content from scratch',
  explain: 'Answering a question, or explaining how something works',
  operate: 'Running commands, tooling, git, deploys or setting up an environment',
  chat: 'Small talk, an acknowledgement, or a request with no real work behind it'
}

export function defaultRouting(): RoutingConfig {
  const pool = (descriptor: string): PoolSetting => ({ descriptor, chain: [] })
  const role = (kind: string): RoleSetting => ({ descriptor: L(ROLE_KINDS[kind]!, ROLE_KINDS[kind]!), chain: [] })
  const roles: Record<string, RoleSetting> = {}
  for (const kind of Object.keys(ROLE_KINDS)) roles[kind] = role(kind)
  return {
    enabled: false, // the tab exists; nothing routes until the person turns it on
    pools: {
      free: pool(L('Só provedores gratuitos: para o que não vale gastar.', "Only free providers: for what isn't worth spending on.")),
      t1: pool(L('Barato e rápido: uma pergunta, um ajuste de uma linha.', 'Cheap and fast: a question, a one-line fix.')),
      t2: pool(L('O dia a dia: código e conversas de sempre.', 'Everyday work: ordinary code and conversations.')),
      t3: pool(L('Trabalho de verdade: várias partes, escolhas a pesar.', 'Real work: several moving parts, tradeoffs to weigh.')),
      t4: pool(L('Difícil: arquitetura, revisão séria, depuração teimosa.', 'Hard: architecture, a serious review, stubborn debugging.')),
      t5: pool(L('O melhor que existe: quando errar custa mais que o token.', 'The best there is: when being wrong costs more than the tokens.'))
    },
    roles,
    roleFloor: { plan: 't3', review: 't3' },
    confidenceFloor: 0.34,
    freeWhenCheap: true
  }
}

// ---------- what a routed turn leaves behind ----------

/** One step of the chain walked, and why it wasn't run when it wasn't. */
export interface RouteAttempt {
  engine: EngineId
  model: string
  effort: Effort
  /** Which chain it came from: the role's own, or a pool's. */
  from: { kind: 'role'; role: string } | { kind: 'pool'; pool: Pool }
  /** Why this one was passed over, in the person's language; absent on the one that ran. */
  skip?: string
}

/**
 * What the router decided for one reply. It holds what happened, never what could be
 * worked out again from the settings: the line the person reads is drawn from this,
 * and the numbers in it are the ones the classifier gave at the time.
 */
export interface RouteTrace {
  at: number
  /** What Jev read: the winning action, its confidence, the two 0..3 scores and the reasoning bit. */
  reading: {
    role: string
    roleConfidence: number
    probabilities?: Record<string, number>
    complexity: number
    capability: number
    deepReasoning: number
    ms: number
  }
  /** 0..3, how much model this work deserves: the plugin's own scale, after the role floors and the brake. */
  demand: number
  /** The pool the reading asked for, before availability. */
  pool: Pool
  /** The pool the model that ran came from (absent when it came from the role's own chain). */
  effective?: Pool
  /** What the config did to the raw read (a floor, the confidence brake), in the person's language. */
  notes: string[]
  /** Every model tried, in order, each with why it was skipped; the one without a `skip` ran. */
  attempts: RouteAttempt[]
  /** The model routing picked: absent when it couldn't decide, and the reply ran on the baseline. */
  selected?: RouteTarget
  /** What the agent would have used had routing not decided: what "kept" or "changed" is measured against. */
  baseline: RouteTarget
  /**
   * changed: another model ran · kept: the same one · fallback: the first choice couldn't run, a later one did ·
   * unavailable: routing couldn't decide (no key, no answer, no usable model) and the baseline ran, `error` saying why.
   */
  state: 'changed' | 'kept' | 'fallback' | 'unavailable'
  /** Why routing didn't decide, in the person's language; only with state 'unavailable'. */
  error?: string
  roleSpecialised?: boolean
}

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh']
const ENGINES: readonly string[] = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline']

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function cleanChain(value: unknown): RouteTarget[] {
  if (!Array.isArray(value)) return []
  const out: RouteTarget[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const { engine, model, effort } = item
    if (typeof engine !== 'string' || !ENGINES.includes(engine)) continue
    if (typeof model !== 'string' || !model.trim() || model.length > 200) continue
    const level = typeof effort === 'string' && EFFORTS.includes(effort) ? (effort as Effort) : 'medium'
    out.push({ engine: engine as EngineId, model: model.trim(), effort: level })
    if (out.length >= 40) break // a chain longer than this is a mistake, not an intent
  }
  return out
}

/** Anything saved (or old) made fit to route with: unknown keys dropped, the defaults kept. */
export function normalizeRouting(raw: unknown): RoutingConfig {
  const base = defaultRouting()
  if (!isRecord(raw)) return base
  const pools = { ...base.pools }
  const rawPools = isRecord(raw.pools) ? raw.pools : {}
  for (const p of POOLS) {
    const value = rawPools[p]
    if (!isRecord(value)) continue
    pools[p] = {
      descriptor: typeof value.descriptor === 'string' ? value.descriptor.slice(0, 400) : base.pools[p].descriptor,
      chain: cleanChain(value.chain)
    }
  }
  const roles: Record<string, RoleSetting> = {}
  const rawRoles = isRecord(raw.roles) ? raw.roles : {}
  for (const [kind, value] of Object.entries(rawRoles)) {
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(kind) || !isRecord(value)) continue
    roles[kind] = {
      descriptor: typeof value.descriptor === 'string' ? value.descriptor.slice(0, 400) : (ROLE_KINDS[kind] ?? kind),
      chain: cleanChain(value.chain)
    }
  }
  for (const kind of Object.keys(ROLE_KINDS)) if (!roles[kind]) roles[kind] = { descriptor: base.roles[kind]!.descriptor, chain: [] }
  const roleFloor: Record<string, Pool> = {}
  const rawFloors = isRecord(raw.roleFloor) ? raw.roleFloor : {}
  for (const [kind, value] of Object.entries(rawFloors)) {
    if (Object.hasOwn(roles, kind) && typeof value === 'string' && (POOLS as readonly string[]).includes(value)) roleFloor[kind] = value as Pool
  }
  const confidence = num(raw.confidenceFloor)
  return {
    enabled: raw.enabled === true,
    pools,
    roles,
    roleFloor,
    confidenceFloor: confidence === undefined ? base.confidenceFloor : Math.min(1, Math.max(0, confidence)),
    freeWhenCheap: raw.freeWhenCheap !== false
  }
}
