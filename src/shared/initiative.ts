// A person's proactive coordinator: the bot they pick to keep an eye on their work between messages
// (docs/autonomous-bots-plan.md in the fork). This file is the whole contract: what a page sends, what
// the core stores, and the rules both sides share.
//
// Initiative says when a review may happen, never what a tool may do. Autonomy (actions.ts) keeps
// deciding every permission, and a responsibility can only narrow what the person and the agent could
// already reach: an empty scope means the home conversation alone, never everything.
import { ACTION_KINDS, type ActionKind } from './actions'
import { L } from './lang'

// How far a responsibility got. done and dismissed are closed; the others are still work.
export const COMMITMENT_STATES = ['open', 'in_progress', 'waiting_external', 'waiting_user', 'done', 'dismissed'] as const
export type CommitmentState = (typeof COMMITMENT_STATES)[number]
const CLOSED: readonly CommitmentState[] = ['done', 'dismissed']
export const isClosed = (s: CommitmentState): boolean => CLOSED.includes(s)

// Whether a person wants to be interrupted. Permission to run reviews is `enabled`, separately.
// material: findings that matter now; decisions: only what waits on them; none: never interrupts.
export const NOTIFY_MODES = ['material', 'decisions', 'none'] as const
export type NotifyMode = (typeof NOTIFY_MODES)[number]

// What a commitment rests on: a message or a file an agent showed. The record keeps the id, never a
// copy of the text: what a person can no longer see is no longer evidence.
export const EVIDENCE_KINDS = ['message', 'artifact'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]
export interface EvidenceRef {
  kind: EvidenceKind
  id: string
}

// Work already running elsewhere. A commitment stores the link, not a second copy of its lifecycle:
// the delegation, approval, question or run stays the one that says whether it is done.
export const LINK_KINDS = ['run', 'delegation', 'question', 'approval'] as const
export type LinkKind = (typeof LINK_KINDS)[number]
export interface CommitmentLink {
  kind: LinkKind
  id: string
}

// Where a review may look, and where a responsibility may act: conversations the person can already
// reach. Empty: the home conversation only (see `inReach`).
export interface ObservationScope {
  conversations: string[]
}
export interface WorkScope extends ObservationScope {
  kinds: ActionKind[] // what may go out to other people or spend something: never more than Autonomy allows
}

export interface InitiativeConfig {
  personId: string
  agentId: string
  conversationId: string // the home DM: the conversation a review resumes
  enabled: boolean
  brief: string // the standing responsibilities, in the person's words
  observe: ObservationScope
  work: WorkScope
  cadenceMinutes: number // the first review's interval; quiet reviews back off from it
  notify: NotifyMode
  dailyReviews: number
  dailyTokens: number
  timezone: string // IANA name, for when a day starts
  revision: number // bumped on every edit: a queued review from before it cannot apply
  createdAt: number
  updatedAt: number
}

// What a page sends. The person is who is asking, and the revision comes beside it.
export type InitiativeInput = Omit<InitiativeConfig, 'personId' | 'revision' | 'createdAt' | 'updatedAt'>

export interface CommitmentInput {
  id?: string // a different state for one that exists
  agentId: string
  conversationId: string // where it was read: a message's or a person's own words
  messageId?: string
  by: 'person' | 'agent' // who wrote the source
  description: string
  scope: WorkScope
  state?: CommitmentState // unset: open, or what it was
  note?: string // why it waits, in the coordinator's words
  nextCheckAt?: number
  evidence?: EvidenceRef[]
  links?: CommitmentLink[]
}

export interface Commitment {
  id: string
  personId: string
  agentId: string
  conversationId: string
  messageId?: string
  by: 'person' | 'agent'
  description: string
  scope: WorkScope
  state: CommitmentState
  note?: string
  nextCheckAt?: number
  evidence: EvidenceRef[]
  links: CommitmentLink[]
  // How many check-ins in a row found this one exactly where it was: a cycle with no progress is
  // bounded, not repeated forever.
  unchangedFor: number
  createdAt: number
  updatedAt: number
  closedAt?: number
}

// What a page shows: the configuration, what the coordinator holds, what it did, and what is left of
// today's allowance. Everything here is the person's own.
export interface InitiativeStatus {
  dueAt?: number // when the next check-in is due; unset: off
  open: number // responsibilities still open
  waitingOnPerson: number // of those, the ones resting on their answer or approval
  today: { reviews: number; tokens: number } // what today has used
  paused: boolean // the app is paused, so nothing runs
}

