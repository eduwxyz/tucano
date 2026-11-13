import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexAppInput, codexAppParser, KEEP_IDLE_MS, leftThreads, MAX_IDLE } from '../src/core/engines/codex-app'
import { CODEX_DISABLED_FEATURES, codexAppArgs, codexEngine, codexIsolated, codexQuota, codexThread } from '../src/core/engines/codex'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'

const isWin = process.platform === 'win32'

// Recorded from `codex app-server` 0.153.4 (gpt-5.6-luna, low): one turn that calls a gateway tool,
// then answers, streamed in deltas. Local paths trimmed.
const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'codex-app-turn.jsonl'), 'utf8').split('\n').filter(Boolean)
const feed = (lines: string[], exit = 0, stderr = ''): EngineEvent[] => {
  const p = codexAppParser()
  return [...lines.flatMap((l) => p.line(l)), ...p.end(exit, stderr)]
}
const textOf = (events: EngineEvent[]): string => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
const n = (method: string, params: Record<string, unknown>): string => JSON.stringify({ method, params: { threadId: 't', turnId: 'u', ...params } })

describe('Codex app-server stream', () => {
  it('streams the text as it comes and reports the turn usage', () => {
    const events = feed(fixture)
    const deltas = events.filter((e) => e.type === 'text')
    expect(deltas.length).toBeGreaterThan(50) // word by word, not one chunk at the end
    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 21916, cacheReadTokens: 6016, outputTokens: 422 }, context: 7971 + 259 })
    expect(textOf(events)).toBe(done?.type === 'done' ? done.text : '')
    expect(textOf(events)).toMatch(/^pong-42; tools: /)
    const progress = events.flatMap((e) => (e.type === 'progress' ? [e.tokens] : []))
    expect(progress).toEqual([6253, 14108, 22338])
    // The rate limits it reports aren't the ones the app shows (those are Claude's): none go out.
    expect(events.some((e) => e.type === 'error' || e.type === 'quota')).toBe(false)
  })

  it("counts only this turn's tokens on a thread that had turns before", () => {
    const usage = (total: number, last: number): string => n('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: total, cachedInputTokens: 0, outputTokens: 0 }, last: { inputTokens: last, cachedInputTokens: 0, outputTokens: 0 } } })
    const events = feed([usage(5000, 1200), usage(6500, 1500), n('turn/completed', { turn: { id: 'u', status: 'completed' } })])
    expect(events.flatMap((e) => (e.type === 'progress' ? [e.tokens] : []))).toEqual([1200, 2700])
    expect(events.find((e) => e.type === 'done')).toMatchObject({ usage: { inputTokens: 2700 }, context: 1500 })
  })

  it('keeps each agent message its own paragraph, and takes one that came whole', () => {
    const events = feed([
      n('item/agentMessage/delta', { itemId: 'a', delta: 'Vou ver.' }),
      n('item/completed', { item: { type: 'agentMessage', id: 'a', text: 'Vou ver.' } }),
      n('item/completed', { item: { type: 'agentMessage', id: 'b', text: 'Pronto.' } }),
      n('turn/completed', { turn: { id: 'u', status: 'completed' } })
    ])
    expect(textOf(events)).toBe('Vou ver.\n\nPronto.')
    expect(events.find((e) => e.type === 'done')).toMatchObject({ text: 'Vou ver.\n\nPronto.' })
  })

  it('reports web searches and page reads', () => {
    const item = (action: object): string => n('item/completed', { item: { type: 'webSearch', id: 'w', query: '', action } })
    expect(feed([item({ type: 'search', query: 'electron release', queries: null }), item({ type: 'openPage', url: 'https://electronjs.org' })]).filter((e) => e.type === 'web')).toEqual([
      { type: 'web', action: 'search', detail: 'electron release' },
      { type: 'web', action: 'fetch', detail: 'https://electronjs.org' }
    ])
  })

  it('turns a failed turn, or an error it gives up on, into an error event', () => {
    const failed = feed([n('turn/completed', { turn: { id: 'u', status: 'failed', error: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } })])
    expect(failed).toEqual([{ type: 'error', message: "You've hit your usage limit." }])
    const retried = feed([n('error', { willRetry: true, error: { message: 'Reconnecting... 1/5' } }), n('turn/completed', { turn: { id: 'u', status: 'completed' } })])
    expect(retried.some((e) => e.type === 'error')).toBe(false)
    expect(feed([n('error', { willRetry: false, error: { message: 'stream disconnected' } })])).toEqual([{ type: 'error', message: 'stream disconnected' }])
    // stopped on purpose: nothing to report
    expect(feed([n('turn/completed', { turn: { id: 'u', status: 'interrupted' } })])).toEqual([])
    expect(feed([], 1, 'boom')).toEqual([{ type: 'error', message: expect.stringMatching(/boom/) }])
  })

  it('sends each image right after the message it came with', () => {
    const png = join(mkdtempSync(join(tmpdir(), 'ca-img-')), 'tela.png')
    writeFileSync(png, 'x')
    const input = codexAppInput({ prompt: 'a\n\nb', blocks: ['a', 'b'], images: [{ block: 0, path: png, mime: 'image/png' }, { block: 1, path: '/nao/existe.png', mime: 'image/png' }] })
    expect(input).toEqual([
      { type: 'text', text: 'a', text_elements: [] },
      { type: 'localImage', path: png },
      { type: 'text', text: 'b', text_elements: [] }
    ])
    expect(codexAppInput({ prompt: 'oi' })).toEqual([{ type: 'text', text: 'oi', text_elements: [] }])
  })
})

