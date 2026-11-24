// How long what was said is kept, and when it goes. Two periods: the Tucano's, for every conversation,
// and one bot's own, which wins for what that bot said and for its own DMs.
//
// 0 is "keep everything, for good": nothing is ever deleted on a clock, and the two wipe buttons are the
// only way history goes. A period is whole days, and the sweep that honours it runs once a day.
import { L } from './lang'

export const MAX_RETENTION_DAYS = 3650
const DAY = 86_400_000

// A period as it's stored: whole days, none below zero, none past the cap. Left out (or not a number at
// all) is not a period: on the Tucano that reads as keeping everything, on a bot as following it.
export function cleanRetentionDays(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  const days = typeof v === 'number' ? v : Number.NaN
  if (!Number.isFinite(days)) return undefined
  return Math.max(0, Math.min(MAX_RETENTION_DAYS, Math.floor(days)))
}

// The moment a message stops being kept: everything said before it goes. undefined: nothing ever goes.
export function retentionCutoff(days: number | undefined, now = Date.now()): number | undefined {
  const kept = cleanRetentionDays(days) ?? 0
  return kept ? now - kept * DAY : undefined
}

// Which period a bot follows for everything it said and everything in its DMs: its own when it set one
// (0 keeps everything, whatever the Tucano's period says), the Tucano's when it has none.
export function retentionOf(bot: { retentionDays?: number } | undefined, tucanoDays: number | undefined): number {
  const own = cleanRetentionDays(bot?.retentionDays)
  return own === undefined ? (cleanRetentionDays(tucanoDays) ?? 0) : own
}

// A period in words, for the hint beside the field: "guardado para sempre", "30 dias".
export function retentionLabel(days: number | undefined): string {
  const kept = cleanRetentionDays(days) ?? 0
  if (!kept) return L('tudo, para sempre', 'everything, for good')
  return kept === 1 ? L('1 dia', '1 day') : L(`${kept} dias`, `${kept} days`)
}
