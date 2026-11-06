// What a conversation is waiting on me for: agents that asked something, and agents that ask
// for approval. The sidebar marks the conversation, and says who, until I answer.
import { L } from '../../../shared/lang'
import type { Message } from '../../../shared/types'

export interface Waiting {
  asked: string[] // agent ids, each once
  approval: string[]
}

// Every row of the sidebar asks on every change, and a reply streaming changes the messages at each
// word: they're read once per change, for all the conversations.
let read: { messages: Message[]; waiting: Map<string, Waiting> } | undefined

function waitingByConversation(messages: Message[]): Map<string, Waiting> {
  if (read?.messages === messages) return read.waiting
  const waiting = new Map<string, Waiting>()
  for (const m of messages) {
    if (m.author.kind !== 'agent' || (m.run?.status !== 'waiting_input' && m.run?.status !== 'waiting_approval')) continue
    const here = waiting.get(m.conversationId) ?? { asked: [], approval: [] }
    const who = m.run.status === 'waiting_input' ? here.asked : here.approval
    if (!who.includes(m.author.id)) who.push(m.author.id)
    waiting.set(m.conversationId, here)
  }
  read = { messages, waiting }
  return waiting
}

export const waitingIn = (messages: Message[], conversationId: string): Waiting => waitingByConversation(messages).get(conversationId) ?? { asked: [], approval: [] }

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
