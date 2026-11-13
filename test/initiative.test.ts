// A person's proactive coordinator at the level of its records: what is stored, who may see it, what
// a revision refuses, and what a copy, a restore or a removed person leaves of it. No review runs in
// this slice, so nothing here waits on an engine.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { Db, MIGRATIONS } from '../src/core/db'
import { Initiative } from '../src/core/initiative'
import { People } from '../src/core/people'
import { INITIATIVE_LIMITS, type CommitmentInput, type InitiativeInput } from '../src/shared/initiative'
import type { Agent, Person } from '../src/shared/types'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  handle: id,
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 1_000_000,
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
let me: Person
let bia: Person
let file: string

// Two agents, a DM for each, one channel, and a second person with her own DM: enough to tell my
// records from anyone else's.
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'ad-initiative-')), 'test.db')
  db = new Db(file)
  people = new People(db)
  initiative = new Initiative(db, people)
  me = db.owner()
  db.saveAgent(agent('orion'))
  db.saveAgent(agent('vega'))
  db.createConversation({ id: 'dm-orion', kind: 'dm', name: 'orion', members: ['orion'], owner: me.id })
  db.createConversation({ id: 'dm-vega', kind: 'dm', name: 'vega', members: ['vega'], owner: me.id })
  db.createConversation({ id: 'clientes', kind: 'channel', name: 'clientes', members: ['orion', 'vega'], createdBy: me.id })
  const joined = people.join(people.createInvite(me, { role: 'member' }).code, 'Bia')
  if ('error' in joined) throw new Error(joined.error)
  bia = joined.person
  db.createConversation({ id: 'dm-bia-orion', kind: 'dm', name: 'orion', members: ['orion'], owner: bia.id })
})

const config = (over: Partial<InitiativeInput> = {}): InitiativeInput => ({
  agentId: 'orion',
  conversationId: 'dm-orion',
  enabled: true,
  brief: 'Watch the client thread, and answer what waits on me.',
  observe: { conversations: ['clientes'] },
  work: { conversations: ['clientes'], kinds: ['send'] },
  cadenceMinutes: 15,
  notify: 'material',
  dailyReviews: 24,
  dailyTokens: 2_000_000,
  timezone: 'Europe/Sofia',
  ...over
})

const commitment = (over: Partial<CommitmentInput> = {}): CommitmentInput => ({
  agentId: 'orion',
  conversationId: 'dm-orion',
  by: 'person',
  description: 'Answer the client about the invoice.',
  scope: { conversations: ['clientes'], kinds: ['send'] },
  ...over
})

describe('the record', () => {
  it('starts with nothing, and reads as off: a fresh workspace and an upgraded one alike', () => {
    expect(initiative.view(me)).toEqual({ config: null, commitments: [], wakes: [], status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused: false } })
    // An install from before this build: every migration but the last, then opened as it would be.
    const old = join(mkdtempSync(join(tmpdir(), 'ad-initiative-')), 'old.db')
    const before = MIGRATIONS.length - 1
    const raw = new DatabaseSync(old)
    raw.exec('PRAGMA foreign_keys = ON')
    for (const step of MIGRATIONS.slice(0, before)) raw.exec(step)
    raw.exec(`PRAGMA user_version = ${before}`)
    raw.close()
    const upgraded = new Db(old)
    expect(upgraded.initiative(upgraded.ownerId())).toBeUndefined()
    // A build from before the link ledger: the table it reads is added on this open, and a
    // responsibility saved here reads with a fresh progress count.
    const peopleUp = new People(upgraded)
    const initiativeUp = new Initiative(upgraded, peopleUp)
    upgraded.saveAgent(agent('orion'))
    upgraded.createConversation({ id: 'dm-orion', kind: 'dm', name: 'orion', members: ['orion'], owner: upgraded.ownerId() })
    upgraded.createConversation({ id: 'clientes', kind: 'channel', name: 'clientes', members: ['orion'], createdBy: upgraded.ownerId() })
    initiativeUp.save(peopleUp.owner(), config(), 0)
    const saved = initiativeUp.saveCommitment(peopleUp.owner(), commitment())
    expect(upgraded.commitment(saved.id)).toMatchObject({ state: 'open', unchangedFor: 0, evidence: [], links: [] })
    expect(upgraded.resumeSeen(upgraded.ownerId(), 'delegation', 'nothing')).toBeUndefined()
    upgraded.close()
  })

  it('says what it did, what is waiting on the person, and what is left of today', () => {
    const saved = initiative.save(me, config({ dailyReviews: 4 }), 0)
    initiative.saveCommitment(me, commitment())
    const waiting = initiative.saveCommitment(me, commitment({ description: 'Ask the client which number.', state: 'waiting_user' }))
    const now = Date.now()
    initiative.settle(me, now, [], now) // one tick passed: nothing moved
    db.saveWake({ id: 'w1', personId: me.id, agentId: 'orion', revision: saved.revision, at: now - 60_000, endedAt: now - 59_000, outcome: 'reported', text: 'Answered the client.', tokens: 1_200 })
    db.saveWake({ id: 'w2', personId: me.id, agentId: 'orion', revision: saved.revision, at: now - 120_000, endedAt: now - 119_000, outcome: 'quiet', text: '[[quiet]]', tokens: 300 })
    const view = initiative.view(me, now)
    // Newest first, and the person's own bookkeeping: what ran today, what it cost, what is left.
    expect(view.wakes.map((w) => w.id)).toEqual(['w1', 'w2'])
    expect(view.status.today).toEqual({ reviews: 2, tokens: 1_500 })
    expect(view.status.open).toBe(2)
    expect(view.status.waitingOnPerson).toBe(1)
    expect(view.status.paused).toBe(false)
    expect(view.status.dueAt).toBe(now - 60_000 + 15 * 60_000) // the cadence after its last attempt
    expect(initiative.view(me, now, true).status.paused).toBe(true)
    expect(view.commitments.map((c) => c.id)).toContain(waiting.id)
  })

  it('survives a restart, revision and all', () => {
    const saved = initiative.save(me, config(), 0)
    db.close()
    const again = new Db(file)
    expect(again.initiative(saved.personId)).toEqual(saved)
    again.close()
  })

  it('refuses words it would only cut, instead of storing less than the person wrote', () => {
    expect(() => initiative.save(me, config({ brief: 'x'.repeat(INITIATIVE_LIMITS.brief + 1) }), 0)).toThrow(/characters|caracteres/)
    expect(db.initiative(me.id)).toBeUndefined()
  })

  it('refuses a save carrying a revision someone else already moved past', () => {
    const saved = initiative.save(me, config(), 0)
    expect(saved.revision).toBe(1)
    const second = initiative.save(me, config({ cadenceMinutes: 30 }), 1)
    expect(second.revision).toBe(2)
    // A page that read revision 1 still open: its save would overwrite the 30 minutes unread.
    expect(() => initiative.save(me, config({ brief: 'something else' }), 1)).toThrow(/Reload|Recarregue/)
    expect(db.initiative(me.id)?.brief).toBe('Watch the client thread, and answer what waits on me.')
  })
})

