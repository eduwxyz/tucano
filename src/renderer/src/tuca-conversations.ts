// The person's conversations with the Tuca: they have several, one per request (src/core/index.ts,
// ensureTuca). What the list shows of each: what it is about and when something was last said there.
import { L } from '../../shared/lang'
import { shortTitle } from '../../shared/titles'
import type { Agent, Conversation, State } from './store'

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
