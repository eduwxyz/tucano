// Who answers to whom. An agent answers to another (Agent.reportsTo) and may answer to more at once
// (Agent.alsoTo), which makes a tree with shared people in it: an agent hands work to anyone below it,
// and to those who answer to the same agent as it does, in that one's own channel, and what comes of it
// goes back to it. Each tree is a sector, headed by its top; under an agent the person chose as an entry
// point, each team below it is a sector instead. Up, only to its own boss (what it can't do) and
// straight to its sector's head (what isn't the sector's), never one step at a time: each step is one
// more reply and one more retelling. Each tree is a sector (its top agent is the head): only heads ask
// other sectors, and only their heads, who pass it down their own branch.
// With no one answering to anyone there is no tree, and everything works as it always did.
import type { Agent, Conversation } from './types'

type Node = Pick<Agent, 'id' | 'reportsTo'> & Partial<Pick<Agent, 'archived' | 'kind' | 'entry' | 'alsoTo'>>

// The links an agent carries as they were made: its primary boss and the ones it also answers to.
const linksOf = (a: Node): string[] => [...(a.reportsTo ? [a.reportsTo] : []), ...(a.alsoTo ?? [])]

// Every agent `a` answers to, its primary boss first: the one it was set under (Agent.reportsTo), then
// the ones it also answers to (Agent.alsoTo) — a specialist several teams share. Each of them hands it
// work the same way and gets the answer back where it asked. One that was archived is passed over:
// whoever answered to it answers to its own boss meanwhile, and to it again when it comes back.
// A link onto itself is ignored. A circle left by hand (a file, an older build) is kept as it is, as it
// always was: saving an agent refuses one, and every walk down the links counts each agent once.
export function bossesOf<T extends Node>(agents: T[], a: Node): T[] {
  const out: T[] = []
  for (const from of linksOf(a)) {
    const seen = new Set([a.id])
    for (let id: string | undefined = from; id && !seen.has(id); ) {
      seen.add(id)
      const boss = agents.find((x) => x.id === id)
      if (!boss) break
      if (boss.archived) {
        id = boss.reportsTo // its own boss meanwhile
        continue
      }
      if (boss.id !== a.id && !out.some((b) => b.id === boss.id)) out.push(boss)
      break
    }
  }
  return out
}

// The one it answers to first: where the board draws it, the line it hangs from.
export const bossOf = <T extends Node>(agents: T[], a: Node): T | undefined => bossesOf(agents, a)[0]

// Those who answer straight to `id`, as they were made: any of its links counts, not only the primary one.
export const directReports = <T extends Node>(agents: T[], id: string): T[] => agents.filter((a) => !a.archived && a.id !== id && bossesOf(agents, a).some((b) => b.id === id))

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

