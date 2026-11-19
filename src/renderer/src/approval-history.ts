// The approvals' history as a person reads it: by day, newest first, with the same action
// repeated in a day folded into one row ("Rodar um comando ×3 · 12:30, 12:38, 12:41").
// Kept apart from React so the grouping can be tested without a browser.
import type { Approval } from '../../shared/types'
import { L, locale } from '../../shared/lang'

// What came of it. "failed": approved, but it didn't go through (the computer was off, the access
// changed, the call errored), which is as much an exception as a refusal.
export type HistoryStatus = 'approved' | 'refused' | 'expired' | 'failed'

// The core writes the outcome in the language of the moment, so both are read.
const FAILED = /^(Não executou|Didn't run|Rodou, com erro|Ran, with an error|Executou, com erro|Falhou|Failed|Nada foi aberto|Nothing was opened)/

export function historyStatus(a: Pick<Approval, 'state' | 'outcome'>): HistoryStatus {
  if (a.state === 'approved') return a.outcome && FAILED.test(a.outcome) ? 'failed' : 'approved'
  return a.state === 'refused' ? 'refused' : 'expired'
}

export const isException = (s: HistoryStatus): boolean => s !== 'approved'

export interface HistoryGroup {
  key: string
  agentId: string
  connectorId: string
  connectorName: string
  what: string
  status: HistoryStatus
  items: Approval[] // oldest first, so the times read in order
}

export interface HistoryDay {
  day: number // local midnight
  counts: Record<HistoryStatus, number>
  rows: HistoryGroup[] // the one that happened last first
}

const decided = (a: Approval): number => a.decidedAt ?? a.createdAt
const midnight = (t: number): number => new Date(t).setHours(0, 0, 0, 0)

// Decided approvals only (pending ones are skipped). `what` names the action in words; two
// approvals fold together when the agent, the words, the connector, the status and the day match.
export function groupHistory(approvals: readonly Approval[], what: (a: Approval) => string, onlyExceptions = false): HistoryDay[] {
  const days = new Map<number, { counts: Record<HistoryStatus, number>; groups: Map<string, HistoryGroup> }>()
  const past = approvals.filter((a) => a.state !== 'pending').sort((a, b) => decided(a) - decided(b))
  for (const a of past) {
    const status = historyStatus(a)
    if (onlyExceptions && !isException(status)) continue
    const day = midnight(decided(a))
    let d = days.get(day)
    if (!d) days.set(day, (d = { counts: { approved: 0, refused: 0, expired: 0, failed: 0 }, groups: new Map() }))
    d.counts[status]++
    const words = what(a)
    const key = [a.agentId, words, a.connectorId, status].join('\u0000')
    const g = d.groups.get(key)
    if (g) g.items.push(a)
    else d.groups.set(key, { key: `${day}:${key}`, agentId: a.agentId, connectorId: a.connectorId, connectorName: a.connectorName, what: words, status, items: [a] })
  }
  return [...days.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([day, d]) => ({ day, counts: d.counts, rows: [...d.groups.values()].sort((a, b) => decided(b.items.at(-1)!) - decided(a.items.at(-1)!)) }))
}

export const exceptionCount = (approvals: readonly Approval[]): number => approvals.filter((a) => a.state !== 'pending' && isException(historyStatus(a))).length

// "Hoje", "Ontem", "Sexta, 13 de nov" (a date with its year only when it isn't this one).
export function dayLabel(day: number, now = Date.now()): string {
  const today = midnight(now)
  if (day === today) return L('Hoje', 'Today')
  if (day === midnight(today - 12 * 3_600_000)) return L('Ontem', 'Yesterday')
  const d = new Date(day)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const text = d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).replace('.', '')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// "6 aprovadas", "5 aprovadas, 1 recusada": what a day came to, the approved first.
export function daySummary(counts: Record<HistoryStatus, number>): string {
  const word: Record<HistoryStatus, (n: number) => string> = {
    approved: (n) => L(`${n} ${n === 1 ? 'aprovada' : 'aprovadas'}`, `${n} approved`),
    refused: (n) => L(`${n} ${n === 1 ? 'recusada' : 'recusadas'}`, `${n} refused`),
    failed: (n) => L(`${n} ${n === 1 ? 'falhou' : 'falharam'}`, `${n} failed`),
    expired: (n) => L(`${n} ${n === 1 ? 'expirada' : 'expiradas'}`, `${n} expired`)
  }
  return (['approved', 'refused', 'failed', 'expired'] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => word[s](counts[s]))
    .join(', ')
}
