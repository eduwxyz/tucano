// Recovery: what the app did not survive, what a late run may not rewrite, and a delivery that fails
// without taking the record of what the check-in did with it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EngineId, Message } from '../src/shared/types'
import type { InitiativeInput } from '../src/shared/initiative'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Heartbeat } from '../src/core/initiative-heartbeat'
import { Initiative } from '../src/core/initiative'
import { People } from '../src/core/people'
import { Runner } from '../src/core/runs'
import type { Settings } from '../src/shared/types'

// The same harness the check-in tests use: one fake engine, the runner's real path, a clock we hold.
type Rig = { db: Db; people: People; initiative: Initiative; runner: Runner; heartbeat: Heartbeat; dm: string; set: (over: Partial<InitiativeInput>) => { due: number }; at: (n: number) => void; turns: string[]; told: string[]; reply: (t: string) => void; delay: (ms: number) => void; clock: () => number; visible: () => Message[] }

const arm = async (): Promise<Rig> => {
  let clock = Date.UTC(2026, 10, 13, 10, 0, 0)
  let reply = ''
  let delay = 2
  const turns: string[] = []
  const told: string[] = []
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-recover-')), 'test.db'))
  const people = new People(db)
  const initiative = new Initiative(db, people)
  const settings = {
    workspaceName: 'Ana',
    context: '',
    engines: { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true }, opencode: { installed: true, loggedIn: true }, pi: { installed: true, loggedIn: true }, antigravity: { installed: true, loggedIn: true }, cursor: { installed: true, loggedIn: true }, grok: { installed: true, loggedIn: true }, cline: { installed: true, loggedIn: true }, hermes: { installed: true, loggedIn: true } },
    routerModel: 'haiku',
    memoryModel: 'haiku',
    memory: 'off',
    chainDepth: 3
  } as unknown as Settings
  const one = (id: EngineId): Engine =>
    fakeEngine(id, {
      delayMs: delay,
      reply: (turn) => {
        turns.push(turn.prompt)
        return reply
      }
    })
  const engines = (): Record<EngineId, Engine> => ({ claude: one('claude'), codex: one('codex'), opencode: one('opencode'), pi: one('pi'), antigravity: one('antigravity'), cursor: one('cursor'), grok: one('grok'), cline: one('cline'), hermes: one('hermes') })
  db.saveAgent({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 10_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'], owner: db.ownerId() })
  const gateway = new Gateway()
  await gateway.start()
  const runner = new Runner({ db, engines: engines(), settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-rec-work-')), gateway })
  const heartbeat = new Heartbeat({ db, runner, initiative, settings: () => settings, people: () => db.people(), notify: (title, body) => told.push(`${title}: ${body}`), now: () => clock })
  return {
    db,
    people,
    initiative,
    runner,
    heartbeat,
    dm: 'dm',
    set: (over) => {
      const saved = initiative.save(db.owner(), { agentId: 'lia', conversationId: 'dm', enabled: true, brief: 'Watch the invoice thread.', observe: { conversations: [] }, work: { conversations: [], kinds: [] }, cadenceMinutes: 15, notify: 'material', dailyReviews: 24, dailyTokens: 2_000_000, timezone: 'Europe/Sofia', ...over }, db.initiative(db.ownerId(), over.agentId ?? 'lia')?.revision ?? 0)
      return { due: saved.updatedAt + (over.cadenceMinutes ?? 15) * 60_000 + 1 }
    },
    at: (n) => {
      clock = n
    },
    turns,
    told,
    reply: (t) => {
      reply = t
    },
    delay: (ms) => {
      delay = ms
    },
    clock: () => clock,
    visible: () => db.openingMessages(100).messages.filter((m) => m.conversationId === 'dm')
  }
}

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 30))
}

