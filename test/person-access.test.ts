// What a person sees of the team (PersonAccess): the shared rule, how it is stored, and what the core enforces.
import { afterEach, describe, expect, it } from 'vitest'
import { accessSummary, cleanAccess, EVERYTHING, sharedAccess, visibleAgentIds } from '../src/shared/access'
import { setLang } from '../src/shared/lang'
import type { Snapshot } from '../src/shared/rpc'
import type { Agent, Person, PersonAccess, Settings } from '../src/shared/types'
import { assertAgentVisible, assertChannelVisible, routineCut } from '../src/core/access-policy'
import { can } from '../src/core/policy-people'
import { Db } from '../src/core/db'
import { deciders, People, requesterOf } from '../src/core/people'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const picked = (p: Partial<PersonAccess> = {}): PersonAccess => ({ mode: 'picked', sectors: [], agents: [], channels: [], ...p })
const ids = (s: Set<string> | undefined): string[] | undefined => s && [...s].sort()

afterEach(() => setLang('pt'))

describe('the shared rule', () => {
  const org = [agent('head'), agent('w1', { reportsTo: 'head' }), agent('solo'), agent('other'), agent('tuca', { kind: 'tuca' })]

  it('the owner, admins and anyone on "all" see every agent', () => {
    expect(visibleAgentIds({ role: 'owner' }, org)).toBeUndefined()
    expect(visibleAgentIds({ role: 'admin', access: picked() }, org)).toBeUndefined()
    expect(visibleAgentIds({ role: 'member', access: EVERYTHING }, org)).toBeUndefined()
    expect(visibleAgentIds({ role: 'member' }, org)).toBeUndefined()
  })

  it('a member on "picked" sees a sector (its head and everyone below, even who joins later), single agents and Tuca', () => {
    const m = { role: 'member' as const, access: picked({ sectors: ['head'], agents: ['solo'] }) }
    expect(ids(visibleAgentIds(m, org))).toEqual(['head', 'solo', 'tuca', 'w1'])
    expect(ids(visibleAgentIds(m, [...org, agent('w2', { reportsTo: 'w1' })]))).toEqual(['head', 'solo', 'tuca', 'w1', 'w2'])
    expect(ids(visibleAgentIds({ role: 'member', access: picked() }, org))).toEqual(['tuca'])
  })

  it('an archived head contributes nothing', () => {
    const m = { role: 'member' as const, access: picked({ sectors: ['head'] }) }
    expect(ids(visibleAgentIds(m, [agent('head', { archived: true }), agent('w1', { reportsTo: 'head' }), agent('tuca', { kind: 'tuca' })]))).toEqual(['tuca'])
  })

  it('a sector whose head became an entry point, or now answers to another, is that agent alone, never the tree under it', () => {
    const m = { role: 'member' as const, access: picked({ sectors: ['head'] }) }
    // "head" was marked the entry point (#465): the sectors are now its leads, and "head" heads none.
    const entry = [agent('head', { entry: true }), agent('lead', { reportsTo: 'head' }), agent('w1', { reportsTo: 'lead' }), agent('other', { reportsTo: 'head' }), agent('tuca', { kind: 'tuca' })]
    expect(ids(visibleAgentIds(m, entry))).toEqual(['head', 'tuca'])
    // "head" now answers to "boss": the sector is boss's, not head's.
    const moved = [agent('boss'), agent('head', { reportsTo: 'boss' }), agent('w1', { reportsTo: 'head' }), agent('tuca', { kind: 'tuca' })]
    expect(ids(visibleAgentIds(m, moved))).toEqual(['head', 'tuca'])
    // A lead under an entry point is a sector head: picked, its people come with it.
    expect(ids(visibleAgentIds({ role: 'member', access: picked({ sectors: ['lead'] }) }, entry))).toEqual(['lead', 'tuca', 'w1'])
  })

  it('what several people see together is only what each of them sees', () => {
    const bia = { role: 'member' as const, access: picked({ sectors: ['head'], channels: ['ch', 'ch2'] }) }
    const caio = { role: 'member' as const, access: picked({ agents: ['w1', 'solo'], channels: ['ch'] }) }
    const both = sharedAccess([bia, caio, { role: 'owner' }], org)!
    expect([...both.agents].sort()).toEqual(['tuca', 'w1'])
    expect(both.channels).toEqual(['ch'])
    expect(ids(visibleAgentIds({ role: 'member', access: both }, org))).toEqual(['tuca', 'w1'])
    // One restricted and others who see everything: that one's view.
    expect([...sharedAccess([bia, { role: 'admin' }], org)!.agents].sort()).toEqual(['head', 'tuca', 'w1'])
    expect(sharedAccess([{ role: 'owner' }, { role: 'member' }], org)).toBeUndefined()
  })

  it('the summary says what is seen, in the language of the app', () => {
    const channels = [{ id: 'ch' }, { id: 'ch2' }]
    expect(accessSummary({ role: 'admin' }, org, channels)).toBe('Vê tudo')
    expect(accessSummary({ role: 'member', access: picked({ agents: ['solo'], channels: ['ch'] }) }, org, channels)).toBe('Vê 1 agente · 1 canal')
    expect(accessSummary({ role: 'member', access: picked({ sectors: ['head'], channels: ['ch', 'ch2'] }) }, org, channels)).toBe('Vê 2 agentes · 2 canais')
    expect(accessSummary({ role: 'member', access: picked() }, org, channels)).toBe('Não vê nenhum agente')
    setLang('en')
    expect(accessSummary({ role: 'member', access: picked({ agents: ['solo'], channels: ['ch'] }) }, org, channels)).toBe('Sees 1 agent · 1 channel')
  })

  it('cleaning drops what does not exist and reads anything malformed as everything', () => {
    expect(cleanAccess(picked({ sectors: ['head', 'gone'], agents: ['solo', 'solo', 7 as unknown as string], channels: ['ch', 'nope'] }), ['head', 'solo'], ['ch'])).toEqual(picked({ sectors: ['head'], agents: ['solo'], channels: ['ch'] }))
    expect(cleanAccess({ mode: 'picked', sectors: 'head' } as unknown as PersonAccess, ['head'], [])).toEqual(picked())
    expect(cleanAccess({ mode: 'weird' } as unknown as PersonAccess, [], [])).toEqual(EVERYTHING)
    expect(cleanAccess(null as unknown as PersonAccess, [], [])).toEqual(EVERYTHING)
  })
})

