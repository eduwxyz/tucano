// The Databricks CLI, on the login the person already has. Every call goes through the command rules and
// runs without a shell. What comes back is turned into one reading, whichever format the API answered in.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { L } from '../shared/lang'
import type { DatabricksProfile, DatabricksStatus, JobReading, JobReadErrorKind, JobState, JobTask, JobWatchSettings, SparkReading } from '../shared/job-watch'
import { checkCli } from './cli-policy'
import { maskSecrets } from './step-text'

const TIMEOUT_MS = 30_000
const MAX_BUFFER = 16 * 1024 * 1024
const MAX_MESSAGE = 400
const MAX_OUTPUT = 8_000
const BASELINE_RUNS = 10
const FOUND_FOR_MS = 10 * 60_000 // what was found stands this long; a failed login looks again sooner
const SPARK_RETRY_MS = 5 * 60_000 // a cluster that didn't answer isn't asked again before this
const SPARK_PORTS = ['40001', '4040'] // Databricks' usual Spark UI port, then Spark's own default

export type CliErrorKind = JobReadErrorKind | 'gone'

// Where the CLI is: on the PATH, or where it's usually installed. An app opened from the desktop doesn't always
// see the terminal's PATH. Only a real program counts: a .cmd can't run without a shell.
export function findCli(o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; exists?: (p: string) => boolean; list?: (dir: string) => string[] } = {}): string | undefined {
  const env = o.env ?? process.env
  const platform = o.platform ?? process.platform
  const home = o.home ?? homedir()
  const exists = o.exists ?? existsSync
  const list =
    o.list ??
    ((dir: string): string[] => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    })
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  const pathVar = env['PATH'] ?? env['Path'] ?? ''
  const dirs = pathVar.split(windows ? ';' : ':').filter(Boolean)
  if (windows) {
    const local = env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local')
    const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages')
    dirs.push(
      path.join(local, 'Microsoft', 'WinGet', 'Links'),
      ...list(packages).filter((d) => /^databricks/i.test(d)).map((d) => path.join(packages, d)),
      path.join(home, 'scoop', 'shims'),
      path.join(local, 'Programs', 'databricks'),
      path.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Databricks'),
      path.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Databricks', 'CLI')
    )
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.databricks', 'bin'))
  }
  const name = windows ? 'databricks.exe' : 'databricks'
  return dirs.map((d) => path.join(d.replace(/^"|"$/g, ''), name)).find((p) => exists(p))
}

// The profiles `databricks auth profiles` lists. Only names, addresses and whether the login works.
export function parseProfiles(out: string): DatabricksProfile[] {
  try {
    return list(obj(JSON.parse(out))['profiles']).flatMap((p) => {
      const name = text(p['name'])
      if (!name) return []
      const host = text(p['host'])
      return [{ name, ...(host ? { host } : {}), ...(typeof p['valid'] === 'boolean' ? { valid: p['valid'] } : {}) }]
    })
  } catch {
    return []
  }
}

// Which one to use, with nobody choosing: the one the environment names, or DEFAULT, or the first whose login
// works. Undefined leaves it to the CLI, as when the environment holds the login itself.
export function chooseProfile(profiles: DatabricksProfile[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env['DATABRICKS_CONFIG_PROFILE']) return env['DATABRICKS_CONFIG_PROFILE']
  if (env['DATABRICKS_HOST']) return undefined
  const working = profiles.filter((p) => p.valid !== false)
  return (working.find((p) => p.name === 'DEFAULT') ?? working[0] ?? profiles.find((p) => p.name === 'DEFAULT') ?? profiles[0])?.name
}

export class CliError extends Error {
  constructor(
    public kind: CliErrorKind,
    message: string
  ) {
    super(message)
  }
}

export interface CliResult {
  stdout: string
  stderr: string
  code: number | null
  failure?: 'missing' | 'timeout' | 'other'
}
export type CliExec = (file: string, args: string[], opts: { timeoutMs: number; maxBuffer: number }) => Promise<CliResult>

