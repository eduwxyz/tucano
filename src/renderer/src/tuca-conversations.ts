// The person's conversations with the Tuca: they have several, one per request (src/core/index.ts,
// ensureTuca). What the lists show of each: what it is about, when something was last said there, and
// how it stands (something waits on the person, the team is still on it, or it is done).
import { L } from '../../shared/lang'
import { shortTitle } from '../../shared/titles'
import { questionsOf } from '../../shared/questions'
import { messagesIn, type Agent, type Conversation, type Delegation, type Message, type State } from './store'

export const tucaOf = (s: Pick<State, 'agents'>): Agent | undefined => s.agents.find((a) => a.kind === 'tuca')

// When something was last said there: what the core told, or a newer message that came since.
export function lastSaid(s: Pick<State, 'messages'>, c: Conversation): number {
  const loaded = (s.messages[c.id] ?? []).at(-1)?.at ?? 0
  return Math.max(loaded, c.lastAt ?? 0, c.createdAt ?? 0)
}

// Mine, the one last talked in first. A DM with no owner is the Tucano owner's (from before people).
export function tucaConversations(s: Pick<State, 'agents' | 'conversations' | 'messages' | 'you' | 'people'>): Conversation[] {
  const tuca = tucaOf(s)
  if (!tuca) return []
  const owner = s.people.find((p) => p.role === 'owner')?.id
  const mine = (c: Conversation): boolean => !s.you || (c.owner ?? owner ?? s.you) === s.you
  return s.conversations.filter((c) => c.kind === 'dm' && c.name === tuca.id && mine(c)).sort((a, b) => lastSaid(s, b) - lastSaid(s, a))
}

// What a conversation with him is about: the name it has, what was first asked there, or that it is new.
export function tucaTitle(s: Pick<State, 'messages'>, c: Conversation): string {
  if (c.title) return c.title
  const first = (s.messages[c.id] ?? []).find((m) => m.author.kind === 'person' && !m.threadId)
  return (first && (first.title || shortTitle(first.text))) || L('Conversa nova', 'New conversation')
}

export type RequestState = 'wait' | 'run' | 'done' | 'new'

// How a conversation with him stands, from what is loaded of it: a question or an approval that waits on
// the person; a reply or a request still going; otherwise done. One nobody wrote in yet is new.
export function requestState(s: Pick<State, 'messages' | 'delegations' | 'approvals'>, c: Conversation): RequestState {
  const messages = s.messages[c.id] ?? []
  if (!messages.some((m) => m.author.kind === 'person')) return 'new'
  const open = s.delegations.filter((d) => d.originConversationId === c.id && d.state === 'open')
  const waits =
    messages.some((m) => m.run?.status === 'waiting_input' && questionsOf(m.run).length > 0) ||
    s.approvals.some((a) => a.state === 'pending' && (a.conversationId === c.id || open.some((d) => d.approval === a.id))) ||
    open.some((d) => !!d.asking)
  if (waits) return 'wait'
  if (open.length || messages.some((m) => m.run?.status === 'working' || m.run?.status === 'waiting_approval')) return 'run'
  return 'done'
}

export const stateLabel = (st: RequestState): string => (st === 'wait' ? L('espera você', 'waiting on you') : st === 'run' ? L('andando', 'under way') : st === 'done' ? L('pronto', 'done') : L('nova', 'new'))

// Who worked on it: everyone the Tuca asked from there, each once, in the order asked.
export function requestAgents(s: Pick<State, 'agents' | 'delegations' | 'messages'>, c: Conversation): Agent[] {
  const ids: string[] = []
  const add = (id: string): void => void (!ids.includes(id) && ids.push(id))
  for (const m of s.messages[c.id] ?? []) for (const d of m.run?.delegations ?? []) add(d.to)
  for (const d of s.delegations) if (d.originConversationId === c.id) add(d.to)
  return ids.flatMap((id) => s.agents.find((a) => a.id === id && a.kind !== 'tuca') ?? [])
}

// The line under a conversation's title: what waits, who is on it, or how it ended.
export function requestLine(s: Pick<State, 'agents' | 'messages' | 'delegations' | 'approvals'>, c: Conversation): string {
  const messages = s.messages[c.id] ?? []
  const name = (id: string): string => s.agents.find((a) => a.id === id)?.name ?? L('alguém', 'someone')
  const open = s.delegations.filter((d) => d.originConversationId === c.id && d.state === 'open')
  const approval = s.approvals.find((a) => a.state === 'pending' && (a.conversationId === c.id || open.some((d) => d.approval === a.id)))
  if (approval) return L(`${name(approval.agentId)} espera a sua aprovação`, `${name(approval.agentId)} is waiting for your approval`)
  const asking = messages.findLast((m) => m.run?.status === 'waiting_input' && questionsOf(m.run).length > 0)
  if (asking) return questionsOf(asking.run)[0]!.question
  if (open.length) return L(`${open.map((d) => name(d.to)).filter((n, i, all) => all.indexOf(n) === i).join(', ')} ${open.length > 1 ? 'estão' : 'está'} nisso`, `${open.map((d) => name(d.to)).filter((n, i, all) => all.indexOf(n) === i).join(', ')} ${open.length > 1 ? 'are' : 'is'} on it`)
  // What he last said, wherever in the conversation: his closing of a request sits in its thread. Not his hello.
  const first = messages.findIndex((m) => m.author.kind === 'person')
  const last = messages.findLast((m, i) => i > first && m.author.kind === 'agent' && !!m.text.trim())
  return last ? last.text.replace(/[#*_`>]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 140) : ''
}

export type { Delegation, Message }
export { messagesIn }
