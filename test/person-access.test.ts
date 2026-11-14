// What a person sees of the team (PersonAccess): the shared rule, how it is stored, and what the core enforces.
import { afterEach, describe, expect, it } from 'vitest'
import { accessSummary, cleanAccess, EVERYTHING, visibleAgentIds } from '../src/shared/access'
import { setLang } from '../src/shared/lang'
import type { Snapshot } from '../src/shared/rpc'
import type { Agent, Person, PersonAccess, Settings } from '../src/shared/types'
import { assertAgentVisible } from '../src/core/access-policy'
import { Db } from '../src/core/db'
import { People } from '../src/core/people'

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
