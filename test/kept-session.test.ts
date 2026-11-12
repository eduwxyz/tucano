import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { claudeArgs, claudeEngine, claudeInput, claudeParser, claudeProjectDir, MAX_IDLE } from '../src/core/engines/claude'
import { LiveCli } from '../src/core/engines/cli'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { Gateway, textResult, type ToolDef } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { SESSION_MAX_CONTEXT, SESSION_TTL_MS, sessionConfig, Sessions, type Shown } from '../src/core/sessions'

const ready = { installed: true, loggedIn: true }
const isWin = process.platform === 'win32'

// ---------- the store ----------

describe('Sessions', () => {
  let now = 1_000
  let forgot: string[] = []
  let gone = new Set<string>()
  const store = (): Sessions => new Sessions({ exists: (id) => !gone.has(id), forget: (s) => void forgot.push(s.id), now: () => now })
  const msgs = (...ids: string[]): Shown[] => ids.map((id) => ({ id, block: `[Edu]\n${id}` }))
  const cfg = sessionConfig({ system: 'a', tools: [] })

  beforeEach(() => {
    now = 1_000
    forgot = []
    gone = new Set()
  })

  // A first reply over m1, m2; the agent answers r1.
  const started = (s: Sessions) => {
    const p = s.begin('k', { config: cfg, shown: msgs('m1', 'm2') })!
    s.end('k', p, { ok: true, config: cfg, shown: msgs('m1', 'm2'), reply: 'r1', context: 1_000 })
    return p
  }

  it('starts with everything, then goes on with only what came after its last reply', () => {
    const s = store()
    const first = started(s)
    expect(first).toMatchObject({ resume: false, send: ['m1', 'm2'] })
    const next = s.begin('k', { config: cfg, shown: [...msgs('m1', 'm2'), { id: 'r1', block: '[Lia]\nresposta' }, ...msgs('m3', 'm4')] })
    expect(next).toEqual({ id: first.id, token: first.token, resume: true, send: ['m3', 'm4'], live: false })
  })

  it('goes on when only the live context changed, and sends it again only then', () => {
    const s = store()
    const p = s.begin('k', { config: cfg, shown: msgs('m1'), live: 'memórias: A' })!
    s.end('k', p, { ok: true, config: cfg, shown: msgs('m1'), live: 'memórias: A', reply: 'r1', context: 1_000 })
    expect(s.begin('k', { config: cfg, shown: [...msgs('m1'), { id: 'r1', block: 'x' }, ...msgs('m2')], live: 'memórias: A' })).toMatchObject({ id: p.id, resume: true, live: false })
    s.end('k', p, { ok: true, config: cfg, shown: msgs('m1', 'm2'), live: 'memórias: A', reply: 'r2', context: 1_000 })
    expect(s.begin('k', { config: cfg, shown: [...msgs('m1'), { id: 'r1', block: 'x' }, ...msgs('m2'), { id: 'r2', block: 'x' }, ...msgs('m3')], live: 'memórias: A, B' })).toMatchObject({ id: p.id, resume: true, send: ['m3'], live: true })
    expect(forgot).toEqual([])
  })

  it('goes on after older messages leave the window', () => {
    const s = store()
    started(s)
    expect(s.begin('k', { config: cfg, shown: [{ id: 'r1', block: 'x' }, ...msgs('m3')] })).toMatchObject({ resume: true, send: ['m3'] })
  })

  it('starts over, letting the old one go, when anything it saw changed', () => {
    const cases: [string, (s: Sessions) => ReturnType<Sessions['begin']>][] = [
      ['another system prompt or tools', (s) => s.begin('k', { config: sessionConfig({ system: 'b', tools: [] }), shown: msgs('m1', 'm2', 'm3') })],
      ['a message edited', (s) => s.begin('k', { config: cfg, shown: [{ id: 'm1', block: '[Edu]\nmudou' }, ...msgs('m2', 'm3')] })],
      ['a message turning up in between', (s) => s.begin('k', { config: cfg, shown: msgs('m1', 'mx', 'm2', 'm3') })],
      ['a message deleted', (s) => ((gone = new Set(['m1'])), s.begin('k', { config: cfg, shown: msgs('m2', 'm3') }))],
      ['the cache gone', (s) => ((now += SESSION_TTL_MS + 1), s.begin('k', { config: cfg, shown: msgs('m1', 'm2', 'm3') }))],
      ['"try again"', (s) => s.begin('k', { config: cfg, shown: msgs('m1', 'm2', 'm3'), restart: true })],
      ['nothing new to send', (s) => s.begin('k', { config: cfg, shown: msgs('m1', 'm2') })]
    ]
    for (const [why, next] of cases) {
      forgot = []
      gone = new Set()
      now = 1_000
      const s = store()
      const first = started(s)
      const p = next(s)
      expect(p?.resume, why).toBe(false)
      expect(p?.id, why).not.toBe(first.id)
      expect(forgot, why).toEqual([first.id])
    }
  })

  it('goes on with nothing new when the reply has a task (an approval, a routine)', () => {
    const s = store()
    started(s)
    expect(s.begin('k', { config: cfg, shown: msgs('m1', 'm2'), task: true })).toMatchObject({ resume: true, send: [] })
  })

  it('starts over once it has grown past what a fresh start costs', () => {
    const s = store()
    const p = s.begin('k', { config: cfg, shown: msgs('m1') })!
    s.end('k', p, { ok: true, config: cfg, shown: msgs('m1'), reply: 'r1', context: SESSION_MAX_CONTEXT + 1 })
    expect(s.begin('k', { config: cfg, shown: msgs('m1', 'm2') })?.resume).toBe(false)
  })

  it('lets a session go when its reply didn’t end well', () => {
    const s = store()
    const first = started(s)
    const p = s.begin('k', { config: cfg, shown: msgs('m1', 'm2', 'm3') })!
    s.end('k', p, { ok: false, config: cfg, shown: msgs('m1', 'm2', 'm3') })
    expect(forgot).toEqual([first.id])
    expect(s.has('k')).toBe(false)
    // and a new one that never got a good reply is let go too
    const q = s.begin('k', { config: cfg, shown: msgs('m1') })!
    s.end('k', q, { ok: false, config: cfg, shown: msgs('m1') })
    expect(forgot).toEqual([first.id, q.id])
  })

  it('gives no session to a second reply while the first one runs', () => {
    const s = store()
    expect(s.begin('k', { config: cfg, shown: msgs('m1') })).toBeDefined()
    expect(s.begin('k', { config: cfg, shown: msgs('m1') })).toBeUndefined()
    expect(s.begin('other', { config: cfg, shown: msgs('m1') })).toBeDefined()
  })

  it('lets an archived agent’s or a deleted conversation’s sessions go, a running one when it ends', () => {
    const s = store()
    const idle = started(s)
    const p = s.begin('a1:c2:', { config: cfg, shown: msgs('m1') })!
    s.dropWhere((key) => key === 'k' || key.startsWith('a1:'))
    expect(forgot).toEqual([idle.id])
    s.end('a1:c2:', p, { ok: true, config: cfg, shown: msgs('m1'), reply: 'r1' })
    expect(forgot).toEqual([idle.id, p.id])
    expect(s.has('a1:c2:')).toBe(false)
  })

  it('sweeps the ones past the cache', () => {
    const s = store()
    const first = started(s)
    now += SESSION_TTL_MS + 1
    s.sweep()
    expect(forgot).toEqual([first.id])
  })
})

