// What a responsibility rests on. A commitment keeps a link to work that runs elsewhere (a delegation,
// a question, an approval, a reply); this file reads that work and says where it stands, so the
// commitment never stores a second copy of a lifecycle it does not own.
//
// Nothing here writes: the delegation, question, approval and run stay the only things that say whether
// they are done, and a person's own answer to a question is the only thing that closes it.
import { isClosed, type Commitment, type CommitmentState, type DependencyState, type LinkKind, type LinkSnapshot } from '../shared/initiative'
import { L } from '../shared/lang'
import type { Db } from './db'

// The linked work, as it stands now. `version` carries every field that moves when it does: a new
// version is what a resume fires on, and it fires once.
export const dependencyOf = (db: Db, kind: LinkKind, id: string): LinkSnapshot | undefined => {
  switch (kind) {
    case 'delegation': {
      const d = db.delegation(id)
      if (!d) return undefined
      const state: DependencyState = d.state === 'done' ? 'done' : d.state === 'failed' ? 'failed' : d.state === 'cancelled' ? 'cancelled' : d.asking ? 'waiting' : 'working'
      const to = db.agent(d.to)
      return {
        kind,
        id,
        state,
        version: `${d.state}|${d.asking ?? ''}|${d.result ? 'r' : ''}|${d.endedAt ?? ''}`,
        what: to ? `${to.name}, ${db.conversation(d.conversationId)?.name ?? ''}`.replace(/, $/, '') : undefined
      }
    }
    case 'question': {
      const q = db.question(id)
      if (!q) return undefined
      const state: DependencyState = q.state === 'answered' ? 'answered' : q.state === 'open' ? 'waiting' : 'gone'
      return { kind, id, state, version: `${q.state}|${q.answeredAt ?? ''}|${q.answeredBy ?? ''}` }
    }
    case 'approval': {
      const a = db.approval(id)
      if (!a) return undefined
      const state: DependencyState = a.state === 'pending' ? 'waiting' : a.state === 'approved' ? 'decided' : 'failed'
      return { kind, id, state, version: `${a.state}|${a.decidedAt ?? ''}`, what: `${a.connectorName} ${a.tool}` }
    }
    case 'run': {
      // A reply's own outcome: the message it lives on says how it ended.
      const m = db.message(id)
      const status = m?.run?.status
      if (!status) return undefined
      const state: DependencyState = status === 'done' ? 'done' : status === 'working' || status === 'waiting_input' || status === 'waiting_approval' ? 'waiting' : 'failed'
      return { kind, id, state, version: `${status}|${m?.run?.endedAt ?? ''}` }
    }
  }
}

// A person does not owe an answer to their own bot's question about something they asked for: the
// question that waits on them is the one worth reporting, and the one worth not repeating.
export const waitsOnPerson = (s: LinkSnapshot): boolean => s.state === 'waiting' && (s.kind === 'question' || s.kind === 'approval')

// Where a responsibility stands, given the work it rests on. The order is the point: what waits on the
// person outranks what waits elsewhere, and a failure never reads as progress.
export const stateFrom = (links: LinkSnapshot[], previous: CommitmentState): CommitmentState => {
  if (links.some((l) => l.state === 'waiting' && (l.kind === 'question' || l.kind === 'approval'))) return 'waiting_user'
  if (links.some((l) => l.state === 'working' || l.state === 'waiting')) return 'waiting_external'
  if (links.some((l) => l.state === 'failed' || l.state === 'cancelled')) return 'open'
  if (links.some((l) => l.state === 'done' || l.state === 'answered' || l.state === 'decided')) return 'open'
  // No link, or every link gone: what the person last said it was.
  return previous === 'in_progress' ? 'in_progress' : 'open'
}

// The note that explains a state nobody chose: what failed, and what it means for the person.
export const noteFrom = (links: LinkSnapshot[]): string | undefined => {
  const failed = links.find((l) => l.state === 'failed' || l.state === 'cancelled')
  if (!failed) return undefined
  return failed.state === 'cancelled'
    ? L('O pedido foi cancelado.', 'The request was cancelled.')
    : L('O pedido não terminou.', "The request didn't finish.")
}

// The links that moved since the last check-in: what a resumed one reads first.
export const movedLinks = (links: LinkSnapshot[], seen: (kind: LinkKind, id: string) => string | undefined): LinkSnapshot[] =>
  links.filter((l) => {
    const before = seen(l.kind, l.id)
    return before !== undefined && before !== l.version
  })

// How a link reads inside the request, in one clause: enough for the bot to act on, never a copy of
// what the linked work said.
export const linkLine = (l: LinkSnapshot): string => {
  const what = l.what ? ` ${l.what}` : ''
  switch (l.state) {
    case 'working':
      return L(`em andamento:${what}`, `in progress:${what}`)
    case 'waiting':
      return l.kind === 'question' ? L('espera a sua resposta', 'waits for your answer') : l.kind === 'approval' ? L('espera a sua aprovação', 'waits for your approval') : L(`espera resposta:${what}`, `waits for an answer:${what}`)
    case 'answered':
      return L('respondido', 'answered')
    case 'decided':
      return L('decidido', 'decided')
    case 'done':
      return L('terminou', 'finished')
    case 'failed':
      return L('não terminou', "didn't finish")
    case 'cancelled':
      return L('cancelado', 'cancelled')
    case 'gone':
      return L('não existe mais', 'no longer exists')
  }
}

// Whether a commitment's scope reaches a conversation, and whether anything it holds can no longer be
// reached: a scope that lost a conversation is narrowed, and the person is told in the request.
export const narrowScope = (c: Commitment, reachable: Set<string>): { scope: Commitment['scope']; dropped: string[] } => {
  const kept = c.scope.conversations.filter((id) => reachable.has(id))
  return { scope: { ...c.scope, conversations: kept }, dropped: c.scope.conversations.filter((id) => !reachable.has(id)) }
}

// The responsibilities worth putting in the request: open ones, newest last, each with the work it
// rests on. Closed ones are the person's record, not the bot's to-do list.
export const openCommitments = (all: Commitment[]): Commitment[] => all.filter((c) => !isClosed(c.state))
