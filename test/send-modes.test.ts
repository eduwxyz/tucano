// A new prompt in a conversation that is already answering starts its own reply beside the ones running
// there, up to the replies at once a conversation may have (Settings › Agents › Replies, 6 when unset);
// past that it waits its turn, says so on the message, and outlives a restart. An agent can go one at a
// time (Agent.oneAtATime): its next reply waits for the one running, wherever that one is.
// A steer is not a prompt: it comes from a running reply's own pill and goes into that reply's chain.
// See `send` and `runIn` in src/core/runs.ts.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { customModel, type Agent, type EngineId, type GrantLevel, type Message, type Settings } from '../src/shared/types'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { chimeSystem, handoffSystem, routerSystem } from '../src/core/router'
import { MAX_CONCURRENT_URGENT, Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'

// These drive the real runner with engines that take real time (a reply held for a second, a step every
// 120 ms, a few messages past the session limit at once), so several take seconds on this box and more on
// a shared runner. The suite's cap is 5 s everywhere but Windows, and `the limit of sessions running at
// once` crossed it on both macOS and Linux CI: 30 s here, so only a real hang is a failure.
vi.setConfig({ testTimeout: 30_000 })

const DEMO = join(import.meta.dirname, '..', 'scripts', 'demo-mcp-server.mjs')
const ready = { installed: true, loggedIn: true }

let dir: string
let tasksFile: string
let db: Db
let gateway: Gateway
let connectors: ConnectorManager
let events: CoreEvent[]
let settings: Settings
let connectorId: string

const agent = (grant?: GrantLevel): Agent => ({
  id: 'a1',
  name: 'Lia',
  handle: 'lia',
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 1_000_000,
  used: 0,
  grants: grant ? { [connectorId]: grant } : {},
  memory: 'auto',
  computer: false,
  archived: false
})

const agentMessages = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')
const mine = (): Message[] => db.messages().filter((m) => m.author.kind === 'person')
const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '')
// Every text the agent gets back from the call, the steer handed over with it included.
const allText = (r: unknown): string => ((r as { content: { text: string }[] }).content.map((c) => c.text ?? '').join('\n'))

// An engine that records when each reply starts and ends, so a test can say "these never overlapped".
function recorded(rec: string[], delayMs = 1): Engine {
  const base = fakeEngine('claude', { delayMs })
  return {
    id: 'claude',
    async *run(turn: Turn) {
      rec.push('start')
      try {
        yield* base.run(turn)
      } finally {
        rec.push('end')
      }
    }
  }
}

function runnerWith(engine: Engine): Runner {
  const engines = { claude: engine, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') } as Record<EngineId, Engine>
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: join(dir, 'work'), gateway, connectors })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ad-modes-'))
  tasksFile = join(dir, 'tasks.json')
  db = new Db(join(dir, 'test.db'))
  events = []
  settings = {
    workspaceName: 'Edu',
    context: '',
    engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready },
    routerModel: 'haiku',
    memoryModel: 'haiku',
    memoryLearning: 'approve',
    defaultLimit: 100_000,
    approvalTtlHours: 24,
    theme: 'system',
    language: 'pt'
  } as Settings
  gateway = new Gateway()
  await gateway.start()
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: (e) => events.push(e), openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
  connectorId = await connectors.add({ kind: 'stdio', name: 'Tarefas', command: process.execPath, args: [DEMO], env: { DEMO_TASKS_FILE: tasksFile } })
  await connectors.connect(connectorId)
})

afterEach(async () => {
  await connectors.closeAll()
  await gateway.stop()
})