describe('whose it is', () => {
  it("is invisible to anyone else, down to not knowing it exists", () => {
    initiative.save(me, config(), 0)
    const mine = initiative.saveCommitment(me, commitment())
    expect(initiative.view(bia)).toEqual({ config: null, commitments: [], wakes: [], status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused: false } })
    // Bia cannot reach my responsibility by its id, and cannot write one on my behalf either,
    // whether or not she has a coordinator of her own.
    expect(() => initiative.saveCommitment(bia, commitment({ id: mine.id, description: 'not mine', conversationId: 'dm-bia-orion', scope: { conversations: [], kinds: [] } }))).toThrow(/no longer exists|não existe/)
    initiative.save(bia, config({ conversationId: 'dm-bia-orion', observe: { conversations: [] }, work: { conversations: [], kinds: ['send'] } }), 0)
    expect(() => initiative.saveCommitment(bia, commitment({ id: mine.id, description: 'still not mine', conversationId: 'dm-bia-orion', scope: { conversations: [], kinds: [] } }))).toThrow(/no longer exists|não existe/)
    expect(db.commitment(mine.id)?.description).toBe('Answer the client about the invoice.')
    // Her own is hers: her own DM, her own agent.
    const hers = initiative.saveCommitment(bia, commitment({ conversationId: 'dm-bia-orion', scope: { conversations: [], kinds: ['send'] } }))
    expect(hers.personId).toBe(bia.id)
    expect(initiative.view(me).commitments.map((c) => c.id)).toEqual([mine.id])
  })

  it('follows a removed person out, and takes their records with a purge', () => {
    initiative.save(me, config(), 0)
    initiative.saveCommitment(me, commitment())
    db.removePerson(me.id) // the owner cannot be removed: nothing changes
    expect(db.initiative(me.id)?.enabled).toBe(true)
    // A member's own coordinator stops when their access ends.
    const hers = initiative.save(bia, config({ conversationId: 'dm-bia-orion', observe: { conversations: [] }, work: { conversations: [], kinds: [] } }), 0)
    db.removePerson(bia.id)
    expect(db.initiative(bia.id)).toMatchObject({ enabled: false, revision: hers.revision + 1 })
    db.purgePerson(bia.id)
    expect(db.initiative(bia.id)).toBeUndefined()
  })
})

