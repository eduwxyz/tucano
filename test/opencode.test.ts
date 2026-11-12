import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, type Parser } from '../src/core/engines/cli'
import { OPENCODE_ERROR_WAIT_MS, opencodeArgs, opencodeConfig, opencodeEngine, opencodeParser, opencodeStreamError, stripJsonComments, userOpencodeProviders } from '../src/core/engines/opencode'
import type { EngineEvent } from '../src/core/engines/types'

// Lines recorded from `opencode run --format json` (1.15), trimmed.
const STEP = '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":222,"input":204,"output":18,"reasoning":0,"cache":{"write":0,"read":0}}}}'
const TOOL = '{"type":"tool_use","part":{"type":"tool","tool":"webfetch","state":{"status":"completed","input":{"url":"https://example.com"},"output":"..."}}}'
const TEXT = '{"type":"text","part":{"type":"text","text":"São 13:37 no Tucano."}}'
const LAST = '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":306,"input":200,"output":60,"reasoning":10,"cache":{"write":0,"read":46}}}}'
const ERROR = '{"type":"error","error":{"name":"APIError","data":{"message":"Model not found: openai/gpt-9"}}}'

describe('opencode', () => {
  it('turns its events into the engine events', () => {
    const p = opencodeParser()
    const events = [STEP, TOOL, TEXT, LAST].flatMap((l) => p.line(l))
    expect(events).toContainEqual({ type: 'web', action: 'fetch', detail: 'https://example.com' })
    expect(events).toContainEqual({ type: 'text', delta: 'São 13:37 no Tucano.' })
    expect(p.end(0, '')).toEqual([{ type: 'done', text: 'São 13:37 no Tucano.', usage: { inputTokens: 450, cacheReadTokens: 46, outputTokens: 88 } }])
  })

  it('reports the first error and nothing else', () => {
    const p = opencodeParser()
    expect(p.line(ERROR)).toEqual([{ type: 'error', message: 'Model not found: openai/gpt-9' }])
    expect(p.line('{"type":"error","error":{"name":"UnknownError"}}')).toEqual([])
    expect(p.end(0, '')).toEqual([])
  })

  it('gives it only the gateway tools, read in its own folder, the web when allowed, and the system prompt', () => {
    const c = opencodeConfig({ system: 'Você é a Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }, { provider: { acme: {} } })
    // `read` keeps the free models (opencode/…-free) working; outside the turn's folder it's denied.
    expect(c['tools']).toEqual({ '*': false, read: true, 'tucano_*': true, webfetch: false, websearch: false })
    expect(c['permission']).toEqual({ read: 'allow', external_directory: 'deny' })
    expect(c['mcp']).toEqual({ tucano: { type: 'remote', url: 'http://127.0.0.1:1/mcp/x', enabled: true } })
    expect(c['agent']).toEqual({ tucano: { mode: 'primary', prompt: 'Você é a Iris.' } })
    expect(c['provider']).toEqual({ acme: {} })
    expect(opencodeArgs({ model: 'openai/gpt-5.6-luna' })).toEqual(['run', '--print-logs', '--log-level', 'ERROR', '--pure', '--format', 'json', '--agent', 'tucano', '-m', 'openai/gpt-5.6-luna'])
  })

  it('accumulates the cost V2 reports per step', () => {
    const p = opencodeParser()
    const withCost = '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.0005,"tokens":{"total":222,"input":204,"output":18,"reasoning":0,"cache":{"write":0,"read":0}}}}'
    p.line(withCost)
    const [done] = p.end(0, '')
    expect(done).toMatchObject({ usage: { apiCostUsd: 0.0005 } })
  })

  it('still ends done when V2 emits no step_finish at all', () => {
    const p = opencodeParser()
    p.line(TEXT)
    expect(p.end(0, '')).toEqual([{ type: 'done', text: 'São 13:37 no Tucano.', usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } }])
  })

  it("takes only the providers from the user's opencode.jsonc", () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode.jsonc'), '{\n  // a comment\n  "provider": { "acme": { "options": { "baseURL": "https://llm.acme.com/v1" } } },\n  "mcp": { "x": {} },\n  "instructions": ["a.md"],\n}\n')
    expect(userOpencodeProviders(dir)).toEqual({ provider: { acme: { options: { baseURL: 'https://llm.acme.com/v1' } } } })
    expect(stripJsonComments('{"url": "http://x//y" /* c */}')).toBe('{"url": "http://x//y" }')
  })

  it("takes V2's providers shape too, for V2 only, and only the policies about providers", () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'))
    const providers = { empresa: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'https://llm.acme.com/v1' } } }
    const policies = [{ action: 'provider.use', resource: 'empresa', effect: 'allow' }, { action: 'tool.use', resource: 'shell', effect: 'allow' }]
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ provider: { acme: {} }, providers, policies, mcp: { servers: {} } }))
    expect(userOpencodeProviders(dir, true)).toEqual({ provider: { acme: {} }, providers, policies: [policies[0]] })
    expect(userOpencodeProviders(dir)).toEqual({ provider: { acme: {} } })
  })

  // A free model (opencode/…-free) refused (past its limit, or a call without `read`): `run` only logs
  // the error and never exits, and the reply showed "Pensando" for good. Recorded from 1.19.5.
  const FREE = 'timestamp=2026-11-09T23:28:02.867Z level=ERROR run=e5f8ebd9 message="stream error" providerID=opencode modelID=deepseek-v4.1-flash-free session.id=ses_e3d5 small=false agent=tucano mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"'

  it('reads a failed model call from its log line: a free model refused ends the turn at once, with what to do', () => {
    const f = opencodeStreamError(FREE)!
    expect(f.waitMs).toBe(0)
    expect(f.message).toContain('O OpenCode recusou o modelo grátis')
    expect(f.message).toContain('Free usage limit reached')
    expect(opencodeParser().stderr).toBe(opencodeStreamError)
  })

  it('gives any other failed call time to be retried, and ignores the other log lines', () => {
    expect(opencodeStreamError('level=ERROR message="stream error" error.error="AI_APICallError: Overloaded"')).toEqual({ message: 'O modelo falhou no OpenCode: Overloaded', waitMs: OPENCODE_ERROR_WAIT_MS })
    expect(opencodeStreamError('level=INFO message="stream" providerID=opencode')).toBeUndefined()
    expect(opencodeStreamError('level=ERROR message="failed to run data migrations"')).toBeUndefined()
  })
})

