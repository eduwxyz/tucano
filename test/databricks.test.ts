import { describe, expect, it } from 'vitest'
import { CliError, DatabricksCli, parseJson, parseRun, parseSpark, stateOf, type CliExec } from '../src/core/databricks'
import { jobWatchConfig } from '../src/shared/job-watch'

describe('reading the state of a run', () => {
  it.each([
    [{ state: { life_cycle_state: 'RUNNING' } }, 'running'],
    [{ state: { life_cycle_state: 'PENDING' } }, 'queued'],
    [{ state: { life_cycle_state: 'QUEUED' } }, 'queued'],
    [{ state: { life_cycle_state: 'BLOCKED' } }, 'queued'],
    [{ state: { life_cycle_state: 'TERMINATING' } }, 'terminating'],
    [{ state: { life_cycle_state: 'WAITING_FOR_RETRY' } }, 'waiting_retry'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } }, 'succeeded'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS_WITH_FAILURES' } }, 'failed'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED' } }, 'failed'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'TIMEDOUT' } }, 'timed_out'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'CANCELED' } }, 'canceled'],
    [{ state: { life_cycle_state: 'TERMINATED', result_state: 'UPSTREAM_FAILED' } }, 'canceled'],
    [{ state: { life_cycle_state: 'INTERNAL_ERROR' } }, 'failed'],
    [{ state: { life_cycle_state: 'SKIPPED' } }, 'canceled'],
    [{ status: { state: 'RUNNING' } }, 'running'],
    [{ status: { state: 'WAITING' } }, 'queued'],
    [{ status: { state: 'TERMINATED', termination_details: { code: 'SUCCESS' } } }, 'succeeded'],
    [{ status: { state: 'TERMINATED', termination_details: { code: 'USER_CANCELED' } } }, 'canceled'],
    [{ status: { state: 'TERMINATED', termination_details: { code: 'RUN_EXECUTION_ERROR' } } }, 'failed']
  ])('%j is %s', (raw, state) => {
    expect(stateOf(raw)).toBe(state)
  })

  it('has no state to give when neither format came', () => {
    expect(stateOf({})).toBeUndefined()
  })
})

describe('parsing a run', () => {
  const raw = {
    run_id: 8841,
    job_id: 123,
    run_name: 'vendas_diarias',
    run_page_url: 'https://x.cloud.databricks.com/?o=1#job/123/run/8841',
    start_time: 1000,
    state: { life_cycle_state: 'RUNNING', state_message: 'In run' },
    tasks: [
      { run_id: 1, task_key: 'ingest', state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' }, start_time: 1000, end_time: 3000, execution_duration: 2000, setup_duration: 0, cleanup_duration: 0, attempt_number: 0, cluster_instance: { cluster_id: 'old' } },
      { run_id: 2, task_key: 'transform', state: { life_cycle_state: 'RUNNING' }, start_time: 3000, end_time: 0, cluster_instance: { cluster_id: 'c-1' } },
      { run_id: 3, task_key: 'publish', state: { life_cycle_state: 'BLOCKED' } }
    ]
  }

  it('reads names, tasks and the running task’s cluster', () => {
    const r = parseRun(raw)
    expect(r).toMatchObject({ name: 'vendas_diarias', jobId: '123', clusterId: 'c-1', state: 'running', startedAt: 1000 })
    expect(r.endedAt).toBeUndefined()
    expect(r.tasks.map((t) => [t.key, t.state])).toEqual([['ingest', 'succeeded'], ['transform', 'running'], ['publish', 'queued']])
    expect(r.tasks[0]).toMatchObject({ ms: 2000, runId: '1' })
    expect(r.tasks[1]!.ms).toBeUndefined()
  })

  it('refuses an answer with no state', () => {
    expect(() => parseRun({ run_id: 1 })).toThrow(CliError)
  })

  it('takes missing fields in stride', () => {
    expect(parseRun({ state: { life_cycle_state: 'PENDING' } })).toMatchObject({ state: 'queued', tasks: [] })
  })

  it('keeps ids too long for a number, and leaves other numbers alone', () => {
    const r = parseJson('{"run_id": 900719925474099312, "job_id":123, "start_time": 900719925474099312}') as Record<string, unknown>
    expect(r['run_id']).toBe('900719925474099312')
    expect(r['job_id']).toBe(123)
    expect(typeof r['start_time']).toBe('number')
    expect(parseRun({ ...(parseJson('{"run_id": 900719925474099312, "job_id": 900719925474099313}') as object), state: { life_cycle_state: 'RUNNING' } }).jobId).toBe('900719925474099313')
  })

  it('takes secrets out of what a task says', () => {
    const r = parseRun({ state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED' }, tasks: [{ task_key: 'a', state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED', state_message: `token dapi${'a'.repeat(32)} refused` } }] })
    expect(r.tasks[0]!.error).not.toContain('dapi')
  })
})

