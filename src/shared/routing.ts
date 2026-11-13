// Smart model routing, the part both the core and the screen need: the pools a person
// keeps — the separate free pool, and capability tiers 1 to 5, cheapest to dearest, each an
// ordered chain of harness · login · model · thinking — the roles a prompt can be read as
// and the specialists they may call, what a saved setup may carry, and the trace one routed
// turn leaves behind, which the conversation draws as a thin line.
//
// The judgment itself (what Jev answers, and the math that turns it into a tier) lives in
// src/core/model-routing.ts: this file is pure shape, safe on both sides of the wire.
import { L } from './lang'
import type { Effort, EngineId } from './types'

/** Where a reply may land: the free pool, or a capability tier. Free is not a tier (see `Pool`). */
export type Tier = 't1' | 't2' | 't3' | 't4' | 't5'
export type Pool = 'free' | Tier
export const TIERS: readonly Tier[] = ['t1', 't2', 't3', 't4', 't5'] as const
export const POOLS: readonly Pool[] = ['free', 't1', 't2', 't3', 't4', 't5'] as const
/** Where each sits: free below every paid tier, tiers 1 (cheap) to 5 (dearest). */
export const POOL_RANK: Record<Pool, number> = { free: 0, t1: 1, t2: 2, t3: 3, t4: 4, t5: 5 }

export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
export const isPool = (v: unknown): v is Pool => typeof v === 'string' && (POOLS as readonly string[]).includes(v)

/** The tier of a rank, or undefined off the ladder (free has no tier). */
export const tierAt = (rank: number): Tier | undefined => TIERS.find((t) => POOL_RANK[t] === rank)

/**
 * One candidate: a harness, the login it runs on (one of Settings › Models › Accounts, the
 * harness's own when unset), the model id that harness expects, and how hard it thinks.
 * `id` is the execution's identity: two candidates with the same id are the same run, which is
 * what a receipt, a session and a deduplicated chain walk key on.
 */
export interface RouteTarget {
  id: string
  engine: EngineId
  accountId?: string
  model: string
  effort: Effort
}

/** The identity of one execution. The model may contain slashes, so the thinking sits last. */
export const targetId = (t: { engine: EngineId; accountId?: string; model: string; effort: Effort }): string =>
  `${t.engine}${t.accountId ? `@${t.accountId}` : ''}/${t.model}#${t.effort}`

/** A chain entry as a person writes it: the identity is filled in when it's saved. */
export type RouteDraft = Omit<RouteTarget, 'id'>

export interface PoolSetting {
  descriptor: string
  chain: RouteTarget[]
}

/**
 * A role's own model. `minTier` is the person's own eligibility call: the lowest capability tier
 * at which this specialist may be spent. It is separate from the role's floor (below).
 */
export interface RoleCandidate extends RouteTarget {
  minTier?: Tier
}

export interface RoleSetting {
  descriptor: string
  chain: RoleCandidate[]
}

/** What the free pool is for: preferred for cheap work, only a fallback, or off entirely. */
export type FreePolicy = 'prefer' | 'fallback' | 'off'

export interface RoutingConfig {
  enabled: boolean
  pools: Record<Pool, PoolSetting>
  roles: Record<string, RoleSetting>
  /** The tier below which a role's own specialists are not consulted at all. */
  roleFloor: Record<string, Tier>
  free: { policy: FreePolicy }
  /**
   * Under this confidence the read is a guess: it caps at tier 2 and cannot unlock tier 5.
   * 0: no cap. A confidence TypeSafe leaves out is unknown, never zero.
   */
  confidenceFloor: number
  /**
   * Whether the reading may reach tier 4 on its own. Off, it stops at tier 3; a role's floor still
   * lifts the reply there, because the switch is about Jev deciding on its own, not about the floor.
   */
  allowTier4: boolean
  /** Tier 5 runs only when it is also switched on here, has a chain, and the read qualifies. */
  allowTier5: boolean
  /** Used when a good read finds nothing eligible. Unset: the reply is not sent, and says so. */
  fallbackTargetId?: string
}

