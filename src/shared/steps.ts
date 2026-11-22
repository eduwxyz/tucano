// How a reply's steps read when a run goes on for a while: every step, or only the newest few in a
// window that keeps them in place while the rest go on below (Settings › Conversations). Unset
// anywhere: every step, which is what the app has always done and what nobody's view changes to
// without asking.
import type { Settings, Step, StepsMode } from './types'

export type { StepsMode }

export const STEPS_MODES: readonly StepsMode[] = ['all', 'latest']

// How many steps `latest` keeps: the number the person can change, and its bounds.
export const STEPS_LATEST = 20
export const STEPS_LATEST_MIN = 5
export const STEPS_LATEST_MAX = 100

export const isStepsMode = (v: unknown): v is StepsMode => typeof v === 'string' && (STEPS_MODES as readonly string[]).includes(v)

// The mode a reply reads in: the person's own, else every step.
export function stepsModeFor(settings: Pick<Settings, 'steps'> | undefined): StepsMode {
  return (isStepsMode(settings?.steps) && settings.steps) || 'all'
}

// The number `latest` keeps, clamped: a saved 0 or a hand-edited 10 000 still reads.
export function stepsKeep(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return STEPS_LATEST
  return Math.min(STEPS_LATEST_MAX, Math.max(STEPS_LATEST_MIN, Math.round(n)))
}

// What a reply shows, and what stays behind: the steps in the window, and how many were left out.
export function stepsWindow(steps: readonly Step[], mode: StepsMode, keep?: number): { shown: readonly Step[]; hidden: number } {
  if (mode !== 'latest') return { shown: steps, hidden: 0 }
  const n = stepsKeep(keep)
  if (steps.length <= n) return { shown: steps, hidden: 0 }
  return { shown: steps.slice(-n), hidden: steps.length - n }
}