// ---------- the runner, with a fake engine that takes sessions ----------

function agent(id: string, handle: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }
}

describe('a reply with a kept session', () => {
  let db: Db
  let settings: Settings
  let turns: Turn[]
  let released: string[]

  const recorded = (e: Engine): Engine => ({ ...e, run: (t) => (turns.push(t), e.run(t)) })
  function runner(opts: { delayMs?: number; reply?: (t: Turn) => string; sessions?: boolean } = {}): Runner {
    const claude = recorded(fakeEngine('claude', { delayMs: opts.delayMs ?? 1, reply: opts.reply, sessions: opts.sessions ?? true, released }))
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
    return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ks-work-')) })
  }
  const agentMessages = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

  beforeEach(() => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ks-db-')), 'test.db'))
    turns = []
    released = []
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(agent('a1', 'lia'))
    db.saveAgent(agent('a2', 'theo'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] })
  })

  it('sends the whole conversation once, then only the new message', async () => {
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'e o job de ontem?')
    await r.idle()

    const [first, second] = turns
    expect(first!.session).toMatchObject({ resume: false, keep: true })
    expect(first!.blocks!.some((b) => b.includes('oi'))).toBe(true)
    expect(second!.session).toEqual({ id: first!.session!.id, resume: true, keep: true })
    expect(second!.blocks).toHaveLength(1)
    expect(second!.blocks![0]).toMatch(/^\[Edu · .*\]\ne o job de ontem\?$/)
    expect(second!.prompt).not.toContain('Resposta de teste') // its own reply is in the session already
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('keeps one session per thread', async () => {
    db.createConversation({ id: 'c2', kind: 'channel', name: 'dados', members: ['a1'], threads: true })
    const r = runner()
    await r.send('c2', 'primeira')
    await r.idle()
    await r.send('c2', 'segunda')
    await r.idle()
    expect(turns[1]!.session!.resume).toBe(false)
    expect(turns[1]!.session!.id).not.toBe(turns[0]!.session!.id)
    const thread = agentMessages()[0]!.threadId!
    await r.send('c2', 'na thread', [], thread)
    await r.idle()
    expect(turns[2]!.session).toMatchObject({ id: turns[0]!.session!.id, resume: true })
  })

  it('starts over, letting the old one go, when the agent’s instructions change', async () => {
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    db.saveAgent(agent('a1', 'lia', { instructions: 'Responda em tópicos.' }))
    await r.send('d1', 'de novo')
    await r.idle()
    expect(turns[1]!.session!.resume).toBe(false)
    expect(released).toEqual([turns[0]!.session!.id])
    expect(turns[1]!.blocks!.some((b) => b.includes('oi'))).toBe(true)
  })

  it('starts over after a message it saw was edited', async () => {
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    const mine = db.messages().find((m) => m.author.kind === 'person')!
    db.saveMessage({ ...mine, text: 'olá' })
    await r.send('d1', 'de novo')
    await r.idle()
    expect(turns[1]!.session!.resume).toBe(false)
    expect(released).toEqual([turns[0]!.session!.id])
  })

  it('lets a stopped reply’s session go, and the next one starts over', async () => {
    const r = runner({ delayMs: 30, reply: () => 'uma resposta bem longa que demora pra chegar inteira' })
    await r.send('d1', 'oi')
    await new Promise((res) => setTimeout(res, 80))
    r.stop(agentMessages()[0]!.id)
    await r.idle()
    expect(released).toEqual([turns[0]!.session!.id])
    await r.send('d1', 'de novo')
    await r.idle()
    expect(turns[1]!.session!.resume).toBe(false)
    expect(turns[1]!.session!.id).not.toBe(turns[0]!.session!.id)
  })

  it('goes without a session while another agent is still writing what it would see', async () => {
    const r = runner()
    const half: Message = { id: 'm-theo', conversationId: 'c1', author: { kind: 'agent', id: 'a2' }, text: 'Estou olhando a tab', at: Date.now() - 1000, run: { status: 'working', depth: 1, steps: [] } }
    db.saveMessage(half)
    await r.send('c1', '@lia oi')
    await r.idle()
    expect(turns[0]!.session).toBeUndefined()
    // Once it's done, the next reply starts a session with all of it.
    db.saveMessage({ ...half, text: 'Estou olhando a tabela de vendas.', run: { status: 'done', depth: 1, steps: [] } })
    await r.send('c1', '@lia e agora?')
    await r.idle()
    expect(turns[1]!.session?.resume).toBe(false)
    expect(turns[1]!.blocks!.some((b) => b.includes('tabela de vendas'))).toBe(true)
  })

  it('lets the session go when its conversation is deleted or its agent archived', async () => {
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    r.forgetSessions({ conversationId: 'c1' })
    expect(released).toEqual([])
    r.forgetSessions({ agentId: 'a1' })
    expect(released).toEqual([turns[0]!.session!.id])
    await r.send('d1', 'de novo')
    await r.idle()
    expect(turns[1]!.session).toMatchObject({ resume: false })
  })

  it('finishes the reply when letting a session go fails', async () => {
    const claude = recorded(fakeEngine('claude', { delayMs: 1, sessions: true, released }))
    const failing: Engine = { ...claude, release: () => { throw new Error('EBUSY: resource busy or locked') } }
    const engines: Record<EngineId, Engine> = { claude: failing, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
    const r = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ks-work-')) })
    await r.send('d1', 'oi')
    await r.idle()
    db.saveAgent({ ...db.agent('a1')!, instructions: 'outra coisa' }) // the next reply starts over, letting the first go
    await r.send('d1', 'de novo')
    await r.idle()
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
    await r.send('d1', 'e agora?')
    await r.idle()
    expect(turns[2]!.session).toMatchObject({ resume: true }) // the key isn't stuck busy
  })

  it('gives an engine that takes no sessions the whole conversation every time', async () => {
    const r = runner({ sessions: false })
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'de novo')
    await r.idle()
    expect(turns.map((t) => t.session)).toEqual([undefined, undefined])
    expect(turns[1]!.blocks!.some((b) => b.includes('oi'))).toBe(true)
  })
})

