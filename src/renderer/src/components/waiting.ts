// What a conversation is waiting on me for: agents that asked something, and agents that ask
// for approval. The sidebar marks the conversation, and says who, until I answer.
import { L } from '../../../shared/lang'
import type { Inbox, Message } from '../../../shared/types'

export interface Waiting {
  asked: string[] // agent ids, each once
  approval: string[]
}

// With a team, only what waits on me: a question in my inbox (to me, to someone I cover for, past
// its deadline for me, or waiting on my yes), an approval I can decide. Alone, everything does.
export const mineIn =
  (inbox: Inbox) =>
  (m: Message): boolean =>
    m.run?.status === 'waiting_input' ? inbox.questions.some((q) => q.id === m.id) : inbox.approvals.some((a) => a.id === m.run?.approvalId)

// Every row of the sidebar asks on every change, and a reply streaming changes the messages at each
// word: a conversation's are read once per change (of them, or of what's mine).
const read = new WeakMap<Message[], { conversationId: string; mine: unknown; waiting: Waiting }>()

export function waitingIn(messages: Message[], conversationId: string, mine?: { key: unknown; test: (m: Message) => boolean }): Waiting {
  const had = read.get(messages)
  if (had && had.conversationId === conversationId && had.mine === mine?.key) return had.waiting
  const waiting: Waiting = { asked: [], approval: [] }
  for (const m of messages) {
    if (m.conversationId !== conversationId || m.author.kind !== 'agent' || (m.run?.status !== 'waiting_input' && m.run?.status !== 'waiting_approval')) continue
    if (mine && !mine.test(m)) continue
    const who = m.run.status === 'waiting_input' ? waiting.asked : waiting.approval
    if (!who.includes(m.author.id)) who.push(m.author.id)
  }
  read.set(messages, { conversationId, mine: mine?.key, waiting })
  return waiting
}

export const isWaiting = (waiting: Waiting): boolean => waiting.asked.length > 0 || waiting.approval.length > 0

export function waitingTitle(waiting: Waiting, nameOf: (agentId: string) => string): string {
  const names = (ids: string[]): string => {
    const all = ids.map(nameOf)
    return all.length > 1 ? `${all.slice(0, -1).join(', ')} ${L('e', 'and')} ${all.at(-1)}` : (all[0] ?? '')
  }
  const parts: string[] = []
  if (waiting.asked.length) parts.push(waiting.asked.length > 1 ? L(`${names(waiting.asked)} te perguntaram algo`, `${names(waiting.asked)} asked you something`) : L(`${names(waiting.asked)} te perguntou algo`, `${names(waiting.asked)} asked you something`))
  if (waiting.approval.length) parts.push(waiting.approval.length > 1 ? L(`${names(waiting.approval)} pedem aprovação`, `${names(waiting.approval)} ask for approval`) : L(`${names(waiting.approval)} pede aprovação`, `${names(waiting.approval)} asks for approval`))
  return parts.join(' · ')
}