// Ana (owner), Bia (a member, cut down to the "head" sector and the "ch" channel), Carl (a member) and Dani (an admin).
function team(): { db: Db; people: People; ana: Person; bia: Person; carl: Person; dani: Person } {
  const db = new Db(':memory:')
  db.renamePerson(db.ownerId(), 'Ana')
  const people = new People(db)
  const ana = db.owner()
  const join = (name: string, role: 'member' | 'admin', access?: PersonAccess): Person => {
    const r = people.join(people.createInvite(ana, { role, ...(access ? { access } : {}) }).code, name)
    if (!('person' in r)) throw new Error(r.error)
    return r.person
  }
  db.saveAgent(agent('head'))
  db.saveAgent(agent('w1', { reportsTo: 'head' }))
  db.saveAgent(agent('hidden'))
  db.saveAgent(agent('tuca', { kind: 'tuca' }))
  db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['head', 'hidden'] })
  db.createConversation({ id: 'ch2', kind: 'channel', name: 'financeiro', members: ['head'] })
  const bia = join('Bia', 'member', picked({ sectors: ['head'], channels: ['ch'] }))
  return { db, people, ana, bia, carl: join('Carl', 'member'), dani: join('Dani', 'admin') }
}

describe('storing access', () => {
  it('a member keeps what was picked, and "all" stores nothing', () => {
    const { db, bia, carl } = team()
    expect(db.person(bia.id)?.access).toEqual(picked({ sectors: ['head'], channels: ['ch'] }))
    db.setPersonAccess(carl.id, picked({ agents: ['hidden', 'gone'] }))
    expect(db.person(carl.id)?.access).toEqual(picked({ agents: ['hidden'] }))
    db.setPersonAccess(carl.id, EVERYTHING)
    expect(db.person(carl.id)?.access).toBeUndefined()
  })

  it('an admin or the owner keeps none, whatever is asked', () => {
    const { db, ana, dani } = team()
    db.setPersonAccess(dani.id, picked())
    db.setPersonAccess(ana.id, picked())
    expect(db.person(dani.id)?.access).toBeUndefined()
    expect(db.person(ana.id)?.access).toBeUndefined()
  })

  it('an invite with access gives it to whoever joins; one without gives everything', () => {
    const { db, bia, carl } = team()
    expect(db.person(bia.id)?.access?.mode).toBe('picked')
    expect(db.person(carl.id)?.access).toBeUndefined()
  })
})