describe('what it may point at', () => {
  it('needs a bot that is here and the DM with it', () => {
    expect(() => initiative.save(me, config({ agentId: 'nobody' }), 0)).toThrow(/no longer exists|não existe/)
    expect(() => initiative.save(me, config({ conversationId: 'clientes' }), 0)).toThrow(/direct conversation|direta/)
    expect(() => initiative.save(me, config({ agentId: 'vega' }), 0)).toThrow(/direct conversation|direta/)
    expect(() => initiative.save(me, config({ conversationId: 'dm-bia-orion' }), 0)).toThrow(/direct conversation|direta/)
    const archived = db.agent('orion')!
    db.saveAgent({ ...archived, archived: true })
    expect(() => initiative.save(me, config(), 0)).toThrow(/no longer exists|não existe/)
  })

  it('refuses a conversation it cannot reach, and work it cannot read', () => {
    // Naming it to look at is refused for a DM of someone else's, or one that is gone.
    expect(() => initiative.save(me, config({ observe: { conversations: ['dm-bia-orion', 'clientes'] } }), 0)).toThrow(/belongs to someone else|outra pessoa/)
    expect(() => initiative.save(me, config({ observe: { conversations: ['gone', 'clientes'] } }), 0)).toThrow(/no longer exists|não existe/)
    // Acting somewhere means reading it: the channel has to be in the observation scope too.
    expect(() => initiative.save(me, config({ observe: { conversations: [] } }), 0)).toThrow(/may also read|pode ler/)
  })

  it('keeps a responsibility inside the brief, and never widens it afterwards', () => {
    initiative.save(me, config(), 0)
    expect(() => initiative.saveCommitment(me, commitment({ scope: { conversations: ['clientes'], kinds: ['send', 'publish'] } }))).toThrow(/authorized|autorizou/)
    // Its words come from a conversation the coordinator may read, its home or an observed one.
    expect(() => initiative.saveCommitment(me, commitment({ conversationId: 'dm-vega' }))).toThrow(/may read|pode ler/)
    const saved = initiative.saveCommitment(me, commitment())
    expect(saved.state).toBe('open')
    // Narrowing is fine; widening after the fact is not.
    expect(() => initiative.saveCommitment(me, { ...commitment(), id: saved.id, scope: { conversations: ['clientes'], kinds: ['send', 'pay'] } })).toThrow(/authorized|autorizou/)
  })

  it('refuses a missing source, a missing file and a link that is not there', () => {
    initiative.save(me, config(), 0)
    expect(() => initiative.saveCommitment(me, commitment({ messageId: 'gone' }))).toThrow(/message no longer exists|mensagem não existe/)
    expect(() => initiative.saveCommitment(me, commitment({ evidence: [{ kind: 'artifact', id: 'gone' }] }))).toThrow(/file no longer exists|arquivo não existe/)
    expect(() => initiative.saveCommitment(me, commitment({ links: [{ kind: 'delegation', id: 'gone' }] }))).toThrow(/no longer exists|não existe/)
    // A message that exists, in another conversation than the one it claims to come from.
    db.saveMessage({ id: 'm1', conversationId: 'clientes', author: { kind: 'person', id: me.id }, text: 'oi', at: Date.now() })
    expect(() => initiative.saveCommitment(me, commitment({ messageId: 'm1' }))).toThrow(/message no longer exists|mensagem não existe/)
    const saved = initiative.saveCommitment(me, commitment({ messageId: 'm1', conversationId: 'clientes', scope: { conversations: ['clientes'], kinds: ['send'] } }))
    expect(saved.messageId).toBe('m1')
    expect(saved.links).toEqual([])
  })

  it('cannot be written before the person has a coordinator', () => {
    expect(() => initiative.saveCommitment(me, commitment())).toThrow(/initiative for a bot|iniciativa/)
  })
})

describe('states', () => {
  it('closes once, and a reopened one keeps the day it last closed', () => {
    initiative.save(me, config(), 0)
    const open = initiative.saveCommitment(me, commitment())
    expect(open.closedAt).toBeUndefined()
    const done = initiative.saveCommitment(me, { ...commitment(), id: open.id, state: 'done' })
    expect(done.state).toBe('done')
    expect(done.closedAt).toBeGreaterThan(0)
    const waiting = initiative.saveCommitment(me, { ...commitment(), id: open.id, state: 'waiting_user', note: 'Ana owes me the invoice' })
    expect(waiting.closedAt).toBeUndefined()
    expect(waiting.note).toBe('Ana owes me the invoice')
    const dismissed = initiative.saveCommitment(me, { ...commitment(), id: open.id, state: 'dismissed' })
    expect(dismissed.closedAt).toBeGreaterThan(0)
  })
})

describe('a copy and a restore', () => {
  it('a copy starts with initiative off and no responsibilities of the source', () => {
    initiative.save(me, config(), 0)
    initiative.saveCommitment(me, commitment())
    const copy = join(mkdtempSync(join(tmpdir(), 'ad-initiative-')), 'copy.db')
    db.duplicateTo(copy, 'Copia')
    const copied = new Db(copy)
    expect(copied.initiative(me.id)).toMatchObject({ enabled: false, revision: 2 })
    expect(copied.commitments(me.id)).toEqual([])
    copied.close()
  })

  it('a restored backup keeps the records and runs none of them', () => {
    initiative.save(me, config(), 0)
    initiative.saveCommitment(me, commitment())
    expect(db.adoptRestore()).toBeGreaterThanOrEqual(0)
    expect(db.initiative(me.id)).toMatchObject({ enabled: false, revision: 2 })
    // What was written survives: only what may run changes.
    expect(db.commitments(me.id)).toHaveLength(1)
  })
})