// ---------- the gateway's URL for a kept session ----------

describe('a kept session’s gateway URL', () => {
  let gateway: Gateway
  beforeEach(async () => {
    gateway = new Gateway()
    await gateway.start()
  })
  afterEach(() => gateway.stop())

  const tool: ToolDef = { name: 'ask_user', description: 'x', inputSchema: { type: 'object', properties: {} } }
  async function connect(url: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    return client
  }

  it('stays the same across turns, refuses calls between them, and goes on release', async () => {
    const token = 'ab'.repeat(24)
    const a = gateway.open({ tools: [tool], call: async () => textResult('turn 1') }, token)
    a.close()
    const b = gateway.open({ tools: [tool], call: async () => textResult('turn 2') }, token)
    expect(b.url).toBe(a.url)
    const client = await connect(b.url)
    expect(await client.callTool({ name: 'ask_user', arguments: {} })).toMatchObject({ content: [{ text: 'turn 2' }] })
    b.close()
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ask_user'])
    expect(await client.callTool({ name: 'ask_user', arguments: {} })).toMatchObject({ isError: true })
    await client.close()
    gateway.release(token)
    expect((await fetch(b.url, { method: 'POST' })).status).toBe(404)
  })
})

// ---------- Claude Code's flags, input and output for a session ----------

