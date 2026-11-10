// A follow up: a reply that has ended goes on where it stopped, with an instruction. The same row keeps
// working (its text and its steps stay, the instruction becomes a row of its own), and the session it
// ended with is resumed, so the new turn carries the instruction and the past comes from the cache
// instead of being written to the model again. See `followUp` in src/core/runs.ts.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { setLang } from '../src/shared/lang'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

let dir: string
let db: Db
let events: CoreEvent[]
let settings: Settings

const DEMO = 1_000_000

const agent = (): Agent => ({
  id: 'a1',
  name: 'Lia',
  handle: 'lia',
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: DEMO,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false
})

const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

// An engine that keeps what each turn was given, so a test can say what the model saw and whether the
// session went on or started over. `sessions` false: an engine that can't keep one at all.
function recorded(turns: Turn[], opts: { sessions?: boolean } = {}): Engine {
  const base = fakeEngine('claude', {
    delayMs: 1,
    sessions: opts.sessions !== false,
    reply: (turn) => (turn.prompt.includes('segunda parte') ? 'Segunda parte pronta.' : 'Primeira parte pronta.')
  })
  return {
    id: 'claude',
    ...(opts.sessions === false ? {} : { sessions: true }),
    async *run(turn) {
      turns.push(turn)
      yield* base.run(turn)
    }
  }
}

function runnerWith(engine: Engine): Runner {
  const engines = { claude: engine, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') } as Record<EngineId, Engine>
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: join(dir, 'work') })
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
// Until the reply on screen is working, without guessing a delay.
async function untilWorking(ms = 3000): Promise<Message> {
  for (let i = 0; i < ms / 25; i++) {
    const m = replies()[0]
    if (m?.run?.status === 'working') return m
    await wait(25)
  }
  throw new Error('no reply started')
}

beforeEach(() => {
  setLang('en')
  dir = mkdtempSync(join(tmpdir(), 'followup-'))
  db = new Db(join(dir, 'test.db'))
  events = []
  const ready = { installed: true, loggedIn: true }
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
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

afterEach(() => setLang('pt'))

describe('a reply that goes on from where it stopped', () => {
  it('goes on in the same reply, keeping what it said and did, and resumes its session', async () => {
    const turns: Turn[] = []
    const r = runnerWith(recorded(turns))
    await r.send('d1', 'faça a primeira parte')
    await r.idle()
    const first = replies()[0]!
    expect(first.run?.status).toBe('done')
    expect(first.text).toBe('Primeira parte pronta.')
    const stepsBefore = first.run!.steps.length

    r.followUp(first.id, 'agora a segunda parte: feche com uma linha')
    await r.idle()

    // One reply, not two: it isn't a message of its own.
    expect(replies()).toHaveLength(1)
    const after = db.message(first.id)!
    expect(after.id).toBe(first.id)
    // What it had said stays, and the new turn goes under it.
    expect(after.text).toBe('Primeira parte pronta.\n\nSegunda parte pronta.')
    expect(after.run?.status).toBe('done')
    // Its steps stay, and the instruction is a row of the person's own before the new ones.
    expect(after.run!.steps.length).toBeGreaterThan(stepsBefore)
    const row = after.run!.steps.find((s) => s.kind === 'followup')!
    expect(row.label).toBe('You asked it to go on')
    expect(row.detail).toBe('agora a segunda parte: feche com uma linha')
    expect(after.run!.steps.indexOf(row)).toBe(stepsBefore)
    // The turn is told it's a continuation, and where to go: not a fresh ask that repeats the old one.
    expect(turns[1]!.prompt).toContain('This carries on from your last reply in this conversation')

    // The session went on: same id, resumed, and only the new work was sent — not the whole history again.
    expect(turns).toHaveLength(2)
    expect(turns[1]!.session?.resume).toBe(true)
    expect(turns[1]!.session?.id).toBe(turns[0]!.session?.id)
    expect(turns[1]!.prompt).toContain('agora a segunda parte: feche com uma linha')
    expect(turns[1]!.prompt).not.toContain('faça a primeira parte')
    expect(turns[1]!.prompt).not.toContain('Primeira parte pronta.') // the past came from the cache
  })

  it('an engine that keeps no session gets the past reply with the instruction, so it can still follow it', async () => {
    const turns: Turn[] = []
    const r = runnerWith(recorded(turns, { sessions: false }))
    await r.send('d1', 'faça a primeira parte')
    await r.idle()
    const first = replies()[0]!

    r.followUp(first.id, 'agora a segunda parte')
    await r.idle()

    expect(replies()).toHaveLength(1)
    expect(db.message(first.id)!.text).toBe('Primeira parte pronta.\n\nSegunda parte pronta.')
    // No session: what the reply had said is the message being answered, so it rides with the task.
    expect(turns[1]!.session).toBeUndefined()
    expect(turns[1]!.prompt).toContain('agora a segunda parte')
    expect(turns[1]!.prompt).toContain('Primeira parte pronta.')
  })

  it('is offered only for a reply that ended: a running one is steered, not followed up', async () => {
    const turns: Turn[] = []
    const r = runnerWith(recorded(turns))
    await r.send('d1', 'demore 2 s')
    const working = await untilWorking()
    r.followUp(working.id, 'não devia entrar')
    await r.idle()
    expect(turns).toHaveLength(1) // no second turn was started
    expect(db.message(working.id)!.run!.steps.some((s) => s.kind === 'followup')).toBe(false)
  })

  it('ignores an empty instruction, an unknown reply, and a message that is not an agent reply', async () => {
    const turns: Turn[] = []
    const r = runnerWith(recorded(turns))
    await r.send('d1', 'faça a primeira parte')
    await r.idle()
    const first = replies()[0]!
    const mine = db.messages().find((m) => m.author.kind === 'person')!
    r.followUp(first.id, '   ')
    r.followUp('nao-existe', 'qualquer coisa')
    r.followUp(mine.id, 'qualquer coisa')
    await r.idle()
    expect(turns).toHaveLength(1)
    expect(db.message(first.id)!.text).toBe('Primeira parte pronta.')
  })
})
