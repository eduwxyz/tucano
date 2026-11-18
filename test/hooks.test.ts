import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanAgentHooks, cleanHooks, clipHookText, HOOK_TEXT_MAX, hookActive, hooksPatchError, runTurnHook, sampleHookEvent, withCaptureOwner } from '../src/core/hooks'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tucano-hook-'))

describe('cleanHooks', () => {
  it('drops junk and keeps an enabled absolute command', () => {
    expect(cleanHooks(null)).toBeUndefined()
    expect(cleanHooks({ enabled: true, command: 'relative' })).toEqual({ enabled: true, command: 'relative' })
    expect(hooksPatchError({ enabled: true, command: 'relative' })).toBeTruthy()
    expect(hooksPatchError({})).toBeUndefined()
    expect(hooksPatchError({ enabled: false })).toBeUndefined()
    expect(hooksPatchError([])).toBeTruthy()
    const abs = join(dir(), 'hook')
    expect(hooksPatchError({ enabled: true, command: abs })).toBeUndefined()
    expect(cleanHooks({ enabled: true, command: ` ${abs} `, captureOwner: true, timeoutMs: 50, env: { HOOK_OUT: '/tmp/x', 'bad key': 'no' }, args: ['--ok', ''] })?.env).toEqual({ HOOK_OUT: '/tmp/x' })
  })

  it('treats only "off" as an agent override', () => {
    expect(cleanAgentHooks('off')).toBe('off')
    expect(cleanAgentHooks('inherit')).toBeUndefined()
    expect(cleanAgentHooks(true)).toBeUndefined()
  })
})

describe('hookActive', () => {
  it('is off unless Settings enable a command and the agent does not silence it', () => {
    const abs = join(dir(), 'h')
    const settings = { hooks: { enabled: true, command: abs } }
    expect(hookActive({}, {})).toBe(false)
    expect(hookActive(settings, {})).toBe(true)
    expect(hookActive(settings, { hooks: 'off' })).toBe(false)
  })
})

describe('runTurnHook', () => {
  const script = (body: string): string => {
    const file = join(dir(), 'hook.mjs')
    writeFileSync(file, body)
    return file
  }

  it('writes one JSON line and records exit 0', async () => {
    const out = join(dir(), 'out.jsonl')
    const command = process.execPath
    const args = [
      script(`
import { appendFileSync } from 'node:fs'
let s = ''
process.stdin.setEncoding('utf8')
for await (const c of process.stdin) s += c
appendFileSync(process.env.HOOK_OUT, s)
`)
    ]
    const event = withCaptureOwner({ enabled: true, command, args, env: { HOOK_OUT: out }, captureOwner: true }, sampleHookEvent())
    const run = await runTurnHook({ enabled: true, command, args, env: { HOOK_OUT: out }, captureOwner: true }, event)
    expect(run.exit).toBe(0)
    expect(run.error).toBeUndefined()
    const payload = JSON.parse(readFileSync(out, 'utf8'))
    expect(payload).toMatchObject({ version: 1, event: 'turn-end', session: 'run-test', captureOwner: 'tucano' })
  })

  it('does not throw when the command exits before reading stdin', async () => {
    const run = await runTurnHook({ enabled: true, command: process.execPath, args: ['-e', 'process.exit(0)'] }, sampleHookEvent())
    expect(run.exit).toBe(0)
    expect(run).not.toHaveProperty('command')
  })

  it('fail-open: missing binary, nonzero exit and timeout still return a run', async () => {
    const missing = await runTurnHook({ enabled: true, command: join(dir(), 'no-such-hook') }, sampleHookEvent())
    expect(missing.exit).not.toBe(0)

    const fail = script('process.exit(2)')
    const bad = await runTurnHook({ enabled: true, command: process.execPath, args: [fail] }, sampleHookEvent())
    expect(bad.exit).toBe(2)

    const slow = script('await new Promise((r) => setTimeout(r, 20_000))')
    const timed = await runTurnHook({ enabled: true, command: process.execPath, args: [slow], timeoutMs: 250 }, sampleHookEvent())
    expect(timed.error).toBe('timeout')
    expect(timed.exit).toBeNull()
  })

  it('clips huge text', () => {
    expect(clipHookText('x'.repeat(HOOK_TEXT_MAX + 10)).endsWith('…')).toBe(true)
  })
})