describe('Claude Code with a session', () => {
  const base = { model: 'haiku', effort: 'low' as const, system: 'x' }

  it('starts it with its id, or resumes it, and saves it', () => {
    const start = claudeArgs({ ...base, session: { id: 's1', resume: false } })
    expect(start).toEqual(expect.arrayContaining(['--session-id', 's1', '--input-format', 'stream-json']))
    expect(start).not.toContain('--no-session-persistence')
    expect(claudeArgs({ ...base, session: { id: 's1', resume: true } })).toEqual(expect.arrayContaining(['--resume', 's1']))
    expect(claudeArgs(base)).toContain('--no-session-persistence')
  })

  it('always writes a JSON message, one line per turn', () => {
    const line = claudeInput({ prompt: 'oi', session: { id: 's1', resume: true } })
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'oi' }] } })
  })

  it('reports how big the context was at the end of the turn', () => {
    const p = claudeParser()
    p.line(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500 } } } }))
    p.line(JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } }))
    const [done] = p.line(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: {} }))
    expect(done).toMatchObject({ type: 'done', context: 20_543 })
  })

  it('keeps its file under the config folder, by working folder', () => {
    expect(claudeProjectDir('/cfg', 'E:\\tucano-tmp\\probe-agent')).toBe(join('/cfg', 'projects', 'E--tucano-tmp-probe-agent'))
  })

  it('names a long working folder as Claude Code does: cut at 200, then a hash of the whole path', () => {
    // A real folder Claude Code made, for an agent of a second workspace under a long data folder.
    const cwd = '/private/tmp/claude-501/-Users-eduardo-dev-agent-desk/a8f0d917-0489-4ee3-b90e-3ab79f9c8560/scratchpad/ws-leak-ySAaAW/workspaces/01a1ade8-40cc-79b7-bd30-8b0854d380d3/agents/9f3ef99c-7f51-4ea2-a06d-8cfbc28ee75c'
    expect(claudeProjectDir('/cfg', cwd)).toBe(join('/cfg', 'projects', '-private-tmp-claude-501--Users-eduardo-dev-agent-desk-a8f0d917-0489-4ee3-b90e-3ab79f9c8560-scratchpad-ws-leak-ySAaAW-workspaces-01a1ade8-40cc-79b7-bd30-8b0854d380d3-agents-9f3ef99c-7f51-4ea2-a06d-8cfb-nrss68'))
  })
})

// ---------- a process kept open between turns (a stand-in for Claude Code) ----------

