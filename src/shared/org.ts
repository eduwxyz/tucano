// Who answers to whom. An agent may answer to another (Agent.reportsTo), which makes a tree: an agent
// hands work to anyone below it, and to those who answer to the same agent as it does, in that one's
// own channel, and what comes of it goes back to it. Never up, nor to another branch.
// With no one answering to anyone there is no tree, and everything works as it always did.
import type { Agent, Conversation } from './types'

type Node = Pick<Agent, 'id' | 'reportsTo'> & Partial<Pick<Agent, 'archived' | 'kind'>>

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

// Everyone `id` may hand work to: those below it, then its colleagues.
export const reachOf = <T extends Node>(agents: T[], id: string): T[] => {
  const below = reportsOf(agents, id)
  return [...below, ...peersOf(agents, id).filter((p) => !below.some((b) => b.id === p.id))]
}

// The most requests one piece of work stacks up, each made inside the thread of the one before.
export const MAX_CHAIN = 3

// Whether `id` answering to `boss` would close a loop (or is itself, or is below itself).
export const loops = (agents: Node[], id: string, boss: string): boolean => id === boss || reportsOf(agents, id).some((a) => a.id === boss)

// The most agents a line holds from top to bottom. Each one more is another model reply between the
// person and the work: slower, dearer, and something is lost every time it is retold.
export const MAX_LINE = 3

// How many agents there are from the top of its line down to `id`, itself included: 1 answering to no one.
export function rankOf(agents: Node[], id: string): number {
  let rank = 1
  const seen = new Set([id])
  for (let at = agents.find((a) => a.id === id), up = at && bossOf(agents, at); up && !seen.has(up.id); up = bossOf(agents, up)) {
    seen.add(up.id)
    rank++
  }
  return rank
}

// Whether `id` answering to `boss` would make a line longer than MAX_LINE: boss's own rank, `id`, and whoever `id` has below.
export const overLine = (agents: Node[], id: string, boss: string): boolean => rankOf(agents, boss) + 1 + depthBelow(agents, id) > MAX_LINE

// Who `id` may answer to: any other agent that isn't below it, nor the Tuca (it builds the others), and
// that keeps the line within MAX_LINE.
export const possibleBosses = <T extends Node>(agents: T[], id: string): T[] => agents.filter((a) => !a.archived && a.kind !== 'tuca' && !loops(agents, id, a.id) && !overLine(agents, id, a.id))

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
