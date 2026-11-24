// The report (spec §20): computed on demand from replies, approvals and receipts,
// for one calendar week (Monday to Sunday), with the five before it for the trend.
import { countedTokens, isTeam, OK_STATUSES, type AgentReport, type Message, type Problem, type Rate, type Report, type SkillReport } from '../shared/types'
import type { Db } from './db'
import { backstage, toolStats, type CanRead } from './executions'

const WEEKS = 6
const WEEK = 7 * 86_400_000
const PROBLEMS = 6 // per agent, the latest

// Monday 00:00 of the week `t` is in.
export const weekStart = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}
const plusWeeks = (week: number, n: number): number => {
  const d = new Date(week)
  d.setDate(d.getDate() + 7 * n)
  return d.getTime()
}
const CUT = /^Parei: (repeti|\d+ ferramentas falharam|fiquei)/

const rate = (ms: Message[]): Rate => ({ replies: ms.length, ok: ms.filter((m) => OK_STATUSES.has(m.run!.status)).length })

export function report(db: Db, now = Date.now(), week = weekStart(now), canRead: CanRead = () => true): Report {
  const until = plusWeeks(week, 1)
  const since = plusWeeks(week, 1 - WEEKS)
  const all = db.messages().filter((m) => m.author.kind === 'agent' && m.run && m.at >= since && m.at < until && m.run.status !== 'working')
  const replies = all.filter((m) => m.at >= week)
  const approvals = db.approvals().filter((a) => a.createdAt >= week && a.createdAt < until)
  const weekAt = (i: number): number => plusWeeks(week, i - (WEEKS - 1))
  const app = backstage(db)

  const agents: AgentReport[] = db
    .agents()
    .filter(isTeam)
    .map((a) => {
      const mine = replies.filter((m) => m.author.kind === 'agent' && m.author.id === a.id)
      const history = all.filter((m) => m.author.kind === 'agent' && m.author.id === a.id)
      const costs = mine.flatMap((m) => (m.run!.receipt ? [{ tokens: countedTokens(m.run!.receipt), ms: m.run!.receipt.ms }] : []))
      const avg = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((x, y) => x + y, 0) / xs.length) : 0)
      const asked = approvals.filter((x) => x.agentId === a.id)
      const failed = mine.filter((m) => m.run!.status === 'failed' && !CUT.test(m.run!.error ?? ''))
      const cut = mine.filter((m) => CUT.test(m.run!.error ?? ''))
      const paused = mine.filter((m) => m.run!.status === 'paused' || m.run!.budget !== undefined)
      const refused = asked.filter((x) => x.state === 'refused')
      const problems: Problem[] = [
        ...failed.map((m) => ({ kind: 'failed' as const, at: m.at, conversationId: m.conversationId, messageId: m.id, detail: m.run!.error })),
        ...cut.map((m) => ({ kind: 'cut' as const, at: m.at, conversationId: m.conversationId, messageId: m.id, detail: m.run!.error })),
        ...paused.map((m) => ({ kind: 'paused' as const, at: m.at, conversationId: m.conversationId, messageId: m.id })),
        ...refused.map((x) => ({ kind: 'refused' as const, at: x.createdAt, conversationId: x.conversationId, messageId: x.messageId, detail: `${x.connectorName}: ${x.tool}` }))
      ]
        .filter(canRead) // a problem's text is the reply's: only who may read the conversation sees it
        .sort((x, y) => y.at - x.at)
        .slice(0, PROBLEMS)
      return {
        agentId: a.id,
        total: rate(mine),
        failed: failed.length,
        cut: cut.length,
        paused: paused.length,
        approvals: { asked: asked.length, refused: refused.length },
        avgTokens: avg(costs.map((c) => c.tokens)),
        avgMs: avg(costs.map((c) => c.ms)),
        problems,
        weeks: Array.from({ length: WEEKS }, (_, i) => {
          const w = history.filter((m) => m.at >= weekAt(i) && m.at < weekAt(i + 1))
          return { start: weekAt(i), rate: rate(w), avgTokens: avg(w.flatMap((m) => (m.run!.receipt ? [countedTokens(m.run!.receipt)] : []))) }
        })
      }
    })

  const skills: SkillReport[] = db
    .skills()
    .filter((k) => k.state === 'active')
    .map((k) => {
      const read = all.filter((m) => m.run!.steps.some((s) => s.label === 'Leu a skill' && s.detail === k.name))
      const changedAt = db.skillVersions(k.id)[0]?.at
      return {
        skillId: k.id,
        name: k.name,
        reads: rate(read),
        changedAt,
        ...(changedAt ? { before: rate(read.filter((m) => m.at < changedAt)), since: rate(read.filter((m) => m.at >= changedAt)) } : {})
      }
    })

  return { since: week, until, agents, skills, work: db.costByWork(week, until), tools: toolStats(replies.filter((m) => canRead(m) && !app.has(m.author.kind === 'agent' ? m.author.id : ''))) }
}
