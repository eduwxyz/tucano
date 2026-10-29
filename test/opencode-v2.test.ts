import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { opencodeEngine } from '../src/core/engines/opencode'
import { opencodeMajor, opencodeV2Args, opencodeV2Config, opencodeV2Env, sessionUsage } from '../src/core/engines/opencode-v2'
import type { EngineEvent, Turn } from '../src/core/engines/types'

// Trimmed from a real OpenCode v2.2.0 run: the stream has no step_finish for the last step,
// and `session export` has the session's totals.
const STEP = '{"type":"step_start","sessionID":"ses_x","part":{"type":"step-start"}}'
const TEXT = '{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"oi"}}'
const EXPORT = JSON.stringify({ info: { id: 'ses_x', cost: 0, tokens: { input: 403, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }, messages: [] })

describe('opencode v2', () => {
  it('emits the native V2 config', () => {
    const c = opencodeV2Config({ system: 'Você é a Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }, { provider: { acme: {} } })
    expect(c['tools']).toEqual({ '*': false, 'tucano_*': true, webfetch: false, websearch: false })
    expect(c['mcp']).toEqual({ servers: { tucano: { type: 'remote', url: 'http://127.0.0.1:1/mcp/x', disabled: false } } })
    expect(c['agents']).toEqual({ tucano: { system: 'Você é a Iris.' } })
    expect(c['update']).toBe('disable')
    expect(c['snapshots']).toBe(false)
    expect(c['share']).toBe('disabled')
    expect(c['provider']).toEqual({ acme: {} })
  })

  it('omits the mcp block when there is no gateway', () => {
    const c = opencodeV2Config({ system: 's', web: true })
    expect(c['mcp']).toEqual({})
    expect(c['tools']).toEqual({ '*': false, 'tucano_*': true, webfetch: true, websearch: true })
  })

  it("runs on the turn's own server, in a session the app names", () => {
    expect(opencodeV2Args({ model: 'acme/gpt-9' }, 'ses_tucano1', 'http://127.0.0.1:5')).toEqual(['run', '--server', 'http://127.0.0.1:5', '--format', 'json', '--agent', 'tucano', '-m', 'acme/gpt-9', '--session', 'ses_tucano1'])
  })

  it("keeps the person's data dir, where V2 keeps the logins, and isolates the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc2-'))
    const env = opencodeV2Env(dir)
    expect(env['XDG_DATA_HOME']).toBeUndefined()
    expect(env['XDG_CONFIG_HOME']).toBe(join(dir, 'v2', 'config'))
    expect(env['OPENCODE_CONFIG_DIR']).toBe(join(dir, 'v2', 'config', 'opencode'))
    expect(env['XDG_STATE_HOME']).toBe(join(dir, 'v2', 'state'))
    expect(env).toMatchObject({ OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' })
  })

  it("reads the session's usage from its export", () => {
    expect(sessionUsage(EXPORT)).toEqual({ inputTokens: 403, cacheReadTokens: 0, outputTokens: 5 })
    const cached = JSON.stringify({ info: { cost: 0.01, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } } } })
    expect(sessionUsage(cached)).toEqual({ inputTokens: 160, cacheReadTokens: 50, outputTokens: 25, apiCostUsd: 0.01 })
    expect(sessionUsage('Session not found')).toBeUndefined()
  })

  it('reads the major version, V1 when unknown', () => {
    expect(opencodeMajor('2.2.0')).toBe(2)
    expect(opencodeMajor('1.15.10')).toBe(1)
    expect(opencodeMajor(undefined)).toBe(1)
    expect(opencodeMajor('tomorrow')).toBe(1)
  })
})

// A stand-in `opencode` that logs every call and answers like v2.2.0 does.
function fakeOpencode(opts: { hang?: boolean } = {}): { bin: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-bin-'))
  const log = join(dir, 'calls.log')
  const bin = join(dir, 'opencode')
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$* | data=$XDG_DATA_HOME | claude=$OPENCODE_DISABLE_CLAUDE_CODE" >> "${log}"
STOPPED='{"type":"error","error":{"message":"Transport: ECONNRESET"}}'
case "$1 $2" in
  "serve --hostname") echo "server listening on http://127.0.0.1:9"; exec sleep 30 ;;
  "session export") echo '${EXPORT}' ;;
  "session delete") echo "Session $3 deleted" ;;
  *) cat > /dev/null; echo '${STEP}'; echo '${TEXT}'; ${opts.hang ? `trap 'echo "$STOPPED"; kill $!; exit 1' TERM; sleep 30 >/dev/null 2>&1 & wait` : 'true'} ;;
esac
`
  )
  chmodSync(bin, 0o755)
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n') }
}

const turn = (signal = new AbortController().signal): Turn => ({ model: 'openai/gpt-5.6-luna', effort: 'low', system: 's', prompt: 'Diga só: oi', cwd: tmpdir(), signal })
const collect = async (it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// These start real processes (the fake opencode, its server): give them room on a busy machine.
describe('the OpenCode engine on V2', () => {
  it("takes the turn's usage from the export and deletes the session", async () => {
    const oc = fakeOpencode()
    const events = await collect(opencodeEngine(() => oc.bin, mkdtempSync(join(tmpdir(), 'oc2-app-')), async () => ({}), () => '2.2.0').run(turn()))
    expect(events.at(-1)).toEqual({ type: 'done', text: 'oi', usage: { inputTokens: 403, cacheReadTokens: 0, outputTokens: 5 } })
    const [serve, run, exported, deleted] = oc.calls()
    const session = /--session (\S+)/.exec(run!)![1]!
    expect(serve).toMatch(/^serve --hostname 127\.0\.0\.1 --port 0/)
    expect(run).toContain('run --server http://127.0.0.1:9')
    expect(run).toContain('claude=1')
    expect(exported).toMatch(new RegExp(`^session export ${session} --server http://127.0.0.1:9`))
    expect(deleted).toMatch(new RegExp(`^session delete ${session} --server http://127.0.0.1:9`))
  }, 20_000)

  it('counts what a stopped turn used and still deletes its session', async () => {
    const oc = fakeOpencode({ hang: true })
    const stop = new AbortController()
    // Stopped once the reply is under way (its first text), however long the start took.
    const events: EngineEvent[] = []
    for await (const ev of opencodeEngine(() => oc.bin, mkdtempSync(join(tmpdir(), 'oc2-app-')), async () => ({}), () => '2.2.0').run(turn(stop.signal))) {
      events.push(ev)
      if (ev.type === 'text') stop.abort()
    }
    expect(events.find((e) => e.type === 'done' || e.type === 'error')).toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'progress', tokens: 408, cacheRead: 0 })
    expect(oc.calls().map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['serve --hostname', 'run --server', 'session export', 'session delete'])
  }, 20_000)

  it('keeps running V1 the way it always did', async () => {
    const oc = fakeOpencode()
    await collect(opencodeEngine(() => oc.bin, mkdtempSync(join(tmpdir(), 'oc2-app-')), async () => ({}), () => '1.15.10').run(turn()))
    const calls = oc.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('run --pure')
    expect(calls[0]).not.toContain('--session')
  }, 20_000)
})