describe('Codex app-server isolation', () => {
  it('turns off every built-in tool exec does, read-only with no approvals, no skills or project docs', () => {
    const args = codexAppArgs()
    expect(args[0]).toBe('app-server')
    for (const f of CODEX_DISABLED_FEATURES) expect(args[args.indexOf(f) - 1]).toBe('--disable')
    expect(args).toEqual(
      expect.arrayContaining(['sandbox_mode="read-only"', 'approval_policy="never"', 'skills.include_instructions=false', 'skills.bundled.enabled=false', 'project_doc_max_bytes=0', 'history.persistence="none"', 'mcp_optional_startup_grace_ms=0', 'include_permissions_instructions=false'])
    )
  })

  it("gives each thread its folder, model and gateway, the gateway's address only over stdin", () => {
    const url = 'http://127.0.0.1:1/mcp/' + 'a'.repeat(48)
    const t = codexThread({ model: 'gpt-5.6-luna', effort: 'low', system: 'Você é Theo.', cwd: '/tmp/x', mcpUrl: url })
    expect(t).toEqual({
      model: 'gpt-5.6-luna',
      cwd: '/tmp/x',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      developerInstructions: expect.stringMatching(/^Você é Theo\.\n\nO sandbox do próprio Codex aqui é vazio de propósito e não limita as suas ferramentas\. Nunca diga que a sessão é só leitura/), // with the app's tools
      config: { model_reasoning_effort: 'low', web_search: 'disabled', 'mcp_servers.tucano': { url, default_tools_approval_mode: 'approve', tool_timeout_sec: 900 } }
    })
    expect(codexAppArgs(['-c', 'model_provider="corp"']).join(' ')).not.toContain('/mcp/')
    expect(codexThread({ model: 'm', effort: 'low', system: 'x', cwd: '/tmp/x', web: true }).config).toEqual({ model_reasoning_effort: 'low', web_search: 'live' })
    // the same note exec gets, for an agent with a computer
    expect(codexThread({ model: 'm', effort: 'low', system: 'Use write_file on /work.', cwd: '/tmp/x', mcpUrl: url }).developerInstructions).toMatch(/apply_patch/)
  })

  it('is isolated only in a home with no config.toml and no rules of its own', () => {
    const h = mkdtempSync(join(tmpdir(), 'ca-home-'))
    expect(codexIsolated(h)).toBe(true)
    writeFileSync(join(h, 'config.toml'), 'model = "x"\n')
    expect(codexIsolated(h)).toBe(false)
    const r = mkdtempSync(join(tmpdir(), 'ca-home-'))
    mkdirSync(join(r, 'rules'))
    expect(codexIsolated(r)).toBe(false)
  })
})

