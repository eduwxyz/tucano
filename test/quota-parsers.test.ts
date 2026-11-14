// The providers' own answers, read as the rows of the panel. The fixtures are shapes taken from live
// accounts; the edges are the ones that used to lie: a zero that is a real exhausted reading, a
// percentage that arrives as used, a window that isn't a percentage at all.
import { describe, expect, it } from 'vitest'
import { parseQuota, slot, ms } from '../src/core/quota-parsers'

const at = (iso: string): number => Date.parse(iso)

describe('Codex, the ChatGPT plan', () => {
  it('reads the 5-hour and the weekly window into the right rows', () => {
    const read = parseQuota(
      'openai-codex',
      JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          primary_window: { limit_window_seconds: 18000, used_percent: 42, reset_at: '2026-11-10T18:00:00Z' },
          secondary_window: { limit_window_seconds: 604800, used_percent: 12.5, reset_at: '2026-11-16T00:00:00Z' }
        }
      })
    )
    expect(read.plan).toBe('plus')
    expect(read.session?.used).toBeCloseTo(0.42)
    expect(read.session?.remaining).toBeCloseTo(0.58)
    expect(read.session?.unit).toBe('%')
    expect(read.session?.resetsAt).toBe(at('2026-11-10T18:00:00Z'))
    expect(read.week?.used).toBeCloseTo(0.125)
  })

  it('turns a spent window into 0 left, which is a reading and not a missing one', () => {
    const read = parseQuota('openai-codex', JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 100 } } }))
    expect(read.session?.remaining).toBe(0)
  })

  it('takes a remaining percentage when that is what the account reports', () => {
    const read = parseQuota('openai-codex', JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 18000, percent_left: 70 } } }))
    expect(read.session?.used).toBeCloseTo(0.3)
  })

  it('reports nothing rather than a wrong row when a window has no usage', () => {
    expect(parseQuota('openai-codex', JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } }))).toEqual({})
  })
})

describe('Claude Code on the subscription', () => {
  it('keeps five_hour and seven_day apart', () => {
    const read = parseQuota('anthropic-claude-code', JSON.stringify({ five_hour: { utilization: 34, resets_at: '2026-11-10T17:30:00Z' }, seven_day: { utilization: 21, resets_at: '2026-11-15T00:00:00Z' } }))
    expect(read.session?.used).toBeCloseTo(0.34)
    expect(read.week?.used).toBeCloseTo(0.21)
    expect(read.session?.resetsAt).toBe(at('2026-11-10T17:30:00Z'))
  })
})

describe('OpenCode Go', () => {
  const body = JSON.stringify({
    usage: {
      rolling: { percent: 20, status: 'ok', resetsAt: '2026-11-10T18:00:00Z' },
      weekly: { percent: 55, status: 'ok', resetsAt: '2026-11-16T00:00:00Z' },
      monthly: { percent: 10, status: 'ok', resetsAt: '2026-12-01T00:00:00Z' }
    }
  })
  it('fills all three rows, and its month is its own window', () => {
    const read = parseQuota('opencode-go', body)
    expect(read.session?.used).toBeCloseTo(0.2)
    expect(read.week?.used).toBeCloseTo(0.55)
    expect(read.month?.used).toBeCloseTo(0.1)
  })

  it('drops a window the provider marks as something other than ok or rate-limited', () => {
    const read = parseQuota('opencode-go', JSON.stringify({ usage: { rolling: { status: 'disabled' }, weekly: { percent: 5, status: 'ok' } } }))
    expect(read.session).toBeUndefined()
    expect(read.week?.used).toBeCloseTo(0.05)
  })
})

describe('Z.ai', () => {
  it('reads the token limit as a 5-hour window and the monthly credit as the month', () => {
    const read = parseQuota(
      'zai',
      JSON.stringify({
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: '2026-11-10T18:00:00Z', unit: 3 },
            { type: 'CREDIT_LIMIT', percentage: 1, nextResetTime: '2026-12-01T00:00:00Z' },
            { type: 'TIME_LIMIT', percentage: 0 }
          ]
        }
      })
    )
    expect(read.session?.used).toBeCloseTo(0.3)
    // Exactly 1 means 1% used on the live route, which is 99% left, not "nothing left".
    expect(read.month?.used).toBeCloseTo(0.01)
    expect(read.month?.remaining).toBeCloseTo(0.99)
  })
})

