// Following a Databricks run: what the core keeps, what the card shows and what the person configures.

export type JobState = 'queued' | 'running' | 'terminating' | 'waiting_retry' | 'succeeded' | 'failed' | 'timed_out' | 'canceled'

export const FINAL_STATES: readonly JobState[] = ['succeeded', 'failed', 'timed_out', 'canceled']
export const isFinal = (s: JobState): boolean => FINAL_STATES.includes(s)

export interface JobTask {
  key: string
  state: JobState
  startedAt?: number
  ms?: number // how long it took, once it ended
  attempt?: number
  runId?: string // the task's own run, for its output
  error?: string
}

// What Spark says about the application, when it can be reached. Bytes are the application's totals so far.
export interface SparkReading {
  stageId: string
  stageName?: string
  tasksDone: number
  tasksTotal: number
  tasksActive: number
  medianTaskMs?: number
  longestActiveTaskMs?: number
  shuffleBytes: number
  spillBytes: number
  memoryPercent?: number
  at: number // when this was read: the cluster may be gone by the time the run ends
}

export interface JobReading {
  name: string
  url?: string
  jobId?: string
  clusterId?: string
  state: JobState
  startedAt?: number
  endedAt?: number
  message?: string // what Databricks says about the state
  tasks: JobTask[]
  spark?: SparkReading
}

export type JobEventKind = 'run_failed' | 'task_failed' | 'run_succeeded' | 'possible_stall' | 'high_spill'
export type JobSignal = 'no_progress' | 'straggler' | 'slow_run'

export interface JobEvent {
  kind: JobEventKind
  key: string // once per key: "no_progress:stage-14"
  title: string
  at: number
  signal?: JobSignal
  late?: boolean // waited for the quiet hours, a pause, or for the app to open
}

export type JobReadErrorKind = 'no_cli' | 'auth' | 'refused' | 'transient' | 'bad_output'
export type JobEndReason = 'finished' | 'stopped' | 'max_time' | 'not_found' | 'agent_removed'

export interface JobWatch {
  id: string
  agentId: string
  conversationId: string
  messageId: string // the message showing the card; analyses go in its thread
  jobId?: string
  runId: string // text: these ids can be too long for a JavaScript number
  status: 'watching' | 'ended'
  endReason?: JobEndReason
  reading?: JobReading // the last good one
  readAt?: number
  readError?: string // why the last check failed
  readErrorKind?: JobReadErrorKind
  sparkError?: string // why Spark's numbers stopped coming; the rest goes on
  baselineMs?: number // the median of the job's last successful runs
  baselineRuns?: number
  progressKey?: string // what the stage's progress was the last time it changed
  progressAt?: number
  signal?: JobSignal // a possible stall showing right now
  spillHigh?: boolean
  firedAlerts: string[] // the keys already fired, so nothing fires twice
  heldEvents: JobEvent[] // waiting for the quiet hours or a pause to end
  wakes: number
  analyzing?: boolean // the agent is working on an event
  note?: string // why the analysis couldn't run
  gap?: { from: number; to: number } // the last time the app wasn't looking
  createdAt: number
  endedAt?: number
}

export interface JobWatchSettings {
  cliPath?: string // unset: found on its own, on the PATH and where it's usually installed
  profile?: string // unset: found on its own, from `databricks auth profiles`
  commands: string[] // "jobs list-runs --job-id --limit": a command and the flags it may take; the rest is refused
  apiPaths: string[] // where `api get` may go
  sparkApiBase?: string // "/driver-proxy-api/o/0/{cluster}/40001/api/v1"; unset: no Spark numbers
  actions: boolean // starting and canceling jobs, each with an approval
  intervalSeconds: number
  maxActive: number
  maxHours: number
  maxWakes: number // per run, the last one kept for the final event
  stallMinutes: number
  stragglerFactor: number
  slowFactor: number
  spillLimitGb: number
  spillAction: 'card' | 'wake'
}

// The analysis skill that comes with following jobs: which agents already got it, so one taken off it, or
// a skill the person deleted, stays that way.
export interface JobSkillState {
  seeded: boolean
  given: string[]
}

// What the app found by itself, for the Settings card.
export interface DatabricksProfile {
  name: string
  host?: string
  valid?: boolean
}
export interface DatabricksStatus {
  ok: boolean
  text: string
  cliPath?: string
  profile?: string // the one in use, saved or found
  profiles: DatabricksProfile[]
}

export const JOB_WATCH_DEFAULTS: JobWatchSettings = {
  commands: ['jobs get', 'jobs get-run', 'jobs get-run-output', 'jobs list-runs --job-id --active-only --completed-only --limit --expand-tasks --page-token', 'clusters get', 'current-user me', 'api get'],
  apiPaths: ['/api/2.1/jobs/runs/list', '/driver-proxy-api/'],
  actions: false,
  intervalSeconds: 30,
  maxActive: 5,
  maxHours: 24,
  maxWakes: 3,
  stallMinutes: 15,
  stragglerFactor: 5,
  slowFactor: 2,
  spillLimitGb: 10,
  spillAction: 'card'
}

const atLeast = (v: unknown, min: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.max(min, n)
}

// What's saved, with the defaults filled in and every number within its minimum.
export function jobWatchConfig(s?: Partial<JobWatchSettings>): JobWatchSettings {
  const d = JOB_WATCH_DEFAULTS
  return {
    ...(s?.cliPath?.trim() ? { cliPath: s.cliPath.trim() } : {}),
    ...(s?.profile?.trim() ? { profile: s.profile.trim() } : {}),
    ...(s?.sparkApiBase?.trim() ? { sparkApiBase: s.sparkApiBase.trim() } : {}),
    commands: Array.isArray(s?.commands) ? s.commands : d.commands,
    apiPaths: Array.isArray(s?.apiPaths) ? s.apiPaths : d.apiPaths,
    actions: s?.actions === true,
    intervalSeconds: atLeast(s?.intervalSeconds, 15, d.intervalSeconds),
    maxActive: Math.round(atLeast(s?.maxActive, 1, d.maxActive)),
    maxHours: atLeast(s?.maxHours, 1, d.maxHours),
    maxWakes: Math.round(atLeast(s?.maxWakes, 1, d.maxWakes)),
    stallMinutes: atLeast(s?.stallMinutes, 1, d.stallMinutes),
    stragglerFactor: atLeast(s?.stragglerFactor, 2, d.stragglerFactor),
    slowFactor: atLeast(s?.slowFactor, 1.5, d.slowFactor),
    spillLimitGb: atLeast(s?.spillLimitGb, 1, d.spillLimitGb),
    spillAction: s?.spillAction === 'wake' ? 'wake' : 'card'
  }
}

// The words of a command, before its flags: "jobs list-runs --limit" is ["jobs", "list-runs"].
export const commandWords = (line: string): string[] => {
  const words = line.trim().split(/\s+/).filter(Boolean)
  const flag = words.findIndex((w) => w.startsWith('-'))
  return flag < 0 ? words : words.slice(0, flag)
}

// A command that only reads, by its verb. Anything else asks before it goes on the list, and for an
// approval each time an agent runs it.
export const isReadCommand = (words: string[]): boolean => {
  const verb = words[words.length - 1] ?? ''
  return /^(get|list|me|events|describe|status)(-[\w-]+)?$/.test(verb)
}