// The CLI here is a shell line (echo, sleep), which Windows doesn't run.
describe.skipIf(process.platform === 'win32')('runCli with an error on stderr', () => {
  const collect = async (script: string, parser: Parser): Promise<{ events: EngineEvent[]; ms: number }> => {
    const start = Date.now()
    const events: EngineEvent[] = []
    for await (const ev of runCli({ bin: '/bin/sh', args: ['-c', script], stdin: '', cwd: tmpdir(), signal: new AbortController().signal, parser })) events.push(ev)
    return { events, ms: Date.now() - start }
  }
  const parser = (waitMs: number): Parser => ({
    line: (l) => [{ type: 'text', delta: l }],
    end: (code) => [{ type: 'done', text: `saiu ${code}`, usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } }],
    stderr: (l) => (l.includes('FALHOU') ? { message: 'o modelo falhou', waitMs } : undefined)
  })

  it('stops a CLI that logs it and hangs, with that error', async () => {
    const { events, ms } = await collect('echo FALHOU >&2; sleep 30', parser(0))
    expect(events).toEqual([{ type: 'error', message: 'o modelo falhou' }])
    expect(ms).toBeLessThan(5_000)
  })

  it('lets it go on when output comes after the error (a retry that worked)', async () => {
    const { events } = await collect('echo FALHOU >&2; sleep 0.05; echo resposta; sleep 0.3', parser(200))
    expect(events).toEqual([{ type: 'text', delta: 'resposta' }, { type: 'done', text: 'saiu 0', usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } }])
  })
})

// OpenCode takes its folder from PWD, not from the process's cwd: with the app's own PWD (`/` when
// opened from the Finder), `read` could go anywhere under it.
describe.skipIf(process.platform === 'win32')('opencode engine', () => {
  it('runs in the turn\'s folder, PWD included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-pwd-'))
    const bin = join(dir, 'opencode')
    // Node, as OpenCode's runtime, takes PWD as it comes (a shell would fix it up).
    writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({ type: 'text', part: { type: 'text', text: process.env.PWD } }))\n`)
    chmodSync(bin, 0o755)
    const cwd = join(dir, 'agent')
    mkdirSync(cwd)
    const prev = process.env['PWD']
    process.env['PWD'] = '/'
    const events: EngineEvent[] = []
    try {
      for await (const ev of opencodeEngine(() => bin, join(dir, 'home'), async () => ({}), () => '1.19.5').run({ model: 'opencode/x-free', effort: 'low', system: '', prompt: 'oi', cwd, signal: new AbortController().signal })) events.push(ev)
    } finally {
      process.env['PWD'] = prev
    }
    const done = events.find((e) => e.type === 'done')
    expect(done?.type === 'done' && done.text).toBe(cwd)
  })
})

