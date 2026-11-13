// Check-ins: the clock, the admission rules, and what a quiet one leaves behind. One fake engine, so
// the runner's real path runs (sessions, queue, receipts) without spawning anything.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { backoffMinutes, dayStartIn, isQuiet, type InitiativeInput } from '../src/shared/initiative'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Heartbeat } from '../src/core/initiative-heartbeat'
import { Initiative } from '../src/core/initiative'
import { admit, dueAt, heartbeatTask } from '../src/core/initiative-state'
import { People } from '../src/core/people'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  handle: id,
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 10_000_000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false,
  ...extra
})

let db: Db
let people: People
let initiative: Initiative
let runner: Runner
let heartbeat: Heartbeat
let gateway: Gateway
let events: CoreEvent[]
let settings: Settings
let reply = ''
let delay = 2
let clock = Date.UTC(2026, 10, 13, 10, 0, 0)
let dm: string
let turns: string[] = []
let told: { title: string; body: string }[] = []

const engines = (): Record<EngineId, Engine> => {
  const one = (id: EngineId): Engine =>
    fakeEngine(id, {
      delayMs: delay,
      reply: (turn) => {
        turns.push(turn.prompt)
        return reply
      }
    })
  return { claude: one('claude'), codex: one('codex'), opencode: one('opencode'), pi: one('pi'), antigravity: one('antigravity'), cursor: one('cursor'), grok: one('grok'), cline: one('cline'), hermes: one('hermes') }
}

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-init-')), 'test.db'))
  people = new People(db)
  initiative = new Initiative(db, people)
  events = []
  reply = ''
  delay = 2
  clock = Date.UTC(2026, 10, 13, 10, 0, 0)
  turns = []
  told = []
  settings = {
    workspaceName: 'Ana',
    context: '',
    engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready },
    routerModel: 'haiku',
    memoryModel: 'haiku',
    memory: 'off',
    chainDepth: 3
  } as unknown as Settings
  db.saveAgent(agent('lia'))
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'], owner: db.ownerId() })
  dm = 'dm'
  gateway = new Gateway()
  await gateway.start()
  runner = new Runner({ db, engines: engines(), settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-init-work-')), gateway })
  heartbeat = new Heartbeat({
    db,
    runner,
    initiative,
    settings: () => settings,
    people: () => db.people(),
    notify: (title, body) => told.push({ title, body }),
    now: () => clock
  })
  return () => gateway.stop()
})

const config = (over: Partial<InitiativeInput> = {}): InitiativeInput => ({
  agentId: 'lia',
  conversationId: dm,
  enabled: true,
  brief: 'Watch the invoice thread and answer the client.',
  observe: { conversations: [] },
  work: { conversations: [], kinds: [] },
  cadenceMinutes: 15,
  notify: 'material',
  dailyReviews: 24,
  dailyTokens: 2_000_000,
  timezone: 'Europe/Sofia',
  ...over
})

// A config saved at `clock`, and a moment a cadence later, when its first check-in is due.
const turnedOn = (over: Partial<InitiativeInput> = {}): { saved: ReturnType<Initiative['save']>; due: number } => {
  const saved = initiative.save(db.owner(), config(over), 0, clock)
  return { saved, due: saved.updatedAt + (over.cadenceMinutes ?? 15) * 60_000 + 1 }
}

const visible = (conversationId = dm): Message[] => db.openingMessages(100).messages.filter((m) => m.conversationId === conversationId)

