import { describe, expect, it } from 'vitest'
import { checkCli, type CliPolicy } from '../src/core/cli-policy'
import { commandWords, isReadCommand, JOB_WATCH_DEFAULTS, jobWatchConfig } from '../src/shared/job-watch'

const policy: CliPolicy = { commands: JOB_WATCH_DEFAULTS.commands, apiPaths: JOB_WATCH_DEFAULTS.apiPaths, actions: false }
const ok = (line: string, p: CliPolicy = policy): boolean => checkCli(line.split(' '), p).ok

describe('the command rules', () => {
  it.each([
    'jobs get-run 8841 --output json',
    'jobs get-run 8841 --output json --profile leitura-jobs',
    'jobs get 123',
    'jobs get-run-output 99',
    'jobs list-runs --job-id 123 --active-only --limit 5',
    'clusters get 0123-abc',
    'current-user me',
    'api get /api/2.1/jobs/runs/list?job_id=1&active_only=true&limit=5',
    'api get /driver-proxy-api/o/0/abc/40001/api/v1/applications --output json'
  ])('allows %s', (line) => {
    expect(ok(line)).toBe(true)
  })

  it.each([
    ['anything off the list', 'workspace delete /Users/x'],
    ['a similar command', 'jobs get-run-outputs 1'],
    ['a command stopped short', 'jobs'],
    ['deleting a job', 'jobs delete 1'],
    ['starting a job', 'jobs run-now 1'],
    ['canceling a run', 'jobs cancel-run 1'],
    ['api post', 'api post /api/2.1/jobs/runs/cancel'],
    ['api delete', 'api delete /api/2.1/jobs/delete'],
    ['api with no verb', 'api'],
    ['a path off the list', 'api get /api/2.0/secrets/list'],
    ['a prefix that only looks allowed', 'api get /api/2.1/jobs/runs/listing'],
    ['climbing out of an allowed path', 'api get /driver-proxy-api/../api/2.0/secrets/list'],
    ['an encoded climb', 'api get /driver-proxy-api/%2e%2e/secrets'],
    ['a double slash', 'api get //driver-proxy-api/x'],
    ['two paths', 'api get /driver-proxy-api/a /api/2.0/secrets/list'],
    ['a path hidden behind a flag', 'api get --profile x /api/2.0/secrets/list'],
    ['a flag off the list', 'jobs get-run 1 --debug'],
    ['a body from a file', 'api get /driver-proxy-api/a --json @/etc/passwd'],
    ['a short flag', 'jobs get-run 1 -o json'],
    ['a file argument', 'jobs get-run @secrets']
  ])('refuses %s', (_, line) => {
    expect(ok(line)).toBe(false)
  })

  it('refuses an empty command', () => {
    expect(checkCli([], policy).ok).toBe(false)
  })

  it('refuses strange characters', () => {
    expect(checkCli(['jobs', 'get-run', '1; rm -rf /'], policy).ok).toBe(false)
    expect(checkCli(['jobs', 'get-run', '1\n2'], policy).ok).toBe(false)
  })

  it('takes actions only with their setting on, and calls them writes', () => {
    const on = { ...policy, actions: true }
    expect(checkCli(['jobs', 'cancel-run', '1', '--no-wait'], on)).toEqual({ ok: true, write: true })
    expect(checkCli(['jobs', 'run-now', '1', '--no-wait'], on)).toEqual({ ok: true, write: true })
    expect(checkCli(['jobs', 'cancel-run', '1', '--debug'], on).ok).toBe(false)
  })

  it('never takes actions from the list alone', () => {
    expect(ok('jobs cancel-run 1', { ...policy, commands: [...policy.commands, 'jobs cancel-run'] })).toBe(false)
  })

  it('never lets the list write through the raw API', () => {
    expect(ok('api post /driver-proxy-api/a', { ...policy, commands: [...policy.commands, 'api post'] })).toBe(false)
  })

  it('follows the list the person edits', () => {
    const edited = { ...policy, commands: ['jobs get-run', 'clusters events --limit'] }
    expect(ok('jobs get 1', edited)).toBe(false)
    expect(ok('clusters events 0123 --limit 10', edited)).toBe(true)
    expect(ok('clusters events 0123 --start-time 1', edited)).toBe(false)
  })

  it('calls an added command that changes things a write', () => {
    const added = { ...policy, commands: [...policy.commands, 'clusters restart'] }
    expect(checkCli(['clusters', 'restart', '1'], added)).toEqual({ ok: true, write: true })
    expect(checkCli(['clusters', 'get', '1'], added)).toEqual({ ok: true, write: false })
  })
})

describe('the settings', () => {
  it('tells reading from writing by the verb', () => {
    expect(isReadCommand(commandWords('jobs list-runs --limit'))).toBe(true)
    expect(isReadCommand(commandWords('jobs get-run-output'))).toBe(true)
    expect(isReadCommand(commandWords('jobs delete'))).toBe(false)
    expect(isReadCommand(commandWords('clusters restart'))).toBe(false)
  })

  it('fills in the defaults and keeps numbers at their minimum', () => {
    expect(jobWatchConfig()).toEqual(JOB_WATCH_DEFAULTS)
    const c = jobWatchConfig({ intervalSeconds: 1, maxWakes: 0, spillLimitGb: 0, spillAction: 'wake', profile: '  x  ' })
    expect(c).toMatchObject({ intervalSeconds: 15, maxWakes: 1, spillLimitGb: 1, spillAction: 'wake', profile: 'x' })
  })

  it('starts with actions off', () => {
    expect(jobWatchConfig().actions).toBe(false)
  })
})
