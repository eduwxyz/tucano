// Who answers to whom. An agent may answer to another (Agent.reportsTo), which makes a tree: an agent
// hands work to anyone below it, and to those who answer to the same agent as it does, in that one's
// own channel, and what comes of it goes back to it. Each tree is a sector, headed by its top; under an
// agent the person chose as an entry point, each team below it is a sector instead. Up, only to its own
// boss (what it can't do) and
// straight to its sector's head (what isn't the sector's), never one step at a time: each step is one
// more reply and one more retelling. Each tree is a sector (its top agent is the head): only heads ask
// other sectors, and only their heads, who pass it down their own branch.
// With no one answering to anyone there is no tree: then each agent may ask any other, as colleagues.
import type { Agent, Conversation } from './types'

type Node = Pick<Agent, 'id' | 'reportsTo'> & Partial<Pick<Agent, 'archived' | 'kind' | 'entry'>>

// The agent `a` answers to. One that was archived is passed over: whoever answered to it answers to
// its own boss meanwhile, and to it again when it comes back.
export function bossOf<T extends Node>(agents: T[], a: Node): T | undefined {
  const seen = new Set([a.id])
  for (let id = a.reportsTo; id && !seen.has(id); ) {
    seen.add(id)
    const boss = agents.find((x) => x.id === id)
    if (!boss) return undefined
    if (!boss.archived) return boss
    id = boss.reportsTo
  }
  return undefined
}

// Those who answer straight to `id`, as they were made.
export const directReports = <T extends Node>(agents: T[], id: string): T[] => agents.filter((a) => !a.archived && a.id !== id && bossOf(agents, a)?.id === id)

// Everyone below `id`, nearest first. A loop left by hand (a → b → a) is walked once.
export function reportsOf<T extends Node>(agents: T[], id: string): T[] {
  const out: T[] = []
  const seen = new Set([id])
  for (let level = directReports(agents, id); level.length; ) {
    const next: T[] = []
    for (const a of level) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      out.push(a)
      next.push(...directReports(agents, a.id))
    }
    level = next
  }
  return out
}

// Those who answer to the same agent as `id` does: its colleagues, who may ask each other for work.
// Answering to no agent (to the person alone) makes no colleagues.
export function peersOf<T extends Node>(agents: T[], id: string): T[] {
  const me = agents.find((a) => a.id === id)
  const boss = me && !me.archived ? bossOf(agents, me) : undefined
  return boss ? directReports(agents, boss.id).filter((a) => a.id !== id) : []
}

// Whether `a` is in no tree: it answers to no agent, no one answers to it, and the person didn't make it
// an entry point. The Tuca (it builds the others) and the archived are never counted.
const isLoose = <T extends Node>(agents: T[], a: T): boolean => !a.archived && a.kind !== 'tuca' && a.entry !== true && !bossOf(agents, a) && directReports(agents, a.id).length === 0

// Those `id` works beside when neither is in any tree: a team nobody drew is still a team, and its agents
// may ask each other. Whoever is in a tree keeps the tree's ways, and is not one of these.
export function looseColleaguesOf<T extends Node>(agents: T[], id: string): T[] {
  const me = agents.find((a) => a.id === id)
  if (!me || !isLoose(agents, me)) return []
  return agents.filter((a) => a.id !== id && isLoose(agents, a))
}

// The tops of the trees: those who answer to no agent and have someone below, Tuca aside.
const topsOf = <T extends Node>(agents: T[]): T[] => agents.filter((a) => !a.archived && a.kind !== 'tuca' && !bossOf(agents, a) && directReports(agents, a.id).length > 0)

// The entry points: an agent the person chose as one (Agent.entry) that answers to no agent. It is in no
// sector: the person talks to it, and it passes each part to the sector it belongs to; those who answer
// to it and have someone below head a sector each. Nothing asks for one: a person may draw only
// sectors, or only agents alone. It is a choice and never read off the tree: a deep sector (a head, a
// lead below it, the lead's own people) looks the same.
export const entriesOf = <T extends Node>(agents: T[]): T[] => agents.filter((a) => a.entry === true && !a.archived && a.kind !== 'tuca' && !bossOf(agents, a))

// The first of them: whom the board's box asks when no card is picked.
export const entryOf = <T extends Node>(agents: T[]): T | undefined => entriesOf(agents)[0]

// The sector heads: under an entry point, those who answer to it and have someone below; any other
// top of a tree heads its own tree. Both kinds may be on the same board.
export const headsOf = <T extends Node>(agents: T[]): T[] => {
  const entries = entriesOf(agents)
  return topsOf(agents).flatMap((t) => (entries.some((e) => e.id === t.id) ? directReports(agents, t.id).filter((a) => directReports(agents, a.id).length > 0) : [t]))
}

// The head of the sector `id` is in (itself, when it is one); none when it is in no sector: alone, the
// entry point, or one who answers to the entry point with no team of its own.
export function sectorOf<T extends Node>(agents: T[], id: string): T | undefined {
  const me = agents.find((a) => a.id === id)
  if (!me || me.archived) return undefined
  const heads = headsOf(agents)
  const seen = new Set<string>()
  for (let at: T | undefined = me; at && !seen.has(at.id); at = bossOf(agents, at)) {
    seen.add(at.id)
    const head = heads.find((h) => h.id === at!.id)
    if (head) return head
  }
  return undefined
}

