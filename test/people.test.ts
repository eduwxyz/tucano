import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { CoreEvent, Snapshot } from '../src/shared/rpc'
import { personScope, type Agent, type Approval, type EngineId, type Message, type Person, type Settings } from '../src/shared/types'
import { Db, MIGRATIONS } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Hub, INVITE_DAYS, People, requesterOf, type PortLike } from '../src/core/people'
import { Runner } from '../src/core/runs'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tucano-people-'))
const agent = (id: string, handle: string): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
const approval = (id: string, conversationId: string, requestedBy: string, agentId = 'a1'): Approval => ({ id, hash: id, agentId, conversationId, messageId: 'x', connectorId: 'c', connectorName: 'Linear', tool: 'create_issue', args: {}, why: '', highRisk: false, state: 'pending', createdAt: 1, expiresAt: Date.now() + 60_000, requestedBy })

// A port as the hub sees it: what reached it, and whether it was closed.
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

afterEach(() => setLang('pt'))

describe('an existing single-user database', () => {
  it('becomes one owner person who keeps everything that was "me"', () => {
    const file = join(dir(), 'tucano.db')
    const raw = new DatabaseSync(file)
    const team = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE people'))
    for (const m of MIGRATIONS.slice(0, team)) raw.exec(m)
    raw.exec(`
      PRAGMA user_version = ${team};
      INSERT INTO settings (key, value) VALUES ('workspaceName', '"Ana"');
      INSERT INTO agents (id, name, handle, color, model, effort, limit_tokens, created_at) VALUES ('a1', 'Lia', 'lia', 'sky', 'sonnet', 'low', 1000, 1);
      INSERT INTO conversations (id, kind, name, created_at) VALUES ('dm', 'dm', 'a1', 1), ('ch', 'channel', 'geral', 2);
      INSERT INTO members (conversation_id, agent_id) VALUES ('dm', 'a1'), ('ch', 'a1');
      INSERT INTO messages (id, conversation_id, author_kind, text, at) VALUES ('m1', 'dm', 'me', 'oi', 1), ('m3', 'ch', 'me', 'bom dia', 3);
      INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES ('m2', 'dm', 'agent', 'a1', 'olá', 2), ('m4', 'ch', 'agent', 'a1', 'bom dia!', 4);
      INSERT INTO message_notifications (message_id, phase, unread) VALUES ('m2', 'message', 0), ('m4', 'message', 1);
      INSERT INTO memories (id, scope, text, state, origin, created_at, confirmed_at) VALUES ('k1', 'me', 'Ana prefere PRs pequenos', 'active', 'me', 1, 1), ('k2', 'a1', 'nota da Lia', 'active', 'agent', 1, 1);
      INSERT INTO approvals (id, hash, agent_id, conversation_id, message_id, connector_id, connector_name, tool, args, state, created_at, expires_at) VALUES ('p1', 'h', 'a1', 'dm', 'm2', 'c', 'Linear', 't', '{}', 'approved', 1, 2), ('p2', 'h', 'a1', 'dm', 'm2', 'c', 'Linear', 't', '{}', 'pending', 1, 2);
      INSERT INTO routines (id, name, agent_id, conversation_id, prompt, days, time, enabled, created_at) VALUES ('r1', 'Resumo', 'a1', 'dm', 'resuma', '[1]', '09:00', 1, 1);
    `)
    raw.close()

    const db = new Db(file)
    const owner = db.owner()
    expect(db.people()).toEqual([owner])
    expect(owner).toMatchObject({ name: 'Ana', role: 'owner' })
    expect(db.ownerNamed()).toBe(false) // a server asks it once
    expect(db.messages().map((m) => m.author)).toEqual([{ kind: 'person', id: owner.id }, { kind: 'agent', id: 'a1' }, { kind: 'person', id: owner.id }, { kind: 'agent', id: 'a1' }])
    expect(db.conversation('dm')?.owner).toBe(owner.id)
    expect(db.conversation('ch')?.owner).toBeUndefined()
    expect(db.agent('a1')?.owner).toBe(owner.id)
    expect(db.memories().map((m) => [m.id, m.scope])).toEqual([['k1', personScope(owner.id)], ['k2', 'a1']])
    expect(db.approvals().map((a) => [a.id, a.requestedBy, a.decidedBy])).toEqual([['p1', owner.id, owner.id], ['p2', owner.id, undefined]])
    expect(db.routines().map((r) => r.id)).toEqual(['r1'])
    // What was unread stays unread for the owner, and only that.
    expect(db.conversations().map((c) => [c.id, c.unread])).toEqual([['dm', 0], ['ch', 1]])
    db.close()
  })

  it('a new install has an owner too, named later by the core', () => {
    const db = new Db(':memory:')
    expect(db.owner()).toMatchObject({ role: 'owner', name: '' })
    db.renamePerson(db.ownerId(), 'Edu', false)
    expect(db.owner().name).toBe('Edu')
    expect(db.ownerNamed()).toBe(false)
  })
})