// The ten kinds the plugin routes on, in Tucano's spelling: its `implement` is Code here, so an
// imported setup keeps its meaning (see KIND_IMPORT). A person can add a role without a release.
export const ROLE_KINDS: Record<string, string> = {
  code: 'Writing or changing code, scripts or configuration until it works',
  review: 'Auditing code, a diff, a document or a plan for problems and risks',
  plan: 'Deciding what to build, sequencing work, designing an approach before any edit',
  debug: 'Diagnosing a failure, an error or odd behaviour, and finding its cause',
  refactor: 'Restructuring code that works without changing what it does',
  research: 'Searching, reading and pulling together external information or unfamiliar APIs',
  write: 'Producing prose, documentation or other non-code content from scratch',
  explain: 'Answering a question, or explaining how something works',
  operate: 'Running commands, tooling, git, deploys or setting up an environment',
  chat: 'Small talk, an acknowledgement, or a request with no real work behind it'
}

/** The plugin's own kind names, for an imported setup; everything else is already Tucano's. */
export const KIND_IMPORT: Record<string, string> = { implement: 'code' }

/** A chain longer than this is a mistake, not an intent. */
export const MAX_CHAIN = 40
/** More roles than this and the classifier is being asked to choose from noise. */
export const MAX_ROLES = 20
export const MAX_DESCRIPTOR = 400
const KEY = /^[a-z][a-z0-9_]{1,30}$/
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype'])

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
    free: { policy: 'prefer' },
    confidenceFloor: 0.34,
    allowTier4: true, // open by default: the reading has always been able to reach it
    allowTier5: false // an explicit switch: qualifying work may then reach the dearest pool on its own
  }
}

// ---------- what a routed turn leaves behind ----------

/** Why a candidate wasn't run, in a form the screen can key on as well as read. */
export type SkipCode = 'unavailable' | 'ineligible' | 'duplicate'

/** One step of the chain walked: where it came from, and why it wasn't run when it wasn't. */
export interface RouteAttempt {
  id: string
  engine: EngineId
  accountId?: string
  model: string
  effort: Effort
  /** Which chain it came from: the free pool, a role's specialists, or a capability tier. */
  from: { kind: 'free' } | { kind: 'role'; role: string } | { kind: 'tier'; tier: Tier }
  /** Why this one was passed over, in the person's language; absent on the one that ran. */
  skip?: string
  skipCode?: SkipCode
}

/** What Jev said about the prompt, exactly as it said it. */
export interface RouteReading {
  role: string
  /** 0..1 when TypeSafe said how sure it is; absent when it didn't (unknown, never zero). */
  confidence?: number
  probabilities?: Record<string, number>
  complexity: number
  capability: number
  deepReasoning: number
  ms: number
}

/**
 * What the router decided for one reply. It holds what happened, never what could be worked out
 * again from the settings: the line the person reads is drawn from this, and the numbers in it are
 * the ones the classifier gave at the time.
 */
export interface RouteTrace {
  at: number
  reading: RouteReading
  /** 0..3, before any floor or cap: what the reading itself asked for. */
  rawDemand: number
  /** 0..3, what the tiers actually policed after the role floor and the confidence cap. */
  demand: number
  /** The capability tier the raw demand asked for. Free never replaces it: it is a destination. */
  requested: Tier
  /** The tier after the role floor and the confidence cap: where the walk started. */
  policy: Tier
  /** The pool the model that ran came from, once one ran. */
  effective?: Pool
  /** Which chain the winner came from. */
  source?: 'free' | 'role' | 'tier'
  /** What the config did to the raw read (a floor, the confidence cap, tier 5 withheld). */
  notes: string[]
  /** Every candidate tried, in order, each with why it was skipped; the one without a `skip` ran. */
  attempts: RouteAttempt[]
  /** The execution routing picked: absent when nothing eligible ran. */
  selected?: RouteTarget
  /** What the agent would have used had routing not decided: what "kept" or "changed" is measured against. */
  baseline: RouteTarget
  /**
   * changed: another model ran · kept: the same one (the reason is in `notes`) · fallback: the first
   * choice couldn't run, a later one did · unavailable: routing couldn't decide (no key, no answer,
   * no usable model) and the baseline ran, `error` saying why · exhausted: it decided, nothing was
   * eligible, and the reply was not sent.
   */
  state: 'changed' | 'kept' | 'fallback' | 'unavailable' | 'exhausted'
  /** Why routing didn't decide, in the person's language; with 'unavailable' and 'exhausted'. */
  error?: string
}

