// "Read the alarm channel, find what broke, send a summary and a triage" took about 35 minutes and
// hundreds to thousands of tool calls, with many `sleep 60`. This reproduces it with a scripted agent
// that does what a model does with the tools and the prompt it gets, a fake Slack (30 days of alarms,
// 20 messages a page) and a fake Databricks whose query comes back PENDING, on a virtual clock: every
// tool call costs a model step (STEP_S), a `sleep N` costs N seconds, and so does the app's own wait.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Connector, EngineId, Settings } from '../src/shared/types'
import { formatExec } from '../src/core/computer'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { awaitDone, idleSleepSeconds, isStatusTool, pendingOf, pollTool, sleepSeconds } from '../src/core/waits'

const ready = { installed: true, loggedIn: true }
const STEP_S = 5 // a model step: what each tool call costs the agent before it's even made
const PAGE = 20 // messages per page, Slack's usual default
const ALARM_EVERY_S = 300 // the alarm bot posts every 5 minutes...
const HISTORY_S = 30 * 86_400 // ...and the channel goes back 30 days
const QUERY_S = 180 // the SQL statement runs 3 minutes (a warehouse waking up)

let db: Db
let gateway: Gateway
let settings: Settings
let clock: number // virtual milliseconds
let agentCalls: string[] // tool calls the agent made (each a model step)
let polls: number // poll_sql_result calls, the agent's or the app's
let slept: number // seconds of sleep that ran

const json = (v: unknown): CallToolResult => textResult(JSON.stringify(v))
const firstText = (r: CallToolResult): string => (r.content[0]?.type === 'text' ? r.content[0].text : '')
const allText = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

function world(opts: { pollTool?: boolean } = {}) {
  const sent = clock // the person's message, and the end of the channel
  const messages = Array.from({ length: HISTORY_S / ALARM_EVERY_S }, (_, i) => {
    // Half a period off: none right on the hour's edge, whatever second the message goes out.
    const ts = sent / 1000 - HISTORY_S + i * ALARM_EVERY_S + ALARM_EVERY_S / 2
    const firing = ts >= sent / 1000 - 3600
    return { ts: ts.toFixed(6), user: 'alertmanager', text: firing ? `[FIRING] job nightly_orders failed (${i})` : `[RESOLVED] all green (${i})` }
  })
  const statements = new Map<string, number>() // id -> when it's done (virtual ms)
  const connectors: Connector[] = [
    { id: 'slack', name: 'Slack', kind: 'remote', auth: 'none', status: 'connected', tools: [] },
    { id: 'dbx', name: 'Databricks', kind: 'remote', auth: 'none', status: 'connected', tools: [] }
  ]
  db.saveConnector({ id: 'slack', name: 'Slack', kind: 'remote', auth: 'none' })
  db.saveConnector({ id: 'dbx', name: 'Databricks', kind: 'remote', auth: 'none' })
  db.syncTools('slack', [
    { name: 'slack_read_channel', description: 'Reads one page of a channel, newest first.', cls: 'read', inputSchema: { type: 'object', properties: { channel_id: { type: 'string' }, oldest: { type: 'string' }, latest: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } }, required: ['channel_id'] } }
  ])
  db.syncTools('dbx', [
    { name: 'execute_sql_read_only', description: 'Runs a read-only SQL statement.', cls: 'read', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ...(opts.pollTool === false ? [] : [{ name: 'poll_sql_result', description: 'Gets the status and result of a statement.', cls: 'read' as const, inputSchema: { type: 'object', properties: { statement_id: { type: 'string' } }, required: ['statement_id'] } }])
  ])
  return {
    list: () => connectors,
    call: async (id: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      if (name === 'slack_read_channel') {
        const oldest = Number(args['oldest'] ?? 0)
        const from = Number(args['cursor'] ?? 0)
        const window = messages.filter((m) => Number(m.ts) >= oldest).reverse()
        const page = window.slice(from, from + Number(args['limit'] ?? PAGE))
        const more = from + page.length < window.length
        return json({ ok: true, messages: page, has_more: more, ...(more ? { response_metadata: { next_cursor: String(from + page.length) } } : {}) })
      }
      if (name === 'execute_sql_read_only') {
        const statement_id = `s-${statements.size + 1}`
        statements.set(statement_id, clock + QUERY_S * 1000)
        return json({ statement_id, status: { state: 'PENDING' } })
      }
      if (name === 'poll_sql_result') {
        polls++
        const statement_id = String(args['statement_id'])
        const done = statements.get(statement_id)
        if (done === undefined) return textResult('No such statement.', true)
        // Each answer carries how long it has run, so no two are the same.
        if (clock < done) return json({ statement_id, status: { state: 'RUNNING' }, elapsed_ms: clock - (done - QUERY_S * 1000) })
        return json({ statement_id, status: { state: 'SUCCEEDED' }, result: { data_array: [['nightly_orders', 'FAILED', 'OutOfMemoryError on stage 12', '2026-11-05 09:31']] } })
      }
      throw new Error(`unknown tool ${id}/${name}`)
    }
  }
}