export interface InitiativeView {
  config: InitiativeConfig | null // unset: this person has no coordinator, and nothing runs
  commitments: Commitment[]
  wakes: InitiativeWake[] // newest first: the internal evidence, for the person whose it is
  status: InitiativeStatus
}

// What a check-in came to. `quiet`: it found nothing that needs the person, and said nothing in the
// conversation. `reported`: it said something they can read. `failed`: the reply did not finish
// (`interrupted`: the app stopped with it running). `skipped`: it was admitted and then refused
// before any work started (`why` says what changed).
export const WAKE_OUTCOMES = ['quiet', 'reported', 'failed', 'skipped', 'interrupted'] as const
export type WakeOutcome = (typeof WAKE_OUTCOMES)[number]

// Where a responsibility rests on work running elsewhere: the link, and what that work last said. The
// commitment keeps the link; the state below is read from the work itself, never stored twice.
export const DEPENDENCY_STATES = ['working', 'waiting', 'answered', 'decided', 'done', 'failed', 'cancelled', 'gone'] as const
export type DependencyState = (typeof DEPENDENCY_STATES)[number]
export interface LinkSnapshot {
  kind: LinkKind
  id: string
  state: DependencyState
  version: string // everything that changes when the linked work moves: a resume fires on a new one
  what?: string // how it reads in a sentence ("Clara, #clientes")
}

// Why a check-in was admitted and did not run. The record keeps it, so a person can later read that
// their bot was ready and what stopped it.
export const WAKE_WHYS = ['paused', 'revision', 'agent', 'dm', 'off', 'error'] as const
export type WakeWhy = (typeof WAKE_WHYS)[number]

// One attempt, kept after the conversation forgot it: the internal evidence of what the coordinator
// did on the person's behalf, and what it cost.
export interface InitiativeWake {
  id: string
  personId: string
  agentId: string
  revision: number // the configuration it was admitted under
  at: number
  endedAt?: number
  outcome: WakeOutcome
  why?: WakeWhy
  text?: string // what it said, for the person alone
  tokens: number
  messageId?: string
  // It said what the last one said, word for word: nothing was delivered, and its record says why.
  deduped?: boolean
  // A report reached the conversation and the person. A record without this and without `deduped` is a
  // report whose delivery did not happen: the app closed between the two, and it is delivered later
  // without running the check-in again.
  delivered?: boolean
}

// The interval a person's coordinator waits before its next check-in: the brief's cadence, doubling
// for each check-in in a row that found nothing, up to the ceiling.
export const MAX_QUIET_BACKOFF = 8
export const backoffMinutes = (cadenceMinutes: number, quietStreak: number): number =>
  Math.min(MAX_CADENCE_MINUTES, cadenceMinutes * 2 ** Math.min(quietStreak, MAX_QUIET_BACKOFF))

// When the day a daily allowance counts in began, in the person's own time zone (no zone: this
// computer's day). Nothing here depends on the platform's zone, so a person who travels keeps the
// day they wrote.
export const dayStartIn = (timeZone: string, now: number): number => {
  const local = new Date(now)
  if (!timeZone) return new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime()
  const offsetAt = (at: number): number => {
    const parts = new Intl.DateTimeFormat('en', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at))
    const v = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
    const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'))
    return asUtc - at
  }
  const offset = offsetAt(now)
  const shifted = new Date(now + offset)
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offset
}