describe('SuperGrok', () => {
  it('puts the shared weekly pool in the week row', () => {
    const read = parseQuota(
      'xai-oauth',
      JSON.stringify({
        config: { creditUsagePercent: 62, isUnifiedBillingUser: true, currentPeriod: { type: 'WEEKLY', start: '2026-11-08T00:00:00Z', end: '2026-11-15T00:00:00Z' } }
      })
    )
    expect(read.week?.used).toBeCloseTo(0.62)
    expect(read.week?.resetsAt).toBe(at('2026-11-15T00:00:00Z'))
  })

  it('reads a month-long period into the month row', () => {
    const read = parseQuota('xai-oauth', JSON.stringify({ config: { creditUsagePercent: 5, currentPeriod: { type: 'MONTHLY', start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' } } }))
    expect(read.month?.used).toBeCloseTo(0.05)
    expect(read.week).toBeUndefined()
  })

  it('takes the omitted percentage as 0% used only for a unified account with a live period', () => {
    const period = { type: 'WEEKLY', start: '2026-11-08T00:00:00Z', end: '2026-11-15T00:00:00Z' }
    expect(parseQuota('xai-oauth', JSON.stringify({ config: { isUnifiedBillingUser: true, currentPeriod: period } })).week?.used).toBe(0)
    expect(parseQuota('xai-oauth', JSON.stringify({ config: { currentPeriod: period } }))).toEqual({})
  })
})

describe('GitHub Copilot', () => {
  it('keeps the premium interactions, which are the ones that run out', () => {
    const read = parseQuota('github-copilot', JSON.stringify({ copilot_plan: 'individual', quota_reset_date: '2026-12-01T00:00:00Z', quota_snapshots: { premium_interactions: { percent_remaining: 75 }, chat: { unlimited: true } } }))
    expect(read.month?.remaining).toBeCloseTo(0.75)
    expect(read.plan).toBe('individual')
  })
})

describe('the wallets', () => {
  it('shows what is left of the OpenRouter credits against what was granted', () => {
    const read = parseQuota('openrouter', JSON.stringify({ data: { total_credits: 20, total_usage: 5 } }))
    expect(read.month?.remaining).toBe(15)
    expect(read.month?.limit).toBe(20)
    expect(read.month?.unit).toBe('usd')
  })

  it('shows a DeepSeek balance with no denominator invented for it', () => {
    const read = parseQuota('deepseek', JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '3.42' }] }))
    expect(read.month?.remaining).toBeCloseTo(3.42)
    expect(read.month?.limit).toBeUndefined()
  })
})

describe('what it refuses to make up', () => {
  it('answers nothing for a provider it has no contract for', () => {
    expect(parseQuota('gemini', JSON.stringify({ anything: 1 }))).toEqual({})
  })
  it('answers nothing for a body that is not JSON', () => {
    expect(parseQuota('openai-codex', '<html>login</html>')).toEqual({})
  })
  it('leaves a window out rather than reading a missing number as zero', () => {
    expect(parseQuota('openrouter', JSON.stringify({ data: { total_usage: 5 } }))).toEqual({})
  })
  it('places a window by how long it lasts', () => {
    expect(slot(3600)).toBe('session')
    expect(slot(18000)).toBe('session')
    expect(slot(604800)).toBe('week')
    expect(slot(30 * 86400)).toBe('month')
  })
  it('reads a timestamp in seconds, milliseconds or ISO', () => {
    expect(ms(1762788000)).toBe(1762788000 * 1000)
    expect(ms(1762788000000)).toBe(1762788000000)
    expect(ms('2026-11-10T18:00:00Z')).toBe(at('2026-11-10T18:00:00Z'))
    expect(ms('soon')).toBeUndefined()
  })
})
