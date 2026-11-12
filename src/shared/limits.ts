// An agent's month has a limit, or it hasn't: 0 (and anything that isn't a
// positive number) means no ceiling at all, never "already spent". One rule,
// shared by the runner and by every place that draws it, so the screen can't
// claim a cap the runner doesn't apply — nor the other way round.

/** The month's ceiling: Infinity when there is none, so every comparison against it is false. */
export const monthlyCeiling = (limit: number): number => (limit > 0 ? limit : Infinity)

/** Whether the agent has a monthly ceiling at all. */
export const hasMonthlyLimit = (limit: number): boolean => limit > 0

/** Whether the month's allowance is spent. Never true without a ceiling. */
export const overMonthlyLimit = (used: number, limit: number): boolean => used >= monthlyCeiling(limit)

/** How much of the month is gone, 0..1 — undefined when there is no month to measure. */
export const usedShare = (used: number, limit: number): number | undefined => (hasMonthlyLimit(limit) ? used / limit : undefined)