describe('the rules on their own', () => {
  it('waits a cadence, then a cadence doubled for each quiet check-in, up to two hours', () => {
    expect(backoffMinutes(15, 0)).toBe(15)
    expect(backoffMinutes(15, 1)).toBe(30)
    expect(backoffMinutes(15, 3)).toBe(120)
    expect(backoffMinutes(15, 12)).toBe(120)
  })

  it('counts a day where the person is, not where the computer is', () => {
    const noon = Date.UTC(2026, 10, 13, 10, 0, 0) // 12:00 in Sofia, 10:00 UTC
    expect(dayStartIn('Europe/Sofia', noon)).toBe(Date.UTC(2026, 10, 12, 22, 0, 0))
    const late = Date.UTC(2026, 10, 13, 22, 30, 0) // 00:30 in Sofia: already the next day there
    expect(dayStartIn('Europe/Sofia', late)).toBe(Date.UTC(2026, 10, 13, 22, 0, 0))
  })

  it('reads the marker only when it is the whole answer', () => {
    expect(isQuiet('[[quiet]]')).toBe(true)
    expect(isQuiet('**[[QUIET]]**\n')).toBe(true)
    expect(isQuiet('[[quiet]]\nThe invoice is still unpaid.')).toBe(false)
    expect(isQuiet('')).toBe(false)
  })

  it('writes a bounded request: the brief, what is owed, and the one rule that keeps it quiet', () => {
    const { saved } = turnedOn()
    const task = heartbeatTask(saved, [], 'Ana')
    expect(task).toContain('Watch the invoice thread and answer the client.')
    expect(task).toContain('[[quiet]]')
    expect(task.length).toBeLessThan(4_000)
  })

  it('refuses before the cadence, at the cap, and past the allowance', () => {
    const { saved, due } = turnedOn({ dailyReviews: 2 })
    const base = { config: saved, now: due, quietStreak: 0, reviewsToday: 0, tokensToday: 0, busy: false, paused: false, quietHours: false }
    expect(admit({ ...base, now: due - 2 })).toEqual({ run: false, why: 'not-due' })
    expect(admit(base)).toMatchObject({ run: true })
    expect(admit({ ...base, reviewsToday: 2 })).toEqual({ run: false, why: 'cap' })
    expect(admit({ ...base, tokensToday: saved.dailyTokens })).toEqual({ run: false, why: 'allowance' })
    expect(admit({ ...base, paused: true })).toEqual({ run: false, why: 'paused' })
    expect(admit({ ...base, quietHours: true })).toEqual({ run: false, why: 'quiet-hours' })
    expect(admit({ ...base, busy: true })).toEqual({ run: false, why: 'busy' })
    expect(dueAt(saved, due, 1)).toBe(due + 30 * 60_000) // one quiet in a row doubled it
  })
})

