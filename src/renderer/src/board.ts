// The board (Quadro): every agent's work as cards, read off what the conversations already have.
// A card is one request: what someone asked (a person's message, a routine, an agent handing a part on),
// with every reply that worked on it: the one that asked a question and the one after the answer, the one
// that split it among the team and the one that put the parts together. Nothing is kept for it: it's
// the messages, the requests handed on (delegations) and what waits on me (the inbox), as they are now.
import { L } from '../../shared/lang'
import { isTeam, type Agent, type Delegation, type Inbox, type Message, type Run } from '../../shared/types'
import { canContinue } from '../../shared/run-progress'
import { mineIn } from './components/waiting'

export type Column = 'doing' | 'you' | 'done' | 'stuck'
export type CardState =
  | 'working' // an agent is on it
  | 'parts' // its agent split it and waits on the parts
  | 'asked-up' // a part whose agent asked the one that handed it something
  | 'other' // waits on someone else (their approval, their answer)
  | 'approval' // waits on my approval
  | 'question' // waits on my answer
  | 'done'
  | 'stopped'
  | 'failed'
  | 'paused' // stopped at its budget: it can go on

export interface Asker {
  kind: 'me' | 'person' | 'routine' | 'agent'
  id?: string
  name: string
}

export interface BoardCard {
  id: string
  agentId: string
  title: string
  by: Asker
  conversationId: string
  threadId?: string // where it goes on: the thread its replies are in
  requestId?: string // the message that asked
  replies: Message[] // oldest first
  last?: Message // the latest reply (none yet: a part just handed on)
  column: Column
  state: CardState
  waitingOn?: string // who it waits on, when it's someone else
  at: number // when it was asked
  endedAt?: number // when it came to rest (done, stopped, failed)
  parent?: string // the card that handed it on
  parts: string[] // the cards it handed on, in order
  delegation?: Delegation // a part: the request it works on
}

export interface BoardInput {
  you: string
  agents: Agent[]
  messages: Record<string, Message[]>
  delegations: Delegation[]
  inbox: Inbox
  name: (personId: string) => string
}

const OPEN = new Set<Run['status']>(['working', 'waiting_input', 'waiting_approval'])
const asked = (m: Message): boolean => !!(m.run?.question || m.run?.questions?.length)
const place = (m: Pick<Message, 'conversationId' | 'threadId'>): string => `${m.conversationId}|${m.threadId ?? ''}`

