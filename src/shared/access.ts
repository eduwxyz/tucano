// What a person sees of the team (PersonAccess). One rule, the same on the server, which enforces it,
// and on the page, which shows it: the owner, admins and anyone on 'all' see everything; someone on
// 'picked' sees the agents and channels marked, every agent of a marked sector (its head and everyone
// below it, as the org chart has it now), and Tuca, who helps everyone. Their own DMs are theirs as always.
import { reportsOf } from './org'
import { L } from './lang'
import type { Agent, Conversation, Person, PersonAccess } from './types'

type Who = Pick<Person, 'role' | 'access'>
type AgentNode = Pick<Agent, 'id' | 'reportsTo'> & Partial<Pick<Agent, 'archived' | 'kind'>>

export const EVERYTHING: PersonAccess = { mode: 'all', sectors: [], agents: [], channels: [] }

// Whether this person's view is cut down at all.
export const restricted = (p: Who | undefined): boolean => !!p && p.role === 'member' && p.access?.mode === 'picked'

// The agents this person sees, or undefined when they see them all.
export function visibleAgentIds(p: Who | undefined, agents: AgentNode[]): Set<string> | undefined {
  if (!restricted(p)) return undefined
  const a = p!.access!
  const ids = new Set<string>(a.agents)
  for (const head of a.sectors) {
    if (!agents.some((x) => x.id === head && !x.archived)) continue
    ids.add(head)
    for (const r of reportsOf(agents, head)) ids.add(r.id)
  }
  for (const x of agents) if (x.kind === 'tuca') ids.add(x.id)
  return ids
}

export const seesAgent = (p: Who | undefined, agents: AgentNode[], id: string): boolean => visibleAgentIds(p, agents)?.has(id) ?? true

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