describe('what the app did not survive', () => {
  it('closes a check-in that started and never ended, and leaves a fresh one alone', async () => {
    const rig = await arm()
    rig.set({})
    const now = rig.clock()
    // A run from a previous life of the app: it started, and nothing ended it.
    rig.db.saveWake({ id: 'lost', personId: rig.db.ownerId(), agentId: 'lia', revision: 1, at: now - 40 * 60_000, outcome: 'interrupted', tokens: 0 })
    // One that started a minute ago is a check-in actually running: not ours to close.
    rig.db.saveWake({ id: 'live', personId: rig.db.ownerId(), agentId: 'lia', revision: 1, at: now - 60_000, outcome: 'interrupted', tokens: 0 })
    expect(rig.heartbeat.recover(now)).toBe(1)
    expect(rig.db.initiativeWake('lost')).toMatchObject({ outcome: 'interrupted', endedAt: now })
    expect(rig.db.initiativeWake('live')!.endedAt).toBeUndefined()
    // Idempotent: a second start of the app has nothing left to close.
    expect(rig.heartbeat.recover(now)).toBe(0)
    // And a page reading the record sees nothing "checking now" from it.
    const view = rig.initiative.view(rig.db.owner(), 'lia', now)
    expect(view.wakes.find((w) => w.id === 'lost')?.endedAt).toBe(now)
  })

  it('never lets a late run finish a claim the app already closed', async () => {
    const rig = await arm()
    rig.set({})
    let finish: (v: { outcome: 'quiet' }) => void = () => {}
    vi.spyOn(rig.runner, 'checkIn').mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    expect(rig.heartbeat.startNow(rig.db.owner(), 'lia')).toEqual({ started: true })
    const started = rig.db.wakes(rig.db.ownerId())[0]!
    expect(started.endedAt).toBeUndefined()
    // The app closed it in the meantime: a restart, a kill, an orphan sweep.
    rig.db.saveWake({ ...started, endedAt: rig.clock(), outcome: 'interrupted', why: 'error' })
    finish({ outcome: 'quiet' })
    await settle()
    // What came back is late: it does not overwrite the closed record, and it changes nothing else.
    expect(rig.db.initiativeWake(started.id)).toMatchObject({ outcome: 'interrupted', why: 'error' })
    expect(rig.db.initiativeWake(started.id)!.endedAt).toBe(rig.clock() - 0)
  })

  it('delivers a report the app closed before showing it, without running the check-in again', async () => {
    const rig = await arm()
    const { due } = rig.set({})
    rig.reply('The invoice is still unpaid.')
    rig.db.saveWake({ id: 'late', personId: rig.db.ownerId(), agentId: 'lia', revision: 1, at: due - 60_000, endedAt: due - 59_000, outcome: 'reported', text: 'The invoice is still unpaid.', tokens: 10, messageId: 'msg-late' })
    // The message it wrote is still hidden: the app ended between the record and the reveal.
    rig.db.saveMessage({ id: 'msg-late', conversationId: rig.dm, author: { kind: 'agent', id: 'lia' }, text: 'The invoice is still unpaid.', at: due - 60_000, hidden: true, run: { status: 'done', depth: 1, steps: [] } })
    rig.at(due)
    await rig.heartbeat.tick(due)
    // Nothing was asked of the engine for it: what was missing was the delivery, not the work.
    expect(rig.turns).toEqual([])
    expect(rig.db.initiativeWake('late')!.delivered).toBe(true)
    expect(rig.visible().map((m) => m.text)).toEqual(['The invoice is still unpaid.'])
    expect(rig.told).toHaveLength(1)
  })
})

describe('delivery and execution are separate', () => {
  it('records the report even when showing it fails, then delivers it on the next tick alone', async () => {
    const rig = await arm()
    const { due } = rig.set({})
    rig.reply('**The invoice is still unpaid.** I asked the client for the number.')
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The reveal throws once: the app could not put it in the conversation.
    vi.spyOn(rig.runner, 'reveal').mockImplementationOnce(() => {
      throw new Error('the window went away')
    })
    rig.at(due)
    const ran = await rig.heartbeat.tick(due)
    expect(ran[0]).toMatchObject({ outcome: 'reported' })
    expect(ran[0]!.delivered).toBeUndefined()
    expect(rig.visible()).toHaveLength(0)
    expect(rig.told).toEqual([])
    // The next tick shows it and tells the person, and the engine is asked nothing: one turn, total.
    const wake = rig.db.wakes(rig.db.ownerId())[0]!
    rig.at(due + 60_000)
    await rig.heartbeat.tick(due + 60_000)
    expect(rig.turns).toHaveLength(1)
    expect(rig.visible().map((m) => m.text)).toEqual(['**The invoice is still unpaid.** I asked the client for the number.'])
    expect(rig.db.initiativeWake(wake.id)!.delivered).toBe(true)
    expect(rig.told).toHaveLength(1)
    expect(rig.told[0]).toContain('The invoice is still unpaid.')
    warn.mockRestore()
  })

  it('does not mark the news as read when the run was cut short', async () => {
    const rig = await arm()
    rig.set({})
    rig.db.saveDelegation({ id: 'del-1', from: 'lia', to: 'lia', conversationId: rig.dm, rootId: 'r', originConversationId: rig.dm, originMessageId: 'm', requestedBy: rig.db.ownerId(), text: 'get the number', state: 'open', createdAt: 1 })
    rig.initiative.saveCommitment(rig.db.owner(), { agentId: 'lia', conversationId: rig.dm, by: 'person', description: 'Send the number.', scope: { conversations: [], kinds: [] }, links: [{ kind: 'delegation', id: 'del-1' }] })
    rig.db.saveDelegation({ ...rig.db.delegation('del-1')!, state: 'done', result: 'm9', endedAt: 2 })
    // The runner stops mid-check-in: an interrupted turn, not a finished one.
    vi.spyOn(rig.runner, 'checkIn').mockResolvedValueOnce({ outcome: 'interrupted' })
    const now = rig.clock() + 20 * 60_000
    rig.at(now)
    const ran = await rig.heartbeat.tick(now)
    expect(ran[0]).toMatchObject({ outcome: 'interrupted' })
    // Nothing was read to the end, so what it came for was not recorded as seen: the ledger still holds
    // the version from when the responsibility was saved, and the news can wake it again.
    expect(rig.db.resumeSeen(rig.db.ownerId(), 'delegation', 'del-1')).toMatch(/^open/)
    rig.reply('[[quiet]]')
    const again = await rig.heartbeat.tick(now + 6 * 60_000)
    expect(again[0]).toMatchObject({ outcome: 'quiet' })
    // The cut-short run never reached the engine; this one did, and it is the only turn.
    expect(rig.turns).toHaveLength(1)
    expect(rig.db.resumeSeen(rig.db.ownerId(), 'delegation', 'del-1')).toMatch(/^done/)
  })
})