describe('a prompt that arrives while a reply is running', () => {
  it('starts its own reply, beside the one running there', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d1', 'e isto também')
    expect(rec.slice(0, 2)).toEqual(['start', 'start']) // it didn't wait for the first one
    await r.idle()
    expect(rec).toEqual(['start', 'start', 'end', 'end'])
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('only one of the two holds the kept session, the other reads the whole conversation', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const seen: string[] = []
    const base = fakeEngine('claude', { delayMs: 1, sessions: true })
    const engine: Engine = {
      ...base,
      async *run(turn) {
        seen.push(turn.session ? `${turn.session.resume ? 'resume' : 'new'} ${turn.session.id}` : 'no session')
        yield* base.run(turn)
      }
    }
    const r = runnerWith(engine)
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d1', 'e isto também')
    await r.idle()
    // A session can only go on in one reply: the one already there keeps it, the second reads it all.
    expect(seen.filter((s) => s !== 'no session')).toHaveLength(1)
    expect(seen.filter((s) => s === 'no session')).toHaveLength(1)
  })

  it('one at a time: it waits, says so, and starts only when the reply above it ended', async () => {
    settings.repliesAtOnce = 1
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d1', 'isto vem depois')
    expect(rec).toEqual(['start']) // still waiting its turn
    expect(mine().map((m) => m.sendMode)).toEqual([undefined, 'queue']) // my message is there, marked as waiting
    await r.idle()
    expect(rec).toEqual(['start', 'end', 'start', 'end']) // one after the other, never side by side
    expect(mine().map((m) => m.sendMode)).toEqual([undefined, undefined]) // started, so it stops saying it
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('up to two: the third waits for one of them to end, not for both', async () => {
    settings.repliesAtOnce = 2
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d1', 'esta vai mais longe, demore 3 s')
    await r.send('d1', 'e esta é curta')
    expect(rec).toEqual(['start', 'start']) // the third is past the limit
    await r.idle()
    // It went when the first one ended, and was done before the long one.
    expect(rec).toEqual(['start', 'start', 'end', 'start', 'end', 'end'])
  })

  it('the limit is per conversation: another one is never held back by it', async () => {
    settings.repliesAtOnce = 1
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d2', 'outra coisa')
    expect(rec.slice(0, 2)).toEqual(['start', 'start'])
    await r.idle()
  })

  it("steer (from a running reply's pill): no other reply starts, and it goes into that reply's chain", async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const r = runnerWith(fakeEngine('claude', { delayMs: 15 }))
    await r.send('d1', 'conte uma história, demore 2 s')
    await r.send('d1', 'mude de plano', [], undefined, undefined, { mode: 'steer' })
    expect(agentMessages()).toHaveLength(1) // no second reply: it went into the one running
    expect(mine()).toHaveLength(1) // a steer is not a message of the person's: nothing of it is posted
    // It is a row of that reply's chain, in their words.
    const rows = agentMessages()[0]?.run?.steps.filter((s) => s.kind === 'steer') ?? []
    expect(rows.map((s) => s.input)).toEqual(['mude de plano'])
    await r.idle()
  })
})

describe('an agent that goes one at a time', () => {
  it('its next reply waits for the one running, even in another conversation', async () => {
    db.saveAgent({ ...agent(), oneAtATime: true })
    expect(db.agent('a1')?.oneAtATime).toBe(true) // kept as it was saved
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d2', 'e isto, em outra conversa')
    expect(rec).toEqual(['start'])
    expect(mine()[1]?.sendMode).toBe('queue') // it says it waits
    await r.idle()
    expect(rec).toEqual(['start', 'end', 'start', 'end'])
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('holds back only itself: another agent goes beside it', async () => {
    db.saveAgent({ ...agent(), oneAtATime: true })
    db.saveAgent({ ...agent(), id: 'a2', name: 'Nina', handle: 'nina' })
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a2', members: ['a2'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d2', 'oi')
    expect(rec.slice(0, 2)).toEqual(['start', 'start'])
    await r.idle()
  })
})

// A channel message nobody was mentioned in, with more than one agent there, is the router's to give
// out (`routeAndRun`). The reply it picks follows the same rule as any other: beside the replies running
// there, up to the conversation's limit.
describe('a channel prompt the router picks for', () => {
  // The fake engine routes to the first agent in the channel, and takes its time on "demore N s".
  // The router's own turn isn't a reply, so it isn't recorded.
  const recording = (rec: string[]): Engine => {
    const base = fakeEngine('claude', { delayMs: 1 })
    return {
      id: 'claude',
      async *run(turn: Turn) {
        // The router, and the small checks after a reply (who goes next, who chimes in), are not replies.
        if ([routerSystem(), handoffSystem(), chimeSystem()].includes(turn.system ?? '')) return yield* base.run(turn)
        rec.push('start')
        try {
          yield* base.run(turn)
        } finally {
          rec.push('end')
        }
      }
    }
  }
  const channel = (): void => {
    db.saveAgent(agent())
    db.saveAgent({ ...agent(), id: 'a2', name: 'Nina', handle: 'nina' })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'eng', members: ['a1', 'a2'] })
  }

  it('the picked reply goes beside the one running there', async () => {
    channel()
    const rec: string[] = []
    const r = runnerWith(recording(rec))
    await r.send('c1', '@lia comece, demore 1 s')
    await r.send('c1', 'e isto também') // nobody named: the router picks Lia again
    await expect.poll(() => rec.filter((x) => x === 'start').length, { timeout: 5000 }).toBe(2)
    await r.idle()
    expect(rec).toEqual(['start', 'start', 'end', 'end'])
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('one at a time: the routed one waits for the reply running there', async () => {
    settings.repliesAtOnce = 1
    channel()
    const rec: string[] = []
    const r = runnerWith(recording(rec))
    await r.send('c1', '@lia comece, demore 1 s')
    await r.send('c1', 'isto vem depois')
    await r.idle()
    expect(rec).toEqual(['start', 'end', 'start', 'end'])
    expect(agentMessages().filter((m) => m.run).map((m) => m.run?.status)).toEqual(['done', 'done'])
  })
})

describe('the limit of sessions running at once', () => {
  it('queues what is past the limit, and runs every message once the slots free', async () => {
    db.saveAgent(agent())
    const rec: string[] = []
    const r = runnerWith(recorded(rec, 120))
    const ids = Array.from({ length: MAX_CONCURRENT_URGENT + 2 }, (_, i) => `d${i}`)
    for (const id of ids) db.createConversation({ id, kind: 'dm', name: 'a1', members: ['a1'] })
    for (const id of ids) await r.send(id, 'oi')
    await r.idle()
    let active = 0
    let most = 0
    for (const e of rec) {
      active += e === 'start' ? 1 : -1
      most = Math.max(most, active)
    }
    // No engine past the urgent ceiling, and never one at a time either: the messages run side by side
    // while slots are free, and what is past the ceiling waits in the scheduler's queue. Nothing else
    // waits here: a message with a slot free is a session of its own.
    expect(most).toBeLessThanOrEqual(MAX_CONCURRENT_URGENT)
    expect(most).toBeGreaterThan(1)
    expect(agentMessages().map((m) => m.run?.status)).toHaveLength(ids.length)
    expect(agentMessages().every((m) => m.run?.status === 'done')).toBe(true)
  })
})

describe('two replies of one agent in the same DM', () => {
  it("a steer from one reply's pill reaches that reply alone", async () => {
    const results: { reply: number; text: string }[] = []
    let turns = 0
    const engine: Engine = {
      id: 'claude',
      async *run(turn: Turn) {
        const me = ++turns
        if (turn.mcpUrl) {
          const client = new Client({ name: 'scripted', version: '0' })
          await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
          const list = (await client.listTools()).tools.map((t) => t.name).find((n) => n.endsWith('__list_tasks'))!
          results.push({ reply: me, text: allText(await client.callTool({ name: list, arguments: {} })) })
          await new Promise((res) => setTimeout(res, 500))
          results.push({ reply: me, text: allText(await client.callTool({ name: list, arguments: {} })) })
          await client.close()
        }
        const said = `ok ${me}`
        yield { type: 'text', delta: said }
        yield { type: 'done', text: said, usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    db.saveAgent(agent('read_write'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const r = runnerWith(engine)
    await r.send('d1', 'quais tarefas?')
    await r.send('d1', 'e as de ontem?')
    // Two sessions of the same agent, running side by side in one DM.
    await expect.poll(() => agentMessages().filter((m) => m.run?.status === 'working').length, { timeout: 8000 }).toBe(2)
    const first = agentMessages().find((m) => m.run?.status === 'working')!
    await r.send('d1', 'mude de plano: só as abertas', [], undefined, undefined, { mode: 'steer', steerTo: first.id })
    await r.idle()
    const told = results.filter((x) => x.text.includes('mude de plano'))
    expect(told).toHaveLength(1) // handed to the reply the pill belongs to, and not to the other one
  })
})

describe('a queued prompt outlives a restart', () => {
  it('is kept as waiting while its reply has not started, and goes when the app opens again', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.saveMessage({ id: 'm1', conversationId: 'd1', author: { kind: 'person', id: db.ownerId() }, text: 'isto depois', at: Date.now(), sendMode: 'queue' })
    expect(db.queuedMessages().map((m) => m.id)).toEqual(['m1']) // what a restart finds

    // A fresh runner over the same database, as if the app had been closed and opened.
    const r = runnerWith(fakeEngine('claude', { delayMs: 1 }))
    await r.resumeQueued()
    await r.idle()
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done'])
    expect(agentMessages()[0]?.run?.replyTo).toBe('m1')
    expect(db.queuedMessages()).toEqual([]) // the mark went with the reply, so it can't start twice
  })

  it('takes its turn after what is already running there, one at a time', async () => {
    settings.repliesAtOnce = 1
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    db.saveMessage({ id: 'm1', conversationId: 'd1', author: { kind: 'person', id: db.ownerId() }, text: 'e isto', at: Date.now(), sendMode: 'queue' })
    await r.resumeQueued() // the app reopened while a reply was still going
    await r.idle()
    expect(rec).toEqual(['start', 'end', 'start', 'end']) // never side by side
  })
})

describe('a steer reaches the agent between two tool calls', () => {
  it('hands it over with the next tool result, and its row in the chain turns done', async () => {
    // Two calls, with a pause between them: the person writes during the pause.
    const results: unknown[] = []
    const engine: Engine = {
      id: 'claude',
      async *run(turn: Turn) {
        let reply = 'ok'
        if (turn.mcpUrl) {
          const client = new Client({ name: 'scripted', version: '0' })
          await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
          const list = (await client.listTools()).tools.map((t) => t.name).find((n) => n.endsWith('__list_tasks'))!
          results.push(await client.callTool({ name: list, arguments: {} }))
          await new Promise((res) => setTimeout(res, 400))
          results.push(await client.callTool({ name: list, arguments: {} }))
          await client.close()
          reply = 'vi as tarefas'
        }
        yield { type: 'text', delta: reply }
        yield { type: 'done', text: reply, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
      }
    }
    db.saveAgent(agent('read_write'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const r = runnerWith(engine)
    await r.send('d1', 'quais tarefas?')
    await new Promise((res) => setTimeout(res, 150)) // inside the pause between the two calls
    await r.send('d1', 'mude de plano: só as abertas', [], undefined, undefined, { mode: 'steer' })
    await r.idle()
    expect(results).toHaveLength(2)
    expect(allText(results[0])).not.toContain('mude de plano')
    expect(allText(results[1])).toContain('mude de plano') // handed over at the second call
    expect(allText(results[1])).toContain('escreveu isto enquanto você trabalhava')
    const reply = agentMessages()[0]!
    // Its row in the chain turned done at the call it was handed over with.
    const row = reply.run?.steps.find((s) => s.kind === 'steer')
    expect(row?.input).toBe('mude de plano: só as abertas')
    expect(row?.status).toBe('done')
  })
})

describe('a steer the reply ended without taking', () => {
  // An engine that records what each reply was told, so a test can say "this text did reach the agent".
  function told(rec: string[]): Engine {
    const base = fakeEngine('claude', { delayMs: 1 })
    return {
      id: 'claude',
      async *run(turn: Turn) {
        rec.push(turn.prompt)
        yield* base.run(turn)
      }
    }
  }

  it('stays in its chain marked as not read, with no prompt and no second reply', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(told(rec))
    await r.send('d1', 'conte uma história, demore 1 s')
    await new Promise((res) => setTimeout(res, 120)) // the reply is running, with no tool call ahead of it
    await r.send('d1', 'mude de plano', [], undefined, undefined, { mode: 'steer' })
    expect(mine()).toHaveLength(1) // nothing of it is posted
    await r.idle()
    const replies = agentMessages()
    expect(replies).toHaveLength(1) // no reply of its own: a steer is the running reply's, not a prompt
    const row = replies[0]?.run?.steps.find((s) => s.kind === 'steer')
    expect(row?.input).toBe('mude de plano')
    expect(row?.status).toBe('error') // the reply ended before reading it, and the row says so
    expect(rec).toHaveLength(1)
  })

  it('never goes into a reply running in another thread, nor a thread, seen from the channel', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'channel', name: 'time', members: ['a1'], threads: true })
    const r = runnerWith(fakeEngine('claude', { delayMs: 1 }))
    await r.send('d1', 'comece uma thread, demore 1 s')
    await new Promise((res) => setTimeout(res, 120)) // a reply is running, inside that thread
    await r.send('d1', 'outra coisa, no canal', [], undefined, undefined, { mode: 'steer' })
    const second = mine()[1]!
    expect(second.sendMode).toBeUndefined() // not handed over: it isn't the reply's place
    await r.idle()
    expect(agentMessages()).toHaveLength(2) // it got a reply of its own
    expect(agentMessages()[1]?.run?.replyTo).toBe(second.id)
  })
})

// A prompt whose reply never starts at once is in no one's hands until it does: it says so in the
// conversation, and a window closed while it waited must not lose it. See `waitingMark` in runs.ts.
describe('a prompt whose reply has not started yet', () => {
  it('is answered when the app opens again, since no reply ever started for it', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const now = Date.now()
    // What a window closed mid-reply leaves behind: its reply still marked working, and mine waiting.
    db.saveMessage({ id: 'p1', conversationId: 'd1', author: { kind: 'person', id: db.ownerId() }, text: 'primeira', at: now - 3000 })
    db.saveMessage({ id: 'old', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: '', at: now - 2000, run: { status: 'working', steps: [] } })
    db.saveMessage({ id: 'p2', conversationId: 'd1', author: { kind: 'person', id: db.ownerId() }, text: 'segunda', at: now - 1000, sendMode: 'queue' })
    db.interruptStaleRuns()
    const r = runnerWith(fakeEngine('claude', { delayMs: 1 }))
    await r.resumeQueued()
    await r.idle()
    const replies = agentMessages().filter((m) => m.run?.status === 'done')
    expect(replies).toHaveLength(1)
    expect(replies[0]?.run?.replyTo).toBe('p2') // the prompt that waited is the one answered
    expect(db.message('p2')?.sendMode).toBeUndefined() // and it no longer says it's waiting
  })
})
