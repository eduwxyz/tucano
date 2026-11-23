import { describe, expect, it } from 'vitest'
import { allowedEvents, detect, holdEvents, type DetectInput } from '../src/core/job-detect'
import { JOB_WATCH_DEFAULTS, type JobEvent, type JobReading, type SparkReading } from '../src/shared/job-watch'

const MIN = 60_000
const GB = 1024 ** 3
const NOW = 1_000 * MIN

const spark = (patch: Partial<SparkReading> = {}): SparkReading => ({ stageId: '14', tasksDone: 10, tasksTotal: 100, tasksActive: 5, shuffleBytes: 0, spillBytes: 0, at: NOW, ...patch })
const run = (patch: Partial<JobReading> = {}): JobReading => ({ name: 'vendas', state: 'running', startedAt: NOW - 10 * MIN, tasks: [], ...patch })
const input = (patch: Partial<DetectInput> = {}): DetectInput => ({ reading: run(), fired: [], config: JOB_WATCH_DEFAULTS, now: NOW, ...patch })
const kinds = (es: JobEvent[]): string[] => es.map((e) => e.kind)

describe('the end of a run', () => {
  it('wakes the agent on a failure, naming the task', () => {
    const d = detect(input({ reading: run({ state: 'failed', tasks: [{ key: 'transform', state: 'failed' }] }) }))
    expect(kinds(d.events)).toEqual(['run_failed'])
    expect(d.events[0]!.title).toContain('transform')
  })

  it('counts a timeout as a failure', () => {
    expect(kinds(detect(input({ reading: run({ state: 'timed_out' }) })).events)).toEqual(['run_failed'])
  })

  it('wakes the agent for a summary when it succeeds', () => {
    expect(kinds(detect(input({ reading: run({ state: 'succeeded' }) })).events)).toEqual(['run_succeeded'])
  })

  it('stays quiet when it is canceled', () => {
    expect(detect(input({ reading: run({ state: 'canceled' }) })).events).toEqual([])
  })

  it('says the final thing once', () => {
    const first = detect(input({ reading: run({ state: 'failed' }) }))
    expect(detect(input({ reading: run({ state: 'failed' }), fired: first.fired })).events).toEqual([])
  })

  it('lets the final event stand for what led to it', () => {
    const d = detect(input({ reading: run({ state: 'failed', tasks: [{ key: 'a', state: 'failed' }], spark: spark() }), progressAt: NOW - 60 * MIN }))
    expect(kinds(d.events)).toEqual(['run_failed'])
    expect(d.signal).toBeUndefined()
  })
})

describe('a task that failed', () => {
  it('wakes the agent once per task, while the run goes on', () => {
    const reading = run({ tasks: [{ key: 'a', state: 'failed' }, { key: 'b', state: 'running' }] })
    const first = detect(input({ reading }))
    expect(kinds(first.events)).toEqual(['task_failed'])
    expect(detect(input({ reading, fired: first.fired })).events).toEqual([])
  })

  it('stays quiet while it waits to retry', () => {
    expect(detect(input({ reading: run({ tasks: [{ key: 'a', state: 'waiting_retry' }] }) })).events).toEqual([])
  })
})

describe('no progress', () => {
  it('starts counting from the first reading', () => {
    const d = detect(input({ reading: run({ spark: spark() }) }))
    expect(d.progressAt).toBe(NOW)
    expect(d.events).toEqual([])
  })

  it('fires when the stage stops moving for the configured time', () => {
    const d = detect(input({ reading: run({ spark: spark() }), progressKey: '14:10', progressAt: NOW - 15 * MIN }))
    expect(d.signal).toBe('no_progress')
    expect(d.events[0]).toMatchObject({ kind: 'possible_stall', signal: 'no_progress', key: 'no_progress:stage-14' })
  })

  it('waits until then', () => {
    expect(detect(input({ reading: run({ spark: spark() }), progressKey: '14:10', progressAt: NOW - 14 * MIN })).signal).toBeUndefined()
  })

  it('follows the configured time', () => {
    const d = detect(input({ reading: run({ spark: spark() }), progressKey: '14:10', progressAt: NOW - 5 * MIN, config: { ...JOB_WATCH_DEFAULTS, stallMinutes: 5 } }))
    expect(d.signal).toBe('no_progress')
  })

  it('counts a moving stage as progress, and clears the alert without firing again', () => {
    const stuck = detect(input({ reading: run({ spark: spark() }), progressKey: '14:10', progressAt: NOW - 20 * MIN }))
    const moved = detect(input({ reading: run({ spark: spark({ tasksDone: 11 }) }), progressKey: '14:10', progressAt: NOW - 20 * MIN, fired: stuck.fired }))
    expect(moved.signal).toBeUndefined()
    expect(moved.progressAt).toBe(NOW)
    expect(moved.events).toEqual([])
  })

  it('fires once per stage', () => {
    const fired = ['no_progress:stage-14']
    expect(detect(input({ reading: run({ spark: spark() }), progressKey: '14:10', progressAt: NOW - 30 * MIN, fired })).events).toEqual([])
    const other = detect(input({ reading: run({ spark: spark({ stageId: '15' }) }), progressKey: '15:10', progressAt: NOW - 30 * MIN, fired }))
    expect(other.events[0]!.key).toBe('no_progress:stage-15')
  })

  it('needs active tasks and a running state', () => {
    expect(detect(input({ reading: run({ spark: spark({ tasksActive: 0 }) }), progressKey: '14:10', progressAt: NOW - 60 * MIN })).signal).toBeUndefined()
    expect(detect(input({ reading: run({ state: 'queued', spark: spark() }), progressKey: '14:10', progressAt: NOW - 60 * MIN })).signal).toBeUndefined()
  })
})