// Those who answer to the same agent as `id` does — any of its bosses, so a shared specialist works beside
// both teams: its colleagues, who may ask each other for work. Answering to no agent (to the person
// alone) makes no colleagues.
export function peersOf<T extends Node>(agents: T[], id: string): T[] {
  const me = agents.find((a) => a.id === id)
  const mine = me && !me.archived ? new Set(bossesOf(agents, me).map((b) => b.id)) : new Set<string>()
  if (!mine.size) return []
  return agents.filter((a) => !a.archived && a.id !== id && bossesOf(agents, a).some((b) => mine.has(b.id)))
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
// Its own line first: the sector it hangs in is its primary boss's, the one the board draws it under.
// A specialist borrowed into other trees has a head there too: that one, the nearest, when its own line
// has none above it.
export function sectorOf<T extends Node>(agents: T[], id: string): T | undefined {
  const me = agents.find((a) => a.id === id)
  if (!me || me.archived) return undefined
  const heads = headsOf(agents)
  const headAt = (at: Node): T | undefined => heads.find((h) => h.id === at.id)
  const seen = new Set<string>()
  for (let at: T | undefined = me; at && !seen.has(at.id); at = bossOf(agents, at)) {
    seen.add(at.id)
    const head = headAt(at)
    if (head) return head
  }
  for (let level: T[] = bossesOf(agents, me); level.length; ) {
    const next: T[] = []
    for (const at of level) {
      if (seen.has(at.id)) continue
      seen.add(at.id)
      const head = headAt(at)
      if (head) return head
      next.push(...bossesOf(agents, at))
    }
    level = next
  }
  return undefined
}

// A sector's name as people read it: the one given on its head, or "Setor de <head>".
export const sectorName = (head: Pick<Agent, 'name'> & Partial<Pick<Agent, 'sectorName'>>, of = 'Setor de'): string => head.sectorName?.trim() || `${of} ${head.name}`

// Everyone `id` may hand work to: those below it, its colleagues, its own bosses (all of them: it answers to
// each the same way), its sector's head (however far above), and, when it heads a sector or is an entry
// point, the sectors' heads. Nearest first, each once.
export const reachOf = <T extends Node>(agents: T[], id: string): T[] => {
  const me = agents.find((a) => a.id === id)
  const bosses = me && !me.archived ? bossesOf(agents, me) : []
  const isHead = headsOf(agents).some((h) => h.id === id)
  const isEntry = entriesOf(agents).some((e) => e.id === id)
  const head = bosses.length && !isHead ? sectorOf(agents, id) : undefined
  const all = [...reportsOf(agents, id), ...peersOf(agents, id), ...bosses, ...(head ? [head] : []), ...(isHead || isEntry ? headsOf(agents).filter((h) => h.id !== id) : [])]
  return all.filter((a, i) => all.findIndex((b) => b.id === a.id) === i)
}

// How `from` asking `to` goes: down its branch, to a colleague, up (to its own boss or its sector's head), or to another sector's head.
export type AskKind = 'down' | 'peer' | 'up' | 'sector'
export function askKind(agents: Node[], from: string, to: string): AskKind {
  if (from === to) return 'peer' // a head and itself are not two sectors
  // Two heads, whether each tops a tree or both answer to the entry point: one sector asking another.
  const heads = headsOf(agents)
  if (heads.some((h) => h.id === from) && heads.some((h) => h.id === to)) return 'sector'
  if (reportsOf(agents, from).some((a) => a.id === to)) return 'down'
  if (peersOf(agents, from).some((a) => a.id === to)) return 'peer'
  const me = agents.find((a) => a.id === from)
  if (me && (bossesOf(agents, me).some((b) => b.id === to) || (to !== from && sectorOf(agents, from)?.id === to))) return 'up'
  return 'sector'
}

// The most requests one piece of work stacks up, each made inside the thread of the one before.
export const MAX_CHAIN = 3

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

// Those who hang under `id` in the tree as drawn: the ones it is their first boss of. A shared specialist
// hangs under its primary boss only, and reaches the others by a line of its own (OrgChart.tsx).
const kidsOf = <T extends Node>(agents: T[], id: string): T[] => agents.filter((a) => !a.archived && a.id !== id && bossOf(agents, a)?.id === id)

// The tree as a screen draws it: at the top, those who answer to no one and have someone below; apart,
// those with neither (and anyone a loop left by hand keeps out of every tree).
export function orgTree<T extends Node>(agents: T[]): { roots: OrgNode<T>[]; loose: T[] } {
  const placed = new Set<string>()
  const node = (a: T): OrgNode<T> => {
    placed.add(a.id)
    return { agent: a, kids: kidsOf(agents, a.id).filter((k) => !placed.has(k.id)).map(node) }
  }
  const tops = agents.filter((a) => !a.archived && !bossOf(agents, a))
  // A top is a root when anyone answers to it at all: one whose only report is a shared specialist still
  // gets its card over the board, with the dashed line down to it.
  const roots = tops.filter((a) => directReports(agents, a.id).length > 0).map((a) => node(a))
  return { roots, loose: agents.filter((a) => !a.archived && !placed.has(a.id)) }
}
