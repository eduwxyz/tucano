import type { Message, RoutineRun } from '../../shared/types'

// Who a reply came from, when its routine's request is not shown.
export interface RoutineVia {
  routineId: string
  run: RoutineRun
}

export interface RoutineTimeline {
  messages: Message[]
  via: Map<string, RoutineVia> // an agent's reply id → the routine run that asked for it
  repliesOf: Map<string, string> // a hidden request's id → the reply that stands in for it
}

const hasThread = (message: Message, replies?: Map<string, Message[]>): boolean => (replies?.get(message.id)?.length ?? 0) > 0

// A routine's request posts first and its agent answers right after, on its own: the reply is the
// first agent message after it that doesn't answer a person (no replyTo), before the next routine's.
// A request that opens a thread stays, so the thread is never left without its root.
export function hideRoutinePrompts(messages: Message[], replies?: Map<string, Message[]>): RoutineTimeline {
  const via = new Map<string, RoutineVia>()
  const repliesOf = new Map<string, string>()
  const hidden = new Set<string>()
  messages.forEach((m, i) => {
    if (m.author.kind !== 'routine' || hasThread(m, replies)) return
    hidden.add(m.id)
    for (const next of messages.slice(i + 1)) {
      if (next.author.kind === 'routine') break
      if (next.author.kind !== 'agent' || next.threadId || next.run?.replyTo) continue
      via.set(next.id, { routineId: m.author.id, run: m.routine ?? { name: '', scheduledAt: m.at, late: false } })
      repliesOf.set(m.id, next.id)
      break
    }
  })
  return { messages: messages.filter((m) => !hidden.has(m.id)), via, repliesOf }
}
