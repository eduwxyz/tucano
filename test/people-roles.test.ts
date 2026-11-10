// Tucano Team, steps 3–5: who may do what, removal, per-person memory, approvals and questions
// between people, mentions, routines that are someone's or the team's, and the activity log.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { CoreEvent } from '../src/shared/rpc'
import { personScope, type Agent, type Approval, type EngineId, type Memory, type Message, type Person, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Memories } from '../src/core/memory'
import { Hub, KEEP_REMOVED_DAYS, mentionedPeople, People, personNamed, presentPeople, requesterOf, type PortLike } from '../src/core/people'
import { admit, can, NEEDS } from '../src/core/policy-people'
import { Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'
import { localUrl, verifyLocal, verifyLocalUrl } from '../src/core/local-paths'
import { Grants } from '../src/server/people'
import type { Method } from '../src/shared/rpc'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tucano-roles-'))
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const approval = (id: string, conversationId: string, requestedBy: string, agentId = 'a1'): Approval => ({ id, hash: id, agentId, conversationId, messageId: 'x', connectorId: 'c', connectorName: 'Linear', tool: 'create_issue', args: {}, why: '', highRisk: false, state: 'pending', createdAt: 1, expiresAt: Date.now() + 60_000, requestedBy })
const ready = { installed: true, loggedIn: true }
const settings: Settings = { workspaceName: 'Ana', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'auto', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }

class FakePort implements PortLike {
  got: CoreEvent[] = []
  closed = false
  postMessage(msg: unknown): void {
    const m = msg as { event?: CoreEvent }
    if (m.event) this.got.push(m.event)
  }
  close(): void {
    this.closed = true
  }
}

// A Tucano with Ana (owner), Bia and Carl (members) and Dani (an admin).
function team(): { db: Db; people: People; ana: Person; bia: Person; carl: Person; dani: Person } {
  const db = new Db(':memory:')
  db.renamePerson(db.ownerId(), 'Ana')
  const people = new People(db)
  const ana = db.owner()
  const join1 = (name: string, role: 'member' | 'admin'): Person => {
    const r = people.join(people.createInvite(ana, { role }).code, name)
    if (!('person' in r)) throw new Error(r.error)
    return r.person
  }
  return { db, people, ana, bia: join1('Bia', 'member'), carl: join1('Carl', 'member'), dani: join1('Dani', 'admin') }
}

afterEach(() => setLang('pt'))

describe('the permissions policy', () => {
  const { ana, bia, dani } = team()

  it('refuses every admin-only method to a member and lets an admin through; the owner-only ones only the owner', () => {
    const adminOnly = (Object.keys(NEEDS) as Method[]).filter((m) => NEEDS[m] === 'admin')
    expect(adminOnly).toEqual(expect.arrayContaining(['saveAgent', 'addConnector', 'decideSkill', 'createInvite', 'removeAccount', 'activity', 'exportTeam', 'setWikiDir']))
    for (const m of adminOnly) {
      expect(() => admit(bia, m), m).toThrow('Só um admin pode fazer isso.')
      expect(() => admit(dani, m), m).not.toThrow()
      expect(() => admit(ana, m), m).not.toThrow()
    }
    for (const m of (Object.keys(NEEDS) as Method[]).filter((x) => NEEDS[x] === 'owner')) {
      expect(() => admit(dani, m), m).toThrow()
      expect(() => admit(ana, m), m).not.toThrow()
    }
    // What a member does: talk, make channels, their own routines and memories, answer and decide what's theirs.
    for (const m of ['sendMessage', 'createChannel', 'saveRoutine', 'decideApproval', 'answerQuestion', 'setDelegation', 'inbox', 'setMyName', 'addMemory'] as Method[]) expect(() => admit(bia, m), m).not.toThrow()
  })

  it('people: admins manage members, only the owner manages admins, no one touches the owner', () => {
    expect(can(dani, { kind: 'person', target: bia })).toBe(true)
    expect(can(dani, { kind: 'person', target: bia, role: 'admin' })).toBe(false) // only the owner makes an admin
    expect(can(ana, { kind: 'person', target: bia, role: 'admin' })).toBe(true)
    expect(can(dani, { kind: 'person', target: { id: 'x', role: 'admin' } })).toBe(false)
    expect(can(ana, { kind: 'person', target: dani })).toBe(true)
    expect(can(dani, { kind: 'person', target: ana })).toBe(false)
    expect(can(bia, { kind: 'person', target: { id: 'x', role: 'member' } })).toBe(false)
  })

  it('routines, memories and settings', () => {
    expect(can(bia, { kind: 'routine', routine: { owner: bia.id } })).toBe(true)
    expect(can(bia, { kind: 'routine', routine: { owner: ana.id } })).toBe(false)
    expect(can(bia, { kind: 'routine', routine: { scope: 'channel', owner: bia.id } })).toBe(false)
    expect(can(dani, { kind: 'routine', routine: { scope: 'channel' } })).toBe(true)
    expect(can(bia, { kind: 'memory', scope: personScope(bia.id) })).toBe(true)
    expect(can(dani, { kind: 'memory', scope: personScope(bia.id) })).toBe(false) // not even an admin
    expect(can(bia, { kind: 'memory', scope: 'a1' })).toBe(false) // an agent's notes are the admins'
    expect(can(bia, { kind: 'settings', keys: ['theme', 'sounds'] })).toBe(true)
    expect(can(bia, { kind: 'settings', keys: ['theme', 'routerModel'] })).toBe(false)
  })
})

describe('approvals: who decides', () => {
  it("the agent's person, admins, and whoever covers for that person until the date", () => {
    const { db, people, ana, bia, carl, dani } = team()
    db.saveAgent({ ...agent('a1', 'lia'), owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const a = approval('p1', 'ch', carl.id)
    db.createApproval(a)
    expect([ana, bia, dani, carl].map((p) => people.canDecide(p, a))).toEqual([true, true, true, false])
    expect(people.inbox(carl).approvals).toEqual([])
    people.setDelegation(bia, carl.id, Date.now() + 3_600_000)
    expect(people.canDecide(carl, a)).toBe(true)
    expect(people.inbox(carl).approvals.map((x) => x.id)).toEqual(['p1'])
    expect(db.person(bia.id)).toMatchObject({ delegateTo: carl.id })
    // Over: no longer.
    people.setDelegation(bia, carl.id, Date.now() + 1, Date.now())
    db.setDelegation(bia.id, carl.id, Date.now() - 1)
    expect(people.canDecide(carl, a)).toBe(false)
    expect(() => people.setDelegation(bia, bia.id, Date.now() + 1000)).toThrow()
    expect(() => people.setDelegation(bia, carl.id, Date.now() - 1000)).toThrow()
    expect(db.activity({ kind: 'person.delegation' }).length).toBeGreaterThan(0)
  })

  it('the decision names who decided, to the agent and in the log; "always" records who', async () => {
    setLang('en')
    const { db, bia, carl } = team()
    const turns: Turn[] = []
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', async *run(t) { turns.push(t); yield* base.run(t) } }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') } as Record<EngineId, Engine>
    const runner = new Runner({ db, engines, settings: async () => ({ ...settings, language: 'en' }), emit: () => {}, workDir: dir() })
    db.saveAgent({ ...agent('a1', 'lia'), owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    db.saveMessage({ id: 'x', conversationId: 'ch', author: { kind: 'agent', id: 'a1' }, text: 'pedi', at: 1, run: { status: 'waiting_approval', steps: [] } })
    db.createApproval(approval('p1', 'ch', carl.id))
    await runner.decide('p1', 'refused', 'not now', false, bia.id)
    await runner.idle()
    expect(db.approval('p1')).toMatchObject({ state: 'refused', decidedBy: bia.id })
    expect(turns.at(-1)?.prompt).toMatch(/Bia turned down/)
    expect(db.activity({ kind: 'approval' })).toMatchObject([{ personId: bia.id, kind: 'approval.decided', target: 'p1', detail: { decision: 'refused' } }])

    db.createApproval({ ...approval('p2', 'ch', carl.id), hash: 'h2' })
    await runner.decide('p2', 'approved', undefined, true, bia.id)
    await runner.idle()
    expect(db.agent('a1')?.autoApprove).toEqual(['c:create_issue'])
    expect(db.activity({ kind: 'approval.always' })).toMatchObject([{ personId: bia.id, target: 'a1' }])
  })
})

describe('removing a person', () => {
  it("hands their agents and routines to the owner, keeps their DMs and memories 30 days, then purges them; their name stays", () => {
    const { db, people, ana, bia, dani } = team()
    db.saveAgent({ ...agent('a1', 'lia'), owner: bia.id })
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const routine = (id: string, conversationId: string) => ({ id, name: id, agentId: 'a1', conversationId, prompt: 'x', schedule: { days: [1], time: '09:00' }, enabled: true, nextAt: Date.now() + 1000, createdAt: 1, owner: bia.id })
    db.saveRoutine(routine('r-dm', 'bia-dm'))
    db.saveRoutine(routine('r-ch', 'ch'))
    db.watchRoutine('r-ch', bia.id, true)
    db.saveMemory({ id: 'k1', scope: personScope(bia.id), text: 'da Bia', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
    db.saveMessage({ id: 'm1', conversationId: 'ch', author: { kind: 'person', id: bia.id }, text: 'oi time', at: 1 })

    expect(() => people.remove(bia, dani.id)).toThrow()
    const now = Date.now()
    const out = people.remove(dani, bia.id, now)
    expect(out).toMatchObject({ agents: ['a1'], routines: ['r-ch'] })
    expect(db.agent('a1')?.owner).toBe(ana.id)
    expect(db.routine('r-dm')).toMatchObject({ owner: bia.id, enabled: false }) // in her DM: still hers, off while she's away (see team-round2-core, 4)
    expect(db.routine('r-ch')).toMatchObject({ owner: ana.id, enabled: true })
    expect(db.routine('r-ch')?.watchers).toBeUndefined()
    expect(db.activity({ kind: 'person.removed' })).toMatchObject([{ personId: dani.id, target: bia.id }])

    // Within the 30 days: nothing purged.
    expect(people.sweep(now + (KEEP_REMOVED_DAYS - 1) * 86_400_000)).toEqual([])
    expect(db.conversation('bia-dm')).toBeDefined()
    expect(() => people.purge(dani, bia.id)).toThrow() // only the owner purges early
    expect(people.sweep(now + (KEEP_REMOVED_DAYS + 1) * 86_400_000).flatMap((p) => p.dms)).toEqual(['bia-dm'])
    expect(db.conversation('bia-dm')).toBeUndefined()
    expect(db.memories({ scope: personScope(bia.id) })).toEqual([])
    expect(db.people({ removed: true }).find((p) => p.id === bia.id)?.name).toBe('Bia')
    expect(db.message('m1')?.author).toEqual({ kind: 'person', id: bia.id })
    expect(people.sweep(now + 40 * 86_400_000)).toEqual([]) // once
  })

  it('the owner may purge early; an invite that restores, before that, gives back DMs and memories', () => {
    const { db, people, ana, bia, carl } = team()
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: [], owner: bia.id })
    db.saveMemory({ id: 'k1', scope: personScope(bia.id), text: 'da Bia', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
    people.remove(ana, bia.id)
    const back = people.join(people.createInvite(ana, { role: 'member', restore: bia.id }).code, 'Bia')
    if (!('person' in back)) throw new Error(back.error)
    expect(db.conversation('bia-dm')?.owner).toBe(bia.id)
    expect(db.memories({ scope: personScope(bia.id) })).toHaveLength(1)

    db.createConversation({ id: 'carl-dm', kind: 'dm', name: 'a1', members: [], owner: carl.id })
    expect(() => people.purge(ana, carl.id)).toThrow() // not removed
    people.remove(ana, carl.id)
    expect(people.purge(ana, carl.id).dms).toEqual(['carl-dm'])
    expect(db.activity({ kind: 'person' }).map((e) => e.kind)).toEqual(expect.arrayContaining(['person.purged', 'person.removed', 'person.restored', 'person.joined']))
  })

  it('a role change: owner only for admins, logged', () => {
    const { db, people, ana, bia, dani } = team()
    expect(() => people.setRole(dani, bia.id, 'admin')).toThrow()
    expect(people.setRole(ana, bia.id, 'admin').role).toBe('admin')
    expect(() => people.setRole(dani, bia.id, 'member')).toThrow()
    expect(() => people.setRole(ana, ana.id, 'member')).toThrow()
    expect(db.activity({ kind: 'person.role' })).toMatchObject([{ personId: ana.id, target: bia.id, detail: { from: 'member', to: 'admin' } }])
  })
})

describe('the activity log', () => {
  it('newest first, a page at a time, by person or kind', () => {
    const db = new Db(':memory:')
    for (let i = 1; i <= 5; i++) db.addActivity({ personId: i % 2 ? 'p1' : 'p2', kind: i % 2 ? 'agent.created' : 'routine.removed', target: `t${i}`, at: i * 10 })
    expect(db.activity({ limit: 2 }).map((e) => e.target)).toEqual(['t5', 't4'])
    expect(db.activity({ before: 40, limit: 2 }).map((e) => e.target)).toEqual(['t3', 't2'])
    expect(db.activity({ personId: 'p2' }).map((e) => e.target)).toEqual(['t4', 't2'])
    expect(db.activity({ kind: 'agent' }).map((e) => e.target)).toEqual(['t5', 't3', 't1'])
    expect(db.activity({ kind: 'routine.removed' }).map((e) => e.target)).toEqual(['t4', 't2'])
  })
})

describe('what a DM leaks: browsers, computers, files', () => {
  it("an agent's browser or service working for someone's DM shows nothing of it to the others", () => {
    const { db, people, ana, bia } = team()
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: [], owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: [] })
    const hub = new Hub(people, db)
    const [pa, pb] = [new FakePort(), new FakePort()]
    hub.add(pa, null)
    hub.add(pb, { person: bia.id })
    const view = { agentId: 'a1', url: 'https://banco.example/extrato', title: 'Extrato', shown: false, log: [{ label: 'Abriu', detail: 'extrato', at: 1 }], conversationId: 'bia-dm', at: 2 }
    hub.emit({ type: 'browser', view })
    expect(pb.got).toEqual([{ type: 'browser', view }])
    expect(pa.got).toEqual([{ type: 'browser', view: { agentId: 'a1', url: '', title: '', shown: false, log: [], at: 2 } }])
    const computer = { agentId: 'a1', state: 'running' as const, folder: '/work', services: [{ name: 'dash', command: 'x', port: 3000, running: true, startedAt: 1, conversationId: 'bia-dm' }, { name: 'site', command: 'y', port: 3001, running: true, startedAt: 1, conversationId: 'ch' }] }
    hub.emit({ type: 'computer', computer })
    expect((pa.got.at(-1) as { computer: { services: { name: string }[] } }).computer.services.map((s) => s.name)).toEqual(['site'])
    expect((pb.got.at(-1) as { computer: { services: { name: string }[] } }).computer.services.map((s) => s.name)).toEqual(['dash', 'site'])
    expect(people.canSeeFrom(ana, 'bia-dm')).toBe(false)
    expect(people.canSeeFrom(ana, 'ch')).toBe(true)
  })

  it('a cited file on a server is signed for one person', () => {
    const url = new URL(localUrl('chave', '/tmp/a.png', 'tucano://local', 'bia'))
    expect(verifyLocal('chave', url)).toEqual({ path: '/tmp/a.png', person: 'bia' })
    expect(verifyLocalUrl('chave', url)).toBeNull() // not an unsigned (desktop) address
    const forged = new URL(url.href.replace(/\/[^/]+$/, `/${Buffer.from('ana').toString('base64url')}`))
    expect(verifyLocal('chave', forged)).toBeNull()
  })

  it("the server asks the core once in a while whether someone may see a file or page", async () => {
    let asked = 0
    let t = 0
    const grants = new Grants(async (person) => (asked++, person === 'bia'), () => t)
    expect(await grants.may('bia', { artifact: 'x' })).toBe(true)
    expect(await grants.may('bia', { artifact: 'x' })).toBe(true)
    expect(await grants.may('ana', { port: 3000 })).toBe(false)
    expect(await grants.may(undefined, { port: 3000 })).toBe(false)
    expect(asked).toBe(2)
    grants.forget('bia')
    await grants.may('bia', { artifact: 'x' })
    t = 60_000
    await grants.may('ana', { port: 3000 })
    expect(asked).toBe(4)
  })
})

describe('@name of a person', () => {
  const people: Person[] = [
    { id: 'p1', name: 'Bia Souza', role: 'member', about: '' },
    { id: 'p2', name: 'João', role: 'member', about: '' },
    { id: 'p3', name: 'Lia Costa', role: 'member', about: '' },
    { id: 'p4', name: 'Bia Lima', role: 'member', about: '' }
  ]
  it('finds people by first name (when no one shares it) or whole name, never an agent', () => {
    expect(mentionedPeople('oi @joao e @bialima', people, []).map((p) => p.id)).toEqual(['p2', 'p4'])
    expect(mentionedPeople('@bia olha isso', people, [])).toEqual([]) // two Bias: whole name only
    expect(mentionedPeople('@lia pode ver?', people, [{ handle: 'lia' }])).toEqual([]) // the agent
    expect(mentionedPeople('@liacosta pode ver? `@joao`', people, [{ handle: 'lia' }]).map((p) => p.id)).toEqual(['p3'])
    expect(personNamed('João', people)?.id).toBe('p2')
    expect(personNamed('@Bia Lima', people)?.id).toBe('p4')
    expect(personNamed('Bia', people)).toBeUndefined()
  })
})

describe('questions, mentions and memory between people', () => {
  let gateway: Gateway
  let db: Db
  let people: People
  let ana: Person, bia: Person, carl: Person, dani: Person
  let runner: Runner
  let turns: Turn[]
  let notes: { title: string; conversationId?: string; to?: string[] }[]
  let events: CoreEvent[]

  beforeEach(async () => {
    gateway = new Gateway()
    await gateway.start()
    ;({ db, people, ana, bia, carl, dani } = team())
    turns = []
    notes = []
    events = []
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', async *run(t) { turns.push(t); yield* base.run(t) } }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') } as Record<EngineId, Engine>
    runner = new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: dir(), gateway, notify: (title, _b, conversationId, _k, _t, to) => void notes.push({ title, conversationId, to }) })
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: ana.id })
    return () => gateway.stop()
  })

  const lia = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

  it('in a channel, a question to Bia waits for her: someone else writing there does not answer it', async () => {
    await runner.send('ch', '@lia pergunte a Bia', [], undefined, ana.id)
    await runner.idle()
    const [asked] = lia()
    expect(asked?.run).toMatchObject({ status: 'waiting_input', askedTo: bia.id })
    expect(db.question(asked!.id)).toMatchObject({ askedTo: bia.id, requestedBy: ana.id, state: 'open' })
    expect(notes.at(-1)).toMatchObject({ title: 'Lia te perguntou', conversationId: 'ch', to: [bia.id] })
    expect(people.inbox(bia).questions.map((q) => q.id)).toEqual([asked!.id])
    expect(people.inbox(carl).questions).toEqual([])

    await runner.send('ch', 'sexta', [], asked!.threadId, carl.id)
    await runner.idle()
    expect(db.message(asked!.id)?.run?.status).toBe('waiting_input')
    await runner.send('ch', 'até quinta', [], asked!.threadId, bia.id)
    await runner.idle()
    expect(db.message(asked!.id)?.run?.status).toBe('done')
    expect(db.question(asked!.id)).toMatchObject({ state: 'answered', answeredBy: bia.id })
    expect(turns.at(-1)?.prompt).toContain('até quinta')
    expect(events.some((e) => e.type === 'inbox')).toBe(true)
  })

  // The Asks page's Dismiss: in a workspace with one person `sweepQuestions` skips every ask
  // (askedTo === requestedBy), so an unanswered question would sit at waiting_input for good.
  it('a question left unanswered closes, and the reply goes on instead of waiting for good', async () => {
    await runner.send('ch', '@lia me pergunta o que faltar', [], undefined, bia.id)
    await runner.idle()
    const [asked] = lia()
    expect(db.question(asked!.id)).toMatchObject({ state: 'open', askedTo: bia.id })
    expect(people.inbox(bia).questions.map((q) => q.id)).toEqual([asked!.id])
    // Whoever may answer it may drop it; anyone else can't.
    await expect(runner.dismiss(asked!.id, carl)).rejects.toThrow()
    await runner.dismiss(asked!.id, bia)
    await runner.idle()
    expect(db.question(asked!.id)?.state).toBe('closed')
    expect(db.message(asked!.id)?.run?.status).toBe('done')
    expect(db.messages().find((m) => m.text.startsWith('Deixei a sua pergunta sem resposta'))?.author).toEqual({ kind: 'person', id: bia.id })
    expect(turns.at(-1)?.prompt).toContain('Deixei a sua pergunta sem resposta')
    // Gone from the list: the reply it woke may ask again, which is a new question, not this one.
    expect(people.inbox(bia).questions.some((q) => q.id === asked!.id)).toBe(false)
    expect(events.some((e) => e.type === 'inbox')).toBe(true)
    // And it moves into the page's history, closed, not answered.
    expect(people.history(bia).find((q) => q.id === asked!.id)).toMatchObject({ state: 'closed' })
    await expect(runner.dismiss(asked!.id, bia)).rejects.toThrow('Essa pergunta não espera mais resposta.')
  })

  it("an untargeted question is the requester's: another person's message there doesn't answer it", async () => {
    await runner.send('ch', '@lia me pergunta o que faltar', [], undefined, bia.id)
    await runner.idle()
    const [asked] = lia()
    expect(db.question(asked!.id)).toMatchObject({ askedTo: bia.id, requestedBy: bia.id })
    expect(notes.at(-1)).toMatchObject({ to: [bia.id] })
    await runner.send('ch', 'eu respondo', [], asked!.threadId, carl.id)
    await runner.idle()
    expect(db.message(asked!.id)?.run?.status).toBe('waiting_input')
    // An admin may answer anyone's.
    await runner.answer(asked!.id, 'sexta', ana)
    await runner.idle()
    expect(db.question(asked!.id)).toMatchObject({ state: 'answered', answeredBy: ana.id })
  })

  it("in a DM, a question to someone else needs the DM's person's yes first; then the other sees the question only", async () => {
    await runner.send('ana-dm', 'pergunte a Bia', [], undefined, ana.id)
    await runner.idle()
    const [asked] = lia()
    expect(db.question(asked!.id)).toMatchObject({ confirm: 'pending', askedTo: bia.id })
    expect(notes.at(-1)).toMatchObject({ title: 'Lia quer perguntar a Bia', to: [ana.id] })
    expect(people.inbox(bia).questions).toEqual([])
    expect(people.inbox(ana).questions.map((q) => q.conversationId)).toEqual(['ana-dm'])
    await expect(runner.answer(asked!.id, 'x', bia)).rejects.toThrow()

    await runner.send('ana-dm', 'sim, pode', [], undefined, ana.id)
    await runner.idle()
    expect(db.question(asked!.id)?.confirm).toBe('yes')
    expect(db.message(asked!.id)?.run?.status).toBe('waiting_input')
    expect(notes.at(-1)).toMatchObject({ title: 'Lia te perguntou', conversationId: undefined, to: [bia.id] }) // no conversation to open
    const [forBia] = people.inbox(bia).questions
    expect(forBia).toMatchObject({ id: asked!.id, text: 'Pra quando você precisa disso?' })
    expect(forBia).not.toHaveProperty('conversationId')

    await runner.answer(asked!.id, 'pra sexta', bia)
    await runner.idle()
    expect(db.message(asked!.id)?.run?.status).toBe('done')
    expect(db.messages().find((m) => m.text === 'pra sexta')?.author).toEqual({ kind: 'person', id: bia.id })
    expect(lia()).toHaveLength(2)
    expect(turns.at(-1)?.prompt).toContain('pra sexta')
  })

  it("a no ends the question there, and the agent hears it", async () => {
    await runner.send('ana-dm', 'pergunte a Bia', [], undefined, ana.id)
    await runner.idle()
    const [asked] = lia()
    await runner.send('ana-dm', 'não, deixa', [], undefined, ana.id)
    await runner.idle()
    expect(db.question(asked!.id)).toMatchObject({ confirm: 'no', state: 'closed' })
    expect(turns.at(-1)?.prompt).toContain('Ana não autorizou perguntar a Bia')
    expect(notes.some((n) => n.to?.includes(bia.id))).toBe(false)
  })

  it('past the deadline the requester is told once, and may answer instead', async () => {
    await runner.send('ch', '@lia pergunte a Bia', [], undefined, ana.id)
    await runner.idle()
    const [asked] = lia()
    const q = db.question(asked!.id)!
    expect(q.deadlineAt - q.createdAt).toBe(4 * 3_600_000)
    expect(people.canAnswer(carl, q)).toBe(false)
    runner.sweepQuestions(q.deadlineAt - 1)
    expect(db.messages().filter((m) => m.author.kind === 'system')).toHaveLength(0)
    runner.sweepQuestions(q.deadlineAt + 1)
    runner.sweepQuestions(q.deadlineAt + 2)
    expect(db.messages().filter((m) => m.author.kind === 'system').map((m) => m.text)).toEqual([expect.stringContaining('Bia ainda não respondeu')])
    expect(notes.at(-1)).toMatchObject({ title: 'Bia não respondeu', to: [ana.id] })
    expect(people.inbox(ana, q.deadlineAt + 1).questions.map((x) => x.id)).toEqual([asked!.id])
    // Ana isn't an admin here? She's the owner: she could anyway. A member requester can only after the deadline.
    const late = { ...q, requestedBy: carl.id }
    expect(people.canAnswer(carl, late, q.deadlineAt - 1)).toBe(false)
    expect(people.canAnswer(carl, late, q.deadlineAt + 1)).toBe(true)
  })

  it('@name of a person notifies them, from a person or an agent; never someone who cannot see it', async () => {
    await runner.send('ch', 'bom dia @bia e @carl', [], undefined, ana.id)
    await runner.idle()
    expect(notes.find((n) => n.title === 'Ana te mencionou')).toMatchObject({ conversationId: 'ch', to: [bia.id, carl.id] })
    notes.length = 0
    await runner.send('ana-dm', 'conta pra @bia depois', [], undefined, ana.id)
    await runner.idle()
    expect(notes.some((n) => n.title.includes('mencionou'))).toBe(false)
    // An agent's reply that calls someone.
    await runner.send('ch', '@lia peça pra bia', [], undefined, ana.id)
    await runner.idle()
    expect(notes.find((n) => n.title === 'Lia te mencionou')).toMatchObject({ to: [bia.id] })
  })

  // ask_user with options (decisions): answered on the card, one at a time, only by who may answer the question.
  it('decisions to Bia: only she (or an admin) answers them on the card; anyone else is refused, and their message stays theirs', async () => {
    await runner.send('ch', '@lia me ajuda a decidir, decida com a Bia', [], undefined, ana.id)
    await runner.idle()
    const [asked] = lia()
    expect(asked?.run).toMatchObject({ status: 'waiting_input', askedTo: bia.id, questions: [{ kind: 'single' }, { kind: 'text' }] })
    expect(db.question(asked!.id)?.text).toBe('1. Paginação no menu? (Busca remota | Scroll infinito)\n2. Pra quando?')
    expect(people.inbox(bia).questions[0]).toMatchObject({ id: asked!.id, decisions: [{ question: 'Paginação no menu?' }, { question: 'Pra quando?' }] })

    expect(() => runner.answerDecision(asked!.id, 0, { chosen: [1] }, carl)).toThrow('Essa pergunta não é pra você.')
    await expect(runner.submitDecisions(asked!.id, carl)).rejects.toThrow('Essa pergunta não é pra você.')
    runner.answerDecision(asked!.id, 0, { chosen: [1] }, bia)
    expect(people.inbox(bia).questions[0]?.answers).toEqual([{ chosen: [1] }, null])
    // Carl writing there neither answers it nor carries Bia's choices.
    await runner.send('ch', 'eu acho sexta', [], asked!.threadId, carl.id)
    await runner.idle()
    expect(db.messages().find((m) => m.text.includes('eu acho sexta'))?.text).toBe('eu acho sexta')
    expect(db.message(asked!.id)?.run?.status).toBe('waiting_input')

    runner.answerDecision(asked!.id, 1, { text: 'sexta' }, bia)
    await runner.submitDecisions(asked!.id, bia)
    await runner.idle()
    const sent = db.messages().find((m) => m.text.startsWith('- Paginação'))
    expect(sent).toMatchObject({ author: { kind: 'person', id: bia.id }, text: '- Paginação no menu? → Scroll infinito\n- Pra quando? → sexta' })
    expect(db.question(asked!.id)).toMatchObject({ state: 'answered', answeredBy: bia.id })
    expect(turns.at(-1)?.prompt).toContain('Scroll infinito')
    expect(() => runner.answerDecision(asked!.id, 0, { chosen: [0] }, bia)).toThrow('Essa pergunta já foi respondida.')
  })

  it("decisions to Bia: an admin and whoever covers for her may answer them for her, and the agent hears so", async () => {
    await runner.send('ch', '@lia me ajuda a decidir, decida com a Bia', [], undefined, ana.id)
    await runner.idle()
    const [asked] = lia()
    people.setDelegation(bia, carl.id, Date.now() + 3_600_000)
    runner.answerDecision(asked!.id, 0, { chosen: [0] }, carl) // covering
    runner.answerDecision(asked!.id, 1, { skipped: true }, dani) // an admin
    await runner.submitDecisions(asked!.id, dani)
    await runner.idle()
    expect(db.question(asked!.id)).toMatchObject({ state: 'answered', answeredBy: dani.id })
    expect(db.messages().find((m) => m.author.kind === 'person' && m.author.id === dani.id)?.text).toBe('- Paginação no menu? → Busca remota\n- Pra quando? → (pulou)')
    expect(turns.at(-1)?.prompt).toContain('Dani (admin) respondeu no lugar de Bia')
  })

  it("decisions from a DM to someone else wait for the DM's person's yes; then Bia answers them from her inbox", async () => {
    await runner.send('ana-dm', 'decida com a Bia', [], undefined, ana.id)
    await runner.idle()
    const [asked] = lia()
    expect(db.question(asked!.id)).toMatchObject({ confirm: 'pending', askedTo: bia.id })
    // Before the yes, no one answers them on the card: not Bia (who hasn't seen it), not Ana (who says yes or no).
    expect(() => runner.answerDecision(asked!.id, 0, { chosen: [0] }, bia)).toThrow()
    expect(() => runner.answerDecision(asked!.id, 0, { chosen: [0] }, ana)).toThrow()
    await runner.send('ana-dm', 'sim', [], undefined, ana.id)
    await runner.idle()
    const [forBia] = people.inbox(bia).questions
    expect(forBia).toMatchObject({ id: asked!.id, decisions: [{ question: 'Paginação no menu?' }, { question: 'Pra quando?' }] })
    expect(forBia).not.toHaveProperty('conversationId')
    runner.answerDecision(asked!.id, 0, { chosen: [1] }, bia)
    runner.answerDecision(asked!.id, 1, { text: 'sexta' }, bia)
    await runner.submitDecisions(asked!.id, bia)
    await runner.idle()
    expect(db.question(asked!.id)).toMatchObject({ state: 'answered', answeredBy: bia.id })
    expect(db.messages().find((m) => m.author.kind === 'person' && m.author.id === bia.id)).toMatchObject({ conversationId: 'ana-dm', text: '- Paginação no menu? → Scroll infinito\n- Pra quando? → sexta' })
  })

  it("memories: each person's words make their own; an agent in a channel gets those of who wrote there", async () => {
    const memory = new Memories({ db, engines: { claude: fakeEngine('claude', { delayMs: 1 }) } as Record<EngineId, Engine>, settings: async () => settings, emit: () => {}, workDir: dir() })
    // A thread's own consolidation reads all of it (a conversation's only what leaves its window).
    const say = (id: string, who: string, text: string): void => db.saveMessage({ id, conversationId: 'ch', author: { kind: 'person', id: who }, text, at: Number(id.slice(1)), ...(id === 'm1' ? {} : { threadId: 'm1' }) })
    say('m1', bia.id, 'prefiro chá')
    say('m2', ana.id, 'prefiro café')
    say('m3', carl.id, 'eu também, prefiro café')
    await memory.consolidateThread('m1', 'now')
    const mine = (p: Person): string[] => db.memories({ scope: personScope(p.id) }).map((m: Memory) => m.text)
    expect(mine(bia)).toEqual(['Prefere chá'])
    expect(mine(ana)).toEqual(['Prefere café'])
    expect(mine(carl)).toEqual(['Prefere café'])
    // Who is present in the channel's recent transcript, newest first.
    const history = db.messages().filter((m) => m.conversationId === 'ch')
    expect(presentPeople(db, db.conversation('ch')!, history, ana)).toEqual([carl.id, ana.id, bia.id])
    expect(presentPeople(db, db.conversation('ana-dm')!, history, ana)).toEqual([ana.id])
    expect(memory.forPrompt(db.agent('a1')!, [bia.id]).aboutMe.map((m) => m.text)).toEqual(['Prefere chá'])
  })
})

