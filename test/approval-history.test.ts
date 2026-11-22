// Aprovações' history, as a person reads it: by day, newest first, the same action repeated in a day
// folded into one row with its times, and a line per day with what it came to.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Approval } from '../src/shared/types'
import { setLang } from '../src/shared/lang'
import { dayLabel, daySummary, exceptionCount, groupHistory, historyStatus } from '../src/renderer/src/approval-history'

const at = (daysAgo: number, h: number, m: number): number => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}
let n = 0
const ap = (p: Partial<Approval> & { decidedAt: number }): Approval => ({
  id: `a${++n}`,
  hash: 'h',
  agentId: 'ravi',
  conversationId: 'c',
  messageId: 'm',
  connectorId: 'computador',
  connectorName: 'Computador',
  tool: 'bash',
  args: {},
  why: '',
  highRisk: false,
  state: 'approved',
  outcome: 'Executou.',
  createdAt: p.decidedAt - 60_000,
  expiresAt: p.decidedAt + 3_600_000,
  ...p
})
// What the page says an approval was for; here, the tool's name is enough.
const what = (a: Approval): string => a.tool

beforeEach(() => setLang('pt'))

describe('the history, grouped', () => {
  it('folds the same action of the same agent on the same connector, with the same result, in a day', () => {
    const list = [
      ap({ decidedAt: at(0, 12, 41) }),
      ap({ decidedAt: at(0, 12, 30) }),
      ap({ decidedAt: at(0, 12, 38) }),
      ap({ decidedAt: at(0, 11, 2), agentId: 'bento', connectorId: 'gh', connectorName: 'GitHub', tool: 'create_pull_request' })
    ]
    const [today, ...rest] = groupHistory(list, what)
    expect(rest).toEqual([])
    expect(today!.rows.map((r) => [r.what, r.items.length])).toEqual([
      ['bash', 3],
      ['create_pull_request', 1]
    ])
    // The times read in order, oldest first.
    expect(today!.rows[0]!.items.map((a) => new Date(a.decidedAt!).getMinutes())).toEqual([30, 38, 41])
    expect(today!.counts).toEqual({ approved: 4, refused: 0, expired: 0, failed: 0 })
  })

  it('keeps apart another agent, another connector, other words, another result and another day', () => {
    const list = [
      ap({ decidedAt: at(1, 9, 0) }),
      ap({ decidedAt: at(1, 9, 1), agentId: 'ivo' }),
      ap({ decidedAt: at(1, 9, 2), connectorId: 'other' }),
      ap({ decidedAt: at(1, 9, 3), tool: 'rm' }),
      ap({ decidedAt: at(1, 9, 4), state: 'refused', outcome: 'Nada foi rodado.' }),
      ap({ decidedAt: at(2, 9, 0) })
    ]
    const days = groupHistory(list, what)
    expect(days).toHaveLength(2)
    expect(days[0]!.rows).toHaveLength(5)
    expect(days[1]!.rows).toHaveLength(1)
  })

  it('puts the newest day first and, in a day, the row that happened last first', () => {
    const list = [ap({ decidedAt: at(3, 10, 0), tool: 'old' }), ap({ decidedAt: at(0, 9, 0), tool: 'early' }), ap({ decidedAt: at(0, 18, 0), tool: 'late' })]
    const days = groupHistory(list, what)
    expect(days.map((d) => d.rows.map((r) => r.what))).toEqual([['late', 'early'], ['old']])
  })

  it('leaves out what still waits', () => {
    expect(groupHistory([ap({ decidedAt: at(0, 9, 0), state: 'pending' })], what)).toEqual([])
  })

  it('"only exceptions": refused, expired and approved-but-failed, counted alike', () => {
    const list = [
      ap({ decidedAt: at(0, 9, 0) }),
      ap({ decidedAt: at(0, 9, 1), state: 'refused', outcome: 'Nada foi rodado.' }),
      ap({ decidedAt: at(0, 9, 2), state: 'expired', outcome: 'Expirou sem decisão.' }),
      ap({ decidedAt: at(0, 9, 3), outcome: 'Não executou: o computador desse agente está desligado.' }),
      ap({ decidedAt: at(0, 9, 4), outcome: "Ran, with an error." })
    ]
    expect(exceptionCount(list)).toBe(4)
    const [day] = groupHistory(list, what, true)
    expect(day!.rows.map((r) => r.status).sort()).toEqual(['expired', 'failed', 'refused'])
    expect(day!.rows.find((r) => r.status === 'failed')!.items).toHaveLength(2)
  })
})

describe('the words', () => {
  it('reads a status from the state and, when approved, from what came of it', () => {
    expect(historyStatus({ state: 'approved', outcome: 'Executou.' })).toBe('approved')
    expect(historyStatus({ state: 'approved' })).toBe('approved')
    expect(historyStatus({ state: 'approved', outcome: 'Falhou: timeout' })).toBe('failed')
    expect(historyStatus({ state: 'refused' })).toBe('refused')
    expect(historyStatus({ state: 'expired' })).toBe('expired')
  })

  it('sums a day up, the approved first', () => {
    expect(daySummary({ approved: 6, refused: 0, expired: 0, failed: 0 })).toBe('6 aprovadas')
    expect(daySummary({ approved: 5, refused: 1, expired: 0, failed: 0 })).toBe('5 aprovadas, 1 recusada')
    expect(daySummary({ approved: 1, refused: 0, expired: 2, failed: 1 })).toBe('1 aprovada, 1 falhou, 2 expiradas')
    setLang('en')
    expect(daySummary({ approved: 5, refused: 1, expired: 0, failed: 0 })).toBe('5 approved, 1 refused')
  })

  it('names today and yesterday, and a date before that', () => {
    const today = new Date().setHours(0, 0, 0, 0)
    expect(dayLabel(today)).toBe('Hoje')
    expect(dayLabel(new Date(at(1, 0, 0)).setHours(0, 0, 0, 0))).toBe('Ontem')
    expect(dayLabel(new Date(at(5, 0, 0)).setHours(0, 0, 0, 0))).toMatch(/^[A-ZÀ-Ú]/)
    setLang('en')
    expect(dayLabel(today)).toBe('Today')
  })
})
