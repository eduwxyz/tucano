// The Tuca speaks first, in the simple view: one thing a day he thinks the person should know, where a
// request starts and never in the middle of one. Not a guess and not a model's turn: each comes from
// something the app already knows (a service asking to sign in, a routine that didn't finish, a
// colleague out of its month, something waiting on the person since yesterday), with what to do about it
// one click away. Turned off in the simple view's settings (Settings.tucaSpeaksFirst).
import { L } from '../../shared/lang'
import { overMonthlyLimit } from '../../shared/limits'
import { isTeam, type Settings, type State, type View } from './store'

export interface Nudge {
  key: string // what it is about, so the same thing isn't said twice
  text: string
  label: string // what the button does
  say?: string // a request to him, sent in a new conversation
  view?: View // or a screen to open
}

const WAITING_HOURS = 12

export const dayOf = (now: number): string => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// What he could say now, the most pressing first.
export function tucaNudges(s: Pick<State, 'agents' | 'connectors' | 'routines' | 'messages' | 'inbox'>, now = Date.now()): Nudge[] {
  const team = s.agents.filter(isTeam)
  const out: Nudge[] = []
  const names = (list: string[]): string => (list.length > 2 ? L(`${list.slice(0, 2).join(', ')} e mais ${list.length - 2}`, `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`) : list.join(L(' e ', ' and ')))
  // A service the team works with that stopped answering: nothing they do there goes through until it is back.
  for (const c of s.connectors) {
    if (c.status !== 'needs_auth' && c.status !== 'error') continue
    const who = team.filter((a) => (a.grants[c.id] ?? 'none') !== 'none').map((a) => a.name)
    if (!who.length) continue
    out.push({
      key: `connector:${c.id}:${c.status}`,
      text: c.status === 'needs_auth' ? L(`O ${c.name} está pedindo login, e ${names(who)} ${who.length > 1 ? 'dependem' : 'depende'} dele.`, `${c.name} is asking you to sign in, and ${names(who)} ${who.length > 1 ? 'depend' : 'depends'} on it.`) : L(`O ${c.name} parou de responder, e ${names(who)} ${who.length > 1 ? 'dependem' : 'depende'} dele.`, `${c.name} stopped answering, and ${names(who)} ${who.length > 1 ? 'depend' : 'depends'} on it.`),
      label: L('Resolver', 'Fix it'),
      view: { kind: 'connectors' }
    })
  }
  // A colleague out of its month: it answers no one until the limit goes up or the month turns.
  for (const a of team) {
    if (!overMonthlyLimit(a.used, a.limit)) continue
    out.push({
      key: `limit:${a.id}:${dayOf(now).slice(0, 7)}`,
      text: L(`${a.name} usou todo o limite do mês e parou de responder.`, `${a.name} used up the month's limit and stopped answering.`),
      label: L('Aumentar o limite', 'Raise the limit'),
      say: L(`${a.name} usou todo o limite do mês. Proponha um limite maior pra ${a.name}.`, `${a.name} used up the month's limit. Propose a higher limit for ${a.name}.`)
    })
  }
  // A routine whose last run didn't finish: its reply, where the routine runs (what is loaded of it).
  for (const r of s.routines) {
    if (!r.enabled || !r.lastMessageId) continue
    const there = s.messages[r.conversationId] ?? []
    const last = there.find((m) => m.id === r.lastMessageId)
    const reply = last?.author.kind === 'routine' ? there.find((m) => m.run?.routineAsk === last.id) : last
    const st = reply?.run?.status
    if (st !== 'failed' && st !== 'limit_reached') continue
    const who = s.agents.find((a) => a.id === r.agentId)?.name
    out.push({
      key: `routine:${r.id}:${r.lastAt ?? 0}`,
      text: L(`A rotina “${r.name}”${who ? ` de ${who}` : ''} não terminou da última vez.`, `The routine “${r.name}”${who ? ` of ${who}` : ''} didn't finish last time.`),
      label: L('Ver o que houve', 'See what happened'),
      say: L(`Por que a rotina “${r.name}” não terminou da última vez?`, `Why didn't the routine “${r.name}” finish last time?`)
    })
  }
  // What has been waiting on the person for a while.
  const waiting = [...s.inbox.approvals.map((a) => ({ id: a.id, at: a.createdAt })), ...s.inbox.questions.map((q) => ({ id: q.id, at: q.createdAt }))].filter((x) => now - x.at > WAITING_HOURS * 3_600_000).sort((a, b) => a.at - b.at)
  if (waiting.length)
    out.push({
      key: `waiting:${waiting[0]!.id}`,
      text: L(waiting.length === 1 ? 'Tem uma coisa esperando você há um tempo, e o trabalho parou nela.' : `Tem ${waiting.length} coisas esperando você há um tempo, e o trabalho parou nelas.`, waiting.length === 1 ? 'One thing has been waiting on you for a while, and the work stopped on it.' : `${waiting.length} things have been waiting on you for a while, and the work stopped on them.`),
      label: L('Ver', 'See them'),
      view: { kind: 'approvals' }
    })
  return out
}

// The one to show now, if any: one a day at most (the day's stays until it is closed or no longer true),
// none when turned off, and none while a request of the person's is still going.
export function nudgeNow(list: Nudge[], settings: Pick<Settings, 'tucaSpeaksFirst' | 'tucaNudge'>, opts: { busy: boolean; now?: number }): Nudge | undefined {
  if (settings.tucaSpeaksFirst === false || opts.busy) return undefined
  const today = dayOf(opts.now ?? Date.now())
  const kept = settings.tucaNudge
  if (kept?.day === today) return kept.closed ? undefined : list.find((n) => n.key === kept.key)
  return list[0]
}