/** The role choices with their probabilities, best first: the bars for the role criterion. */
export function roleBars(probabilities: Record<string, number> | undefined, limit = 3): { role: string; p: number }[] {
  return Object.entries(probabilities ?? {})
    .filter(([role]) => !!role)
    .map(([role, p]) => ({ role, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, limit)
}

// ---------- reading and writing ----------

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh']
const ENGINES: readonly string[] = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline']

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
const idOf = (v: Record<string, unknown>): string | undefined => (typeof v.id === 'string' && v.id ? v.id.slice(0, 300) : undefined)

/** One chain entry made fit, or undefined when it can't be one at all. */
function cleanTarget(value: unknown, kind: 'pool' | 'role'): RouteTarget | RoleCandidate | undefined {
  if (!isRecord(value)) return undefined
  const engine = typeof value.engine === 'string' && ENGINES.includes(value.engine) ? (value.engine as EngineId) : undefined
  const model = text(value.model, 200)
  const effort = typeof value.effort === 'string' && EFFORTS.includes(value.effort) ? (value.effort as Effort) : undefined
  // Nothing is invented here: an entry with an unknown harness, no model or a thinking level this
  // build can't run is not made into something else, it is dropped (a save refuses it instead).
  if (!engine || !model || !effort) return undefined
  const accountId = text(value.accountId, 100)
  const id = targetId({ engine, ...(accountId ? { accountId } : {}), model, effort })
  const base: RouteTarget = { id, engine, ...(accountId ? { accountId } : {}), model, effort }
  if (kind === 'role') {
    const minTier = isTier(value.minTier) ? value.minTier : undefined
    return { ...base, ...(minTier ? { minTier } : {}) }
  }
  return base
}

function cleanChain(value: unknown, kind: 'pool' | 'role'): (RouteTarget | RoleCandidate)[] {
  if (!Array.isArray(value)) return []
  const out: (RouteTarget | RoleCandidate)[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const target = cleanTarget(item, kind)
    if (!target || seen.has(target.id)) continue
    seen.add(target.id)
    out.push(target)
    if (out.length >= MAX_CHAIN) break
  }
  return out
}

/**
 * Anything saved by an older build or a hand-edited file, made fit to route with: unknown keys
 * dropped, defaults kept. This is the tolerant read, for loading and for an import preview;
 * a save goes through `validateRouting`, which refuses instead of quietly changing something.
 */
export function normalizeRouting(raw: unknown): RoutingConfig {
  const base = defaultRouting()
  if (!isRecord(raw)) return base
  const pools = { ...base.pools }
  const rawPools = isRecord(raw.pools) ? raw.pools : {}
  for (const p of POOLS) {
    const value = rawPools[p]
    if (!isRecord(value)) continue
    pools[p] = {
      descriptor: text(value.descriptor, MAX_DESCRIPTOR) ?? base.pools[p].descriptor,
      chain: cleanChain(value.chain, 'pool') as RouteTarget[]
    }
  }
  const roles: Record<string, RoleSetting> = {}
  const rawRoles = isRecord(raw.roles) ? raw.roles : {}
  let written = 0
  for (const [rawKind, value] of Object.entries(rawRoles)) {
    const kind = KIND_IMPORT[rawKind] ?? rawKind
    if (written >= MAX_ROLES || !KEY.test(kind) || DANGEROUS.has(kind) || !isRecord(value)) continue
    roles[kind] = {
      descriptor: text(value.descriptor, MAX_DESCRIPTOR) ?? ROLE_KINDS[kind] ?? kind,
      chain: cleanChain(value.chain, 'role') as RoleCandidate[]
    }
    written += 1
  }
  for (const kind of Object.keys(ROLE_KINDS)) if (!roles[kind]) roles[kind] = { descriptor: base.roles[kind]!.descriptor, chain: [] }
  const roleFloor: Record<string, Tier> = {}
  const rawFloors = isRecord(raw.roleFloor) ? raw.roleFloor : {}
  for (const [kind, value] of Object.entries(rawFloors)) {
    if (Object.hasOwn(roles, kind) && isTier(value)) roleFloor[kind] = value
  }
  const confidence = num(raw.confidenceFloor)
  // Older builds had a boolean `freeWhenCheap` and no free policy: true meant "try free first".
  const policy = ((): FreePolicy => {
    const p = isRecord(raw.free) ? raw.free.policy : undefined
    if (p === 'prefer' || p === 'fallback' || p === 'off') return p
    if (raw.freeWhenCheap === false) return 'off'
    if (raw.freeWhenCheap === true) return 'prefer'
    return base.free.policy
  })()
  return {
    enabled: raw.enabled === true,
    pools,
    roles,
    roleFloor,
    free: { policy },
    confidenceFloor: confidence === undefined ? base.confidenceFloor : Math.min(1, Math.max(0, confidence)),
    // Absent in a setup written before this switch existed, and open then as it is now.
    allowTier4: raw.allowTier4 !== false,
    allowTier5: raw.allowTier5 === true,
    ...(typeof raw.fallbackTargetId === 'string' && raw.fallbackTargetId ? { fallbackTargetId: raw.fallbackTargetId.slice(0, 300) } : {})
  }
}

export interface RoutingProblem {
  /** Where it is: `pools.t2.chain[1].effort`, `roles.code.descriptor`, `confidenceFloor`… */
  path: string
  /** What is wrong, in the person's language. */
  message: string
}

export type RoutingValidation = { ok: true; value: RoutingConfig } | { ok: false; problems: RoutingProblem[] }

/**
 * A save, judged instead of cleaned: every entry that this build can't run is named with where it
 * is, so nothing is silently turned into something else (an unsupported thinking level is a
 * visible refusal, not a quiet Medium). Reading an old setup stays tolerant — that is
 * `normalizeRouting`, above.
 */
export function validateRouting(raw: unknown): RoutingValidation {
  const problems: RoutingProblem[] = []
  if (!isRecord(raw)) return { ok: false, problems: [{ path: '', message: L('não é um conjunto de rotas', "isn't a routing setup") }] }

  const checkChain = (where: string, chain: unknown, kind: 'pool' | 'role'): void => {
    if (!Array.isArray(chain)) {
      problems.push({ path: where, message: L('tem que ser uma lista de modelos', 'must be a list of models') })
      return
    }
    if (chain.length > MAX_CHAIN) problems.push({ path: where, message: L(`no máximo ${MAX_CHAIN} modelos`, `at most ${MAX_CHAIN} models`) })
    chain.forEach((entry, i) => {
      const at = `${where}[${i}]`
      if (!isRecord(entry)) {
        problems.push({ path: at, message: L('não é um modelo', "isn't a model") })
        return
      }
      if (typeof entry.engine !== 'string' || !ENGINES.includes(entry.engine)) problems.push({ path: `${at}.engine`, message: L('harness desconhecido', 'unknown harness') })
      if (!text(entry.model, 200)) problems.push({ path: `${at}.model`, message: L('modelo em branco', 'model is empty') })
      if (typeof entry.effort !== 'string' || !EFFORTS.includes(entry.effort))
        problems.push({ path: `${at}.effort`, message: L('esse nível de raciocínio não existe aqui (use low, medium, high ou xhigh)', "that thinking level doesn't exist here (use low, medium, high or xhigh)") })
      if (entry.accountId !== undefined && !text(entry.accountId, 100)) problems.push({ path: `${at}.accountId`, message: L('conta em branco', 'account is empty') })
      if (kind === 'role' && entry.minTier !== undefined && !isTier(entry.minTier)) problems.push({ path: `${at}.minTier`, message: L('tier mínimo desconhecido', 'unknown minimum tier') })
    })
  }

  const pools = isRecord(raw.pools) ? raw.pools : {}
  for (const p of POOLS) {
    const value = pools[p]
    if (value === undefined) continue
    if (!isRecord(value)) {
      problems.push({ path: `pools.${p}`, message: L('não é um pool', "isn't a pool") })
      continue
    }
    if (value.descriptor !== undefined && (typeof value.descriptor !== 'string' || value.descriptor.length > MAX_DESCRIPTOR))
      problems.push({ path: `pools.${p}.descriptor`, message: L(`a descrição vai até ${MAX_DESCRIPTOR} caracteres`, `the description goes up to ${MAX_DESCRIPTOR} characters`) })
    checkChain(`pools.${p}.chain`, value.chain ?? [], 'pool')
  }

  const roles = isRecord(raw.roles) ? raw.roles : {}
  const kinds = Object.keys(roles)
  if (kinds.length > MAX_ROLES) problems.push({ path: 'roles', message: L(`no máximo ${MAX_ROLES} papéis`, `at most ${MAX_ROLES} roles`) })
  for (const [kind, value] of Object.entries(roles)) {
    if (!KEY.test(kind) || DANGEROUS.has(kind)) {
      problems.push({ path: `roles.${kind}`, message: L('nome de papel inválido', 'invalid role name') })
      continue
    }
    if (!isRecord(value)) {
      problems.push({ path: `roles.${kind}`, message: L('não é um papel', "isn't a role") })
      continue
    }
    if (value.descriptor !== undefined && (typeof value.descriptor !== 'string' || value.descriptor.length > MAX_DESCRIPTOR))
      problems.push({ path: `roles.${kind}.descriptor`, message: L(`a descrição vai até ${MAX_DESCRIPTOR} caracteres`, `the description goes up to ${MAX_DESCRIPTOR} characters`) })
    checkChain(`roles.${kind}.chain`, value.chain ?? [], 'role')
  }

  const floors = isRecord(raw.roleFloor) ? raw.roleFloor : {}
  for (const [kind, value] of Object.entries(floors)) {
    if (!Object.hasOwn(roles, kind)) problems.push({ path: `roleFloor.${kind}`, message: L('papel que não existe', "role that doesn't exist") })
    else if (!isTier(value)) problems.push({ path: `roleFloor.${kind}`, message: L('tier desconhecido', 'unknown tier') })
  }

  const confidence = raw.confidenceFloor
  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1))
    problems.push({ path: 'confidenceFloor', message: L('a confiança vai de 0 a 1', 'confidence goes from 0 to 1') })

  const policy = isRecord(raw.free) ? raw.free.policy : undefined
  if (policy !== undefined && policy !== 'prefer' && policy !== 'fallback' && policy !== 'off')
    problems.push({ path: 'free.policy', message: L('o pool grátis é prefer, fallback ou off', 'the free pool is prefer, fallback or off') })

  if (raw.allowTier4 !== undefined && typeof raw.allowTier4 !== 'boolean') problems.push({ path: 'allowTier4', message: L('tem que ser sim ou não', 'must be on or off') })
  if (raw.allowTier5 !== undefined && typeof raw.allowTier5 !== 'boolean') problems.push({ path: 'allowTier5', message: L('tem que ser sim ou não', 'must be on or off') })
  if (raw.fallbackTargetId !== undefined && raw.fallbackTargetId !== null && !text(raw.fallbackTargetId, 300))
    problems.push({ path: 'fallbackTargetId', message: L('modelo de reserva em branco', 'the reserve model is empty') })

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, value: normalizeRouting(raw) }
}