describe('a straggler task', () => {
  const late = spark({ tasksDone: 80, medianTaskMs: 2 * MIN, longestActiveTaskMs: 11 * MIN })

  it('fires past the median, with most of the stage done', () => {
    const d = detect(input({ reading: run({ spark: late }), progressKey: '14:80', progressAt: NOW }))
    expect(d.signal).toBe('straggler')
  })

  it.each<[string, Partial<SparkReading>]>([
    ['under the factor', { longestActiveTaskMs: 9.9 * MIN, medianTaskMs: 2 * MIN }],
    ['under ten minutes', { medianTaskMs: 0.5 * MIN, longestActiveTaskMs: 9 * MIN }],
    ['too early in the stage', { tasksDone: 74 }]
  ])('stays quiet %s', (_, patch) => {
    expect(detect(input({ reading: run({ spark: { ...late, ...patch } }), progressKey: `14:${patch.tasksDone ?? 80}`, progressAt: NOW })).signal).toBeUndefined()
  })
})

describe('a slow run', () => {
  const reading = run({ startedAt: NOW - 61 * MIN })

  it('fires past the median of the last runs', () => {
    const d = detect(input({ reading, baselineMs: 30 * MIN, baselineRuns: 3 }))
    expect(d.signal).toBe('slow_run')
    expect(d.events[0]).toMatchObject({ kind: 'possible_stall', key: 'slow_run' })
  })

  it('works with no Spark numbers', () => {
    expect(reading.spark).toBeUndefined()
    expect(detect(input({ reading, baselineMs: 30 * MIN, baselineRuns: 10 })).signal).toBe('slow_run')
  })

  it('needs enough history', () => {
    expect(detect(input({ reading, baselineMs: 30 * MIN, baselineRuns: 2 })).signal).toBeUndefined()
  })

  it('waits for the factor', () => {
    expect(detect(input({ reading: run({ startedAt: NOW - 59 * MIN }), baselineMs: 30 * MIN, baselineRuns: 5 })).signal).toBeUndefined()
  })
})

describe('spill', () => {
  const high = run({ spark: spark({ spillBytes: 10 * GB }) })

  it('only shows on the card by default', () => {
    const d = detect(input({ reading: high }))
    expect(d.spillHigh).toBe(true)
    expect(d.events).toEqual([])
  })

  it('wakes the agent when set to, once per stage', () => {
    const config = { ...JOB_WATCH_DEFAULTS, spillAction: 'wake' as const }
    const d = detect(input({ reading: high, config }))
    expect(d.events[0]).toMatchObject({ kind: 'high_spill', key: 'high_spill:stage-14' })
    expect(detect(input({ reading: high, config, fired: d.fired })).events).toEqual([])
  })

  it('follows the configured limit', () => {
    const config = { ...JOB_WATCH_DEFAULTS, spillLimitGb: 2 }
    expect(detect(input({ reading: run({ spark: spark({ spillBytes: 3 * GB }) }), config })).spillHigh).toBe(true)
    expect(detect(input({ reading: run({ spark: spark({ spillBytes: 1 * GB }) }), config })).spillHigh).toBe(false)
    expect(detect(input({ reading: run({ spark: spark({ spillBytes: 3 * GB }) }) })).spillHigh).toBe(false)
  })
})

describe('a spill Spark didn’t report', () => {
  it('isn’t high', () => {
    expect(detect(input({ reading: run({ spark: spark({ spillBytes: undefined }) }) })).spillHigh).toBe(false)
  })
})

describe('the limit on wakes', () => {
  const alert = (key: string): JobEvent => ({ kind: 'possible_stall', key, title: key, at: NOW })
  const final: JobEvent = { kind: 'run_failed', key: 'run_failed', title: 'x', at: NOW }

  it('keeps the last wake for the final event', () => {
    expect(allowedEvents([alert('a'), alert('b'), alert('c')], 0, 3).map((e) => e.key)).toEqual(['a', 'b'])
    expect(allowedEvents([alert('c')], 2, 3)).toEqual([])
    expect(allowedEvents([final], 2, 3)).toEqual([final])
  })

  it('lets a final event through even past the limit', () => {
    expect(allowedEvents([final], 5, 3)).toEqual([final])
  })

  it('with a limit of one, wakes only for the final event', () => {
    expect(allowedEvents([alert('a')], 0, 1)).toEqual([])
    expect(allowedEvents([final], 0, 1)).toEqual([final])
  })

  it('collapses what was held into the final event, marked late', () => {
    expect(holdEvents([alert('a')], [final], true)).toEqual([{ ...final, late: true }])
    expect(holdEvents([alert('a')], [alert('b')], true).map((e) => e.late)).toEqual([true, true])
    expect(holdEvents([], [alert('b')], false)[0]!.late).toBeUndefined()
  })
})
