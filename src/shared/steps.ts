// How a reply's steps read while it works: every step, only the latest few with the older
// ones fading out, or one line showing the current activity. Unset anywhere: every step, which is
// what the app has always done and what nobody's view changes to without asking.
import type { Agent, Settings, Step, StepsMode } from './types'

export type { StepsMode }

export const STEPS_MODES: readonly StepsMode[] = ['all', 'latest', 'one-line']

// How many steps `latest` keeps: the number the person can change, and its bounds.
export const STEPS_LATEST = 20
export const STEPS_LATEST_MIN = 5
export const STEPS_LATEST_MAX = 100
// How many of the steps shown at the top fade out: the older ones on their way out of the window.
export const STEPS_FADE = 5

export const isStepsMode = (v: unknown): v is StepsMode => typeof v === 'string' && (STEPS_MODES as readonly string[]).includes(v)

// The mode a reply reads in: the agent's own, else the workspace's, else every step.
export function stepsModeFor(settings: Pick<Settings, 'steps'> | undefined, agent?: Pick<Agent, 'steps'> | null): StepsMode {
  return (isStepsMode(agent?.steps) && agent.steps) || (isStepsMode(settings?.steps) && settings.steps) || 'all'
}

// The number `latest` keeps, clamped: a saved 0 or a hand-edited 10 000 still reads.
export function stepsKeep(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return STEPS_LATEST
  return Math.min(STEPS_LATEST_MAX, Math.max(STEPS_LATEST_MIN, Math.round(n)))
}

// What a reply shows, and what stays behind: the steps in the window, how many were left out,
// and how many steps from the top of the window are fading (none when they all fit).
export function stepsWindow(steps: readonly Step[], mode: StepsMode, keep: number | undefined): { shown: readonly Step[]; hidden: number; fade: number } {
  if (mode !== 'latest') return { shown: steps, hidden: 0, fade: 0 }
  const n = stepsKeep(keep)
  if (steps.length <= n) return { shown: steps, hidden: 0, fade: 0 }
  return { shown: steps.slice(-n), hidden: steps.length - n, fade: Math.min(STEPS_FADE, n) }
}