describe('a check-in', () => {
  it('finds nothing, says nothing, and keeps what it did to itself', async () => {
    const { due } = turnedOn()
    reply = '[[quiet]]'
    clock = due
    const ran = await heartbeat.tick(due)
    expect(ran.map((w) => w.outcome)).toEqual(['quiet'])
    // The conversation is untouched: no bubble, no unread, nothing to page back through.
    expect(visible()).toEqual([])
    const wake = db.wakes(db.ownerId())[0]!
    expect(wake).toMatchObject({ outcome: 'quiet', revision: 1, personId: db.ownerId() })
    expect(wake.messageId).toBeDefined()
    expect(wake.endedAt).toBeGreaterThan(0)
    // The reply itself is still there, hidden, as the record of what it said.
    expect(db.message(wake.messageId!)).toMatchObject({ hidden: true, text: '[[quiet]]' })
    expect(db.conversation(dm)?.unread).toBe(0)
  })

  it('says what it found, and then it is a message like any other', async () => {
    const { due } = turnedOn()
    reply = 'The invoice is still unpaid. I asked the client for the number.'
    clock = due
    const ran = await heartbeat.tick(due)
    expect(ran[0]).toMatchObject({ outcome: 'reported' })
    const shown = visible()
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ text: reply, author: { kind: 'agent', id: 'lia' } })
    expect(shown[0]!.hidden).toBeUndefined()
    expect(events.filter((e) => e.type === 'message' && (e as { message: Message }).message.id === shown[0]!.id).length).toBeGreaterThan(0)
    expect(db.wakes(db.ownerId())[0]!.text).toBe(reply)
  })

  it('runs once however often the clock looks, and waits its cadence after', async () => {
    const { due } = turnedOn()
    reply = '[[quiet]]'
    clock = due
    expect((await heartbeat.tick(due)).length).toBe(1)
    for (let i = 0; i < 5; i++) expect(await heartbeat.tick(due + i * 1_000)).toEqual([])
    expect(db.wakes(db.ownerId()).filter((w) => w.outcome !== 'skipped')).toHaveLength(1)
    // A quiet one doubled the wait: 30 minutes, not 15.
    const next = heartbeat.dueAtFor(db.owner(), db.initiative(db.ownerId(), 'lia')!)!
    expect(next).toBe(due + 30 * 60_000)
    expect(await heartbeat.tick(next - 1)).toEqual([])
    expect((await heartbeat.tick(next + 1)).length).toBe(1)
  })

  it('stops at the day\'s reviews, and at the allowance it was given', async () => {
    const { due } = turnedOn({ dailyReviews: 1 })
    reply = 'Something worth reading.'
    clock = due
    expect((await heartbeat.tick(due)).length).toBe(1)
    const next = heartbeat.dueAtFor(db.owner(), db.initiative(db.ownerId(), 'lia')!)!
    // The next is due, but today's one review is spent.
    expect(await heartbeat.tick(next + 1)).toEqual([])
    expect(db.wakes(db.ownerId())).toHaveLength(1)
  })

  it('starts the wait over when the person edits the brief, instead of running the old one', async () => {
    turnedOn()
    reply = 'should never be sent'
    // Edited before its turn: the cadence counts from the edit, and the old brief's moment is not one.
    const edited = initiative.save(db.owner(), config({ brief: 'Something else entirely.' }), 1)
    expect(edited.revision).toBe(2)
    clock = edited.updatedAt + 15 * 60_000 - 1
    expect(await heartbeat.tick(clock)).toEqual([])
    expect(db.wakes(db.ownerId())).toEqual([])
    // Its own moment, 15 minutes after the edit, still runs.
    expect((await heartbeat.tick(edited.updatedAt + 15 * 60_000 + 1)).length).toBe(1)
  })

  it('does nothing at all while the app is paused', async () => {
    const { due } = turnedOn()
    reply = 'anything'
    runner.setPaused(true)
    clock = due
    expect(await heartbeat.tick(due)).toEqual([])
    expect(db.wakes(db.ownerId())).toEqual([])
    // And a check-in taken straight to the runner refuses, saying why.
    const skipped = await runner.checkIn({ personId: db.ownerId(), revision: 1, wake: 'w1', agent: db.agent('lia')!, conversation: db.conversation(dm)!, task: 'x' })
    expect(skipped).toEqual({ outcome: 'skipped', why: 'paused' })
  })

  it('runs again after its session was let go, and after the app forgot them all', async () => {
    const { due } = turnedOn()
    reply = '[[quiet]]'
    clock = due
    expect((await heartbeat.tick(due)).length).toBe(1)
    runner.forgetSessions({ conversationId: dm })
    const next = heartbeat.dueAtFor(db.owner(), db.initiative(db.ownerId(), 'lia')!)!
    clock = next
    expect((await heartbeat.tick(next)).length).toBe(1)
    expect(db.wakes(db.ownerId()).filter((w) => w.outcome === 'quiet')).toHaveLength(2)
  })

  it('sits behind a person talking to the same bot, and leaves their exchange alone', async () => {
    const { due } = turnedOn()
    delay = 30
    reply = '[[quiet]]'
    clock = due
    const sent = runner.send(dm, 'quick question')
    // The person speaks first, and the check-in that was due steps back for it: a review of a thread they
    // are in the middle of waits, and their turn never queues behind the coordinator's.
    expect((await heartbeat.tick(due)).length).toBe(0)
    await sent
    await runner.idle()
    expect(turns).toHaveLength(1)
    expect(turns[0]).toContain('quick question')
    // The next one, now that they have been answered, goes ahead.
    clock = due + 16 * 60_000
    expect((await heartbeat.tick(clock)).length).toBe(1)
    expect(turns).toHaveLength(2)
    expect(turns[1]).toContain('Watch the invoice thread')
    // The person's reply is the only thing in the DM: the check-in found nothing and left nothing.
    const shown = visible()
    expect(shown.filter((m) => m.author.kind === 'person').map((m) => m.text)).toEqual(['quick question'])
    expect(db.wakes(db.ownerId()).map((w) => w.outcome)).toEqual(['quiet'])
    expect(typeof db.wakes(db.ownerId())[0]!.tokens).toBe('number')
  })

  it('wakes once when the work it handed out comes back, and reads what changed', async () => {
    const { saved } = turnedOn()
    db.saveDelegation({
      id: 'del-1',
      from: 'lia',
      to: 'lia',
      conversationId: dm,
      rootId: 'r-1',
      originConversationId: dm,
      originMessageId: 'm-1',
      requestedBy: db.ownerId(),
      text: 'get the number from the client',
      state: 'open',
      createdAt: clock
    })
    initiative.saveCommitment(db.owner(), {
      agentId: 'lia',
      conversationId: dm,
      by: 'person',
      description: 'Send the client the number they asked for.',
      scope: { conversations: [], kinds: [] },
      links: [{ kind: 'delegation', id: 'del-1' }]
    })
    expect(db.commitments(db.ownerId())[0]).toMatchObject({ state: 'waiting_external' })
    reply = '[[quiet]]'
    // Inside the cadence: only news gets a check-in here, and being asked to wait is not news.
    clock = saved.updatedAt + 60_000
    expect(await heartbeat.tick(clock)).toEqual([])
    db.saveDelegation({ ...db.delegation('del-1')!, state: 'done', result: 'm-9', endedAt: clock })
    const ran = await heartbeat.tick(clock += 60_000)
    expect(ran.map((w) => w.outcome)).toEqual(['quiet'])
    expect(turns.at(-1)).toMatch(/Mudou desde|Changed since/)
    expect(db.commitments(db.ownerId())[0]!.state).toBe('open')
    // Read once: the next ticks have no news in them, and the cadence is what is left.
    expect(await heartbeat.tick(clock += 60_000)).toEqual([])
    expect(await heartbeat.tick(clock += 6 * 60_000)).toEqual([])
  })

  it('does not ask the person again while their answer is what it is waiting on', async () => {
    const { saved } = turnedOn()
    reply = '[[quiet]]'
    clock = saved.updatedAt + 15 * 60_000 + 1
    expect((await heartbeat.tick(clock)).length).toBe(1)
    // During that check-in the bot asked the person something, and took the answer as what it waits on.
    db.saveQuestion({
      id: 'q-1',
      conversationId: dm,
      agentId: 'lia',
      text: 'Which number do I send?',
      askedTo: db.ownerId(),
      requestedBy: db.ownerId(),
      state: 'open',
      deadlineAt: clock + 10 ** 9,
      createdAt: clock
    })
    initiative.saveCommitment(db.owner(), {
      agentId: 'lia',
      conversationId: dm,
      by: 'agent',
      description: 'Send the client the number they asked for.',
      scope: { conversations: [], kinds: [] },
      links: [{ kind: 'question', id: 'q-1' }]
    })
    expect(db.commitments(db.ownerId())[0]!.state).toBe('waiting_user')
    // The cadence alone would call it due in 30 minutes; an unanswered question of its own holds it to
    // two hours, because asking a second time helps nobody.
    expect(await heartbeat.tick(clock + 90 * 60_000)).toEqual([])
    expect((await heartbeat.tick(clock + 121 * 60_000)).length).toBe(1)
  })

  it('reaches the person once for a report, and never for a quiet one', async () => {
    const { due } = turnedOn()
    reply = '[[quiet]]'
    clock = due
    await heartbeat.tick(due)
    expect(told).toEqual([])
    reply = '**The invoice is still unpaid.** I asked the client for the number.'
    const next = heartbeat.dueAtFor(db.owner(), db.initiative(db.ownerId(), 'lia')!)!
    clock = next
    await heartbeat.tick(next)
    expect(told).toHaveLength(1)
    expect(told[0]!.title).toMatch(/lia|Lia/)
    // The notification carries the first line, without the markdown around it.
    expect(told[0]!.body).toContain('The invoice is still unpaid.')
    expect(told[0]!.body).not.toContain('**')
  })

  it('keeps a report that repeats the one before it out of the conversation, and says why', async () => {
    const { due } = turnedOn()
    reply = 'The invoice is still unpaid.'
    clock = due
    expect((await heartbeat.tick(due)).length).toBe(1)
    expect(visible()).toHaveLength(1)
    // The same finding, wrapped differently: not news, so not delivered.
    reply = '**The invoice is still unpaid.**'
    const next = heartbeat.dueAtFor(db.owner(), db.initiative(db.ownerId(), 'lia')!)!
    clock = next
    const ran = await heartbeat.tick(next)
    expect(ran[0]).toMatchObject({ outcome: 'reported', deduped: true })
    expect(visible()).toHaveLength(1)
    expect(told).toHaveLength(1)
    // The record keeps what it said, so the page can explain why nothing appeared.
    expect(db.wakes(db.ownerId())[0]!.deduped).toBe(true)
    // A day later the same words are a new finding, if it says them again.
    clock = next + 25 * 3_600_000
    const later = await heartbeat.tick(clock)
    expect(later[0]?.deduped).toBeUndefined()
  })

  it('looks right now when the person asks, and says what stopped it when it cannot', async () => {
    const { saved } = turnedOn()
    reply = '[[quiet]]'
    // Nothing is due for fifteen minutes, and the person asks anyway.
    clock = saved.updatedAt + 60_000
    expect(await heartbeat.tick(clock)).toEqual([])
    expect(heartbeat.startNow(db.owner(), 'lia')).toEqual({ started: true })
    // One at a time: the button refuses while that one is still going.
    expect(heartbeat.startNow(db.owner(), 'lia')).toEqual({ started: false, why: 'busy' })
    await runner.idle()
    await new Promise((r) => setTimeout(r, 20))
    expect(db.wakes(db.ownerId()).map((w) => w.outcome)).toEqual(['quiet'])
    expect(heartbeat.running(db.ownerId())).toBe(false)
    // Paused: nothing starts, and the reason is the one a person can act on.
    runner.setPaused(true)
    expect(heartbeat.startNow(db.owner(), 'lia')).toEqual({ started: false, why: 'paused' })
    runner.setPaused(false)
    // The day's reviews spent: it says so instead of spending more.
    const cap = db.initiative(db.ownerId(), 'lia')!
    initiative.save(db.owner(), { ...cap, enabled: true, dailyReviews: 1 } as unknown as InitiativeInput, cap.revision)
    expect(heartbeat.startNow(db.owner(), 'lia')).toEqual({ started: false, why: 'cap' })
  })

  it('keeps a failed one out of the conversation, and says so in its record', async () => {
    const { due } = turnedOn()
    db.saveAgent(agent('lia', { limit: 1_000 }))
    clock = due
    // Its whole month is spent: the runner stops before spawning anything.
    db.addReceipt({ messageId: 'x', agentId: 'lia', engine: 'claude', model: 'sonnet', inputTokens: 10_000_000, cacheReadTokens: 0, outputTokens: 1_000, ms: 1, at: Date.now() })
    const ran = await heartbeat.tick(due)
    expect(ran.map((w) => w.outcome)).toEqual(['failed'])
    expect(visible()).toEqual([])
    expect(db.wakes(db.ownerId())[0]!.why).toBe('error')
    expect(db.wakes(db.ownerId())[0]!.text).toContain('limite')
  })
})