describe('what a restricted member can reach', () => {
  it('a channel they were given, not the others; a DM with an agent they see, not with one they cannot', () => {
    const { db, people, bia } = team()
    db.createConversation({ id: 'dm-head', kind: 'dm', name: 'head', members: ['head'], owner: bia.id })
    db.createConversation({ id: 'dm-hidden', kind: 'dm', name: 'hidden', members: ['hidden'], owner: bia.id })
    const of = (id: string) => db.conversationOwner(id)
    expect(people.canSeeConversation(bia, of('ch'))).toBe(true)
    expect(people.canSeeConversation(bia, of('ch2'))).toBe(false)
    expect(people.canSeeConversation(bia, of('dm-head'))).toBe(true)
    expect(people.canSeeConversation(bia, of('dm-hidden'))).toBe(false)
  })

  it('the snapshot lists only visible agents and takes the hidden ones out of channel members', () => {
    const { db, people, ana, bia } = team()
    const base = (): Omit<Snapshot, 'people' | 'you' | 'needsName' | 'conversations' | 'inbox'> => ({ settings: {} as Settings, agents: db.agents(), messages: [], connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'mac', packaged: false, isolatedComputers: true })
    const mine = people.snapshotFor(bia, base())
    expect(mine.agents.map((a) => a.id).sort()).toEqual(['head', 'tuca', 'w1'])
    expect(mine.conversations.map((c) => c.id)).toEqual(['ch'])
    expect(mine.conversations[0]?.members).toEqual(['head'])
    expect(people.snapshotFor(ana, base()).agents).toHaveLength(4)
    expect(db.conversation('ch')?.members).toEqual(['head', 'hidden']) // stored as it was
  })

  it("another member's access is stripped for a member and kept for the owner; one's own stays", () => {
    const { people, ana, bia, carl } = team()
    const base: Omit<Snapshot, 'people' | 'you' | 'needsName' | 'conversations' | 'inbox'> = { settings: {} as Settings, agents: [], messages: [], connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'mac', packaged: false, isolatedComputers: true }
    const seen = (viewer: Person) => people.snapshotFor(viewer, base).people.find((p) => p.id === bia.id)
    expect(seen(carl)?.access).toBeUndefined()
    expect(seen(ana)?.access?.mode).toBe('picked')
    expect(seen(bia)?.access?.mode).toBe('picked')
  })

  it('a hidden agent is refused with a plain message, in either language, and the owner is never refused', () => {
    const { db, ana, bia } = team()
    expect(() => assertAgentVisible(db, bia, 'hidden')).toThrow('Esse agente não está disponível pra você.')
    expect(() => assertAgentVisible(db, bia, 'w1')).not.toThrow()
    expect(() => assertAgentVisible(db, ana, 'hidden')).not.toThrow()
    setLang('en')
    expect(() => assertAgentVisible(db, bia, 'hidden')).toThrow("That agent isn't available to you.")
  })

  it('a channel taken out of their access is not theirs to change, even one they made; one given in the same request is', () => {
    const { db, ana, bia } = team()
    expect(() => assertChannelVisible(db, bia, { id: 'ch2', kind: 'channel' })).toThrow('Esse canal não está disponível pra você.')
    expect(() => assertChannelVisible(db, bia, { id: 'ch', kind: 'channel' })).not.toThrow()
    expect(() => assertChannelVisible(db, ana, { id: 'ch2', kind: 'channel' })).not.toThrow()
    db.setPersonAccess(bia.id, { ...db.person(bia.id)!.access!, channels: ['ch', 'ch2'] })
    expect(() => assertChannelVisible(db, bia, { id: 'ch2', kind: 'channel' })).not.toThrow() // bia as the request had her: read again
  })

  it('only an admin or the owner changes it, and only for a member', () => {
    const { db, people, ana, bia, carl, dani } = team()
    expect(() => people.setPersonAccess(bia, carl.id, picked())).toThrow()
    expect(() => people.setPersonAccess(carl, carl.id, EVERYTHING)).toThrow()
    expect(() => people.setPersonAccess(ana, dani.id, picked())).toThrow('Admins e o dono sempre veem tudo.')
    expect(() => people.setPersonAccess(dani, ana.id, picked())).toThrow()
    expect(people.setPersonAccess(dani, carl.id, picked({ agents: ['hidden'] })).access).toEqual(picked({ agents: ['hidden'] }))
    expect(db.activity({ kind: 'person.access' }).length).toBe(1)
  })
})