describe('Spark’s numbers', () => {
  const stages = [
    { status: 'COMPLETE', stageId: 13, numTasks: 10, numCompleteTasks: 10, numActiveTasks: 0, shuffleReadBytes: 100, shuffleWriteBytes: 50, diskBytesSpilled: 5 },
    { status: 'ACTIVE', stageId: 14, attemptId: 0, name: 'join', numTasks: 400, numCompleteTasks: 312, numActiveTasks: 88, shuffleReadBytes: 1000, shuffleWriteBytes: 0, diskBytesSpilled: 20 },
    { status: 'ACTIVE', stageId: 15, numTasks: 4, numCompleteTasks: 3, numActiveTasks: 1 }
  ]

  it('reads the busiest active stage, and totals across the application', () => {
    const s = parseSpark({ stages, now: 5, executors: [{ memoryUsed: 50, maxMemory: 100 }, { memoryUsed: 25, maxMemory: 100 }] })
    expect(s).toMatchObject({ stageId: '14', stageName: 'join', tasksDone: 312, tasksTotal: 400, tasksActive: 88, shuffleBytes: 1150, spillBytes: 25, memoryPercent: 38, at: 5 })
  })

  it('reads the median and the longest running task', () => {
    const now = Date.parse('2026-11-06T10:10:00Z')
    const s = parseSpark({ stages, now, median: { executorRunTime: [1200] }, running: [{ launchTime: '2026-11-06T10:00:00.000GMT' }, { launchTime: '2026-11-06T10:09:00.000GMT' }] })
    expect(s).toMatchObject({ medianTaskMs: 1200, longestActiveTaskMs: 600_000 })
  })

  it('keeps its place between stages', () => {
    const previous = parseSpark({ stages, now: 1 })!
    const s = parseSpark({ stages: [{ ...stages[1], status: 'COMPLETE', numActiveTasks: 0 }], now: 2, previous })
    expect(s).toMatchObject({ stageId: '14', tasksDone: 312, tasksActive: 0, at: 2 })
  })

  it('has nothing to say with no stage yet', () => {
    expect(parseSpark({ stages: [], now: 1 })).toBeUndefined()
  })

  it('doesn’t make up a memory number', () => {
    expect(parseSpark({ stages, now: 1 })!.memoryPercent).toBeUndefined()
  })
})