describe('Codex app-server process', () => {
  let dir: string
  let bin: string
  let home: string
  let logFile: string
  let engine: Engine | undefined
  const env = { ...process.env }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ca-cli-'))
    home = join(dir, 'home')
    mkdirSync(join(home, '.codex'), { recursive: true })
    logFile = join(dir, 'log.jsonl')
    process.env['FAKE_CODEX_LOG'] = logFile
    const script = join(dir, 'fake-codex.mjs')
    copyFileSync(join(import.meta.dirname, 'fixtures', 'fake-codex.mjs'), script)
    if (isWin) {
      bin = join(dir, 'codex.cmd')
      writeFileSync(bin, `@"${process.execPath}" "%~dp0\\fake-codex.mjs" %*\r\n`)
    } else {
      bin = join(dir, 'codex')
      writeFileSync(bin, `#!/usr/bin/env node\n${readFileSync(script, 'utf8')}`)
      chmodSync(bin, 0o755)
    }
  })
  afterEach(() => {
    engine?.dispose?.()
    engine = undefined
    process.env = { ...env }
  })

  const make = (): Engine => (engine = codexEngine(() => bin, home, async () => ({}), async () => ({ config: [], envNames: [] })))
  const collect = async (events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
    const out: EngineEvent[] = []
    for await (const e of events) out.push(e)
    return out
  }
  const reply = (events: EngineEvent[]): string => events.flatMap((e) => (e.type === 'done' ? [e.text] : e.type === 'error' ? [`ERROR ${e.message}`] : [])).join('')
  const field = (s: string, k: string): string => new RegExp(`${k}=(\\S+)`).exec(s)?.[1] ?? ''
  const requests = (): { pid: number; method?: string; params?: Record<string, unknown>; argv?: string[]; exec?: string[] }[] =>
    existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const cwd = (): string => {
    const c = join(dir, 'agents', 'a1')
    mkdirSync(c, { recursive: true })
    return c
  }
  const turn = (id: string | undefined, resume: boolean, prompt = 'oi', signal = new AbortController().signal): Turn => ({
    model: 'gpt-5.6-luna',
    effort: 'low',
    system: 'x',
    prompt,
    blocks: [prompt],
    cwd: cwd(),
    mcpUrl: 'http://127.0.0.1:1/mcp/' + 'a'.repeat(48),
    signal,
    ...(id ? { session: { id, resume, keep: true } } : {})
  })
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50))
  }

  it('goes on in the same thread of the same process, with only the new message', async () => {
    const e = make()
    expect(e.sessions).toBe(true)
    const one = reply(await collect(e.run(turn('s1', false, 'primeira'))))
    const two = reply(await collect(e.run(turn('s1', true, 'segunda'))))
    expect(field(two, 'pid')).toBe(field(one, 'pid'))
    expect(field(two, 'thread')).toBe(field(one, 'thread'))
    expect(two).toMatch(/turn=2 resumed=false/)
    const starts = requests().filter((r) => r.method === 'turn/start')
    expect(starts.map((r) => (r.params!['input'] as { text: string }[])[0]!.text)).toEqual(['primeira', 'segunda'])
    // isolated as exec is, and the gateway's token never in the arguments
    const argv = requests().find((r) => r.argv)!.argv!
    expect(argv).toEqual(codexAppArgs())
    expect(argv.join(' ')).not.toContain('/mcp/')
    const start = requests().find((r) => r.method === 'thread/start')!.params!
    expect(start).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false, cwd: cwd() })
  }, 20_000)

  it('past the cap of waiting threads, unloads the oldest; its next turn resumes it from disk', async () => {
    const e = make()
    const first = reply(await collect(e.run(turn('s0', false))))
    for (let i = 1; i <= MAX_IDLE; i++) await collect(e.run(turn(`s${i}`, false)))
    await until(() => requests().some((r) => r.method === 'thread/unsubscribe'))
    const again = reply(await collect(e.run(turn('s0', true))))
    expect(field(again, 'pid')).toBe(field(first, 'pid')) // the same process
    expect(again).toMatch(/turn=1 resumed=true/)
    expect(KEEP_IDLE_MS).toBeGreaterThan(0)
  }, 20_000)

  it('never unloads a thread in the middle of its turn, warmed again or past the cap', async () => {
    const e = make()
    await collect(e.run(turn('s0', false)))
    const long = collect(e.run(turn('s0', true, 'demore')))
    await until(() => requests().filter((r) => r.method === 'turn/start').length === 2)
    e.rewarm!('s0')
    for (let i = 1; i <= MAX_IDLE + 1; i++) await collect(e.run(turn(`s${i}`, false)))
    expect(reply(await long)).toMatch(/turn=2 resumed=false/)
    const thread = (r: { params?: Record<string, unknown> }): unknown => r.params?.['threadId']
    const s0 = thread(requests().find((r) => r.method === 'turn/start')!)
    expect(requests().filter((r) => r.method === 'thread/unsubscribe').map(thread)).not.toContain(s0)
  }, 20_000)

  it('resumes a thread in a new process when its process is gone, and deletes it on release', async () => {
    const e = make()
    const first = reply(await collect(e.run(turn('s1', false))))
    process.kill(Number(field(first, 'pid')))
    await until(() => requests().some((r) => r.method === 'thread/start') && !isAlive(Number(field(first, 'pid'))))
    const again = reply(await collect(e.run(turn('s1', true))))
    expect(field(again, 'pid')).not.toBe(field(first, 'pid'))
    expect(field(again, 'thread')).toBe(field(first, 'thread'))
    expect(again).toMatch(/resumed=true/)
    const sessions = join(home, '.codex', 'sessions')
    expect(leftThreads(join(home, '.codex')).map((t) => t.id)).toEqual([field(first, 'thread')])
    e.release!('s1')
    await e.settle!()
    expect(leftThreads(join(home, '.codex'))).toEqual([])
    expect(existsSync(sessions)).toBe(true)
  }, 20_000)

  it('interrupts a stopped turn and lets its thread go', async () => {
    const e = make()
    const stop = new AbortController()
    const running = collect(e.run(turn('s1', false, 'demore', stop.signal)))
    await until(() => requests().some((r) => r.method === 'turn/start'))
    const t0 = Date.now()
    stop.abort()
    const cut = await running
    expect(Date.now() - t0).toBeLessThan(2000) // it doesn't wait the 5 s
    expect(cut.some((x) => x.type === 'done' || x.type === 'error')).toBe(false)
    await until(() => requests().some((r) => r.method === 'thread/unsubscribe'))
    expect(requests().some((r) => r.method === 'turn/interrupt')).toBe(true)
    expect(requests().some((r) => r.method === 'thread/unsubscribe')).toBe(true)
  }, 20_000)

  it('starts a thread of its own, not on disk, ahead of a turn with no session, and uses it', async () => {
    const e = make()
    const t = turn(undefined, false)
    const { prompt: _p, blocks: _b, signal: _s, ...shape } = t
    e.warm!(shape)
    await until(() => requests().some((r) => r.method === 'thread/start'))
    const warmed = requests().find((r) => r.method === 'thread/start')!
    expect(warmed.params!['ephemeral']).toBe(true)
    const out = reply(await collect(e.run(t)))
    expect(out).toMatch(/turn=1/)
    expect(requests().filter((r) => r.method === 'thread/start')).toHaveLength(1) // the warmed one
    expect(leftThreads(join(home, '.codex'))).toEqual([])
  }, 20_000)

  it('goes to exec, with no sessions, on a CLI without the app-server', async () => {
    process.env['FAKE_CODEX_OLD'] = '1'
    const e = make()
    expect(e.sessions).toBe(true) // not known yet
    const out = reply(await collect(e.run(turn('s1', false))))
    expect(out).toMatch(/^exec pid=/)
    expect(e.sessions).toBe(false)
    expect(reply(await collect(e.run(turn(undefined, false))))).toMatch(/^exec pid=/)
  }, 20_000)

  it('goes to exec in a home with a config of its own, which the app-server would read', async () => {
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n')
    const e = make()
    expect(e.sessions).toBe(false)
    expect(reply(await collect(e.run(turn(undefined, false))))).toMatch(/^exec pid=/)
    expect(requests().some((r) => r.argv)).toBe(false)
  }, 20_000)

  it("reads the subscription's windows from a short-lived app-server, and lets it go", async () => {
    const q = await make().planUsage!()
    expect(q).toMatchObject({ plan: 'plus', windows: [{ minutes: 10_080, utilization: 0.09, resetsAt: 1794567151000 }] })
    expect(requests().some((r) => r.method === 'account/rateLimits/read')).toBe(true)
  })

  it("cleans the threads an earlier run left, of the agents' folders only", async () => {
    const day = join(home, '.codex', 'sessions', '2026', '11', '06')
    mkdirSync(day, { recursive: true })
    const left = (id: string, folder: string): string => {
      const f = join(day, `rollout-2026-11-06T10-00-00-${id}.jsonl`)
      writeFileSync(f, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: folder } })}\n`)
      return f
    }
    const mine = left('0f8fad5b-d9cb-469f-a165-70867728950e', join(dir, 'agents', 'a1'))
    const other = left('1f8fad5b-d9cb-469f-a165-70867728950e', join(dir, 'agents-backup', 'x'))
    const e = make()
    e.clean!(join(dir, 'agents'))
    await e.settle!()
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(readdirSync(day)).toHaveLength(1)
  }, 20_000)
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Codex subscription windows', () => {
  it('reads each window, shortest first, as a fraction, with its reset in ms', () => {
    const r = { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2000 }, secondary: { usedPercent: 120, windowDurationMins: 300, resetsAt: 1000 }, planType: 'pro' } }
    expect(codexQuota(r, 5)).toEqual({ windows: [{ minutes: 300, utilization: 1, resetsAt: 1_000_000 }, { minutes: 10_080, utilization: 0.4, resetsAt: 2_000_000 }], plan: 'pro', at: 5 })
  })

  it('has nothing to say with no windows (an API key) or an answer it does not know', () => {
    expect(codexQuota({ rateLimits: { primary: null, secondary: null } })).toBeUndefined()
    expect(codexQuota({ rateLimits: { primary: { usedPercent: '9' } } })).toBeUndefined()
    expect(codexQuota(undefined)).toBeUndefined()
  })
})
