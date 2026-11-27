// Uso e limites › Execuções: the agents' finished replies, as a list someone can investigate.
import { firstLine } from '../shared/titles'
import { countedTokens, OK_STATUSES, type ExecutionFilter, type ExecutionPage, type ExecutionQuery, type ExecutionRow, type ExecutionStep, type Message, type RunStatus, type ToolStat } from '../shared/types'
import type { Db } from './db'

const DAY = 86_400_000
const PREVIEW_MAX = 120
const PAGE = 50

export type CanRead = (reply: Pick<Message, 'conversationId' | 'at'>) => boolean
// The Tuca is the app's own, like the router and memory: Usage counts it backstage, not as the team's work.
export const backstage = (db: Db): Set<string> => new Set(db.agents().flatMap((a) => (a.kind === 'tuca' ? [a.id] : [])))

type Outcome = ReturnType<Db['agentReplyOutcomes']>[number]

// How long it took: what the harness reported, else from when this attempt started to when it ended.
const durationOf = (r: Outcome): number | undefined => r.ms ?? (r.endedAt === undefined ? undefined : Math.max(0, r.endedAt - (r.startedAt ?? r.at)))

// Only the rows on the page read their whole reply.
const toRow = (db: Db, r: Outcome): ExecutionRow => {
  const m = db.message(r.id)!
  const { receipt, steps } = m.run!
  return {
    id: r.id,
    conversationId: r.conversationId,
    agentId: r.agentId,
    preview: firstLine(m.text.slice(0, 400)).slice(0, PREVIEW_MAX),
    status: r.status,
    at: r.at,
    tools: steps.filter((s) => s.tool).length,
    model: receipt?.model,
    tokens: receipt && countedTokens(receipt),
    ms: durationOf(r)
  }
}

const IN_FILTER: Record<ExecutionFilter, ReadonlySet<RunStatus>> = {
  ok: OK_STATUSES,
  failed: new Set(['failed']),
  stopped: new Set(['stopped', 'limit_reached', 'paused', 'interrupted'])
}

// The value at or below which this share of them falls (nearest rank): always one that really happened.
function percentile(values: number[], share: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)]
}

// One reply's steps. What a person steered is theirs, and isn't a step of the work.
export function executionSteps(db: Db, messageId: string): ExecutionStep[] | undefined {
  const m = db.message(messageId)
  if (!m?.run || m.author.kind !== 'agent') return undefined
  return m.run.steps.filter((s) => s.kind !== 'steer').map(({ id, label, detail, tool, status, ms, error }) => ({ id, label, detail, tool, status, ms, error }))
}

// Each tool's uses, p95 and error rate across these replies, slowest first.
export function toolStats(replies: Pick<Message, 'run'>[]): ToolStat[] {
  const byTool = new Map<string, { uses: number; failed: number; times: number[] }>()
  for (const r of replies) {
    for (const s of r.run?.steps ?? []) {
      if (!s.tool) continue
      const t = byTool.get(s.tool) ?? { uses: 0, failed: 0, times: [] }
      t.uses++
      if (s.status === 'error' && s.ms !== undefined) t.failed++ // a call that never came back (the reply ended under it) isn't the tool failing
      if (s.ms !== undefined) t.times.push(s.ms)
      byTool.set(s.tool, t)
    }
  }
  return [...byTool].map(([tool, t]) => ({ tool, uses: t.uses, p95: percentile(t.times, 0.95), errorRate: t.failed / t.uses })).sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1))
}

export function executions(db: Db, canRead: CanRead, query: ExecutionQuery, now = Date.now()): ExecutionPage {
  const { agentId, status, beforeAt, beforeId } = query
  const app = backstage(db)
  const selected = db.agentReplyOutcomes(now - query.days * DAY).filter((r) => r.status !== 'working' && !app.has(r.agentId) && (!agentId || r.agentId === agentId) && (!status || IN_FILTER[status].has(r.status)) && canRead(r))
  const times = selected.flatMap((r) => durationOf(r) ?? [])
  // By position in the order (newest first, then id), so a reply landing meanwhile moves nothing.
  const after = beforeAt !== undefined && beforeId !== undefined ? selected.filter((r) => r.at < beforeAt || (r.at === beforeAt && r.id < beforeId)) : selected
  const shown = after.slice(0, PAGE)
  const last = shown.at(-1)
  return {
    rows: shown.map((r) => toRow(db, r)),
    next: after.length > PAGE && last ? { at: last.at, id: last.id } : undefined,
    count: selected.length,
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
    errorRate: selected.length ? selected.filter((r) => r.status === 'failed').length / selected.length : undefined
  }
}