describe('routines of a person and of the team', () => {
  const settings2 = { ...settings, workspaceName: 'Ana' }
  let db: Db
  let ana: Person, bia: Person
  let notes: { title: string; to?: string[] }[]
  let routines: Routines

  beforeEach(() => {
    ;({ db, ana, bia } = team())
    notes = []
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'vendas', members: ['a1'] })
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id })
    const reply = (r: { conversationId: string }): Message => ({ id: `rep-${Math.random()}`, conversationId: r.conversationId, author: { kind: 'agent', id: 'a1' }, text: 'feito', at: Date.now(), run: { status: 'done', steps: [] } })
    routines = new Routines({ db, runner: { runRoutine: async (r) => reply(r) }, emit: () => {}, notify: (title, _b, _c, _f, to) => void notes.push({ title, to }) })
  })

  it("a person's own routine tells its person; the team's tells only who watches", async () => {
    const mine = routines.save({ name: 'Resumo', agentId: 'a1', conversationId: 'bia-dm', prompt: 'resuma', schedule: { days: [1], time: '09:00' }, enabled: true }, bia.id)
    expect(mine).toMatchObject({ owner: bia.id })
    expect(mine.scope).toBeUndefined()
    routines.runNow(mine.id)
    await routines.idle()
    expect(notes).toEqual([{ title: 'Lia · Resumo', to: [bia.id] }])

    expect(() => routines.save({ name: 'Time', agentId: 'a1', conversationId: 'bia-dm', prompt: 'x', schedule: { days: [1], time: '09:00' }, enabled: true, scope: 'channel' }, ana.id)).toThrow()
    const team1 = routines.save({ name: 'Pipeline', agentId: 'a1', conversationId: 'ch', prompt: 'x', schedule: { days: [1], time: '09:00' }, enabled: true, scope: 'channel' }, ana.id)
    expect(db.routine(team1.id)?.scope).toBe('channel')
    notes.length = 0
    routines.runNow(team1.id)
    await routines.idle()
    expect(notes).toEqual([]) // nobody by default
    db.watchRoutine(team1.id, bia.id, true)
    routines.runNow(team1.id)
    await routines.idle()
    expect(notes).toEqual([{ title: 'Lia · Pipeline', to: [bia.id] }])
  })

  it("runs on its person's behalf: the reply is for them, and approvals say whose routine", () => {
    const r = routines.save({ name: 'Resumo', agentId: 'a1', conversationId: 'ch', prompt: 'resuma', schedule: { days: [1], time: '09:00' }, enabled: true }, bia.id)
    const ask: Message = { id: 'r1', conversationId: 'ch', author: { kind: 'routine', id: r.id }, text: 'resuma', at: 1 }
    expect(requesterOf(db, db.conversation('ch')!, [ask]).id).toBe(bia.id)
    const t = routines.save({ name: 'Time', agentId: 'a1', conversationId: 'ch', prompt: 'x', schedule: { days: [1], time: '09:00' }, enabled: true, scope: 'channel' }, ana.id)
    expect(requesterOf(db, db.conversation('ch')!, [{ ...ask, author: { kind: 'routine', id: t.id } }]).id).toBe(ana.id) // the team's: the owner answers for it
    expect(settings2.workspaceName).toBe('Ana')
  })
})
