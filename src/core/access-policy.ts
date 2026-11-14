// What a restricted member (PersonAccess) may reach, on the server. The rule itself is in
// src/shared/access.ts, the same one the page shows; this is where the core asks it: which agents
// a request may use, which conversations it may open, and the error for what is out of reach.
import { L } from '../shared/lang'
import { restricted, seesAgent, seesChannel, visibleAgentIds } from '../shared/access'
import type { Agent, Conversation, Person, Routine } from '../shared/types'
import type { Db } from './db'

type Who = Pick<Person, 'role' | 'access'>

export const hiddenAgentError = (): string => L('Esse agente não está disponível pra você.', "That agent isn't available to you.")

// The agents this person may use (all of them when nothing is cut). `keep`: one that stays anyway,
// like the agent answering, so a prompt built from the list still has it.
export function agentsFor<T extends Pick<Agent, 'id' | 'reportsTo'> & Partial<Pick<Agent, 'archived' | 'kind'>>>(person: Who | undefined, agents: T[], keep?: string): T[] {
  const seen = visibleAgentIds(person, agents)
  return seen ? agents.filter((a) => seen.has(a.id) || a.id === keep) : agents
}

// Throws for an agent a restricted person can't reach (or that no longer exists). Anyone who sees
// everything goes on exactly as before.
export function assertAgentVisible(db: Db, person: Who, agentId: string): void {
  if (!restricted(person)) return
  const agent = db.agent(agentId)
  if (!agent || !seesAgent(person, db.agents(), agentId)) throw new Error(hiddenAgentError())
}

// Whether a conversation is within this person's access: a channel they were given, a DM with an
// agent they see. (Whose a DM is, stays with dmOwner.) Not asked for someone who sees everything.
export function withinAccess(db: Db, person: Who, c: Pick<Conversation, 'kind'> & Partial<Pick<Conversation, 'id' | 'name'>>): boolean {
  if (!restricted(person)) return true
  if (c.kind === 'dm') return !!c.name && seesAgent(person, db.agents(), c.name)
  return !!c.id && seesChannel(person, c.id)
}

// A channel a restricted member makes is theirs to see: it joins their access.
export function grantOwnChannel(db: Db, person: Person, channelId: string): void {
  const now = db.person(person.id) ?? person // read again: one request may make more than one channel
  if (restricted(now)) db.setPersonAccess(now.id, { ...now.access!, channels: [...now.access!.channels, channelId] })
}

// The members a restricted person asks for in a channel: only agents they see; the ones they can't see stay as they were.
export function membersFor(db: Db, person: Person, current: string[], asked: string[]): string[] {
  const seen = visibleAgentIds(person, db.agents())
  return seen ? [...asked.filter((a) => seen.has(a)), ...current.filter((a) => !seen.has(a))] : asked
}

// What a person is told of another: their access only goes to admins and to themself.
export function accessVisibleTo(viewer: Pick<Person, 'id' | 'role'>, who: Pick<Person, 'id'>): boolean {
  return viewer.role === 'owner' || viewer.role === 'admin' || viewer.id === who.id
}

export function peopleFor(viewer: Pick<Person, 'id' | 'role'>, people: Person[]): Person[] {
  return people.map((p) => {
    if (!p.access || accessVisibleTo(viewer, p)) return p
    const { access: _a, ...rest } = p
    return rest
  })
}

// A reply by an agent this person can't see is not theirs to retry or continue.
export function assertReplyVisible(db: Db, person: Who, messageId: string): void {
  const author = db.message(messageId)?.author
  if (author?.kind === 'agent' && restricted(person) && !seesAgent(person, db.agents(), author.id)) throw new Error(hiddenAgentError())
}

// A routine whose person (its owner) can no longer see its agent: it doesn't run.
export function routineCut(db: Db, r: Pick<Routine, 'agentId' | 'owner'>): boolean {
  const owner = r.owner ? db.person(r.owner) : undefined
  return restricted(owner) && !seesAgent(owner, db.agents(), r.agentId)
}

// The people whose view is cut down now: their open pages read it again when what they see changes.
export const restrictedIds = (db: Db): string[] => db.people().filter((p) => restricted(p)).map((p) => p.id)

// A restricted viewer's channels, with the members they can't see left out (a DM is its one agent's, decided elsewhere).
export function viewedConversations<T extends Pick<Conversation, 'kind' | 'members'>>(db: Db, person: Who | undefined, cs: T[]): T[] {
  if (!restricted(person)) return cs
  const seen = visibleAgentIds(person, db.agents())!
  return cs.map((c) => (c.kind === 'dm' ? c : { ...c, members: c.members.filter((m) => seen.has(m)) }))
}