describe('work an agent hands down for a restricted member', () => {
  it('runs for the member who asked, not for the owner, all the way down the chain', () => {
    const { db, ana, bia } = team()
    const conv = db.conversation('ch2')!
    const hand = (id: string, rootId: string, requestedBy: string): void =>
      db.saveDelegation({ id, from: 'head', to: 'w1', conversationId: conv.id, rootId, originConversationId: 'ch', originMessageId: 'm0', requestedBy, text: 'faça', state: 'open', createdAt: 1 })
    hand('d1', 'root-bia', bia.id)
    expect(requesterOf(db, conv, [], 'root-bia').id).toBe(bia.id)
    hand('d2', 'root-ana', ana.id)
    expect(requesterOf(db, conv, [], 'root-ana').id).toBe(ana.id)
    expect(requesterOf(db, conv, []).id).toBe(ana.id) // a bare channel, as before
    expect(requesterOf(db, conv, [], 'no-such-thread').id).toBe(ana.id)
  })

  it('a person who writes in that thread is who it is for from then on', () => {
    const { db, ana, bia } = team()
    const conv = db.conversation('ch2')!
    db.saveDelegation({ id: 'd1', from: 'head', to: 'w1', conversationId: conv.id, rootId: 'root', originConversationId: 'ch', originMessageId: 'm0', requestedBy: bia.id, text: 'faça', state: 'open', createdAt: 1 })
    const said = { id: 'm1', conversationId: conv.id, threadId: 'root', author: { kind: 'person', id: ana.id }, text: 'eu assumo', at: 2 } as unknown as Parameters<typeof requesterOf>[2][number]
    expect(requesterOf(db, conv, [said], 'root').id).toBe(ana.id)
  })
})

describe('covering for someone', () => {
  it('a restricted member cannot be picked to cover; anyone else can', () => {
    const { people, ana, bia, carl } = team()
    const week = Date.now() + 7 * 86_400_000
    expect(() => people.setDelegation(carl, bia.id, week)).toThrow('Bia não vê todo o time, então não pode cobrir ninguém.')
    setLang('en')
    expect(() => people.setDelegation(carl, bia.id, week)).toThrow("Bia doesn't see the whole team, so they can't cover for anyone.")
    expect(() => people.setDelegation(carl, ana.id, week)).not.toThrow()
  })

  it('one who becomes restricted stops covering, and an old cover to them decides and answers nothing', () => {
    const { db, people, ana, bia, carl } = team()
    const week = Date.now() + 7 * 86_400_000
    db.saveAgent(agent('carls', { owner: carl.id }))
    // From before the rule: Carl left Bia covering for him.
    db.setDelegation(carl.id, bia.id, week)
    expect(deciders(db, 'carls')).not.toContain(bia.id)
    expect(can(bia, { kind: 'approval', agentOwner: db.person(carl.id) })).toBe(false)
    db.saveQuestion({ id: 'q1', conversationId: 'ch2', agentId: 'carls', text: 'Qual o orçamento?', askedTo: carl.id, requestedBy: carl.id, state: 'open', deadlineAt: week, createdAt: 1 })
    expect(people.inbox(db.person(bia.id)!).questions).toHaveLength(0)
    expect(can(bia, { kind: 'question', question: db.openQuestions()[0]!, askedTo: db.person(carl.id) })).toBe(false)
    // Dani-less: Carl covers for Ana, then Ana cuts Carl down: the cover ends.
    db.setDelegation(ana.id, carl.id, week)
    expect(deciders(db, 'carls')).toContain(carl.id)
    people.setPersonAccess(ana, carl.id, picked({ agents: ['carls'] }))
    expect(db.person(ana.id)?.delegateTo).toBeUndefined()
  })
})

describe('a restricted member\'s routines', () => {
  it('stop in a channel they no longer see, even with an agent they still see', () => {
    const { db, bia, carl } = team()
    const r = { agentId: 'head', owner: bia.id }
    expect(routineCut(db, { ...r, conversationId: 'ch' })).toBe(false)
    expect(routineCut(db, { ...r, conversationId: 'ch2' })).toBe(true)
    expect(routineCut(db, { ...r, agentId: 'hidden', conversationId: 'ch' })).toBe(true)
    expect(routineCut(db, { agentId: 'hidden', owner: carl.id, conversationId: 'ch2' })).toBe(false) // sees everything
  })
})
