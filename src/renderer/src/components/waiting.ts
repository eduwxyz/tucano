// What a conversation is waiting on me for: agents that asked something, and agents that ask
// for approval. The sidebar marks the conversation, and says who, until I answer.
import { L } from '../../../shared/lang'
import type { Message } from '../../../shared/types'

export interface Waiting {
  asked: string[] // agent ids, each once
  approval: string[]
}

export function waitingIn(messages: Message[], conversationId: string): Waiting {
  const asked = new Set<string>()
  const approval = new Set<string>()
  for (const m of messages) {
    if (m.conversationId !== conversationId || m.author.kind !== 'agent') continue
    if (m.run?.status === 'waiting_input') asked.add(m.author.id)
    else if (m.run?.status === 'waiting_approval') approval.add(m.author.id)
  }
  return { asked: [...asked], approval: [...approval] }
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
