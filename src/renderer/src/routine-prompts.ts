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

// A routine's request is left out only once a reply that runs it (run.routineMessage) is in the
// conversation, so nothing disappears without its attribution. `conversation`: every loaded
// message, not just the page shown, so a reply finds its request across the history cutoff.
// A request that opens a thread stays, so the thread is never left without its root.
export function hideRoutinePrompts(shown: Message[], conversation: Message[], replies?: Map<string, Message[]>): RoutineTimeline {
  const requests = new Map<string, Message & { author: { kind: 'routine'; id: string } }>()
  for (const m of conversation) if (m.author.kind === 'routine') requests.set(m.id, m as Message & { author: { kind: 'routine'; id: string } })
  const via = new Map<string, RoutineVia>()
  const repliesOf = new Map<string, string>()
  for (const reply of conversation) {
    const request = reply.run?.routineMessage ? requests.get(reply.run.routineMessage) : undefined
    if (!request || repliesOf.has(request.id) || hasThread(request, replies)) continue
    repliesOf.set(request.id, reply.id)
    via.set(reply.id, { routineId: request.author.id, run: request.routine ?? { name: '', scheduledAt: request.at, late: false } })
  }
  return { messages: shown.filter((m) => !repliesOf.has(m.id)), via, repliesOf }
}
