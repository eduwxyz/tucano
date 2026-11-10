import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Followups, replyKey } from '../src/core/followups'
import { Gateway } from '../src/core/gateway'
import { handoffSystem, routerSystem } from '../src/core/router'
import { ROUTED_STALE_MS, Runner } from '../src/core/runs'
import { setLang } from '../src/shared/lang'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra
})

let db: Db
let settings: Settings
let gateway: Gateway
let held: () => Promise<void>

// The fake engine, with a hold on the first reply a test names: nothing advances until it lets go.
function runner(opts: { routeCheckMs?: number } = {}): Runner {
  const base = fakeEngine('claude', { delayMs: 1 })
  const claude: Engine = {
    id: 'claude',
    async *run(t) {
      if (t.system !== routerSystem() && t.system !== handoffSystem()) await held()
      yield* base.run(t)
    }
  }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') }
  return new Runner({
    db,
    engines,
    settings: async () => settings,
    emit: () => {},
    workDir: mkdtempSync(join(tmpdir(), 'rw-work-')),
    gateway,
    ...(opts.routeCheckMs !== undefined ? { routeCheckMs: opts.routeCheckMs } : {})
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const mine = (): Message[] => db.messages().filter((m) => m.author.kind === 'person')
const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')
const said = (): string => db.messages().filter((m) => m.author.kind === 'system').map((m) => m.text).join('\n')
const dump = (): string => db.messages().map((m) => `${m.author.kind}${m.author.kind === 'agent' ? `:${m.author.id}` : ''} t=${m.threadId ?? '-'} s=${m.run?.status ?? '-'} :: ${m.text.slice(0, 60).replace(/\n/g, ' ')}`).join('\n')

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'rw-db-')), 'test.db'))
  setLang('en')
  held = async (): Promise<void> => {}
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  db.saveAgent(agent('a1', 'lia', { role: 'Engineering' }))
  db.saveAgent(agent('a2', 'theo', { role: 'Data' }))
  // The channel answers in threads, as the one this was reported in does.
  db.createConversation({ id: 'c1', kind: 'channel', name: 'deep-work', members: ['a1', 'a2'], threads: true })
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

// A thread both messages go in: the reply being waited for and the routed one share a place.
const root = (): Message => {
  const m: Message = { id: 'root', conversationId: 'c1', author: { kind: 'person', id: db.ownerId() }, text: 'the plan for the week', at: 1 }
  db.saveMessage(m)
  return m
}

// Whatever the router picks, the place it waits for is the same one: the thread both messages go in.
const markBusy = (r: Runner): void => {
  const inner = r as unknown as { followups: Followups }
  inner.followups.reserve(replyKey('a1', 'c1', 'root'))
  inner.followups.reserve(replyKey('a2', 'c1', 'root'))
}

describe('a routed reply waiting for the reply already running in that thread', () => {
  it('waits for it, then answers', async () => {
    const r = runner()
    root()
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => (release = res))
    let holds = 1 // the first reply only: the routed one must finish on its own
    held = async (): Promise<void> => {
      if (holds-- > 0) await gate
    }
    await r.send('c1', '@lia take your time with the build', [], 'root')
    await sleep(40) // it's running, and not letting go
    await r.send('c1', 'the build is red again', [], 'root') // no mention: the router picks one
    await sleep(150)
    expect(replies(), dump()).toHaveLength(1) // the routed one waits for the place to free
    expect(said()).toMatch(/Called \*\*(Lia|Theo)\*\*/)
    expect(said()).not.toContain('going now')

    release()
    await r.idle()
    expect(replies(), dump()).toHaveLength(2)
    expect(replies().every((m) => m.threadId === 'root')).toBe(true)
    expect(said()).not.toContain('going now') // it wasn't late: the place was free again in time
  })

  it('answers when the place is marked busy and no reply holds it, and says so', async () => {
    const r = runner({ routeCheckMs: 40 })
    root()
    // A mark nothing holds: a reservation whose reply was dropped, or a start whose end never came.
    // Nothing will ever call startWaiting for it, so before this the routed reply waited for ever.
    markBusy(r)
    await r.send('c1', 'the build is red again', [], 'root')
    await sleep(1_000)
    expect(said()).toMatch(/· the one before stopped without finishing, going now/)
    expect(replies(), dump()).toHaveLength(1)
    expect(replies()[0]?.run?.status).toBe('done')
  })

  it('keeps waiting while a reply really holds the place, check after check', async () => {
    const r = runner({ routeCheckMs: 40 })
    root()
    held = (): Promise<void> => new Promise(() => {}) // a reply that never ends
    await r.send('c1', '@lia take your time with the build', [], 'root')
    await sleep(40)
    await r.send('c1', 'the build is red again', [], 'root')
    await sleep(400) // ten checks later
    expect(replies(), dump()).toHaveLength(1) // it isn't cut off: the one before is still working
    expect(said()).not.toContain('going now')
  }, 20_000)

  it('looks every thirty seconds unless the app says otherwise', () => {
    expect(ROUTED_STALE_MS).toBe(30_000)
  })
})