export const realExec: CliExec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer, windowsHide: true, shell: false }, (e, stdout, stderr) => {
      const err = e as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (err?.message ?? ''),
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        ...(err?.code === 'ENOENT' ? { failure: 'missing' as const } : err?.killed ? { failure: 'timeout' as const } : err && typeof err.code !== 'number' ? { failure: 'other' as const } : {})
      })
    })
  })

// Ids this long don't fit a JavaScript number: they become text before parsing.
export function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/"(\w*_id)"(\s*:\s*)(\d{15,})/g, '"$1"$2"$3"'))
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : [])
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const time = (v: unknown): number | undefined => {
  const n = num(v)
  return n && n > 0 ? n : undefined
}

const END_STATE: Record<string, JobState> = {
  SUCCESS: 'succeeded',
  SUCCESS_WITH_FAILURES: 'failed',
  FAILED: 'failed',
  INTERNAL_ERROR: 'failed',
  DRIVER_ERROR: 'failed',
  CLUSTER_ERROR: 'failed',
  RUN_EXECUTION_ERROR: 'failed',
  TIMEDOUT: 'timed_out',
  TIMED_OUT: 'timed_out',
  CANCELED: 'canceled',
  USER_CANCELED: 'canceled',
  MAXIMUM_CONCURRENT_RUNS_REACHED: 'canceled',
  // These tasks didn't run because of another's failure: the cause is what counts.
  UPSTREAM_FAILED: 'canceled',
  UPSTREAM_CANCELED: 'canceled',
  EXCLUDED: 'canceled',
  SKIPPED: 'canceled',
  DISABLED: 'canceled'
}

// Both of the API's formats: state.life_cycle_state and status.state. Undefined when it has neither.
export function stateOf(o: Record<string, unknown>): JobState | undefined {
  const state = obj(o['state'])
  const status = obj(o['status'])
  const life = text(state['life_cycle_state'])
  const current = text(status['state'])
  if (!life && !current) return undefined
  const result = text(state['result_state']) ?? text(obj(status['termination_details'])['code'])
  if (current === 'TERMINATED' || life === 'TERMINATED' || life === 'SKIPPED' || life === 'INTERNAL_ERROR') {
    if (life === 'SKIPPED') return 'canceled'
    if (life === 'INTERNAL_ERROR') return 'failed'
    return (result && END_STATE[result]) || (result ? 'failed' : 'canceled')
  }
  const now = current ?? life
  if (now === 'RUNNING') return 'running'
  if (now === 'TERMINATING') return 'terminating'
  if (now === 'WAITING_FOR_RETRY') return 'waiting_retry'
  return 'queued' // PENDING, QUEUED, BLOCKED, WAITING
}

const messageOf = (o: Record<string, unknown>): string | undefined => {
  const m = text(obj(o['state'])['state_message']) ?? text(obj(obj(o['status'])['termination_details'])['message'])
  return m ? clip(maskSecrets(m), MAX_MESSAGE) : undefined
}

const clusterOf = (o: Record<string, unknown>): string | undefined => text(obj(o['cluster_instance'])['cluster_id']) ?? text(o['existing_cluster_id'])

