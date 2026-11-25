// The Tuca's screen in the full app: beside his conversation sits what the conversation is about. While
// he builds an agent, the proposal filling in (as it always was); otherwise the team, where whoever has
// the request in hand shows what was asked and how it stands.
import { L } from '../../shared/lang'
import { isTeam, type Agent, type Delegation, type Message, type State } from './store'

// Where his conversation is, by its newest new-agent card: still talking (none yet, or the newest was
// discarded), a proposal waiting, or the agent made from it.
export type TucaStage = 'talk' | 'proposal' | 'done'
export const newestDraft = (messages: Message[]): Message | undefined => messages.findLast((m) => !!m.run?.agentDraft)
export function tucaStage(m: Message | undefined): TucaStage {
  const state = m?.run?.agentDraft?.state
  return !m || state === 'dismissed' || state === 'undone' ? 'talk' : state === 'created' ? 'done' : 'proposal'
}

// What the person last asked there. His replies and the cards' answers sit in that message's thread.
export const latestAsk = (messages: Message[]): Message | undefined => messages.findLast((m) => m.author.kind === 'person' && !m.threadId)

// What he passed on for that ask, in the order asked. Only what is still loaded: a request stays for a
// day after it ends (State.delegations), so an old conversation shows the team at rest.
export function requestOf(s: Pick<State, 'delegations'>, tucaId: string, conversationId: string, ask: Message | undefined): Delegation[] {
  if (!ask) return []
  return s.delegations
    .filter((d) => d.from === tucaId && d.originConversationId === conversationId && (d.originThreadId ? d.originThreadId === ask.id : d.createdAt >= ask.at))
    .sort((a, b) => a.createdAt - b.createdAt)
}

export type Subject = 'build' | 'team'

// What the person asked of the screen itself. `build`: to make an agent, with the ask that was the
// latest when they said so ('' for none; unset while it isn't known yet). `closed`: the made agent's
// card they closed, to see the team again.
export interface Want {
  build?: { asked?: string }
  closed?: string
}

// What sits beside the conversation. The proposal, while there is one to decide, right after its agent
// was made (until the person asks for something else, or closes it), when there is no one on the team
// yet, or when the person came to make an agent (until something they ask after that is passed on).
// Otherwise the team.
export function subjectOf(s: Pick<State, 'agents' | 'delegations'>, tucaId: string, conversationId: string, messages: Message[], want: Want = {}): Subject {
  const draft = newestDraft(messages)
  const stage = tucaStage(draft)
  const ask = latestAsk(messages)
  if (stage === 'proposal') return 'build'
  if (stage === 'done' && draft && draft.id !== want.closed && draft.at >= (ask?.at ?? 0)) return 'build'
  if (!s.agents.some(isTeam)) return 'build'
  if (want.build && (want.build.asked === undefined || want.build.asked === (ask?.id ?? '') || !requestOf(s, tucaId, conversationId, ask).length)) return 'build'
  return 'team'
}

export interface TeamRow {
  agent: Agent
  // The part of the request this agent has in hand, when it has one.
  asked?: {
    tone: 'live' | 'done' | 'warn' | 'idle'
    label: string // "trabalhando", "concluído"
    text: string // what it was asked
    conversationId: string // where its work is
    open: string // the message that opens its work there
  }
}

function askedOf(s: Pick<State, 'approvals'>, d: Delegation): NonNullable<TeamRow['asked']> {
  const where = { conversationId: d.conversationId, open: d.threadId ?? d.rootId }
  const what = d.text.replace(/\s+/g, ' ').trim()
  if (d.state === 'done') return { ...where, tone: 'done', label: L('concluído', 'done'), text: what }
  if (d.state === 'cancelled') return { ...where, tone: 'idle', label: L('cancelado', 'cancelled'), text: what }
  if (d.state === 'failed') return { ...where, tone: 'warn', label: L('não terminou', 'did not finish'), text: what }
  if (d.asking) return { ...where, tone: 'warn', label: L('com uma dúvida', 'has a question'), text: what }
  if (d.approval && s.approvals.some((a) => a.id === d.approval && a.state === 'pending')) return { ...where, tone: 'warn', label: L('espera sua aprovação', 'waiting for your approval'), text: what }
  return { ...where, tone: 'live', label: L('trabalhando', 'working'), text: what }
}

// The team as his screen lists it: whoever has a part of the request in hand first, in the order asked
// (the newest part, when one was asked twice), then everyone else at rest.
export function teamRows(s: Pick<State, 'agents' | 'delegations' | 'approvals'>, tucaId: string, conversationId: string, messages: Message[]): TeamRow[] {
  const parts = new Map<string, Delegation>()
  for (const d of requestOf(s, tucaId, conversationId, latestAsk(messages))) parts.set(d.to, d)
  const team = s.agents.filter(isTeam)
  const asked = [...parts.values()].flatMap((d): TeamRow[] => {
    const agent = team.find((a) => a.id === d.to)
    return agent ? [{ agent, asked: askedOf(s, d) }] : []
  })
  return [...asked, ...team.filter((a) => !parts.has(a.id)).map((agent) => ({ agent }))]
}

// The line under the card's title: how the request stands, or what the team is there for.
export function teamLine(rows: TeamRow[]): string {
  const asked = rows.flatMap((r) => (r.asked ? [r.asked] : []))
  if (!asked.length) return L('Quem faz o que você pede', 'Who does what you ask')
  const live = asked.filter((a) => a.tone === 'live').length
  const waits = asked.filter((a) => a.tone === 'warn').length
  const n = L(`${asked.length} neste pedido`, `${asked.length} on this request`)
  if (live) return `${n} · ${L(`${live} trabalhando`, `${live} working`)}`
  if (waits) return `${n} · ${L(waits > 1 ? `${waits} pedem atenção` : '1 pede atenção', waits > 1 ? `${waits} need attention` : '1 needs attention')}`
  return `${n} · ${L('tudo de volta', 'all back')}`
}
