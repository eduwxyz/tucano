import { describe, expect, it } from 'vitest'
import { cleanRetentionDays, MAX_RETENTION_DAYS, retentionCutoff, retentionLabel, retentionOf } from '../src/shared/retention'

const DAY = 86_400_000

describe('a period of keeping history', () => {
  it('is whole days, never below zero, never past the cap', () => {
    expect(cleanRetentionDays(30)).toBe(30)
    expect(cleanRetentionDays(30.9)).toBe(30)
    expect(cleanRetentionDays(0)).toBe(0)
    expect(cleanRetentionDays(-7)).toBe(0)
    expect(cleanRetentionDays(9_999)).toBe(MAX_RETENTION_DAYS)
  })

  it('is not a period when nothing says one', () => {
    for (const nothing of [undefined, null, Number.NaN, '30', {}, []]) expect(cleanRetentionDays(nothing)).toBeUndefined()
  })

  it('cuts off exactly its days before now, and nothing ever goes at zero', () => {
    const now = 1_700_000_000_000
    expect(retentionCutoff(30, now)).toBe(now - 30 * DAY)
    expect(retentionCutoff(1, now)).toBe(now - DAY)
    expect(retentionCutoff(0, now)).toBeUndefined()
    expect(retentionCutoff(undefined, now)).toBeUndefined()
  })

  it('follows the Tucano unless the bot has its own, and zero is its own answer', () => {
    expect(retentionOf(undefined, 30)).toBe(30)
    expect(retentionOf({}, 30)).toBe(30)
    expect(retentionOf({ retentionDays: 7 }, 30)).toBe(7)
    // A bot that keeps everything whatever the Tucano's period says.
    expect(retentionOf({ retentionDays: 0 }, 30)).toBe(0)
    expect(retentionOf(undefined, 0)).toBe(0)
    expect(retentionOf(undefined, undefined)).toBe(0)
  })

  it('says itself in words, for the hint beside the field', () => {
    expect(retentionLabel(0)).toBe('tudo, para sempre')
    expect(retentionLabel(1)).toBe('1 dia')
    expect(retentionLabel(30)).toBe('30 dias')
  })
})