export function parseRun(raw: unknown): JobReading {
  const o = obj(raw)
  const state = stateOf(o)
  if (!state) throw new CliError('bad_output', L('A resposta do run veio sem estado.', 'The run came back with no state.'))
  const tasks: JobTask[] = list(o['tasks']).map((t) => {
    const taskState = stateOf(t) ?? 'queued'
    const startedAt = time(t['start_time'])
    const endedAt = time(t['end_time'])
    const parts = [num(t['setup_duration']), num(t['execution_duration']), num(t['cleanup_duration'])].filter((n): n is number => n !== undefined)
    const worked = parts.reduce((a, b) => a + b, 0)
    const ms = num(t['run_duration']) ?? (worked > 0 ? worked : startedAt && endedAt ? endedAt - startedAt : undefined)
    const error = taskState === 'failed' || taskState === 'timed_out' ? messageOf(t) : undefined
    return {
      key: text(t['task_key']) ?? text(t['run_id']) ?? '?',
      state: taskState,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt && ms !== undefined ? { ms } : {}),
      ...(num(t['attempt_number']) !== undefined ? { attempt: num(t['attempt_number'])! } : {}),
      ...(text(t['run_id']) ? { runId: text(t['run_id'])! } : {}),
      ...(error ? { error } : {})
    }
  })
  const running = list(o['tasks']).find((t) => stateOf(t) === 'running')
  const clusterId = (running && clusterOf(running)) ?? clusterOf(o) ?? list(o['tasks']).map(clusterOf).find(Boolean)
  const startedAt = time(o['start_time'])
  const endedAt = time(o['end_time'])
  const message = messageOf(o)
  return {
    name: text(o['run_name']) ?? L('Job sem nome', 'Unnamed job'),
    ...(text(o['run_page_url']) ? { url: text(o['run_page_url'])! } : {}),
    ...(text(o['job_id']) ? { jobId: text(o['job_id'])! } : {}),
    ...(clusterId ? { clusterId } : {}),
    state,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(message ? { message } : {}),
    tasks
  }
}

// The stage the run is on: the one doing the most, among those still active.
export function activeStage(stages: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const active = stages.filter((s) => s['status'] === 'ACTIVE')
  return active.sort((a, b) => (num(b['numActiveTasks']) ?? 0) - (num(a['numActiveTasks']) ?? 0))[0]
}

// The fullest executor, since the average hides the one running out. Its peak use of Spark's memory when reported;
// `memoryUsed` alone only counts what's cached, and stays near zero on a job that's short of memory.
export function executorMemory(all: Record<string, unknown>[]): { memoryPercent?: number; memoryKind?: 'peak' | 'storage' } {
  const workers = all.filter((e) => e['id'] !== 'driver')
  const execs = (workers.length ? workers : all).filter((e) => (num(e['maxMemory']) ?? 0) > 0)
  const peaks = execs.flatMap((e) => {
    const m = obj(e['peakMemoryMetrics'])
    const parts = ['OnHeapExecutionMemory', 'OnHeapStorageMemory', 'OffHeapExecutionMemory', 'OffHeapStorageMemory'].map((k) => num(m[k])).filter((n): n is number => n !== undefined)
    return parts.length ? [parts.reduce((a, b) => a + b, 0) / num(e['maxMemory'])!] : []
  })
  const percent = (r: number): number => Math.min(100, Math.round(r * 100))
  if (peaks.length) return { memoryPercent: percent(Math.max(...peaks)), memoryKind: 'peak' }
  const stored = execs.map((e) => (num(e['memoryUsed']) ?? 0) / num(e['maxMemory'])!)
  return stored.length ? { memoryPercent: percent(Math.max(...stored)), memoryKind: 'storage' } : {}
}

