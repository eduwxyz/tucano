// A routine's runs in its conversation. Each run is the message the routine posted (its whole prompt)
// and the agent's reply; an hourly one turned a conversation into a wall. Here the routine's message
// rides on its reply (a chip that opens the prompt), and runs in a row of the same routine that found
// nothing new (Run.noNews, marked by the core) become one line. Read off the messages as they are:
// nothing is kept for it.
import { L, locale } from '../../shared/lang'
import { timeOpts } from '../../shared/clock'
import { saidAt, type Message, type Routine } from '../../shared/types'

export interface RoutineRunPair {
  reply: Message
  ask: Message // what the routine posted
}

export type Shown =
  | { kind: 'message'; message: Message; ask?: Message } // `ask`: the routine's message this reply answers, folded into it
  | { kind: 'no-news'; key: string; routineId: string; name: string; runs: RoutineRunPair[] }

const failedRun = (m: Message): boolean => m.run?.status === 'failed' || m.run?.status === 'interrupted'

// `threaded`: whether a message has a thread. One that does carries talk of its own: it stays whole.
export function shownMessages(messages: Message[], routines: Pick<Routine, 'id' | 'agentId'>[], threaded: (id: string) => boolean = () => false): Shown[] {
  const asks = new Map<string, Message>()
  for (const m of messages) if (m.author.kind === 'routine' && !m.threadId) asks.set(m.id, m)
  if (asks.size === 0) return messages.map((message) => ({ kind: 'message', message }))

  // Each reply with the routine's message it answers: kept on its run since that was recorded.
  const askOf = new Map<string, Message>() // reply id → ask
  const taken = new Set<string>()
  for (const m of messages) {
    const ask = m.author.kind === 'agent' && m.run?.routineAsk ? asks.get(m.run.routineAsk) : undefined
    if (ask && !taken.has(ask.id)) (askOf.set(m.id, ask), taken.add(ask.id))
  }
  // Older runs don't say: the reply is the next one from the routine's agent (as the Rotinas page reads them),
  // before that routine posts again. With the routine gone, only a reply right after it counts.
  messages.forEach((ask, i) => {
    if (ask.author.kind !== 'routine' || !asks.has(ask.id) || taken.has(ask.id)) return
    const routineId = ask.author.id
    const agentId = routines.find((r) => r.id === routineId)?.agentId
    for (let j = i + 1; j < messages.length && (agentId || j === i + 1); j++) {
      const m = messages[j]!
      if (m.author.kind === 'routine' && m.author.id === routineId) break
      if (m.author.kind !== 'agent' || !m.run || m.threadId || m.run.routineAsk || m.run.replyTo || askOf.has(m.id)) continue
      if (agentId && m.author.id !== agentId) continue
      askOf.set(m.id, ask)
      taken.add(ask.id)
      break
    }
  })

  const out: Shown[] = []
  let streak: RoutineRunPair[] = []
  const flush = (): void => {
    // A failure the routine got past (a later run went fine) folds in with the rest; one at the end, it's
    // the latest word on that routine: it shows whole, with its way to try again.
    let end = streak.length
    while (end > 0 && failedRun(streak[end - 1]!.reply)) end--
    const kept = streak.slice(0, end)
    if (kept.length) {
      const last = kept.at(-1)!.ask
      out.push({ kind: 'no-news', key: `no-news:${kept[0]!.reply.id}`, routineId: last.author.kind === 'routine' ? last.author.id : '', name: last.routine?.name ?? L('Rotina', 'Routine'), runs: kept })
    }
    for (const p of streak.slice(end)) out.push({ kind: 'message', message: p.reply, ask: p.ask })
    streak = []
  }
  const routineOf = (p: RoutineRunPair): string => (p.ask.author.kind === 'routine' ? p.ask.author.id : '')
  const day = (p: RoutineRunPair): string => new Date(saidAt(p.reply)).toDateString()

  for (const m of messages) {
    if (taken.has(m.id)) continue // rides on its reply
    const ask = askOf.get(m.id)
    const foldable = !!ask && (m.run?.noNews || failedRun(m)) && !threaded(m.id) && !threaded(ask.id)
    if (!foldable) {
      flush()
      out.push(ask ? { kind: 'message', message: m, ask } : { kind: 'message', message: m })
      continue
    }
    const pair = { reply: m, ask }
    // Another routine, or another day: a line of its own.
    if (streak.length && (routineOf(streak[0]!) !== routineOf(pair) || day(streak[0]!) !== day(pair))) flush()
    streak.push(pair)
    // Failures alone aren't a line of runs with nothing new: they wait for one that is.
  }
  // Only failures: they show whole (flush keeps none of them).
  flush()
  return out
}

// The messages a shown item stands for: where to scroll when the app opens on one of them.
export const idsOf = (s: Shown): string[] => (s.kind === 'message' ? (s.ask ? [s.message.id, s.ask.id] : [s.message.id]) : s.runs.flatMap((p) => [p.reply.id, p.ask.id]))

// "09:00–11:00", or with the day when it isn't today ("12 de nov. · 09:00–17:00"); one run, its time.
export function spanOf(ats: number[], now = Date.now()): string {
  if (!ats.length) return ''
  const hm = (at: number): string => new Date(at).toLocaleTimeString(locale(), timeOpts({ hour: '2-digit', minute: '2-digit' }))
  const first = Math.min(...ats)
  const last = Math.max(...ats)
  const times = first === last || hm(first) === hm(last) ? hm(first) : `${hm(first)}–${hm(last)}`
  if (new Date(first).toDateString() === new Date(now).toDateString()) return times
  return `${new Date(first).toLocaleDateString(locale(), { day: '2-digit', month: 'short' })} · ${times}`
}
