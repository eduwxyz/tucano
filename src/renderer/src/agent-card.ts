// What an agent's profile card says about it right now, and where the card goes on the
// screen. Kept apart from React so both can be tested without a browser.
import type { Agent, Conversation, Message } from '../../shared/types'

export type AgentNow =
  | { kind: 'working'; conversationId: string; doing?: string; since: number }
  | { kind: 'waiting'; conversationId: string; on: 'input' | 'approval' }
  | { kind: 'archived' }
  | { kind: 'limit' }
  | { kind: 'idle'; lastAt?: number }

// Archived first (it does nothing), then what it's doing (the latest reply at work, with the
// step running), then what waits on me, then the monthly limit, else when it last spoke.
export function agentNow(agent: Pick<Agent, 'id' | 'archived' | 'used' | 'limit'>, messages: readonly Message[]): AgentNow {
  if (agent.archived) return { kind: 'archived' }
  const own = messages.filter((m) => m.author.kind === 'agent' && m.author.id === agent.id)
  const working = own.findLast((m) => m.run?.status === 'working')
  if (working) {
    const step = working.run!.steps.findLast((st) => st.status === 'running')
    return { kind: 'working', conversationId: working.conversationId, doing: step?.label, since: working.at }
  }
  const waiting = own.findLast((m) => m.run?.status === 'waiting_input' || m.run?.status === 'waiting_approval')
  if (waiting) return { kind: 'waiting', conversationId: waiting.conversationId, on: waiting.run!.status === 'waiting_input' ? 'input' : 'approval' }
  if (agent.limit > 0 && agent.used >= agent.limit) return { kind: 'limit' }
  return { kind: 'idle', lastAt: own.at(-1)?.at }
}

// The channels it's in, by name, in the sidebar's order.
export const agentChannels = (agentId: string, conversations: readonly Conversation[]): Conversation[] => conversations.filter((c) => c.kind === 'channel' && c.members.includes(agentId))

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

const GAP = 8 // between the card and what was clicked
const EDGE = 12 // the least room kept to the window's edges

// Next to what was clicked, like Slack: to its right, top-aligned with it; else to its left;
// else below it, else above. `below`: what's in a top bar opens it under itself, the way a menu
// does. Always whole on screen. A narrow window (a phone) gets the card across its width, under the click.
export function placeCard(anchor: Box, card: { width: number; height: number }, view: { width: number; height: number }, prefer: 'side' | 'below' = 'side'): { left: number; top: number; width: number } {
  const clampTop = (t: number): number => Math.max(EDGE, Math.min(t, view.height - card.height - EDGE))
  if (view.width < card.width + 2 * EDGE + 40) {
    const width = view.width - 2 * EDGE
    const below = anchor.top + anchor.height + GAP
    const top = below + card.height <= view.height - EDGE ? below : anchor.top - GAP - card.height
    return { left: EDGE, top: clampTop(top), width }
  }
  const right = anchor.left + anchor.width + GAP
  if (prefer === 'side' && right + card.width <= view.width - EDGE) return { left: right, top: clampTop(anchor.top), width: card.width }
  const left = anchor.left - GAP - card.width
  if (prefer === 'side' && left >= EDGE) return { left, top: clampTop(anchor.top), width: card.width }
  const x = Math.max(EDGE, Math.min(anchor.left, view.width - card.width - EDGE))
  const below = anchor.top + anchor.height + GAP
  return { left: x, top: clampTop(below + card.height <= view.height - EDGE ? below : anchor.top - GAP - card.height), width: card.width }
}
