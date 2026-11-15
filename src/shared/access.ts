// What a person sees of the team (PersonAccess). One rule, the same on the server, which enforces it,
// and on the page, which shows it: the owner, admins and anyone on 'all' see everything; someone on
// 'picked' sees the agents and channels marked, every agent of a marked sector (its head and everyone
// below it, as the org chart has it now), and Tuca, who helps everyone. Their own DMs are theirs as always.
import { headsOf, reportsOf } from './org'
import { L } from './lang'
import { delegating, type Agent, type Conversation, type Person, type PersonAccess } from './types'

type Who = Pick<Person, 'role' | 'access'>
type AgentNode = Pick<Agent, 'id' | 'reportsTo'> & Partial<Pick<Agent, 'archived' | 'kind' | 'entry'>>

export const EVERYTHING: PersonAccess = { mode: 'all', sectors: [], agents: [], channels: [] }

// Whether this person's view is cut down at all.
export const restricted = (p: Who | undefined): boolean => !!p && p.role === 'member' && p.access?.mode === 'picked'

// Whether `who` covers for `of` right now. Never someone restricted: covering decides another
// person's approvals and answers their questions, whatever agent or channel they come from.
export const covers = (of: Pick<Person, 'delegateTo' | 'delegateUntil'> | undefined, who: (Who & Pick<Person, 'id'>) | undefined, now = Date.now()): boolean =>
  !!who && !restricted(who) && delegating(of, who.id, now)

// The agents this person sees, or undefined when they see them all.
export function visibleAgentIds(p: Who | undefined, agents: AgentNode[]): Set<string> | undefined {
  if (!restricted(p)) return undefined
  const a = p!.access!
  const ids = new Set<string>(a.agents)
  // A sector reaches below its head only while that agent heads one (headsOf, as the tree is now):
  // one made an entry point since, or moved under another, is that agent alone, never the whole tree under it.
  const heads = new Set(headsOf(agents).map((h) => h.id))
  for (const head of a.sectors) {
    if (!agents.some((x) => x.id === head && !x.archived)) continue
    ids.add(head)
    if (heads.has(head)) for (const r of reportsOf(agents, head)) ids.add(r.id)
  }
  for (const x of agents) if (x.kind === 'tuca') ids.add(x.id)
  return ids
}

export const seesAgent = (p: Who | undefined, agents: AgentNode[], id: string): boolean => visibleAgentIds(p, agents)?.has(id) ?? true

// What several people see together, for one reply that all of them read: only what every one of
// them sees. Undefined when none of them is restricted. A sector counts as its agents, as the tree is now.
export function sharedAccess(people: Who[], agents: AgentNode[]): PersonAccess | undefined {
  const cut = people.filter((p) => restricted(p))
  if (!cut.length) return undefined
  const seen = cut.map((p) => visibleAgentIds(p, agents)!)
  const both = <T,>(lists: T[][]): T[] => lists.reduce((a, b) => a.filter((x) => b.includes(x)))
  return { mode: 'picked', sectors: [], agents: both(seen.map((s) => [...s])), channels: both(cut.map((p) => p.access!.channels)) }
}

// Whether this person sees a channel (a DM is decided by its owner and agent elsewhere).
export const seesChannel = (p: Who | undefined, channelId: string): boolean => !restricted(p) || p!.access!.channels.includes(channelId)

// "Vê tudo" / "Vê 2 agentes · 1 canal", for the people list.
export function accessSummary(p: Who | undefined, agents: AgentNode[], channels: Pick<Conversation, 'id'>[]): string {
  const seen = visibleAgentIds(p, agents)
  if (!seen) return L('Vê tudo', 'Sees everything')
  const team = agents.filter((a) => !a.archived && a.kind !== 'tuca' && seen.has(a.id)).length
  const rooms = channels.filter((c) => p!.access!.channels.includes(c.id)).length
  if (!team && !rooms) return L('Não vê nenhum agente', 'Sees no agent')
  const parts = [
    team ? (team === 1 ? L('1 agente', '1 agent') : L(`${team} agentes`, `${team} agents`)) : '',
    rooms ? (rooms === 1 ? L('1 canal', '1 channel') : L(`${rooms} canais`, `${rooms} channels`)) : ''
  ].filter(Boolean)
  return L(`Vê ${parts.join(' · ')}`, `Sees ${parts.join(' · ')}`)
}

// A stored access with what no longer exists dropped (an agent or channel removed since).
// Whatever came in (a page's request, a stored value) is read defensively: anything but a list of
// ids counts as none, and anything but 'picked' as everything.
export function cleanAccess(a: PersonAccess, agentIds: string[], channelIds: string[]): PersonAccess {
  if (!a || typeof a !== 'object' || a.mode !== 'picked') return EVERYTHING
  const uniq = (xs: unknown, ok: string[]): string[] => (Array.isArray(xs) ? [...new Set(xs)].filter((x): x is string => typeof x === 'string' && ok.includes(x)) : [])
  return { mode: 'picked', sectors: uniq(a.sectors, agentIds), agents: uniq(a.agents, agentIds), channels: uniq(a.channels, channelIds) }
}
