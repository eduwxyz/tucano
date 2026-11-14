// What a responsibility rests on: the work it links to, read fresh, and what that means for the person's
// coordinator. No engine here: these are the records and the rules over them.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Approval, Delegation, Message, Question } from '../src/shared/types'
import { MAX_COMMITMENTS, STALL_AFTER, type CommitmentInput, type InitiativeInput } from '../src/shared/initiative'
import { Db } from '../src/core/db'
import { Initiative } from '../src/core/initiative'
import { stateFrom } from '../src/core/initiative-links'
import { heartbeatTask } from '../src/core/initiative-state'
import { People } from '../src/core/people'

let db: Db
let people: People
let initiative: Initiative
let dm: string
let dm2: string

const agent = (id: string): Agent => ({
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
  archived: false
})

const config = (over: Partial<InitiativeInput> = {}): InitiativeInput => ({
  agentId: 'lia',
  conversationId: dm,
  enabled: true,
  brief: 'Keep the client thread moving.',
  observe: { conversations: [] },
  work: { conversations: [], kinds: [] },
  cadenceMinutes: 15,
  notify: 'material',
  dailyReviews: 24,
  dailyTokens: 2_000_000,
  timezone: 'Europe/Sofia',
  ...over
})

const commitment = (over: Partial<CommitmentInput> = {}): CommitmentInput => ({
  agentId: 'lia',
  conversationId: dm,
  by: 'person',
  description: 'Send the client the number they asked for.',
  scope: { conversations: [], kinds: [] },
  ...over
})

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
  id: 'del-1',
  from: 'lia',
  to: 'sol',
  conversationId: dm2,
  rootId: 'root-1',
  originConversationId: dm,
  originMessageId: 'm-1',
  requestedBy: db.ownerId(),
  text: 'get the number',
  state: 'open',
  createdAt: 1_000,
  ...over
})

const question = (over: Partial<Question> = {}): Question => ({
  id: 'q-1',
  conversationId: dm,
  agentId: 'lia',
  text: 'Which number do I send?',
  askedTo: db.ownerId(),
  requestedBy: db.ownerId(),
  state: 'open',
  deadlineAt: 9_999,
  createdAt: 1_000,
  ...over
})

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'ap-1',
  hash: 'h',
  agentId: 'lia',
  conversationId: dm,
  messageId: 'm-1',
  connectorId: 'c-1',
  connectorName: 'Mail',
  tool: 'send',
  args: {},
  why: 'send the number',
  highRisk: false,
  state: 'pending',
  createdAt: 1_000,
  expiresAt: 99_999,
  ...over
})

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-links-')), 'test.db'))
  people = new People(db)
  initiative = new Initiative(db, people)
  db.saveAgent(agent('lia'))
  db.saveAgent(agent('sol'))
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'], owner: db.ownerId() })
  db.createConversation({ id: 'dm2', kind: 'dm', name: 'sol', members: ['sol'], owner: db.ownerId() })
  dm = 'dm'
  dm2 = 'dm2'
})

const turnedOn = (over: Partial<InitiativeInput> = {}): void => {
  initiative.save(db.owner(), config(over), 0)
}

const refresh = (now = 10_000_000) => initiative.refresh(db.owner(), now)

