import { describe, expect, it } from 'vitest'
import { monthlyCeiling, replyBudget } from '../src/core/runs'

describe('an agent with no monthly limit', () => {
  it('has no ceiling, so nothing is ever over it', () => {
    expect(monthlyCeiling(0)).toBe(Infinity)
    expect(0 >= monthlyCeiling(0)).toBe(false)
    expect(50_000_000 >= monthlyCeiling(0)).toBe(false)
  })

  it('keeps the ceiling it was given', () => {
    expect(monthlyCeiling(2_000_000)).toBe(2_000_000)
    expect(2_000_000 >= monthlyCeiling(2_000_000)).toBe(true)
  })

  it('treats a negative limit as no limit instead of as spent', () => {
    expect(monthlyCeiling(-1)).toBe(Infinity)
  })

  it('still caps a single reply', () => {
    // 10% of a month, and 10% of the fallback base when there is no month.
    expect(replyBudget(1_000_000, 10)).toBe(100_000)
    expect(replyBudget(0, 10)).toBe(100_000)
    expect(replyBudget(0, 10)).toBeLessThan(Infinity)
  })

  it('follows the configured share', () => {
    expect(replyBudget(0, 5)).toBe(50_000)
    expect(replyBudget(4_000_000, 5)).toBe(200_000)
  })
})