// A sector's name as people read it: the one given on its head, or "Setor de <head>".
export const sectorName = (head: Pick<Agent, 'name'> & Partial<Pick<Agent, 'sectorName'>>, of = 'Setor de'): string => head.sectorName?.trim() || `${of} ${head.name}`

// Everyone `id` may hand work to: those below it, its colleagues, its own boss, its sector's head (however
// far above), and, when it heads a sector or is an entry point, the sectors' heads. Nearest first, each once.
// One in no tree reaches the others in none (looseColleaguesOf).
export const reachOf = <T extends Node>(agents: T[], id: string): T[] => {
  const loose = looseColleaguesOf(agents, id)
  if (loose.length) return loose
  const me = agents.find((a) => a.id === id)
  const boss = me && !me.archived ? bossOf(agents, me) : undefined
  const isHead = headsOf(agents).some((h) => h.id === id)
  const isEntry = entriesOf(agents).some((e) => e.id === id)
  const head = boss && !isHead ? sectorOf(agents, id) : undefined
  const all = [...reportsOf(agents, id), ...peersOf(agents, id), ...(boss ? [boss] : []), ...(head ? [head] : []), ...(isHead || isEntry ? headsOf(agents).filter((h) => h.id !== id) : [])]
  return all.filter((a, i) => all.findIndex((b) => b.id === a.id) === i)
}

// Everyone `id` may ask: the tree organizes who divides the work and whom to think of first, but it fences
// no one in. Those it reaches by the tree come first (reachOf), then everyone else, each once. Not the Tuca
// (it builds the others), nor an archived agent.
export const anyoneOf = <T extends Node>(agents: T[], id: string): T[] => {
  const near = reachOf(agents, id)
  const rest = agents.filter((a) => a.id !== id && !a.archived && a.kind !== 'tuca' && !near.some((n) => n.id === a.id))
  return [...near.filter((a) => !a.archived && a.kind !== 'tuca'), ...rest]
}

// How `from` asking `to` goes: down its branch, to a colleague, up (to its own boss or its sector's head), to
// another sector's head, or to someone out of its way in the tree ('other': another sector's member, a loose agent).
export type AskKind = 'down' | 'peer' | 'up' | 'sector' | 'other'
export function askKind(agents: Node[], from: string, to: string): AskKind {
  if (from === to) return 'peer' // a head and itself are not two sectors
  if (looseColleaguesOf(agents, from).some((a) => a.id === to)) return 'peer' // two agents in no tree
  // Two heads, whether each tops a tree or both answer to the entry point: one sector asking another.
  const heads = headsOf(agents)
  if (heads.some((h) => h.id === from) && heads.some((h) => h.id === to)) return 'sector'
  if (reportsOf(agents, from).some((a) => a.id === to)) return 'down'
  if (peersOf(agents, from).some((a) => a.id === to)) return 'peer'
  const me = agents.find((a) => a.id === from)
  if (me && (bossOf(agents, me)?.id === to || (to !== from && sectorOf(agents, from)?.id === to))) return 'up'
  return heads.some((h) => h.id === to) ? 'sector' : 'other'
}

// The most requests one piece of work stacks up, each made inside the thread of the one before.
export const MAX_CHAIN = 5

// Whether `id` answering to `boss` would close a loop (or is itself, or is below itself).
export const loops = (agents: Node[], id: string, boss: string): boolean => id === boss || reportsOf(agents, id).some((a) => a.id === boss)

// Who `id` may answer to: any other agent that isn't below it, nor the Tuca (it builds the others).
export const possibleBosses = <T extends Node>(agents: T[], id: string): T[] => agents.filter((a) => !a.archived && a.kind !== 'tuca' && !loops(agents, id, a.id))

// How deep the tree goes below `id`: 0 with no one.
export function depthBelow(agents: Node[], id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0
  seen.add(id)
  return directReports(agents, id)
    .filter((a) => !seen.has(a.id))
    .reduce((d, a) => Math.max(d, 1 + depthBelow(agents, a.id, seen)), 0)
}

// The channels an agent works in, the first it joined first: handed work goes to the first, unless another is named.
export const channelsOf = <C extends Pick<Conversation, 'kind' | 'members'>>(conversations: C[], agentId: string): C[] => conversations.filter((c) => c.kind === 'channel' && c.members.includes(agentId))

export interface OrgNode<T> {
  agent: T
  kids: OrgNode<T>[]
}

// The tree as a screen draws it: at the top, those who answer to no one and have someone below; apart,
// those with neither (and anyone a loop left by hand keeps out of every tree).
export function orgTree<T extends Node>(agents: T[]): { roots: OrgNode<T>[]; loose: T[] } {
  const placed = new Set<string>()
  const node = (a: T): OrgNode<T> => {
    placed.add(a.id)
    return { agent: a, kids: directReports(agents, a.id).filter((k) => !placed.has(k.id)).map(node) }
  }
  const tops = agents.filter((a) => !a.archived && !bossOf(agents, a))
  const roots = tops.filter((a) => directReports(agents, a.id).length > 0).map(node)
  return { roots, loose: agents.filter((a) => !a.archived && !placed.has(a.id)) }
}