describe('the work behind a responsibility', () => {
  it('reads a delegation as waiting while it runs, and as done when it comes back', () => {
    turnedOn()
    db.saveDelegation(delegation())
    initiative.saveCommitment(db.owner(), commitment({ links: [{ kind: 'delegation', id: 'del-1' }] }))
    expect(refresh().due).toEqual([])
    // Waiting elsewhere is the honest state: the person's bot is not what is holding it up.
    const waiting = db.commitments(db.ownerId())[0]!
    expect(waiting.state).toBe('waiting_external')
    db.saveDelegation(delegation({ state: 'done', result: 'm-9', endedAt: 5_000 }))
    const after = refresh()
    expect(after.due.map((l) => l.state)).toEqual(['done'])
    expect(db.commitments(db.ownerId())[0]!.state).toBe('open')
  })

  it('reads a question that waits on the person as theirs, and one that was answered as answered', () => {
    turnedOn()
    db.saveQuestion(question())
    initiative.saveCommitment(db.owner(), commitment({ links: [{ kind: 'question', id: 'q-1' }] }))
    const first = refresh()
    expect(first.waitingUser).toBe(true)
    expect(first.due).toEqual([]) // their own question is not news
    expect(db.commitments(db.ownerId())[0]!.state).toBe('waiting_user')
    db.saveQuestion(question({ state: 'answered', answeredBy: db.ownerId(), answeredAt: 5_000 }))
    const second = refresh()
    expect(second.waitingUser).toBe(false)
    expect(second.due.map((l) => l.state)).toEqual(['answered'])
    expect(db.commitments(db.ownerId())[0]!.state).toBe('open')
  })

  it('reads a pending approval as theirs to decide', () => {
    turnedOn()
    db.createApproval(approval())
    initiative.saveCommitment(db.owner(), commitment({ links: [{ kind: 'approval', id: 'ap-1' }] }))
    expect(refresh().waitingUser).toBe(true)
    expect(db.commitments(db.ownerId())[0]!.state).toBe('waiting_user')
    db.decideApproval('ap-1', 'approved', undefined, db.ownerId())
    expect(refresh().due.map((l) => l.state)).toEqual(['decided'])
    expect(db.commitments(db.ownerId())[0]!.state).toBe('open')
  })

  it('keeps a failure as work still open, and says so in its own words', () => {
    turnedOn()
    db.saveDelegation(delegation({ state: 'failed', endedAt: 5_000 }))
    initiative.saveCommitment(db.owner(), commitment({ links: [{ kind: 'delegation', id: 'del-1' }] }))
    refresh()
    const after = db.commitments(db.ownerId())[0]!
    expect(after.state).toBe('open')
    expect(after.note).toMatch(/não terminou|didn't finish/)
  })

  it('wakes once for a change, and never again for the same version of it', () => {
    turnedOn()
    db.saveDelegation(delegation())
    initiative.saveCommitment(db.owner(), commitment({ links: [{ kind: 'delegation', id: 'del-1' }] }))
    db.saveDelegation(delegation({ state: 'done', result: 'm-9', endedAt: 5_000 }))
    const moved = refresh().due
    expect(moved).toHaveLength(1)
    initiative.settle(db.owner(), 10_000_000, moved, 10_000_000)
    expect(refresh().due).toEqual([])
    // Reading it again changes nothing: the same version is not news twice.
    expect(refresh().due).toEqual([])
  })

  it('narrows a scope that lost a conversation, and says which one it can no longer reach', () => {
    turnedOn({ observe: { conversations: [dm2] }, work: { conversations: [dm2], kinds: ['send'] } })
    initiative.saveCommitment(db.owner(), commitment({ scope: { conversations: [dm2], kinds: ['send'] } }))
    // The person takes that conversation out of what the bot may read.
    initiative.save(db.owner(), config({ observe: { conversations: [] }, work: { conversations: [], kinds: [] } }), 1)
    const after = refresh()
    expect(after.narrowed.map((c) => c.id)).toEqual([db.commitments(db.ownerId())[0]!.id])
    expect(db.commitments(db.ownerId())[0]!.scope.conversations).toEqual([])
  })

  it('counts check-ins without progress and names a stalled one, but never one waiting on the person', () => {
    turnedOn()
    const c = initiative.saveCommitment(db.owner(), commitment())
    expect(refresh().stalled).toEqual([])
    const later = Date.now() + 1_000
    for (let i = 0; i < STALL_AFTER; i++) initiative.settle(db.owner(), later, [], later)
    expect(db.commitment(c.id)!.unchangedFor).toBe(STALL_AFTER)
    const stalled = refresh().stalled
    expect(stalled.map((x) => x.id)).toEqual([c.id])
    // The request names it, and asks for one concrete step or a close.
    const task = heartbeatTask(db.initiative(db.ownerId(), 'lia')!, db.commitments(db.ownerId()), 'Ana', { stalled: stalled.map((x) => x.description) })
    expect(task).toMatch(/Sem avanço|No progress/)
    // A person's own change is progress again.
    initiative.saveCommitment(db.owner(), commitment({ id: c.id, description: 'Send the number, this time with the contract.' }))
    expect(db.commitment(c.id)!.unchangedFor).toBe(0)
    expect(refresh().stalled).toEqual([])
  })

  it('drops evidence it can no longer read, so nothing rests on what the person cannot see', () => {
    turnedOn()
    const m: Message = { id: 'ev-1', conversationId: dm, author: { kind: 'person', id: db.ownerId() }, text: 'the client asked for 42', at: 1_000 }
    db.saveMessage(m)
    const c = initiative.saveCommitment(db.owner(), commitment({ evidence: [{ kind: 'message', id: 'ev-1' }] }))
    expect(db.commitment(c.id)!.evidence).toHaveLength(1)
    // The message goes (a cleared history, a deleted thread): the commitment must not keep resting on it.
    ;(db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db.prepare('DELETE FROM messages WHERE id = ?').run('ev-1')
    refresh()
    expect(db.commitment(c.id)!.evidence).toEqual([])
  })

  it('holds twelve responsibilities, and refuses the thirteenth', () => {
    turnedOn()
    for (let i = 0; i < MAX_COMMITMENTS; i++) initiative.saveCommitment(db.owner(), commitment({ description: `Thing ${i}` }))
    expect(() => initiative.saveCommitment(db.owner(), commitment({ description: 'One more' }))).toThrow(/demais|as many/)
    // Closing one makes room again.
    const first = db.commitments(db.ownerId())[0]!
    initiative.saveCommitment(db.owner(), commitment({ id: first.id, description: first.description, state: 'done' }))
    expect(() => initiative.saveCommitment(db.owner(), commitment({ description: 'One more' }))).not.toThrow()
  })
})

describe('reading the links on their own', () => {
  it('prefers what waits on the person over what waits elsewhere, and never reads a failure as progress', () => {
    const working = { kind: 'delegation' as const, id: 'd', state: 'working' as const, version: 'v' }
    const asking = { kind: 'question' as const, id: 'q', state: 'waiting' as const, version: 'v' }
    const failed = { kind: 'delegation' as const, id: 'd2', state: 'failed' as const, version: 'v' }
    expect(stateFrom([working, asking], 'open')).toBe('waiting_user')
    // One failed while another still runs: the work is still out there, and the note says what failed.
    expect(stateFrom([working, failed], 'open')).toBe('waiting_external')
    expect(stateFrom([failed], 'waiting_external')).toBe('open')
    expect(stateFrom([working], 'open')).toBe('waiting_external')
    expect(stateFrom([{ ...working, state: 'done' }], 'in_progress')).toBe('open')
    expect(stateFrom([], 'in_progress')).toBe('in_progress')
  })

  it('reads a reply it links to by how that reply ended', () => {
    turnedOn()
    const m: Message = {
      id: 'm-run',
      conversationId: dm,
      author: { kind: 'agent', id: 'lia' },
      text: 'working',
      at: 1_000,
      run: { status: 'working', depth: 1, steps: [] }
    }
    db.saveMessage(m)
    initiative.saveCommitment(db.owner(), commitment({ links: [{ kind: 'run', id: 'm-run' }] }))
    expect(refresh().due).toEqual([])
    expect(db.commitments(db.ownerId())[0]!.state).toBe('waiting_external')
    db.saveMessage({ ...m, run: { ...m.run!, status: 'done', endedAt: 5_000 } })
    expect(refresh().due.map((l) => l.state)).toEqual(['done'])
  })
})