// What a model does with these tools: read the channel page after page (with a time window only
// when it knows what "now" is), run the query, and while it's pending sleep a minute and ask again.
// It heeds what the tools tell it, as a model does: a warning to narrow, a refused sleep, a cut.
function triageAgent(): Engine {
  return {
    id: 'claude',
    async *run(turn: Turn) {
      const client = new Client({ name: 'triage-agent', version: '0.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl!)))
      const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
        clock += STEP_S * 1000
        agentCalls.push(name)
        return (await client.callTool({ name, arguments: args })) as CallToolResult
      }
      try {
        // "now", if the prompt gives it as Unix seconds: the last message's own time.
        const unix = [...turn.prompt.matchAll(/unix (\d+)\)\]/g)].at(-1)?.[1]
        const windowed = unix && /oldest/.test(turn.system) ? { oldest: String(Number(unix) - 3600) } : {}
        let cursor: string | undefined
        const alarms: string[] = []
        for (;;) {
          if (turn.signal.aborted) return
          const r = await call('slack__slack_read_channel', { channel_id: 'C0ALARMS', ...windowed, ...(cursor ? { cursor } : {}) })
          if (r.isError) break
          const page = JSON.parse(firstText(r)) as { messages: { text: string }[]; has_more: boolean; response_metadata?: { next_cursor: string, grok: string } }
          alarms.push(...page.messages.filter((m) => m.text.startsWith('[FIRING]')).map((m) => m.text))
          if (/Atenção: você já chamou|Careful: you've called/.test(allText(r))) break // told to narrow: it has the alarm already
          if (!page.has_more) break
          cursor = page.response_metadata!.next_cursor
        }
        const query = { query: "SELECT job, state, error, at FROM ops.job_runs WHERE at > now() - INTERVAL 1 HOUR AND state = 'FAILED'" }
        let r = await call('databricks__execute_sql_read_only', query)
        for (let i = 1; !turn.signal.aborted && i < 100; i++) {
          const state = (JSON.parse(firstText(r)) as { status?: { state?: string } }).status?.state
          if (state !== 'PENDING' && state !== 'RUNNING') break
          if (/\[(Ainda|Still) /.test(allText(r))) break // the app waited and says to move on
          await call('bash', { command: `sleep 60 && echo "check ${i}"` })
          const polled = await call('databricks__poll_sql_result', { statement_id: (JSON.parse(firstText(r)) as { statement_id: string }).statement_id })
          // No status tool: it runs the query again, as a model would.
          r = polled.isError ? await call('databricks__execute_sql_read_only', query) : polled
        }
        if (turn.signal.aborted) return
        const text = `**Resumo:** ${alarms.length} alarmes do nightly_orders na última hora. **Triagem:** ${firstText(r).includes('OutOfMemoryError') ? 'OOM no stage 12, P1.' : 'consulta ainda rodando.'}`
        yield { type: 'text', delta: text }
        yield { type: 'done', text, usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 50 } }
      } finally {
        await client.close()
      }
    }
  }
}

function runner(connectors: ReturnType<typeof world>, engine: Engine = triageAgent()): Runner {
  const engines: Record<EngineId, Engine> = { claude: engine, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  const computers = {
    call: async (_a: Agent, name: string, args: Record<string, unknown>) => {
      const command = String(args['command'] ?? '')
      const s = Number(/^\s*sleep\s+(\d+)/.exec(command)?.[1] ?? 0)
      clock += s * 1000
      slept += s
      return { result: textResult(formatExec({ code: 0, stdout: command.replace(/^.*echo\s+"?([^"]*)"?$/, '$1'), stderr: '' }, 120)) }
    }
  }
  const timers = { wait: async (ms: number) => void (clock += ms), now: () => clock }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'st-w-')), gateway, connectors, computers, timers })
}

const reply = () => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!

