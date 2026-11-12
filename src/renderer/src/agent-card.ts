// What an agent's profile card says about it right now, and where the card goes on the
// screen. Kept apart from React so both can be tested without a browser.
import type { Agent, Conversation, Message } from '../../shared/types'
import { overMonthlyLimit } from '../../shared/limits'

export type AgentNow =
  | { kind: 'working'; conversationId: string; doing?: string; since: number }
  | { kind: 'waiting'; conversationId: string; on: 'input' | 'approval'; askedTo?: string } // askedTo: the person a question is for (team mode)
  | { kind: 'archived' }
  | { kind: 'limit' }
  | { kind: 'idle'; lastAt?: number }

// Archived first (it does nothing), then what it's doing (the latest reply at work, with the
// step running), then what waits on me, then the monthly limit, else when it last spoke.
export function agentNow(agent: Pick<Agent, 'id' | 'archived' | 'used' | 'limit'>, messages: readonly Message[]): AgentNow {
  if (agent.archived) return { kind: 'archived' }
  // In time order: the messages come per conversation, one list after another.
  const own = messages.filter((m) => m.author.kind === 'agent' && m.author.id === agent.id).sort((a, b) => a.at - b.at)
  const working = own.findLast((m) => m.run?.status === 'working')
  if (working) {
    const step = working.run!.steps.findLast((st) => st.status === 'running')
    return { kind: 'working', conversationId: working.conversationId, doing: step?.label, since: working.at }
  }
  const waiting = own.findLast((m) => m.run?.status === 'waiting_input' || m.run?.status === 'waiting_approval')
  if (waiting) {
    const on = waiting.run!.status === 'waiting_input' ? 'input' : 'approval'
    return { kind: 'waiting', conversationId: waiting.conversationId, on, ...(on === 'input' && waiting.run!.askedTo ? { askedTo: waiting.run!.askedTo } : {}) }
  }
  // 0 is no limit, so there is nothing to have hit (shared/limits.ts).
  if (overMonthlyLimit(agent.used, agent.limit)) return { kind: 'limit' }
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

// ---------- which card is open, and how ----------

export const HOVER_OPEN_MS = 500 // the pointer rests on a face this long before its card opens
export const HOVER_CLOSE_MS = 300 // and the card waits this long after it leaves, to reach the card
const SCROLL_QUIET_MS = 250 // right after a scroll, a face passing under the pointer isn't a hover

export interface CardOpen<A> {
  agentId: string
  anchor: A // what opened it: the card goes next to it and gives it focus back
  via: 'click' | 'hover' // a clicked card stays until clicked away; a hovered one goes with the pointer
  settingsOf?: string // opened from the top of a DM: the card also leads to that conversation's settings
  below?: boolean // opened from a top bar: under it, like a menu
}
export type CardOptions = Pick<CardOpen<unknown>, 'settingsOf' | 'below'>

// One card at a time. A click (or Enter) opens it at once and the same click again closes it;
// a pointer resting on a face opens it after a moment and, leaving the face and the card, closes it.
// A click on a face whose card the hover opened keeps that card, as a clicked one.
export function cardState<A>(ms = { open: HOVER_OPEN_MS, close: HOVER_CLOSE_MS }) {
  let current: CardOpen<A> | null = null
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let scrolledAt = -Infinity
  const listeners = new Set<() => void>()
  const set = (next: CardOpen<A> | null): void => {
    current = next
    listeners.forEach((l) => l())
  }
  const stopOpening = (): void => {
    clearTimeout(openTimer)
    openTimer = undefined
  }
  const stopClosing = (): void => {
    clearTimeout(closeTimer)
    closeTimer = undefined
  }
  const leave = (): void => {
    stopOpening()
    if (current?.via !== 'hover') return
    stopClosing()
    closeTimer = setTimeout(() => {
      closeTimer = undefined
      if (current?.via === 'hover') set(null)
    }, ms.close)
  }
  return {
    get: (): CardOpen<A> | null => current,
    subscribe(l: () => void): () => void {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    click(agentId: string, anchor: A, opts: CardOptions = {}): void {
      stopOpening()
      stopClosing()
      if (current?.anchor === anchor) return set(current.via === 'hover' ? { ...current, via: 'click' } : null)
      set({ agentId, anchor, via: 'click', ...opts })
    },
    hoverEnter(agentId: string, anchor: A, opts: CardOptions = {}): void {
      if (current?.via === 'click') return // a clicked card stays the one open
      if (current?.anchor === anchor) return stopClosing() // back on its face in time
      if (Date.now() - scrolledAt < SCROLL_QUIET_MS) return
      stopOpening()
      openTimer = setTimeout(() => {
        openTimer = undefined
        stopClosing()
        set({ agentId, anchor, via: 'hover', ...opts })
      }, ms.open)
    },
    hoverLeave: leave,
    cardEnter: stopClosing,
    cardLeave: leave,
    scrolled(): void {
      scrolledAt = Date.now()
      stopOpening()
    },
    close(): CardOpen<A> | null {
      stopOpening()
      stopClosing()
      const was = current
      if (was) set(null)
      return was
    }
  }
}