describe('a Claude Code process kept open', () => {
  let dir: string
  let bin: string
  let cfg: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ks-cli-'))
    cfg = join(dir, 'config')
    mkdirSync(cfg)
    const script = join(dir, 'fake-claude.mjs')
    copyFileSync(join(__dirname, 'fixtures', 'fake-claude.mjs'), script)
    if (isWin) {
      bin = join(dir, 'claude.cmd')
      writeFileSync(bin, '@"%~dp0\\fake-claude.mjs" %*\r\n')
    } else {
      bin = join(dir, 'claude')
      writeFileSync(bin, `#!/usr/bin/env node\n${readFileSync(script, 'utf8')}`)
      chmodSync(bin, 0o755)
    }
  })

  const collect = async (events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
    const out: EngineEvent[] = []
    for await (const e of events) out.push(e)
    return out
  }
  const textOf = (events: EngineEvent[]): string => events.flatMap((e) => (e.type === 'done' ? [e.text] : [])).join('')

  it('answers one turn after another in the same process, until a stop kills it', async () => {
    const cli = new LiveCli({ bin: isWin ? process.execPath : bin, args: isWin ? [join(dir, 'fake-claude.mjs')] : [], cwd: dir })
    const line = (t: string) => claudeInput({ prompt: t, session: { id: 's', resume: false } })
    const one = textOf(await collect(cli.turn(line('oi'), claudeParser(), new AbortController().signal)))
    const two = textOf(await collect(cli.turn(line('de novo'), claudeParser(), new AbortController().signal)))
    expect(one).toMatch(/turn=1/)
    expect(two).toMatch(/turn=2/)
    expect(one.split(' ')[0]).toBe(two.split(' ')[0]) // the same pid
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 200)
    const cut = await collect(cli.turn(line('demore'), claudeParser(), stop.signal))
    expect(cut.some((e) => e.type === 'done')).toBe(false)
    // taskkill on Windows takes its time, more so with the whole suite running
    for (let i = 0; i < 100 && cli.alive; i++) await new Promise((r) => setTimeout(r, 100))
    expect(cli.alive).toBe(false)
  }, 30_000)

  it('writes the next turn of a session to the process still open, and keeps only a few waiting', async () => {
    const engine = claudeEngine(() => bin, async () => ({ env: {} }))
    const turn = (id: string, resume: boolean, prompt = 'oi'): Turn => ({ ...{ model: 'haiku', effort: 'low', system: 'x', prompt, cwd: dir, account: cfg }, signal: new AbortController().signal, session: { id, resume, keep: true } })
    const first = textOf(await collect(engine.run(turn('s1', false))))
    const second = textOf(await collect(engine.run(turn('s1', true))))
    expect(second.split(' ')[0]).toBe(first.split(' ')[0])
    expect(second).toMatch(/turn=2 resume=false/)

    // Past the cap, the one waiting longest closes: its next turn resumes it in a new process.
    for (let i = 2; i <= MAX_IDLE + 1; i++) await collect(engine.run(turn(`s${i}`, false)))
    const again = textOf(await collect(engine.run(turn('s1', true))))
    expect(again.split(' ')[0]).not.toBe(first.split(' ')[0])
    expect(again).toMatch(/turn=1 resume=true/)

    // Let go: its process and its file.
    const file = join(claudeProjectDir(cfg, dir), 's1.jsonl')
    mkdirSync(claudeProjectDir(cfg, dir), { recursive: true })
    writeFileSync(file, '{}\n')
    mkdirSync(join(claudeProjectDir(cfg, dir), 's1', 'tool-results'), { recursive: true })
    engine.release!('s1')
    await engine.settle!() // once its process is gone
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(claudeProjectDir(cfg, dir), 's1'))).toBe(false)
    engine.dispose!()
  }, 30_000)

  it('cleans what an earlier run left in the agents’ own folders only, the accounts’ too', () => {
    const engine = claudeEngine(() => bin, async () => ({ env: {} }))
    const work = join(dir, 'agents')
    mkdirSync(join(work, 'a1'), { recursive: true })
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const left = join(claudeProjectDir(cfg, join(work, 'a1')), `${id}.jsonl`)
    const beside = join(claudeProjectDir(cfg, join(work, 'a1')), id)
    const neighbour = join(claudeProjectDir(cfg, join(dir, 'agents-backup', 'x')), `${id}.jsonl`)
    for (const f of [left, neighbour]) {
      mkdirSync(join(f, '..'), { recursive: true })
      writeFileSync(f, '{}\n')
    }
    mkdirSync(beside)
    engine.clean!(work, [cfg])
    expect(existsSync(left)).toBe(false)
    expect(existsSync(beside)).toBe(false)
    expect(existsSync(neighbour)).toBe(true)
  })
})
