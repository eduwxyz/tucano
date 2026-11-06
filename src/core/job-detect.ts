// What changed between two readings of a run. Pure functions: no network, no database, no clock of its own.
import { L } from '../shared/lang'
import { isFinal, type JobEvent, type JobReading, type JobSignal, type JobWatchSettings } from '../shared/job-watch'

const MIN = 60_000
const GB = 1024 ** 3
const STRAGGLER_MIN_MS = 10 * MIN
const STRAGGLER_MIN_DONE = 0.75
export const MIN_BASELINE_RUNS = 3

export interface DetectInput {
  reading: JobReading
  fired: string[]
  progressKey?: string
  progressAt?: number
  baselineMs?: number
  baselineRuns?: number
  config: Pick<JobWatchSettings, 'stallMinutes' | 'stragglerFactor' | 'slowFactor' | 'spillLimitGb' | 'spillAction'>
  now: number
}

export interface DetectOutput {
  events: JobEvent[] // new ones, already told apart from what fired before
  fired: string[]
  progressKey?: string
  progressAt?: number
  signal?: JobSignal // a possible stall showing right now
  spillHigh: boolean
}

const minutes = (ms: number): number => Math.round(ms / MIN)

// The signals true right now, each with what it says and the key it fires under.
function stallSignals(i: DetectInput, progressAt: number | undefined): { signal: JobSignal; key: string; title: string }[] {
  const { reading: r, config: c, now } = i
  if (r.state !== 'running') return []
  const out: { signal: JobSignal; key: string; title: string }[] = []
  const s = r.spark
  if (s && s.tasksActive > 0 && progressAt !== undefined && now - progressAt >= c.stallMinutes * MIN) {
    out.push({
      signal: 'no_progress',
      key: `no_progress:stage-${s.stageId}`,
      title: L(`A etapa ${s.stageId} está sem avanço há ${minutes(now - progressAt)} min (${s.tasksDone} de ${s.tasksTotal} tasks)`, `Stage ${s.stageId} has made no progress for ${minutes(now - progressAt)} min (${s.tasksDone} of ${s.tasksTotal} tasks)`)
    })
  }
  if (s?.medianTaskMs && s.longestActiveTaskMs && s.tasksTotal > 0) {
    const late = s.longestActiveTaskMs >= c.stragglerFactor * s.medianTaskMs && s.longestActiveTaskMs >= STRAGGLER_MIN_MS && s.tasksDone / s.tasksTotal >= STRAGGLER_MIN_DONE
    if (late) {
      out.push({
        signal: 'straggler',
        key: `straggler:stage-${s.stageId}`,
        title: L(`Uma task da etapa ${s.stageId} roda há ${minutes(s.longestActiveTaskMs)} min, contra uma mediana de ${Math.max(1, minutes(s.medianTaskMs))} min`, `A task in stage ${s.stageId} has been running for ${minutes(s.longestActiveTaskMs)} min, against a median of ${Math.max(1, minutes(s.medianTaskMs))} min`)
      })
    }
  }
  if (r.startedAt && i.baselineMs && (i.baselineRuns ?? 0) >= MIN_BASELINE_RUNS && now - r.startedAt >= c.slowFactor * i.baselineMs) {
    out.push({
      signal: 'slow_run',
      key: 'slow_run',
      title: L(`O run está em ${minutes(now - r.startedAt)} min, e a mediana dos últimos é ${Math.max(1, minutes(i.baselineMs))} min`, `The run is at ${minutes(now - r.startedAt)} min, and the median of the last ones is ${Math.max(1, minutes(i.baselineMs))} min`)
    })
  }
  return out
}

export function detect(i: DetectInput): DetectOutput {
  const { reading: r, config: c, now } = i
  const fired = new Set(i.fired)
  const events: JobEvent[] = []
  const fire = (e: Omit<JobEvent, 'at'>): void => {
    if (fired.has(e.key)) return
    fired.add(e.key)
    events.push({ ...e, at: now })
  }

  // Progress: the stage moved, or another stage started.
  const key = r.spark ? `${r.spark.stageId}:${r.spark.tasksDone}` : undefined
  const moved = key !== undefined && key !== i.progressKey
  const progressKey = key ?? i.progressKey
  const progressAt = moved ? now : i.progressAt

  const signals = stallSignals(i, progressAt)
  const spillHigh = !!r.spark && r.spark.spillBytes >= c.spillLimitGb * GB

  if (isFinal(r.state)) {
    // The last word: what led to it goes with it, and a canceled run is the person's own doing.
    if (r.state === 'failed' || r.state === 'timed_out') {
      const task = r.tasks.find((t) => t.state === 'failed' || t.state === 'timed_out')
      fire({ kind: 'run_failed', key: 'run_failed', title: task ? L(`O run falhou na task ${task.key}`, `The run failed at task ${task.key}`) : L('O run falhou', 'The run failed') })
    } else if (r.state === 'succeeded') {
      fire({ kind: 'run_succeeded', key: 'run_succeeded', title: L('O run terminou', 'The run finished') })
    }
    return { events, fired: [...fired], progressKey, progressAt, spillHigh }
  }

  for (const t of r.tasks) if (t.state === 'failed' || t.state === 'timed_out') fire({ kind: 'task_failed', key: `task_failed:${t.key}`, title: L(`A task ${t.key} falhou`, `Task ${t.key} failed`) })
  for (const s of signals) fire({ kind: 'possible_stall', key: s.key, title: s.title, signal: s.signal })
  if (spillHigh && c.spillAction === 'wake') {
    fire({
      kind: 'high_spill',
      key: `high_spill:stage-${r.spark!.stageId}`,
      title: L(`O spill passou de ${c.spillLimitGb} GB na etapa ${r.spark!.stageId}`, `Spill went over ${c.spillLimitGb} GB at stage ${r.spark!.stageId}`)
    })
  }

  return { events, fired: [...fired], progressKey, progressAt, spillHigh, ...(signals[0] ? { signal: signals[0].signal } : {}) }
}

// What's left to wake the agent for: the last wake is always kept for the final event.
export function allowedEvents(events: JobEvent[], wakes: number, maxWakes: number): JobEvent[] {
  const alerts = Math.max(0, maxWakes - 1 - wakes)
  let used = 0
  return events.filter((e) => {
    if (e.kind === 'run_failed' || e.kind === 'run_succeeded') return true
    return used++ < alerts
  })
}

// Events waiting their turn: a final one stands for the alerts that came before it. `late`: they're waiting
// on the quiet hours or a pause, and say so when they get there.
export function holdEvents(held: JobEvent[], events: JobEvent[], late: boolean): JobEvent[] {
  const all = [...held, ...events].map((e) => (late ? { ...e, late: true } : e))
  const final = all.find((e) => e.kind === 'run_failed' || e.kind === 'run_succeeded')
  return final ? [final] : all
}
