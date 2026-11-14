// A new prompt in a conversation that is already answering can arrive four ways: beside the reply
// running there, the two at once (parallel, what the setting says by default), after everything
// running there (queue), handed to it between two tool calls (steer), or in place of it (interrupt).
// A prompt with no mode at all (the phone, an approval's outcome, a routine) keeps the way replies
// have always gone: one at a time per agent and thread, the person's newer messages taking over.
// With nothing running, all of them are the same thing: a prompt like any other.
// See `send` in src/core/runs.ts.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { customModel, type Agent, type EngineId, type GrantLevel, type Message, type Settings } from '../src/shared/types'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { routerSystem } from '../src/core/router'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'

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
function recorded(rec: string[]): Engine {
  const base = fakeEngine('claude', { delayMs: 1 })
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
  it('no mode: the reply goes as replies always go, one at a time there', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d1', 'e isto também')
    await r.idle()
    expect(rec).toEqual(['start', 'end', 'start', 'end']) // never side by side: the agent answers one at a time there
    expect(agentMessages()).toHaveLength(2) // each prompt still gets its reply
  })

  it('parallel: it goes beside the reply running there, the two at once', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d1', 'e isto também', [], undefined, undefined, { mode: 'parallel' })
    expect(rec.slice(0, 2)).toEqual(['start', 'start']) // it didn't wait for the first one
    await r.idle()
    expect(rec.filter((x) => x === 'start')).toHaveLength(2)
    expect(rec.filter((x) => x === 'end')).toHaveLength(2)
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done']) // both answered
  })

  it('parallel: only one of the two holds the kept session, the other reads the whole conversation', async () => {
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
    await r.send('d1', 'e isto também', [], undefined, undefined, { mode: 'parallel' })
    await r.idle()
    // A session can only go on in one reply: the one already there keeps it, the second reads it all.
    expect(seen.filter((s) => s !== 'no session')).toHaveLength(1)
    expect(seen.filter((s) => s === 'no session')).toHaveLength(1)
  })

  it('queue behind two parallel replies: it waits for both to end', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d1', 'e isto também', [], undefined, undefined, { mode: 'parallel' })
    await r.send('d1', 'isto vem depois', [], undefined, undefined, { mode: 'queue' })
    expect(rec.filter((x) => x === 'start')).toHaveLength(2) // still waiting: two are running there
    await r.idle()
    expect(rec.filter((x) => x === 'start')).toHaveLength(3)
    expect(rec.at(-1)).toBe('end') // the queued one went last, after both
  })

  it('queue: it waits, and starts only when the reply above it ended', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    await r.send('d1', 'isto vem depois', [], undefined, undefined, { mode: 'queue' })
    expect(rec).toEqual(['start']) // still waiting its turn
    expect(mine()).toHaveLength(2) // my message is there already: it waits, it isn't held back
    await r.idle()
    expect(rec).toEqual(['start', 'end', 'start', 'end']) // one after the other, never side by side
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('queue: with nothing running there, it is a prompt like any other', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const r = runnerWith(fakeEngine('claude', { delayMs: 1 }))
    await r.send('d1', 'oi', [], undefined, undefined, { mode: 'queue' })
    await r.idle()
    expect(agentMessages()).toHaveLength(1)
    expect(agentMessages()[0]?.run?.status).toBe('done')
  })

  it('interrupt: the reply that was running stops, and the new one runs in its place', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const r = runnerWith(fakeEngine('claude', { delayMs: 15 }))
    await r.send('d1', 'conte uma história, demore 3 s')
    await new Promise((res) => setTimeout(res, 150))
    await r.send('d1', 'pare, faça isto', [], undefined, undefined, { mode: 'interrupt' })
    // The old one is stopped, and the new one goes as soon as it lets go: it doesn't wait out the
    // three seconds the old one asked for, only the turn it was in the middle of.
    await expect.poll(() => agentMessages().filter((m) => m.run?.status === 'done').length, { timeout: 6000 }).toBe(1)
    await r.idle()
    expect(agentMessages().map((m) => m.run?.status).sort()).toEqual(['done', 'stopped'])
  })

  it('interrupt: it stops only that conversation, never another one', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a1', members: ['a1'] })
    const r = runnerWith(fakeEngine('claude', { delayMs: 15 }))
    await r.send('d2', 'conte uma história, demore 2 s')
    await new Promise((res) => setTimeout(res, 100))
    await r.send('d1', 'outra coisa', [], undefined, undefined, { mode: 'interrupt' })
    await r.idle()
    const other = db.messages().filter((m) => m.conversationId === 'd2' && m.author.kind === 'agent')
    expect(other[0]?.run?.status).toBe('done') // d2 was left alone
  })

  it('steer: with a reply running there, no other one starts while it runs; the message says where it went', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const r = runnerWith(fakeEngine('claude', { delayMs: 15 }))
    await r.send('d1', 'conte uma história, demore 2 s')
    await r.send('d1', 'mude de plano', [], undefined, undefined, { mode: 'steer' })
    expect(agentMessages()).toHaveLength(1) // no second reply: it went into the one running
    expect(mine()).toHaveLength(2)
    expect(mine()[1]?.text).toBe('mude de plano')
    expect(mine()[1]?.sendMode).toBe('steer') // and the conversation says so, so it never looks unanswered
    await r.idle()
  })
})

