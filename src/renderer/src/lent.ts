// The computers people lent this server (docs/local-node.md) that an agent may use: each is a connector of
// its person's, and the agent has it when it holds a grant on it. Off means the Tucano app is closed there.
import { nodeOf } from '../../shared/node-link'
import type { Agent, Connector } from '../../shared/types'

export interface LentComputer {
  id: string
  name: string
  on: boolean // the Tucano app is open there and linked
  mine: boolean // lent by whoever is looking
}

export function lentComputersOf(s: { connectors: Connector[]; people: { id: string; role: string }[]; you: string }, agent: Pick<Agent, 'grants'>): LentComputer[] {
  const owner = s.people.find((p) => p.role === 'owner')?.id
  return s.connectors.flatMap((c) => {
    const node = nodeOf(c.url)
    if (!node || (agent.grants[c.id] ?? 'none') === 'none') return []
    return [{ id: c.id, name: c.name, on: c.status === 'connected', mine: (node.owner ?? owner) === s.you }]
  })
}