// Spark's monitoring API, as its documentation describes it.
export function parseSpark(input: { stages: unknown; executors?: unknown; median?: unknown; running?: unknown; now: number; previous?: SparkReading }): SparkReading | undefined {
  const stages = list(input.stages)
  const stage = activeStage(stages)
  const sum = (key: string): number => stages.reduce((n, s) => n + (num(s[key]) ?? 0), 0)
  if (!stage && !input.previous) return undefined
  const memory = executorMemory(list(input.executors))
  // The same spilled data measured twice, in memory and on disk: the larger, never the sum.
  const spilled = stages.flatMap((s) => {
    const sizes = [num(s['diskBytesSpilled']), num(s['memoryBytesSpilled'])].filter((n): n is number => n !== undefined)
    return sizes.length ? [Math.max(...sizes)] : []
  })
  const median = Array.isArray(obj(input.median)['executorRunTime']) ? num((obj(input.median)['executorRunTime'] as unknown[])[0]) : undefined
  const longest = list(input.running).reduce<number | undefined>((best, t) => {
    const launched = text(t['launchTime'])
    const at = launched ? Date.parse(launched.replace('GMT', 'Z')) : NaN
    const ms = Number.isNaN(at) ? num(t['duration']) : input.now - at
    return ms !== undefined && (best === undefined || ms > best) ? ms : best
  }, undefined)
  // Between stages: the last stage's place stands, with the totals so far.
  const p = input.previous
  return {
    stageId: stage ? (text(stage['stageId']) ?? '?') : p!.stageId,
    ...((stage ? text(stage['name']) : p?.stageName) ? { stageName: clip(stage ? text(stage['name'])! : p!.stageName!, 120) } : {}),
    tasksDone: stage ? (num(stage['numCompleteTasks']) ?? 0) : p!.tasksDone,
    tasksTotal: stage ? (num(stage['numTasks']) ?? 0) : p!.tasksTotal,
    tasksActive: stage ? (num(stage['numActiveTasks']) ?? 0) : 0,
    ...(median !== undefined ? { medianTaskMs: median } : {}),
    ...(longest !== undefined ? { longestActiveTaskMs: longest } : {}),
    shuffleBytes: sum('shuffleReadBytes') + sum('shuffleWriteBytes'),
    ...(spilled.length ? { spillBytes: spilled.reduce((a, b) => a + b, 0) } : {}),
    ...memory,
    at: input.now
  }
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function failure(r: CliResult): CliError {
  const said = maskSecrets(`${r.stderr}\n${r.stdout}`).trim()
  const short = clip(said.split('\n').find((l) => l.trim()) ?? said, MAX_MESSAGE)
  if (r.failure === 'missing') return new CliError('no_cli', L('Não achei a CLI do Databricks. Instale ou informe o caminho nas Configurações.', "I couldn't find the Databricks CLI. Install it or set its path in Settings."))
  if (r.failure === 'timeout') return new CliError('transient', L('A CLI do Databricks não respondeu a tempo.', "The Databricks CLI didn't answer in time."))
  if (/cannot configure default credentials|unauthenticated|invalid access token|invalid_grant|token.*expired|refresh token|auth login|\b401\b/i.test(said)) return new CliError('auth', short)
  if (/does not exist|RESOURCE_DOES_NOT_EXIST|PERMISSION_DENIED|not authorized|\b403\b|\b404\b/i.test(said)) return new CliError('gone', short)
  return new CliError('transient', short || L('A CLI do Databricks falhou.', 'The Databricks CLI failed.'))
}

// The addresses to try for a cluster's Spark API. The workspace's number comes from the run's link; 0 stands
// for the current workspace.
export function sparkAddresses(clusterId: string, runUrl?: string): string[] {
  const org = runUrl ? (/[?&]o=(\d+)/.exec(runUrl)?.[1] ?? /\badb-(\d+)\./.exec(runUrl)?.[1]) : undefined
  return [...new Set([org, '0'].filter((o): o is string => !!o))].flatMap((o) => SPARK_PORTS.map((port) => `/driver-proxy-api/o/${o}/${clusterId}/${port}/api/v1`))
}

type Found = { cliPath: string; profile?: string; profiles: DatabricksProfile[] }

export class DatabricksCli {
  private found: { key: string; at: number; value: Promise<Found> } | undefined
  private sparkAddress = new Map<string, { base: string; app: string }>() // per cluster, what answered
  private sparkFailed = new Map<string, { at: number; error: string }>()

  constructor(private deps: { config: () => JobWatchSettings; exec?: CliExec; find?: () => string | undefined; env?: NodeJS.ProcessEnv; now?: () => number }) {}

  private exec(file: string, args: string[]): Promise<CliResult> {
    return (this.deps.exec ?? realExec)(file, args, { timeoutMs: TIMEOUT_MS, maxBuffer: MAX_BUFFER })
  }

  // What's set in Settings wins; the rest is found once and kept for a while.
  private resolve(): Promise<Found> {
    const { cliPath, profile } = this.deps.config()
    const key = `${cliPath ?? ''}|${profile ?? ''}`
    const now = this.deps.now?.() ?? Date.now()
    if (this.found && this.found.key === key && now - this.found.at < FOUND_FOR_MS) return this.found.value
    const value = (async (): Promise<Found> => {
      const file = cliPath || (this.deps.find ?? findCli)() || 'databricks'
      // Asked even with a profile set: the list is what Settings offers. Only when it isn't set does it decide.
      const r = await this.exec(file, ['auth', 'profiles', '--output', 'json'])
      const profiles = r.code === 0 ? parseProfiles(r.stdout) : []
      const chosen = profile ?? chooseProfile(profiles, this.deps.env ?? process.env)
      return { cliPath: file, profiles, ...(chosen ? { profile: chosen } : {}) }
    })()
    this.found = { key, at: now, value }
    return value
  }

  private forget(): void {
    this.found = undefined
  }

  // Runs one command, if the rules allow it. Nothing starts for one they refuse, not even the search.
  async run(args: string[]): Promise<string> {
    const config = this.deps.config()
    const asked = [...args, '--output', 'json']
    const first = checkCli(asked, config)
    if (!first.ok) throw new CliError('refused', first.reason)
    const { cliPath, profile } = await this.resolve()
    const argv = [...asked, ...(profile ? ['--profile', profile] : [])]
    const verdict = checkCli(argv, config)
    if (!verdict.ok) throw new CliError('refused', verdict.reason)
    const r = await this.exec(cliPath, argv)
    if (r.code !== 0) {
      const e = failure(r)
      // The CLI was installed, or the person signed in, since the last search.
      if (e.kind === 'auth' || e.kind === 'no_cli') this.forget()
      throw e
    }
    return r.stdout
  }

  private async json(args: string[]): Promise<unknown> {
    const out = await this.run(args)
    try {
      return parseJson(out)
    } catch {
      throw new CliError('bad_output', L('A CLI do Databricks devolveu algo que não é JSON.', "The Databricks CLI returned something that isn't JSON."))
    }
  }

  async reading(runId: string): Promise<JobReading> {
    return parseRun(await this.json(['jobs', 'get-run', runId]))
  }

  // The job's runs still going, newest first. Through the API for one page: the CLI's list goes through them all.
  async activeRuns(jobId: string): Promise<string[]> {
    const r = obj(await this.json(['api', 'get', `/api/2.1/jobs/runs/list?job_id=${jobId}&active_only=true&limit=5`]))
    return list(r['runs']).flatMap((x) => text(x['run_id']) ?? [])
  }

  // The job's last run, of any state: what there is to show when none is going.
  async latestRun(jobId: string): Promise<string | undefined> {
    const r = obj(await this.json(['api', 'get', `/api/2.1/jobs/runs/list?job_id=${jobId}&limit=1`]))
    return text(list(r['runs'])[0]?.['run_id'])
  }

  // The ids of the jobs with exactly this name.
  async jobsNamed(name: string): Promise<string[]> {
    const r = obj(await this.json(['api', 'get', `/api/2.1/jobs/list?name=${name}&limit=5`]))
    return list(r['jobs']).flatMap((j) => text(j['job_id']) ?? [])
  }

  async baseline(jobId: string): Promise<{ ms?: number; runs: number }> {
    const r = obj(await this.json(['api', 'get', `/api/2.1/jobs/runs/list?job_id=${jobId}&completed_only=true&limit=25`]))
    const done = list(r['runs'])
      .filter((x) => stateOf(x) === 'succeeded')
      .slice(0, BASELINE_RUNS)
      .flatMap((x) => {
        const start = time(x['start_time'])
        const end = time(x['end_time'])
        const ms = num(x['run_duration']) ?? (start && end ? end - start : undefined)
        return ms ? [ms] : []
      })
    const ms = median(done)
    return { ...(ms ? { ms } : {}), runs: done.length }
  }

  // Where this cluster's Spark API answers: the address set in Settings, or the first one that works.
  private async sparkPlace(clusterId: string, now: number, runUrl?: string): Promise<{ base: string; app: string }> {
    const set = this.deps.config().sparkApiBase?.replace('{cluster}', clusterId).replace(/\/$/, '')
    const known = this.sparkAddress.get(clusterId)
    if (known && (!set || known.base === set)) return known
    const failed = this.sparkFailed.get(clusterId)
    if (!set && failed && now - failed.at < SPARK_RETRY_MS) throw new CliError('transient', failed.error)
    let error = L('O Spark não listou nenhuma aplicação.', "Spark didn't list any application.")
    for (const base of set ? [set] : sparkAddresses(clusterId, runUrl)) {
      try {
        const app = text(list(await this.json(['api', 'get', `${base}/applications`]))[0]?.['id'])
        if (app) {
          const place = { base, app }
          this.sparkAddress.set(clusterId, place)
          this.sparkFailed.delete(clusterId)
          return place
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    }
    this.sparkFailed.set(clusterId, { at: now, error })
    throw new CliError('transient', error)
  }

  // Spark's numbers for a cluster. An application can restart: an address that stops answering is looked for again.
  async spark(clusterId: string, now: number, previous?: SparkReading, runUrl?: string): Promise<SparkReading | undefined> {
    const { base, app } = await this.sparkPlace(clusterId, now, runUrl)
    const root = `${base}/applications/${app}`
    try {
      return await this.sparkAt(root, now, previous)
    } catch (e) {
      this.sparkAddress.delete(clusterId)
      throw e
    }
  }

  private async sparkAt(root: string, now: number, previous?: SparkReading): Promise<SparkReading | undefined> {
    const stages = await this.json(['api', 'get', `${root}/stages`])
    const executors = await this.json(['api', 'get', `${root}/executors`])
    const active = activeStage(list(stages))
    const id = active ? text(active['stageId']) : undefined
    const attempt = active ? (text(active['attemptId']) ?? '0') : '0'
    const summary = id ? await this.json(['api', 'get', `${root}/stages/${id}/${attempt}/taskSummary?quantiles=0.5`]) : undefined
    const running = id ? await this.json(['api', 'get', `${root}/stages/${id}/${attempt}/taskList?status=RUNNING&length=50`]) : undefined
    return parseSpark({ stages, executors, median: summary, running, now, ...(previous ? { previous } : {}) })
  }

  // What a task left: the error and its output, without secrets, in a size that fits a reply.
  async output(taskRunId: string): Promise<string> {
    const o = obj(await this.json(['jobs', 'get-run-output', taskRunId]))
    const notebook = text(obj(o['notebook_output'])['result'])
    const parts = [text(o['error']), text(o['error_trace']), notebook, text(o['logs'])].filter(Boolean)
    return clip(maskSecrets(parts.join('\n\n')), MAX_OUTPUT) || L('A task não deixou saída.', 'The task left no output.')
  }

  // For Settings: finds everything again, and says whether the login works.
  async check(): Promise<DatabricksStatus> {
    this.forget()
    const { cliPath, profile, profiles } = await this.resolve()
    const found = { profiles, ...(profile ? { profile } : {}) }
    const version = await this.exec(cliPath, ['--version'])
    if (version.code !== 0) return { ok: false, text: failure(version).message, ...found }
    try {
      const me = obj(parseJson(await this.run(['current-user', 'me'])))
      return { ok: true, text: `${version.stdout.trim()} · ${text(me['userName']) ?? L('login ok', 'signed in')}`, cliPath, ...found }
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e), cliPath, ...found }
    }
  }
}
