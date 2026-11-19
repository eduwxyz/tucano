// What a cut reply has to go on with, and when it has nothing. The core acts on this and the window
// draws the button from it: one reading, so the button the person sees is the one the core will take.
import type { Run, RunStatus } from './types'

// A step that only says the model is working is not work the reply got done: it is the same step
// every reply has before anything came back.
export const WORKLESS_LABELS = ['Pensou', 'Pensando', 'Pausou', 'Thought', 'Thinking', 'Paused']

// A reply the app cut, rather than one that ran to its own end.
export const CUT: RunStatus[] = ['stopped', 'interrupted', 'failed']

// At least one step came back: something was read, written, edited or run, or a call failed.
export const workedOn = (run: Run): boolean =>
  (run.steps ?? []).some((s) => s.status !== 'running' && !WORKLESS_LABELS.includes(s.label))

// A reply paused at its budget always goes on; a cut one only when there is something to go on with.
// A session that ended without a word: the app cut it while it worked (so the row reads `done` once a
// continuation was asked for, `cutAt` behind it) or the turn ended with nothing said. A bubble with a
// chain and no answer is a dead end unless the person can nudge it, and its own text is the only thing
// that says whether it answered — which is why it comes in here instead of being read from the status.
export const finishedSilently = (run: Run, text: string): boolean => run.status === 'done' && !text.trim()

// What the person's Continue accepts: any reply the app cut, even one with nothing but thoughts behind
// it (the app closing mid-sentence, a stop from the rail), and a session left showing no answer at all
// because it was cut and the continuation asked for from it never wrote one. `canContinue` stays the
// bar for going on by itself, so nothing restarts in a loop.
export const canResume = (run: Run, text = ''): boolean =>
  run.status === 'paused' || CUT.includes(run.status) || finishedSilently(run, text)

export const canContinue = (run: Run): boolean =>
  run.status === 'paused' || (CUT.includes(run.status) && workedOn(run))