// Whether a check-in's answer is the marker and nothing else. Anything written after it is a report,
// and a report is never hidden: losing what the person should read is worse than a stray marker.
export const QUIET_MARKER = '[[quiet]]'
export const isQuiet = (text: string): boolean => {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length === 1 && (lines[0] ?? '').replace(/[*_`]/g, '').toLowerCase() === QUIET_MARKER
}

// The tuning defaults, not promises. Cadence doubles after quiet reviews up to MAX_CADENCE_MINUTES.
export const DEFAULT_CADENCE_MINUTES = 15
export const MIN_CADENCE_MINUTES = 5
export const MAX_CADENCE_MINUTES = 120
export const DEFAULT_DAILY_REVIEWS = 24
export const MAX_DAILY_REVIEWS = 96
export const DEFAULT_DAILY_TOKENS = 2_000_000
export const MAX_DAILY_TOKENS = 200_000_000
export const DEFAULT_NOTIFY: NotifyMode = 'material'

export const INITIATIVE_LIMITS = {
  brief: 2_000,
  description: 600,
  note: 500,
  conversations: 24,
  evidence: 20,
  links: 12
}

// How many responsibilities one coordinator holds at a time: enough for a person's plate, small enough
// that every check-in can read them all.
export const MAX_COMMITMENTS = 12
// While a question of the coordinator's waits for the person, a check-in that asks it again helps no
// one: the wait is at least this long, whatever the cadence says.
export const REMINDER_FLOOR_MINUTES = 120
// Check-ins in a row that may find a responsibility exactly where it was before the coordinator is
// told to take a step or close it.
export const STALL_AFTER = 6

const line = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max).trim() : '')
// A person's own words are kept whole: a brief or a note is refused when it is too long, never cut.
const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '')
const number = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback)
const refs = <T extends string>(v: unknown, kinds: readonly T[], max: number): { kind: T; id: string }[] => {
  const out: { kind: T; id: string }[] = []
  for (const r of Array.isArray(v) ? v : []) {
    const kind = (r as { kind?: unknown } | null)?.kind
    const id = line((r as { id?: unknown } | null)?.id, 200)
    if (typeof kind !== 'string' || !(kinds as readonly string[]).includes(kind) || !id) continue
    if (!out.some((o) => o.kind === kind && o.id === id)) out.push({ kind: kind as T, id })
  }
  return out.slice(0, max)
}
// The ids of whatever a page sent, each once, in the order given.
const ids = (v: unknown, max: number): string[] => {
  const out: string[] = []
  for (const id of Array.isArray(v) ? v : []) {
    const clean = line(id, 200)
    if (clean && !out.includes(clean)) out.push(clean)
  }
  return out.slice(0, max)
}

export const cleanObserve = (v: unknown): ObservationScope => ({ conversations: ids((v as ObservationScope | null)?.conversations, INITIATIVE_LIMITS.conversations) })
export const cleanWork = (v: unknown): WorkScope => {
  const kinds = (v as WorkScope | null)?.kinds
  return {
    conversations: ids((v as WorkScope | null)?.conversations, INITIATIVE_LIMITS.conversations),
    kinds: (Array.isArray(kinds) ? kinds : []).filter((k): k is ActionKind => (ACTION_KINDS as readonly string[]).includes(k))
  }
}

// A saved record is normalized as it is read: Windows line breaks become newlines, ids and kinds are
// kept once each, and the person's own words are kept whole.
export const cleanInitiative = (input: Partial<InitiativeInput>): InitiativeInput => ({
  agentId: line(input.agentId, 200),
  conversationId: line(input.conversationId, 200),
  enabled: input.enabled === true,
  brief: text(input.brief),
  observe: cleanObserve(input.observe),
  work: cleanWork(input.work),
  cadenceMinutes: number(input.cadenceMinutes, DEFAULT_CADENCE_MINUTES),
  notify: NOTIFY_MODES.includes(input.notify as NotifyMode) ? (input.notify as NotifyMode) : DEFAULT_NOTIFY,
  dailyReviews: number(input.dailyReviews, DEFAULT_DAILY_REVIEWS),
  dailyTokens: number(input.dailyTokens, DEFAULT_DAILY_TOKENS),
  timezone: line(input.timezone, 60)
})

export const cleanCommitment = (input: Partial<CommitmentInput>): CommitmentInput => ({
  ...(line(input.id, 200) ? { id: line(input.id, 200) } : {}),
  agentId: line(input.agentId, 200),
  conversationId: line(input.conversationId, 200),
  ...(line(input.messageId, 200) ? { messageId: line(input.messageId, 200) } : {}),
  by: input.by === 'agent' ? 'agent' : 'person',
  description: text(input.description),
  scope: cleanWork(input.scope),
  ...(COMMITMENT_STATES.includes(input.state as CommitmentState) ? { state: input.state as CommitmentState } : {}),
  ...(text(input.note) ? { note: text(input.note) } : {}),
  ...(typeof input.nextCheckAt === 'number' && Number.isFinite(input.nextCheckAt) ? { nextCheckAt: Math.round(input.nextCheckAt) } : {}),
  evidence: refs(input.evidence, EVIDENCE_KINDS, INITIATIVE_LIMITS.evidence),
  links: refs(input.links, LINK_KINDS, INITIATIVE_LIMITS.links)
})

// A time zone is one the platform knows: the daily allowance counts in the person's day.
export const knownTimeZone = (tz: string): boolean => {
  if (!tz) return true
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const timeZoneError = (): string => L('Fuso horário desconhecido.', 'That time zone is not one this computer knows.')

// What is wrong with a configuration as a shape (a missing agent or home is the core's to check).
export function initiativeError(c: InitiativeInput): string | undefined {
  if (!c.agentId) return L('Escolha o bot que vai cuidar disso.', 'Choose the bot that will keep an eye on this.')
  if (!c.conversationId) return L('Escolha a conversa em que ele trabalha.', 'Choose the conversation it works in.')
  if (c.enabled && !c.brief) return L('Escreva o que ele deve cuidar.', 'Write what it should look after.')
  if (c.brief.length > INITIATIVE_LIMITS.brief) return L(`O que ele deve cuidar vai até ${INITIATIVE_LIMITS.brief.toLocaleString('pt-BR')} caracteres.`, `What it should look after goes up to ${INITIATIVE_LIMITS.brief.toLocaleString('en-US')} characters.`)
  if (!knownTimeZone(c.timezone)) return timeZoneError()
  if (c.cadenceMinutes < MIN_CADENCE_MINUTES || c.cadenceMinutes > MAX_CADENCE_MINUTES) return L(`O intervalo vai de ${MIN_CADENCE_MINUTES} a ${MAX_CADENCE_MINUTES} minutos.`, `The interval goes from ${MIN_CADENCE_MINUTES} to ${MAX_CADENCE_MINUTES} minutes.`)
  if (c.dailyReviews < 1 || c.dailyReviews > MAX_DAILY_REVIEWS) return L(`As revisões por dia vão de 1 a ${MAX_DAILY_REVIEWS}.`, `Reviews a day go from 1 to ${MAX_DAILY_REVIEWS}.`)
  if (c.dailyTokens < 100_000 || c.dailyTokens > MAX_DAILY_TOKENS) return L('O limite diário de tokens é baixo ou alto demais.', 'That daily token limit is too low or too high.')
  // Acting somewhere means reading it: a conversation it may act in is one it may look at.
  const stray = c.work.conversations.find((id) => id !== c.conversationId && !c.observe.conversations.includes(id))
  if (stray) return L('Só dá pra agir numa conversa que ele também pode ler.', 'It can only act in a conversation it may also read.')
  return undefined
}

// What is wrong with a responsibility as a shape. Where its targets are is the core's to check.
export function commitmentError(c: CommitmentInput): string | undefined {
  if (!c.description) return L('Escreva o que precisa ser feito.', 'Write what needs doing.')
  if (c.description.length > INITIATIVE_LIMITS.description) return L(`Descreva em até ${INITIATIVE_LIMITS.description} caracteres.`, `Describe it in up to ${INITIATIVE_LIMITS.description} characters.`)
  if ((c.note?.length ?? 0) > INITIATIVE_LIMITS.note) return L(`A nota vai até ${INITIATIVE_LIMITS.note} caracteres.`, `The note goes up to ${INITIATIVE_LIMITS.note} characters.`)
  if (!c.agentId) return L('Escolha o bot responsável.', 'Choose the bot responsible.')
  if (!c.conversationId) return L('Diga de onde isso veio.', 'Say where this came from.')
  if (c.nextCheckAt !== undefined && c.nextCheckAt <= 0) return L('Data de conferência inválida.', 'Invalid check time.')
  return undefined
}

// Whether a responsibility stays inside the scope its coordinator was given.
export function within(parent: WorkScope, child: WorkScope): boolean {
  return child.kinds.every((k) => parent.kinds.includes(k)) && child.conversations.every((id) => parent.conversations.includes(id))
}

// Whether a conversation is one a scope names; the home conversation is always in reach.
export const inReach = (scope: ObservationScope, home: string, id: string): boolean => id === home || scope.conversations.includes(id)

// The state a responsibility moves to, closed or reopened, keeps when it closed.
export const closedAtFor = (state: CommitmentState, now: number, prev?: number): number | undefined => (isClosed(state) ? (prev ?? now) : undefined)
