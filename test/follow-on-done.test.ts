// A reply that has ended goes on from where it stopped: the pill on it reads Follow, and what the person
// writes there arrives as a steer to a reply that isn't running, so that reply's own session is resumed
// and it works again toward a new final answer in the same row. Nothing of it is posted as a message.
// See `send`, `followIn` and the `followUp` case in `reply` (src/core/runs.ts).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, GrantLevel, Message, Settings } from '../src/shared/types'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'

vi.setConfig({ testTimeout: 30_000 })

const ready = { installed: true, loggedIn: true }

let dir: string
let db: Db
let gateway: Gateway
let connectors: ConnectorManager
let events: CoreEvent[]
let settings: Settings

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
  grants: grant ? { c1: grant } : {},
  memory: 'auto',
  computer: false,
  archived: false
})

const agentMessages = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')
const mine = (): Message[] => db.messages().filter((m) => m.author.kind === 'person')

// Every turn the engine ran, in order: its prompt and the session it was given.
const recorder = (opts: { sessions?: boolean } = {}): { engine: Engine; turns: Turn[] } => {
  const turns: Turn[] = []
  const base = fakeEngine('claude', { delayMs: 1, ...(opts.sessions ? { sessions: true } : {}) })
  return {
    turns,
    engine: {
      ...base,
      async *run(turn: Turn) {
        turns.push(turn)
        yield* base.run(turn)
      }
    }
  }
}

function runnerWith(engine: Engine): Runner {
  const engines = { claude: engine, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') } as Record<EngineId, Engine>
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: join(dir, 'work'), gateway, connectors })
}

// What the pill sends: the same call a steer makes, with the reply it was written for.
const follow = (r: Runner, id: string, text: string): Promise<void> => r.send('d1', text, [], undefined, undefined, { mode: 'steer', steerTo: id })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'follow-'))
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
    language: 'en'
  } as Settings
  gateway = new Gateway()
  await gateway.start()
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: (e) => events.push(e), openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

afterEach(async () => {
  await connectors.closeAll()
  await gateway.stop()
})

describe('a reply that has ended', () => {
  it('goes on from where it stopped: the same row, its text and steps kept, and its session resumed', async () => {
    const { engine, turns } = recorder({ sessions: true })
    const r = runnerWith(engine)
    await r.send('d1', 'look at what is missing')
    await r.idle()
    const first = agentMessages()[0]!
    expect(first.run?.status).toBe('done')
    const said = first.text
    const before = first.run!.steps.length

    await follow(r, first.id, 'also do the second part')
    await r.idle()

    expect(agentMessages()).toHaveLength(1) // the same reply, never a second one beside it
    expect(mine()).toHaveLength(1) // and nothing of the person's was posted
    const now = agentMessages()[0]!
    expect(now.text).toContain(said) // what it had said is still the first of its paragraphs
    expect(now.text).toMatch(/I went on from there|Segui dali/) // and the new turn is under it
    expect(now.run?.status).toBe('done')
    // Its own steps, then the instruction as a row of its own, then the new turn's work.
    expect(now.run!.steps.length).toBeGreaterThan(before + 1)
    const row = now.run!.steps.find((s) => s.kind === 'steer' && s.input === 'also do the second part')
    expect(row?.status).toBe('done')
    expect(now.run!.steps.indexOf(row!)).toBe(before) // right after what it had done
    // The session it ended with is the one resumed, with only this instruction sent to it.
    expect(turns).toHaveLength(2)
    expect(turns[1]!.session?.resume).toBe(true)
    expect(turns[1]!.session?.id).toBe(turns[0]!.session?.id)
    expect(turns[1]!.prompt).toContain('also do the second part')
  })

  it("handed its own answer when the engine has no session to resume", async () => {
    const { engine, turns } = recorder()
    const r = runnerWith(engine)
    await r.send('d1', 'look at what is missing')
    await r.idle()
    const first = agentMessages()[0]!
    expect(first.run?.status).toBe('done')

    await follow(r, first.id, 'also do the second part')
    await r.idle()

    expect(turns).toHaveLength(2)
    expect(turns[1]!.session).toBeUndefined() // no session to resume
    // Its last answer is the message this turn answers, so it travels with the task: the engine would
    // otherwise be asked to carry on from something it cannot see.
    expect(turns[1]!.prompt).toMatch(/Your last reply in this conversation, which you carry on now, was:|A sua última resposta nesta conversa, que você continua agora, foi:/)
    expect(turns[1]!.prompt).toContain(first.text)
    expect(turns[1]!.prompt).toContain('also do the second part')
  })

  it('is steered, not restarted, while it is still working', async () => {
    const { engine, turns } = recorder()
    const r = runnerWith(engine)
    await r.send('d1', 'start, demore 1 s')
    const running = agentMessages()[0]!
    await follow(r, running.id, 'change of plan')
    expect(agentMessages()).toHaveLength(1) // no second reply, and nothing restarted
    expect(turns).toHaveLength(1)
    const chain = agentMessages()[0]!.run!.steps
    expect(chain.some((s) => s.kind === 'steer' && s.input === 'change of plan')).toBe(true)
    await r.idle()
  })

  it('nothing follows a reply that is not there, is not an agent’s, or never ended that way', async () => {
    const r = runnerWith(fakeEngine('claude', { delayMs: 1 }))
    await r.send('d1', 'look at what is missing')
    await r.idle()
    const first = agentMessages()[0]!

    // An id nobody has: the words come out as an ordinary prompt of the person's, as they always did.
    await follow(r, 'nope', 'this belongs to no reply')
    await r.idle()
    expect(mine()).toHaveLength(2)

    // A message of the person's is not a reply to go on from: again, theirs.
    await follow(r, mine()[0]!.id, 'and this one either')
    await r.idle()
    expect(mine()).toHaveLength(3)

    // Empty words do nothing at all.
    await follow(r, first.id, '   ')
    await r.idle()
    expect(mine()).toHaveLength(3)
    expect(agentMessages()).toHaveLength(3)
  })
})