// A channel message nobody was mentioned in, with more than one agent there, is the router's to give
// out (`routeAndRun`). The reply it picks follows the same rule as any other: beside the reply running
// there when the person's prompt asked for it (parallel), after it otherwise.
describe('a channel prompt the router picks for', () => {
  // The fake engine routes to the first agent in the channel, and takes its time on "demore N s".
  // The router's own turn isn't a reply, so it isn't recorded.
  const recording = (rec: string[]): Engine => {
    const base = fakeEngine('claude', { delayMs: 1 })
    return {
      id: 'claude',
      async *run(turn: Turn) {
        if (turn.system === routerSystem()) return yield* base.run(turn)
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

  it('parallel: the picked reply goes beside the reply running there, the two at once', async () => {
    channel()
    const rec: string[] = []
    const r = runnerWith(recording(rec))
    await r.send('c1', '@lia comece, demore 1 s')
    await r.send('c1', 'e isto também', [], undefined, undefined, { mode: 'parallel' })
    await expect.poll(() => rec.filter((x) => x === 'start').length, { timeout: 5000 }).toBe(2)
    expect(rec.slice(0, 2)).toEqual(['start', 'start']) // it didn't wait for the first one
    await r.idle()
    expect(rec).toEqual(['start', 'start', 'end', 'end'])
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('no mode: it waits for the reply running there to end, as any other reply', async () => {
    channel()
    const rec: string[] = []
    const r = runnerWith(recording(rec))
    await r.send('c1', '@lia comece, demore 1 s')
    await r.send('c1', 'e isto também') // nobody named: the router picks Lia again
    await new Promise((res) => setTimeout(res, 400)) // the router thought, and the reply waited
    expect(rec).toEqual(['start'])
    await r.idle()
    expect(rec).toEqual(['start', 'end', 'start', 'end']) // never side by side
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done', 'done'])
  })

  it('queue: it waits for the whole conversation to go quiet, the routed one included', async () => {
    channel()
    const rec: string[] = []
    const r = runnerWith(recording(rec))
    await r.send('c1', '@lia comece, demore 1 s')
    await r.send('c1', 'e isto também', [], undefined, undefined, { mode: 'parallel' })
    await r.send('c1', 'isto vem depois', [], undefined, undefined, { mode: 'queue' })
    await r.idle()
    expect(rec.filter((x) => x === 'start')).toHaveLength(3)
    expect(rec.at(-1)).toBe('end') // the queued one went last, after both
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
    r.resumeQueued()
    await r.idle()
    expect(agentMessages().map((m) => m.run?.status)).toEqual(['done'])
    expect(agentMessages()[0]?.run?.replyTo).toBe('m1')
    expect(db.queuedMessages()).toEqual([]) // the mark went with the reply, so it can't start twice
  })

  it('a message handed into a reply is not started again when the app opens', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    // It says where it went, and keeps saying it: only a queued one is a reply waiting to happen.
    db.saveMessage({ id: 'm1', conversationId: 'd1', author: { kind: 'person', id: db.ownerId() }, text: 'mude de plano', at: Date.now(), sendMode: 'steer' })
    expect(db.queuedMessages()).toEqual([])
    const r = runnerWith(fakeEngine('claude', { delayMs: 1 }))
    r.resumeQueued()
    await r.idle()
    expect(agentMessages()).toEqual([]) // nothing ran: that message already went into a reply
  })

  it('takes its turn after what is already running there', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(recorded(rec))
    await r.send('d1', 'comece, demore 1 s')
    db.saveMessage({ id: 'm1', conversationId: 'd1', author: { kind: 'person', id: db.ownerId() }, text: 'e isto', at: Date.now(), sendMode: 'queue' })
    r.resumeQueued() // the app reopened while a reply was still going
    await r.idle()
    expect(rec).toEqual(['start', 'end', 'start', 'end']) // never side by side
  })
})

describe('a steer reaches the agent between two tool calls', () => {
  it('hands it over with the next tool result, and says so in a step', async () => {
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
    const steerStep = reply.run?.steps.find((s) => s.label === 'Recebeu o que você escreveu')
    expect(steerStep).toBeDefined()
    // In the chain it reads as a steer, not as a tool call, and it carries what the person wrote.
    expect(steerStep?.kind).toBe('steer')
    expect(steerStep?.detail).toContain('mude de plano: só as abertas')
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

  it('is answered by a reply of its own, in the place it was written', async () => {
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    const rec: string[] = []
    const r = runnerWith(told(rec))
    await r.send('d1', 'conte uma história, demore 1 s')
    await new Promise((res) => setTimeout(res, 120)) // the reply is running, with no tool call ahead of it
    await r.send('d1', 'mude de plano', [], undefined, undefined, { mode: 'steer' })
    const steered = mine()[1]!
    expect(steered.sendMode).toBe('steer') // it went into the reply that was running, and says so
    await r.idle()
    const replies = agentMessages()
    expect(replies).toHaveLength(2) // the one it went into, and the one that answers it: nothing is left silent
    expect(replies[1]?.run?.replyTo).toBe(steered.id) // that reply answers my steered message, not another
    expect(rec[1]).toContain('mude de plano') // the agent did read it, in the end
    expect(db.message(steered.id)?.sendMode).toBeUndefined() // answered, so it no longer says it went into the reply above
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