describe('calling the CLI', () => {
  const answers = (fn: (args: string[]) => { stdout?: string; stderr?: string; code?: number; failure?: 'missing' | 'timeout' }) => {
    const calls: { file: string; args: string[] }[] = []
    const exec: CliExec = async (file, args) => {
      calls.push({ file, args })
      const r = fn(args)
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0, ...(r.failure ? { failure: r.failure } : {}) }
    }
    return { calls, exec }
  }
  const cli = (exec: CliExec, patch: Parameters<typeof jobWatchConfig>[0] = {}): DatabricksCli => new DatabricksCli({ exec, config: () => jobWatchConfig(patch) })

  it('always sets the format and the profile', async () => {
    const { calls, exec } = answers(() => ({ stdout: JSON.stringify({ state: { life_cycle_state: 'RUNNING' } }) }))
    await cli(exec, { profile: 'leitura', cliPath: 'C:\\db.exe' }).reading('8841')
    expect(calls[0]).toEqual({ file: 'C:\\db.exe', args: ['jobs', 'get-run', '8841', '--output', 'json', '--profile', 'leitura'] })
  })

  it('never starts what the rules refuse', async () => {
    const { calls, exec } = answers(() => ({}))
    await expect(cli(exec, { commands: [] }).reading('1')).rejects.toMatchObject({ kind: 'refused' })
    expect(calls).toEqual([])
  })

  it.each([
    [{ failure: 'missing' as const, code: 1 }, 'no_cli'],
    [{ failure: 'timeout' as const, code: 1 }, 'transient'],
    [{ stderr: 'Error: cannot configure default credentials', code: 1 }, 'auth'],
    [{ stderr: 'Error: Invalid access token. 401', code: 1 }, 'auth'],
    [{ stderr: 'Error: Run 1 does not exist', code: 1 }, 'gone'],
    [{ stderr: 'PERMISSION_DENIED', code: 1 }, 'gone'],
    [{ stderr: 'Error: 503 service unavailable', code: 1 }, 'transient'],
    [{ stdout: 'not json' }, 'bad_output']
  ])('%j is a %s error', async (answer, kind) => {
    await expect(cli(answers(() => answer).exec).reading('1')).rejects.toMatchObject({ kind })
  })

  it('takes secrets out of errors', async () => {
    const token = `dapi${'b'.repeat(32)}`
    const e = await cli(answers(() => ({ stderr: `boom ${token}`, code: 1 })).exec).reading('1').catch((x: Error) => x)
    expect((e as Error).message).not.toContain(token)
  })

  it('finds active runs and the median of the good ones', async () => {
    const { exec } = answers((args) => ({
      stdout: JSON.stringify(
        String(args[2]).includes('active_only')
          ? { runs: [{ run_id: 9 }, { run_id: 8 }] }
          : { runs: [
              { state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' }, run_duration: 100 },
              { state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED' }, run_duration: 9999 },
              { state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' }, run_duration: 300 },
              { state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' }, start_time: 1000, end_time: 1200 }
            ] }
      )
    }))
    const c = cli(exec)
    expect(await c.activeRuns('1')).toEqual(['9', '8'])
    expect(await c.baseline('1')).toEqual({ ms: 200, runs: 3 })
  })

  it('reads Spark only when an address is set', async () => {
    const { calls, exec } = answers(() => ({ stdout: '[]' }))
    expect(await cli(exec).spark('c-1', 1)).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('reads Spark through the allowed paths, with the cluster in the address', async () => {
    const paths: string[] = []
    const { exec } = answers((args) => {
      const path = args[2]!
      paths.push(path)
      if (path.endsWith('/applications')) return { stdout: '[{"id":"app-1"}]' }
      if (path.endsWith('/stages')) return { stdout: JSON.stringify([{ status: 'ACTIVE', stageId: 3, attemptId: 0, numTasks: 4, numCompleteTasks: 1, numActiveTasks: 3 }]) }
      if (path.endsWith('/executors')) return { stdout: '[{"memoryUsed":1,"maxMemory":2}]' }
      if (path.includes('taskSummary')) return { stdout: '{"executorRunTime":[10]}' }
      return { stdout: '[]' }
    })
    const s = await cli(exec, { sparkApiBase: '/driver-proxy-api/o/0/{cluster}/40001/api/v1/' }).spark('c-1', 1)
    expect(paths[0]).toBe('/driver-proxy-api/o/0/c-1/40001/api/v1/applications')
    expect(paths.at(-1)).toContain('/stages/3/0/taskList?status=RUNNING')
    expect(s).toMatchObject({ stageId: '3', memoryPercent: 50, medianTaskMs: 10 })
  })

  it('reports whether it’s there and signed in', async () => {
    const ok = answers((args) => (args[0] === '--version' ? { stdout: 'Databricks CLI v0.200\n' } : { stdout: '{"userName":"a@b.c"}' }))
    expect(await cli(ok.exec).check()).toEqual({ ok: true, text: 'Databricks CLI v0.200 · a@b.c' })
    const missing = answers(() => ({ failure: 'missing', code: 1 }))
    expect((await cli(missing.exec).check()).ok).toBe(false)
  })
})