describe('two people', () => {
  let db: Db
  let people: People
  let owner: Person
  let bia: Person
  let hub: Hub<FakePort>

  beforeEach(() => {
    db = new Db(':memory:')
    db.renamePerson(db.ownerId(), 'Ana')
    people = new People(db)
    owner = db.owner()
    const { code } = people.createInvite(owner, { role: 'member', about: 'cuida do financeiro' })
    const joined = people.join(code, ' Bia ')
    if (!('person' in joined)) throw new Error(joined.error)
    bia = joined.person
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: owner.id })
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    hub = new Hub(people, db)
  })

  const say = (id: string, conversationId: string, author: Message['author'], text: string): Message => {
    const m: Message = { id, conversationId, author, text, at: Date.now() }
    db.saveMessage(m)
    return m
  }
  const base = (): Omit<Snapshot, 'people' | 'you' | 'needsName' | 'conversations' | 'inbox'> => ({ settings: {} as Settings, agents: db.agents(), messages: db.messages(), connectors: [], approvals: db.approvals(), memories: db.memories(), artifacts: [], computers: [], browsers: [], routines: db.routines(), skills: [], platform: 'mac', packaged: false, isolatedComputers: true })

  it('each sees only their own DM in the snapshot, with its messages and their own memories', () => {
    say('m1', 'ana-dm', { kind: 'person', id: owner.id }, 'segredo da Ana')
    say('m2', 'bia-dm', { kind: 'person', id: bia.id }, 'segredo da Bia')
    say('m3', 'ch', { kind: 'person', id: bia.id }, 'bom dia, time')
    db.saveMemory({ id: 'k1', scope: personScope(owner.id), text: 'da Ana', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
    db.saveMemory({ id: 'k2', scope: personScope(bia.id), text: 'da Bia', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
    db.saveMemory({ id: 'k3', scope: 'a1', text: 'da Lia', state: 'active', origin: 'agent', messageIds: [], createdAt: 1, confirmedAt: 1 })

    const ana = people.snapshotFor(owner, base(), { server: true })
    expect(ana.conversations.map((c) => c.id)).toEqual(['ana-dm', 'ch'])
    expect(ana.messages.map((m) => m.id)).toEqual(['m1', 'm3'])
    expect(ana.memories.map((m) => m.id)).toEqual(['k1', 'k3'])
    expect(ana.you).toBe(owner.id)
    expect(ana.people.map((p) => p.name)).toEqual(['Ana', 'Bia'])
    expect(ana.needsName).toBeUndefined() // she said her name

    const b = people.snapshotFor(bia, base())
    expect(b.conversations.map((c) => c.id)).toEqual(['bia-dm', 'ch'])
    expect(b.messages.map((m) => m.id)).toEqual(['m2', 'm3'])
    expect(b.memories.map((m) => m.id)).toEqual(['k2', 'k3'])
    expect(JSON.stringify(b)).not.toContain('segredo da Ana')
  })

  it("events of a DM reach only its person's ports; a channel's reach everyone", () => {
    const anaPort = new FakePort()
    const biaPort = new FakePort()
    expect(hub.add(anaPort, null)).toEqual(owner) // a desktop's window: the owner
    expect(hub.add(biaPort, { person: bia.id })).toEqual(bia)

    const secret = say('m1', 'bia-dm', { kind: 'agent', id: 'a1' }, 'só pra Bia')
    hub.emit({ type: 'message', message: secret })
    hub.emit({ type: 'delta', id: 'm1', text: ' mais' })
    hub.emit({ type: 'conversation', conversation: db.conversation('bia-dm')! })
    hub.emit({ type: 'artifact', artifact: { id: 'f', agentId: 'a1', conversationId: 'bia-dm', messageId: 'm1', kind: 'text', name: 'x.txt', title: 'x', source: '', size: 1, createdAt: 1 } })
    hub.emit({ type: 'memory', memory: { id: 'k', scope: personScope(bia.id), text: 'da Bia', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 } })
    expect(anaPort.got).toEqual([])
    expect(biaPort.got.map((e) => e.type)).toEqual(['message', 'delta', 'conversation', 'artifact', 'memory'])

    const open = say('m2', 'ch', { kind: 'agent', id: 'a1' }, 'pra todos')
    hub.emit({ type: 'message', message: open })
    hub.emit({ type: 'agent', agent: db.agent('a1')! })
    expect(anaPort.got.map((e) => e.type)).toEqual(['message', 'agent'])
    expect(biaPort.got.slice(-2).map((e) => e.type)).toEqual(['message', 'agent'])
  })

  it("an approval from a DM reaches its deciders and requester, never the rest; one in a channel, whoever reads it", () => {
    const carl = people.join(people.createInvite(owner, { role: 'member' }).code, 'Carl')
    if (!('person' in carl)) throw new Error(carl.error)
    const ports = { ana: new FakePort(), bia: new FakePort(), carl: new FakePort() }
    hub.add(ports.ana, null)
    hub.add(ports.bia, { person: bia.id })
    hub.add(ports.carl, { person: carl.person.id })
    hub.emit({ type: 'approval', approval: approval('p1', 'bia-dm', bia.id) })
    expect([ports.ana.got.length, ports.bia.got.length, ports.carl.got.length]).toEqual([1, 1, 0]) // the owner decides; Carl isn't in it
    hub.emit({ type: 'approval', approval: approval('p2', 'ch', bia.id) })
    expect([ports.ana.got.length, ports.bia.got.length, ports.carl.got.length]).toEqual([2, 2, 1])
  })

  it('counts unread per person, and what arrives where someone is looking is read for them', () => {
    const reply = (id: string): Message => say(id, 'ch', { kind: 'agent', id: 'a1' }, 'novidade')
    db.recordActivity(reply('r1'), new Map())
    expect(db.conversation('ch', owner.id)?.unread).toBe(1)
    expect(db.conversation('ch', bia.id)?.unread).toBe(1)
    db.markRead('ch', bia.id)
    expect(db.conversation('ch', owner.id)?.unread).toBe(1)
    expect(db.conversation('ch', bia.id)?.unread).toBe(0)
    // Bia has the channel open: the next one is read for her, not for Ana.
    db.recordActivity(reply('r2'), new Map([[bia.id, 'ch']]))
    expect(db.conversation('ch', owner.id)?.unread).toBe(2)
    expect(db.conversation('ch', bia.id)?.unread).toBe(0)
    // Each port gets its own count.
    const anaPort = new FakePort()
    const biaPort = new FakePort()
    hub.add(anaPort, null)
    hub.add(biaPort, { person: bia.id })
    hub.emit({ type: 'conversation', conversation: db.conversation('ch')! })
    expect(anaPort.got).toMatchObject([{ type: 'conversation', conversation: { unread: 2 } }])
    expect(biaPort.got).toMatchObject([{ type: 'conversation', conversation: { unread: 0 } }])
  })

  it('a person who joins later starts with nothing unread from before', () => {
    db.recordActivity(say('r1', 'ch', { kind: 'agent', id: 'a1' }, 'antes'), new Map())
    const dan = people.join(people.createInvite(owner, { role: 'member' }).code, 'Dan')
    if (!('person' in dan)) throw new Error(dan.error)
    expect(db.conversation('ch', dan.person.id)?.unread).toBe(0)
    db.recordActivity(say('r2', 'ch', { kind: 'agent', id: 'a1' }, 'depois'), new Map())
    expect(db.conversation('ch', dan.person.id)?.unread).toBe(1)
  })

  it('the requester of a reply is the DM person, or whoever wrote last in a channel', () => {
    const conv = (id: string) => db.conversation(id)!
    expect(requesterOf(db, conv('bia-dm'), []).id).toBe(bia.id)
    expect(requesterOf(db, conv('ana-dm'), []).id).toBe(owner.id)
    const msgs = [say('x1', 'ch', { kind: 'person', id: owner.id }, 'a'), say('x2', 'ch', { kind: 'person', id: bia.id }, 'b'), say('x3', 'ch', { kind: 'agent', id: 'a1' }, 'c')]
    expect(requesterOf(db, conv('ch'), msgs).id).toBe(bia.id)
    expect(requesterOf(db, conv('ch'), []).id).toBe(owner.id)
  })
})

describe('invites, keys and removal', () => {
  let db: Db
  let people: People
  let owner: Person

  beforeEach(() => {
    db = new Db(':memory:')
    people = new People(db)
    owner = db.owner()
  })

  it('only admins invite; a member is refused', () => {
    const { code, expiresAt } = people.createInvite(owner, { role: 'member' }, 1_000)
    expect(expiresAt).toBe(1_000 + INVITE_DAYS * 86_400_000)
    expect(db.invites()).toMatchObject([{ role: 'member', createdBy: owner.id }])
    expect(JSON.stringify(db.invites())).not.toContain(code) // only its hash is kept
    const joined = people.join(code, 'Bia', 2_000)
    if (!('person' in joined)) throw new Error(joined.error)
    expect(() => people.createInvite(joined.person, { role: 'member' })).toThrow(/admin/)
  })

  it('a code works once, for a week, and its key opens the person', () => {
    const { code } = people.createInvite(owner, { role: 'admin', about: 'design' })
    expect(people.join(code, '   ')).toMatchObject({ error: expect.any(String) }) // no name: the code isn't spent
    const joined = people.join(code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    expect(joined.person).toMatchObject({ name: 'Bia', role: 'admin', about: 'design' })
    expect(joined.key).toMatch(/^p_[\w-]{43}$/)
    expect(people.authenticate(joined.key)).toEqual(joined.person)
    expect(people.authenticate('p_' + 'x'.repeat(43))).toBeUndefined()
    expect(people.join(code, 'Outro')).toMatchObject({ error: expect.any(String) }) // used
    expect(people.join('nope', 'Outro')).toMatchObject({ error: expect.any(String) })
    const late = people.createInvite(owner, { role: 'member' }, Date.now() - (INVITE_DAYS + 1) * 86_400_000)
    expect(people.join(late.code, 'Tarde')).toMatchObject({ error: expect.any(String) }) // expired
  })

  it('removal ends access at once: keys gone, ports closed; an invite that restores brings the same person back', () => {
    const joined = people.join(people.createInvite(owner, { role: 'member' }).code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    const bia = joined.person
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: [], owner: bia.id })
    const hub = new Hub(people, db)
    const port = new FakePort()
    hub.add(port, { person: bia.id })

    expect(() => people.remove(bia, owner.id)).toThrow()
    people.remove(owner, bia.id)
    hub.closeFor(bia.id)
    expect(port.closed).toBe(true)
    expect(people.authenticate(joined.key)).toBeUndefined()
    expect(db.people().map((p) => p.id)).toEqual([owner.id])
    const again = new FakePort()
    expect(hub.add(again, { person: bia.id })).toBeUndefined() // a removed person's port closes
    expect(again.closed).toBe(true)
    expect(() => people.remove(owner, owner.id)).toThrow()

    const back = people.join(people.createInvite(owner, { role: 'member', restore: bia.id }).code, 'Bia Souza')
    if (!('person' in back)) throw new Error(back.error)
    expect(back.person).toMatchObject({ id: bia.id, name: 'Bia Souza' })
    expect(db.conversation('bia-dm')?.owner).toBe(bia.id) // her DM is still hers
  })
})

describe('leaving on one\'s own', () => {
  it('ends access now and takes what was theirs alone with it; the owner cannot leave', () => {
    const db = new Db(':memory:')
    const people = new People(db)
    const owner = db.owner()
    const joined = people.join(people.createInvite(owner, { role: 'member' }).code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    const bia = joined.person
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    db.saveMessage({ id: 'm1', conversationId: 'bia-dm', author: { kind: 'person', id: bia.id }, text: 'só meu', at: 1 })
    db.saveMessage({ id: 'm2', conversationId: 'ch', author: { kind: 'person', id: bia.id }, text: 'pro time', at: 2 })
    db.saveMemory({ id: 'k', scope: personScope(bia.id), text: 'da Bia', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })

    expect(() => people.leave(owner)).toThrow()
    const out = people.leave(bia)
    expect(out.purged.dms).toEqual(['bia-dm'])
    expect(people.authenticate(joined.key)).toBeUndefined()
    expect(db.people().map((p) => p.id)).toEqual([owner.id])
    expect(db.conversation('bia-dm')).toBeUndefined()
    expect(db.memories().some((m) => m.id === 'k')).toBe(false)
    expect(db.messages().map((m) => m.id)).toEqual(['m2']) // what was said in a channel stays the channel's
    expect(db.removedPeople().some((p) => p.id === bia.id)).toBe(false) // nothing kept for a re-invite
  })
})

describe('a reply, with people', () => {
  let db: Db
  let turns: Turn[]
  let notes: { kind?: string; to?: string[] }[]
  let runner: Runner
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Ana', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }

  beforeEach(() => {
    setLang('en')
    db = new Db(':memory:')
    db.renamePerson(db.ownerId(), 'Ana')
    turns = []
    notes = []
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = {
      id: 'claude',
      async *run(t) {
        turns.push(t)
        yield* base.run(t)
      }
    }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') } as Record<EngineId, Engine>
    runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: dir(), notify: (_t, _b, _c, kind, _th, to) => void notes.push({ kind, to }) })
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'] })
  })

  it('one person: the prompt reads as it always did', async () => {
    await runner.send('dm', 'hi')
    await runner.idle()
    expect(db.messages()[0]!.author).toEqual({ kind: 'person', id: db.ownerId() })
    const t = turns[0]!
    expect(t.system).toContain("You're in a direct conversation (DM) with Ana.")
    expect(t.system).not.toContain('## The people')
    expect(t.prompt).toMatch(/\[Ana · /)
    expect(notes).toEqual([{ kind: 'done', to: [db.ownerId()] }])
  })

  it("someone else's DM: the message is theirs, and the agent knows who they are", async () => {
    const people = new People(db)
    const bia = people.join(people.createInvite(db.owner(), { role: 'member', about: 'runs finance' }).code, 'Bia')
    if (!('person' in bia)) throw new Error(bia.error)
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.person.id })
    await runner.send('bia-dm', 'hi', [], undefined, bia.person.id)
    await runner.idle()
    expect(db.messages().find((m) => m.conversationId === 'bia-dm')!.author).toEqual({ kind: 'person', id: bia.person.id })
    const t = turns[0]!
    expect(t.system).toContain("You're in a direct conversation (DM) with Bia.")
    expect(t.system).toContain('## The people')
    expect(t.system).toContain('- Bia (member): runs finance')
    expect(t.prompt).toMatch(/\[Bia · /)
    expect(notes).toEqual([{ kind: 'done', to: [bia.person.id] }])
  })
})