// A request's words as a card's title: its first line that says something, without mentions or Markdown.
export function titleOf(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/@[\w.-]+/g, '').replace(/[*_`#>]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? ''
  const t = line.length > 160 ? `${line.slice(0, 157).trimEnd()}…` : line
  return t.charAt(0).toUpperCase() + t.slice(1)
}

// The start of the day `now` is in, where the board's "done" begins.
export const dayStart = (now: number): number => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function boardCards(input: BoardInput, now = Date.now()): BoardCard[] {
  const { you, agents, messages, delegations, inbox, name } = input
  const team = new Map(agents.filter(isTeam).map((a) => [a.id, a]))
  const byId = new Map<string, Message>()
  for (const list of Object.values(messages)) for (const m of list) byId.set(m.id, m)
  const mine = mineIn(inbox)
  const agentAsker = (id: string): Asker => ({ kind: 'agent', id, name: agents.find((a) => a.id === id)?.name ?? L('Agente', 'Agent') })

  const asker = (m: Message | undefined): Asker => {
    if (!m) return { kind: 'person', name: L('Alguém', 'Someone') }
    if (m.author.kind === 'routine') return { kind: 'routine', id: m.author.id, name: m.routine?.name ?? L('Rotina', 'Routine') }
    if (m.author.kind === 'agent') return agentAsker(m.author.id)
    if (m.author.kind === 'person') return m.author.id === you ? { kind: 'me', id: you, name: L('Você', 'You') } : { kind: 'person', id: m.author.id, name: name(m.author.id) }
    return { kind: 'person', name: L('Tucano', 'Tucano') }
  }

  type Draft = Omit<BoardCard, 'column' | 'state' | 'last' | 'parts' | 'endedAt'>
  const cards = new Map<string, Draft>()
  const cardOf = new Map<string, string>() // a reply's id → its card
  const byRequest = new Map<string, string>() // the message that asked (or opened the thread) → its card
  const answers = new Map<string, string>() // a person's message that answered a question → that question's card
  const splitter = new Map<string, string>() // agent|place → the card whose reply there split work on
  const lastAgent = new Map<string, Message>() // place → the latest agent message there
  const routineWaiting = new Map<string, Message>() // conversation → a routine message no reply took yet
  const delegationOf = new Map(delegations.map((d) => [d.id, d]))

  const open = (key: string, d: Draft): string => {
    if (!cards.has(key)) cards.set(key, d)
    if (d.requestId) byRequest.set(d.requestId, key)
    return key
  }

  for (const list of Object.values(messages)) {
    for (const m of list) {
      if (m.author.kind === 'routine' && !m.threadId) routineWaiting.set(m.conversationId, m)
      if (m.author.kind === 'person') {
        const before = lastAgent.get(place(m))
        const k = before && cardOf.get(before.id)
        // What a person writes right after an agent asked there is the answer: the reply to it goes on the same card.
        if (k && asked(before)) answers.set(m.id, k)
      }
      if (m.author.kind !== 'agent' || !m.run) continue
      // What opens a part in its agent's channel, an answer given there in the asker's name, what brings
      // a part back: notes about handed work, not work of their own.
      if (m.run.delegation && !m.run.handed) continue
      lastAgent.set(place(m), m)
      if (!team.has(m.author.id)) continue
      const run = m.run
      let key: string | undefined
      if (run.handed) {
        const d = delegationOf.get(run.handed)
        const root = byId.get(d?.rootId ?? '')
        key = open(`d:${run.handed}`, {
          id: `d:${run.handed}`,
          agentId: m.author.id,
          title: titleOf(d?.text ?? root?.text ?? m.text),
          by: d ? agentAsker(d.from) : asker(root),
          conversationId: m.conversationId,
          ...(m.threadId ? { threadId: m.threadId } : {}),
          ...(d?.rootId ? { requestId: d.rootId } : {}),
          replies: [],
          at: d?.createdAt ?? m.at,
          ...(d ? { delegation: d } : {})
        })
      } else if (m.threadId && byRequest.has(m.threadId)) key = byRequest.get(m.threadId)
      else if (run.replyTo) {
        const p = byId.get(run.replyTo)
        if (p?.threadId && byRequest.has(p.threadId)) key = byRequest.get(p.threadId)
        else if (answers.has(run.replyTo)) key = answers.get(run.replyTo)
        else
          key = open(`m:${run.replyTo}`, {
            id: `m:${run.replyTo}`,
            agentId: m.author.id,
            title: titleOf(p?.text ?? m.text) || L('Pedido', 'Request'),
            by: asker(p),
            conversationId: m.conversationId,
            ...(m.threadId ? { threadId: m.threadId } : {}),
            requestId: run.replyTo,
            replies: [],
            at: p?.at ?? m.at
          })
      } else {
        const r = !m.threadId ? routineWaiting.get(m.conversationId) : undefined
        const follow = splitter.get(`${m.author.id}|${place(m)}`)
        if (r && (!follow || (cards.get(follow)?.at ?? 0) < r.at)) {
          routineWaiting.delete(m.conversationId)
          key = open(`m:${r.id}`, { id: `m:${r.id}`, agentId: m.author.id, title: titleOf(r.routine?.name ?? r.text) || L('Rotina', 'Routine'), by: asker(r), conversationId: m.conversationId, requestId: r.id, replies: [], at: r.at })
        } else if (follow) key = follow
        else key = open(`m:${m.id}`, { id: `m:${m.id}`, agentId: m.author.id, title: titleOf(m.text) || L('Trabalho do agente', 'Agent’s work'), by: asker(m), conversationId: m.conversationId, ...(m.threadId ? { threadId: m.threadId } : {}), replies: [], at: m.at })
      }
      if (!key) continue
      const card = cards.get(key)!
      card.replies.push(m)
      if (!card.threadId && m.threadId) card.threadId = m.threadId
      cardOf.set(m.id, key)
      if (run.delegations?.length) splitter.set(`${m.author.id}|${place(m)}`, key)
    }
  }

  // Parts handed on that no reply has taken yet: a card already, worked on soon.
  for (const d of delegations) {
    const key = `d:${d.id}`
    if (cards.has(key) || !team.has(d.to) || !cardOf.has(d.originMessageId)) continue
    cards.set(key, { id: key, agentId: d.to, title: titleOf(d.text), by: agentAsker(d.from), conversationId: d.conversationId, threadId: d.threadId ?? d.rootId, requestId: d.rootId, replies: [], at: d.createdAt, delegation: d })
  }

  // Who handed what: a part's parent is the card of the reply that asked for it.
  const parts = new Map<string, string[]>()
  const parentOf = new Map<string, string>()
  for (const d of delegations) {
    const child = `d:${d.id}`
    const parent = cardOf.get(d.originMessageId)
    if (!cards.has(child) || !parent || parent === child) continue
    parentOf.set(child, parent)
    parts.set(parent, [...(parts.get(parent) ?? []), child])
  }

  const out: BoardCard[] = []
  const start = dayStart(now)
  for (const draft of cards.values()) {
    const last = draft.replies.at(-1)
    const run = last?.run
    const d = draft.delegation
    const kids = parts.get(draft.id) ?? []
    const openKids = kids.filter((k) => {
      const kd = cards.get(k)?.delegation
      return kd ? (delegationOf.get(kd.id)?.state ?? kd.state) === 'open' : false
    })
    let column: Column = 'doing'
    let state: CardState = 'working'
    let waitingOn: string | undefined
    if (!run) {
      if (d && d.state !== 'open') [column, state] = d.state === 'done' ? ['done', 'done'] : d.state === 'failed' ? ['stuck', 'failed'] : ['done', 'stopped']
    } else if (run.status === 'working') state = 'working'
    else if (run.status === 'waiting_approval') {
      if (mine(last!)) [column, state] = ['you', 'approval']
      else [state, waitingOn] = ['other', L('esperando aprovação', 'waiting for approval')]
    } else if (run.status === 'waiting_input') {
      if (mine(last!)) [column, state] = ['you', 'question']
      else if (d?.asking === last!.id) [state, waitingOn] = ['asked-up', team.get(d.from)?.name ?? '']
      else [state, waitingOn] = ['other', run.askedTo ? name(run.askedTo) : L('uma resposta', 'an answer')]
    } else if (openKids.length) state = 'parts'
    else if (run.status === 'done') [column, state] = ['done', 'done']
    else if (run.status === 'stopped') [column, state] = ['done', 'stopped']
    else if (run.status === 'paused' || canContinue(run)) [column, state] = ['stuck', 'paused']
    else [column, state] = ['stuck', 'failed']
    const resting = column === 'done' || column === 'stuck'
    const endedAt = resting ? (run?.endedAt ?? last?.at ?? d?.endedAt ?? draft.at) : undefined
    if (resting && endedAt! < start) continue
    // A reply that said nothing and did nothing (an answer to its team's question, a hand-off alone) isn't work to show.
    if (column === 'done' && draft.replies.every((r) => !r.text.trim() && !r.run?.steps.length) && !kids.length) continue
    out.push({ ...draft, column, state, ...(last ? { last } : {}), parts: kids, ...(endedAt ? { endedAt } : {}), ...(waitingOn ? { waitingOn } : {}), ...(parentOf.has(draft.id) ? { parent: parentOf.get(draft.id) } : {}) })
  }
  // A part whose parent didn't make it in (older than the board's day): it stands alone.
  const kept = new Set(out.map((c) => c.id))
  for (const c of out) {
    if (c.parent && !kept.has(c.parent)) delete c.parent
    c.parts = c.parts.filter((p) => kept.has(p))
  }
  return out.sort(order)
}

// Within a column: what waits on me, oldest first (it waited longest); the rest, newest first.
function order(a: BoardCard, b: BoardCard): number {
  if (a.column === 'you' && b.column === 'you') return a.at - b.at
  if (a.column === 'done' || a.column === 'stuck') return (b.endedAt ?? 0) - (a.endedAt ?? 0)
  return b.at - a.at
}

// The steps of a card, across its replies: what it did, in order.
export const stepsOf = (c: BoardCard): (Run['steps'][number] & { replyId: string })[] => c.replies.flatMap((r) => (r.run?.steps ?? []).map((s) => ({ ...s, replyId: r.id })))

// What it cost: the time from the ask to the end (or now), and the tokens of every reply.
export function costOf(c: BoardCard, now = Date.now()): { ms: number; tokens: number } {
  const first = c.replies[0]?.at ?? c.at
  const ms = Math.max(0, (c.endedAt ?? (OPEN.has(c.last?.run?.status ?? 'working') ? now : (c.last?.run?.endedAt ?? now))) - first)
  const tokens = c.replies.reduce((n, r) => n + (r.run?.receipt ? r.run.receipt.inputTokens + r.run.receipt.outputTokens : 0), 0)
  return { ms, tokens }
}

// The words of the last thing a card's agent is doing ("Rodando os testes"), while it works.
export function liveStep(c: BoardCard): string | undefined {
  const run = c.last?.run
  if (run?.status !== 'working') return undefined
  const s = [...run.steps].reverse().find((x) => x.status === 'running') ?? run.steps.at(-1)
  return s?.label
}

// The family of a card: the request and every part of it (for the hover that lights them up).
export function familyOf(cards: BoardCard[], id: string): Set<string> {
  const byId = new Map(cards.map((c) => [c.id, c]))
  let root = byId.get(id)
  for (let i = 0; root?.parent && i < 5; i++) root = byId.get(root.parent) ?? root
  const out = new Set<string>()
  const walk = (c: BoardCard | undefined): void => {
    if (!c || out.has(c.id)) return
    out.add(c.id)
    for (const p of c.parts) walk(byId.get(p))
  }
  walk(root)
  return out
}
