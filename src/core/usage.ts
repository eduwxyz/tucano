// Uso e limites: this month's receipts, by day, by who spent them and by model.
import { countedTokens, type EngineId, type UsageReport } from '../shared/types'
import { monthStart, type Db } from './db'

const APP = new Set(['router', 'memory', 'accounts']) // the app's own turns, not replies

export function usage(db: Db, now = new Date()): UsageReport {
  const start = monthStart(now)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  // The same stretch of last month: from its first day to this day and hour (capped at its end).
  const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime()
  const lastUntil = Math.min(start, new Date(now.getFullYear(), now.getMonth() - 1, now.getDate(), now.getHours(), now.getMinutes()).getTime())
  const all = db.receiptsSince(lastStart)
  const before = all.filter((r) => r.at < start)
  const month = all.filter((r) => r.at >= start && r.at <= now.getTime())

  const days: Record<string, number>[] = Array.from({ length: now.getDate() }, () => ({}))
  const who = new Map<string, { tokens: number; replies: Set<string>; ms: number }>()
  const models = new Map<string, { model: string; engine: EngineId; tokens: number }>()
  const replies = new Set<string>()
  let total = 0
  let apiUsd = 0
  let ms = 0
  for (const r of month) {
    const t = countedTokens(r)
    total += t
    apiUsd += r.apiCostUsd ?? 0
    const day = days[new Date(r.at).getDate() - 1]
    if (day) day[r.agentId] = (day[r.agentId] ?? 0) + t
    const w = who.get(r.agentId) ?? { tokens: 0, replies: new Set<string>(), ms: 0 }
    w.tokens += t
    if (!APP.has(r.agentId)) {
      w.replies.add(r.messageId)
      w.ms += r.ms
      replies.add(r.messageId)
      ms += r.ms
    }
    who.set(r.agentId, w)
    const key = `${r.engine}:${r.model}`
    const m = models.get(key) ?? { model: r.model, engine: r.engine as EngineId, tokens: 0 }
    m.tokens += t
    models.set(key, m)
  }

  return {
    monthStart: start,
    daysInMonth,
    total,
    replies: replies.size,
    apiUsd,
    avgMs: replies.size ? Math.round(ms / replies.size) : 0,
    lastMonth: before.length ? before.filter((r) => r.at < lastUntil).reduce((acc, r) => acc + countedTokens(r), 0) : undefined,
    days,
    who: [...who].map(([id, w]) => ({ id, tokens: w.tokens, replies: w.replies.size, avgMs: w.replies.size ? Math.round(w.ms / w.replies.size) : 0 })).sort((a, b) => b.tokens - a.tokens),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens)
  }
}