describe('one clock, whatever happens to the app', () => {
  it('starts once and stops cleanly, so a disable and an enable never own the schedule twice', async () => {
    const rig = await arm()
    rig.set({})
    rig.heartbeat.start()
    const timer = (rig.heartbeat as unknown as { timer?: unknown }).timer
    expect(timer).toBeDefined()
    rig.heartbeat.start()
    expect((rig.heartbeat as unknown as { timer?: unknown }).timer).toBe(timer)
    rig.heartbeat.stop()
    expect((rig.heartbeat as unknown as { timer?: unknown }).timer).toBeUndefined()
    // Enabled again: a new one, and still only one.
    rig.heartbeat.start()
    expect((rig.heartbeat as unknown as { timer?: unknown }).timer).toBeDefined()
    rig.heartbeat.stop()
  })

  it('runs one check-in however many ticks look at once, and one per sleep, not one per hour', async () => {
    const rig = await arm()
    const { due } = rig.set({})
    rig.reply('[[quiet]]')
    rig.at(due + 10 * 3_600_000) // the app was asleep for ten hours
    const [a, b] = await Promise.all([rig.heartbeat.tick(due + 10 * 3_600_000), rig.heartbeat.tick(due + 10 * 3_600_000)])
    expect(a.length + b.length).toBe(1)
    expect(rig.turns).toHaveLength(1)
  })

  it('gives a second bot its own plate, so neither inherits nor closes what the other took on', async () => {
    const rig = await arm()
    rig.set({})
    const taken = rig.initiative.saveCommitment(rig.db.owner(), { agentId: 'lia', conversationId: rig.dm, by: 'person', description: 'Send the number.', scope: { conversations: [], kinds: [] } })
    // A second bot of the same person, with its own DM and its own brief: it joins, it does not replace.
    rig.db.saveAgent({ id: 'sol', name: 'Sol', handle: 'sol', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 10_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    rig.db.createConversation({ id: 'dm-sol', kind: 'dm', name: 'sol', members: ['sol'], owner: rig.db.ownerId() })
    const { due } = rig.set({ agentId: 'sol', conversationId: 'dm-sol' })
    rig.reply('[[quiet]]')
    rig.at(due)
    const ran = await rig.heartbeat.tick(due)
    expect(ran.map((w) => w.agentId).sort()).toEqual(['lia', 'sol'])
    // What each took on stays with it: one bot's plate is not the other's to read or close.
    expect(rig.initiative.view(rig.db.owner(), 'lia').commitments.map((c) => c.id)).toEqual([taken.id])
    expect(rig.initiative.view(rig.db.owner(), 'sol').commitments).toEqual([])
  })

  it('stops for a person who left, and for a bot that was archived', async () => {
    const rig = await arm()
    // A second person, with her own coordinator, leaves: hers stops with her access.
    const bia = rig.people.join(rig.people.createInvite(rig.db.owner(), { role: 'member' }).code, 'Bia')
    if ('error' in bia) throw new Error(bia.error)
    rig.db.createConversation({ id: 'dm-bia', kind: 'dm', name: 'lia', members: ['lia'], owner: bia.person.id })
    rig.initiative.save(bia.person, { agentId: 'lia', conversationId: 'dm-bia', enabled: true, brief: 'Watch the invoices.', observe: { conversations: [] }, work: { conversations: [], kinds: [] }, cadenceMinutes: 15, notify: 'material', dailyReviews: 24, dailyTokens: 2_000_000, timezone: 'Europe/Sofia' }, 0)
    expect(rig.db.initiative(bia.person.id, 'lia')!.enabled).toBe(true)
    rig.db.removePerson(bia.person.id)
    expect(rig.db.initiative(bia.person.id, 'lia')).toMatchObject({ enabled: false, revision: 2 })

    // The bot itself is archived: the owner's coordinator runs nothing through it.
    const { due } = rig.set({})
    rig.reply('[[quiet]]')
    const lia = rig.db.agent('lia')!
    rig.db.saveAgent({ ...lia, archived: true })
    rig.at(due)
    const ran = await rig.heartbeat.tick(due)
    expect(ran.map((w) => w.outcome)).toEqual(['skipped'])
    expect(ran[0]!.why).toBe('agent')
    expect(rig.turns).toHaveLength(0)
  })
})