async function triage(connectors = world()) {
  const start = clock
  const r = runner(connectors)
  await r.send('dm', 'Lê o #alarmes, acha o que quebrou no alarme da última hora e me manda um resumo e a triagem.')
  await r.idle()
  const minutes = (clock - start) / 60_000
  return { minutes, calls: agentCalls.length, polls, slept, reply: reply() }
}

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'st-db-')), 'test.db'))
  settings = { workspaceName: 'Gabriel', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent({ id: 'ops', name: 'Ops', handle: 'ops', role: 'Plantão', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 50_000_000, used: 0, grants: { slack: 'read', dbx: 'read' }, memory: 'auto', computer: true, archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'ops', members: ['ops'] })
  clock = Date.now()
  agentCalls = []
  polls = 0
  slept = 0
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('an alarm triage', () => {
  it('reads only the last hour and gets the pending query back done: a few minutes and a handful of calls', async () => {
    const t = await triage()
    console.log(`[slow-triage] ${t.calls} agent calls, ${t.polls} polls by the app, ${t.slept} s slept, ${t.minutes.toFixed(1)} min`)
    expect(t.reply.run!.status).toBe('done')
    expect(t.reply.text).toContain('OOM no stage 12')
    expect(t.reply.text).toContain('12 alarmes') // the last hour: one page, with every alarm in it
    expect(t.calls).toBeLessThanOrEqual(3)
    expect(t.slept).toBe(0)
    expect(t.minutes).toBeLessThan(QUERY_S / 60 + 1) // the query's own time, and little else
    expect(t.reply.run!.steps.some((s) => /esperou 3 min/.test(s.detail ?? ''))).toBe(true)
  })

  it('an agent that ignores the window is told to narrow at 15 pages, not left to read 30 days', async () => {
    const engine = triageAgent()
    // A model that pays no attention to the times in the prompt.
    const blind: Engine = { id: 'claude', run: (turn) => engine.run({ ...turn, prompt: turn.prompt.replace(/unix \d+/g, '') }) }
    const r = runner(world(), blind)
    await r.send('dm', 'Lê o #alarmes e me manda a triagem.')
    await r.idle()
    expect(agentCalls.filter((c) => c.endsWith('slack_read_channel'))).toHaveLength(15)
    expect(reply().run!.status).toBe('done')
  })

  it('without a status tool to wait with, sleeps after the first are refused and the reply still ends', async () => {
    const t = await triage(world({ pollTool: false }))
    console.log(`[slow-triage, no status tool] ${t.calls} agent calls, ${t.slept} s slept, ${t.minutes.toFixed(1)} min, ${t.reply.run!.status}`)
    expect(t.slept).toBe(60) // the first one ran
    expect(t.reply.run!.steps.filter((s) => s.label === 'Não esperou com sleep').length).toBeGreaterThan(0)
    expect(t.reply.run!.status === 'done' || t.reply.run!.status === 'failed').toBe(true)
    expect(t.calls).toBeLessThan(20)
  })
})

// An agent that makes these calls, in order, and ends.
function scripted(calls: [string, Record<string, unknown>][]): Engine {
  return {
    id: 'claude',
    async *run(turn: Turn) {
      const client = new Client({ name: 'scripted', version: '0.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl!)))
      try {
        for (const [name, args] of calls) {
          clock += STEP_S * 1000
          agentCalls.push(name)
          const r = (await client.callTool({ name, arguments: args })) as CallToolResult
          agentCalls.push(`=> ${allText(r).slice(0, 80)}`)
        }
        yield { type: 'done', text: 'pronto', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      } finally {
        await client.close()
      }
    }
  }
}

describe('what stays as it was', () => {
  it('sleeps before checking something on the computer always run, and so do an agent without connectors', async () => {
    const r = runner(world(), scripted([['bash', { command: 'sleep 30 && curl -s localhost:3000' }], ['bash', { command: 'sleep 30 && curl -s localhost:3000' }], ['bash', { command: 'sleep 30 && curl -s localhost:3000' }]]))
    await r.send('dm', 'sobe o servidor e confere')
    await r.idle()
    expect(slept).toBe(90)
    db.saveAgent({ ...db.agent('ops')!, grants: {} }) // a coding agent: no connectors
    slept = 0
    const coder = runner(world(), scripted([['bash', { command: 'sleep 60' }], ['bash', { command: 'sleep 60' }], ['bash', { command: 'sleep 60' }]]))
    await coder.send('dm', 'espera o build')
    await coder.idle()
    expect(slept).toBe(180)
  })

  it("asking a status tool itself gets today's answer, not a wait", async () => {
    const r = runner(world(), scripted([['databricks__execute_sql_read_only', { query: 'select 1' }]]))
    await r.send('dm', 'roda')
    await r.idle()
    polls = 0
    const start = clock
    const asks = runner(world(), scripted([['databricks__poll_sql_result', { statement_id: 's-1' }]]))
    await asks.send('dm', 'já terminou?')
    await asks.idle()
    expect(polls).toBe(1) // its own call, answered RUNNING, and nothing more
    expect(clock - start).toBeLessThan(10_000)
  })

  it('many writes in a row are the work: only reads count toward the same-tool guard', async () => {
    db.saveConnector({ id: 'sheet', name: 'Planilha', kind: 'remote', auth: 'none' })
    db.syncTools('sheet', [{ name: 'insert_row', description: 'Inserts a row.', cls: 'write', inputSchema: { type: 'object', properties: { v: { type: 'number' } } } }])
    db.saveAgent({ ...db.agent('ops')!, grants: { sheet: 'read_write' } })
    const calls = { n: 0 }
    const sheet = {
      list: (): Connector[] => [{ id: 'sheet', name: 'Planilha', kind: 'remote', auth: 'none', status: 'connected', tools: [] }],
      call: async (): Promise<CallToolResult> => json({ ok: true, n: ++calls.n })
    }
    const r = runner(sheet as unknown as ReturnType<typeof world>, scripted(Array.from({ length: 70 }, (_, i): [string, Record<string, unknown>] => ['planilha__insert_row', { v: i }])))
    await r.send('dm', 'insere as 70 linhas')
    await r.idle()
    expect(calls.n).toBe(70)
    expect(reply().run!.status).toBe('done')
  })
})

describe('waiting on a pending result', () => {
  const pending = json({ statement_id: 's-1', status: { state: 'PENDING' } })
  const tools = [
    { name: 'execute_sql_read_only', description: '', cls: 'read' as const, enabled: true, highRisk: false, isNew: false, inputSchema: { required: ['query'] } },
    { name: 'poll_sql_result', description: '', cls: 'read' as const, enabled: true, highRisk: false, isNew: false, inputSchema: { required: ['statement_id'] } }
  ]

  it('knows a not-done state from a done one, and only in a structured result', () => {
    expect(pendingOf(pending)).toEqual({ state: 'PENDING', ids: { statement_id: 's-1' } })
    expect(pendingOf(json({ run_id: 7, state: { life_cycle_state: 'RUNNING' }, job_id: 'j' }))?.state).toBe('RUNNING')
    expect(pendingOf(json({ statement_id: 's-1', status: { state: 'SUCCEEDED' } }))).toBeUndefined()
    expect(pendingOf(json({ statement_id: 's-1', status: { state: 'FAILED' } }))).toBeUndefined()
    expect(pendingOf(textResult('The deploy is still pending, statement_id s-1'))).toBeUndefined()
    expect(pendingOf(json({ rows: [{ id: 'a', status: 'pending' }] }))).toBeUndefined() // rows of data, not a status
  })

  it("finds the connector's status tool by the ids the result gave", () => {
    expect(pollTool(tools, pendingOf(pending)!, () => true)).toMatchObject({ tool: { name: 'poll_sql_result' }, args: { statement_id: 's-1' } })
    expect(pollTool(tools, pendingOf(pending)!, (t) => t.name !== 'poll_sql_result')).toBeUndefined() // not granted
    expect(pollTool([{ ...tools[1]!, cls: 'write' }], pendingOf(pending)!, () => true)).toBeUndefined() // never a write tool
  })

  it('polls with backoff until done, and gives up at the limit with the result still pending', async () => {
    let t = 0
    const timers = { wait: async (ms: number) => void (t += ms), now: () => t }
    const done = await awaitDone(pending, async () => (t >= 30_000 ? json({ status: { state: 'SUCCEEDED' } }) : pending), { maxMs: 300_000, ...timers })
    expect(done.pending).toBeUndefined()
    expect(done.polls).toBe(5) // at 2, 6, 14, 29 s still running; at 44 s done
    t = 0
    const late = await awaitDone(pending, async () => pending, { maxMs: 60_000, ...timers })
    expect(late.pending?.state).toBe('PENDING')
    expect(late.ms).toBe(60_000)
  })

  it('reads how long a command sleeps before doing anything', () => {
    expect(sleepSeconds('sleep 60')).toBe(60)
    expect(sleepSeconds('sleep 60 && echo "check 3"')).toBe(60)
    expect(sleepSeconds('  sleep 1m; curl x')).toBe(60)
    expect(sleepSeconds('sleep 2 && curl localhost:5173')).toBe(2)
    expect(sleepSeconds('for i in 1 2 3; do curl x && break; sleep 10; done')).toBe(0)
    expect(sleepSeconds('npm test')).toBe(0)
  })

  it('tells a sleep with nothing after it from one before a check, and a status tool by its name', () => {
    expect(idleSleepSeconds('sleep 60')).toBe(60)
    expect(idleSleepSeconds('sleep 60 && echo "check 3"')).toBe(60)
    expect(idleSleepSeconds('sleep 1m; date')).toBe(60)
    expect(idleSleepSeconds('sleep 30 && curl -s localhost:3000')).toBe(0)
    expect(idleSleepSeconds('sleep 60; gh run view 123')).toBe(0)
    expect(idleSleepSeconds('npm test')).toBe(0)
    expect(isStatusTool('poll_sql_result')).toBe(true)
    expect(isStatusTool('get_workflow_run')).toBe(true)
    expect(isStatusTool('execute_sql_read_only')).toBe(false)
  })
})
