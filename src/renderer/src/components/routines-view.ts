// The routines page's pure logic: the list split ("precisa de você", "próximas", "desligadas"),
// the marks on a run, and the short words for a schedule and a time. Every run stays in the hour
// grid. Kept apart from Routines.tsx so it can be tested without React.
import { L, lang } from '../../../shared/lang'
import { dateAt, nextRun, timesOf, validDate, type Message, type Routine, type RunStatus, type Schedule } from '../../../shared/types'

// One routine at one time: a run that happened (with how it went), or one still to come.
export type Occ = {
  key: string
  routine?: Routine
  name: string
  agentId: string
  at: number
  conversationId: string
  status?: RunStatus
  replyId?: string
  reply?: Message // the agent's reply, for what it said or why it failed
  upcoming?: boolean
}

export const FAILED: ReadonlySet<RunStatus> = new Set(['failed', 'limit_reached'])
export const WAITS: ReadonlySet<RunStatus> = new Set(['waiting_approval', 'waiting_input'])
const OK: ReadonlySet<RunStatus> = new Set(['done'])

// A routine the person turned off, as against one that turned itself off by running its single time:
// it keeps its place in the week, greyed, so it can be turned back on from its own panel.
export const isOff = (o: Pick<Occ, 'routine'>): boolean => !!o.routine && !o.routine.enabled && !finished(o.routine)

// How one run looks as a tick or a dot: done, failed, waiting on me, running, still to come, or stopped.
export type Mark = 'ok' | 'bad' | 'wait' | 'live' | 'todo' | 'off'
export function markOf(o: Pick<Occ, 'status' | 'upcoming' | 'routine'>): Mark {
  if (o.upcoming) return isOff(o) ? 'off' : 'todo'
  if (!o.status) return 'off'
  if (o.status === 'working') return 'live'
  if (FAILED.has(o.status)) return 'bad'
  if (WAITS.has(o.status)) return 'wait'
  if (OK.has(o.status)) return 'ok'
  return 'off'
}

// ---------- the list ----------

export type Need = { routine: Routine; occ: Occ; kind: 'failed' | 'waiting'; okSince: number }
export type Upcoming = { routine: Routine; next?: number; last?: Occ }
export type Sections = { needs: Need[]; next: Upcoming[]; off: Routine[] }

const DAY_MS = 86_400_000

// A one-off that already ran: off by itself, done rather than turned off.
export const finished = (r: Routine): boolean => !r.enabled && !!r.schedule.once && !!r.lastAt && !r.trigger

// When it runs next: what the core keeps, or worked out from its clock; none for a trigger or while off.
export const nextOf = (r: Routine, now: number): number | undefined => (!r.enabled || r.trigger ? undefined : (r.nextAt ?? nextRun(r.schedule, now)))

// The list's sections, from the routines and the runs that happened (any order):
// - precisa de você: the last run waits on me (an approval, a question), or, for one that's on, a run
//   failed in the last day (even if later ones went fine: it says so). Waiting first, then the newest failure.
// - próximas: the rest that are on, by their next run; the ones that watch for something at the end.
// - desligadas: the ones that are off (a one-off that already ran too), by name.
export function listSections(routines: Routine[], runs: Occ[], now: number): Sections {
  const byRoutine = new Map<string, Occ[]>()
  for (const o of [...runs].filter((x) => !x.upcoming && x.routine).sort((a, b) => a.at - b.at)) {
    const list = byRoutine.get(o.routine!.id)
    if (list) list.push(o)
    else byRoutine.set(o.routine!.id, [o])
  }
  const needs: Need[] = []
  const next: Upcoming[] = []
  const off: Routine[] = []
  for (const r of routines) {
    const ran = byRoutine.get(r.id) ?? []
    const last = ran.at(-1)
    const failedAt = r.enabled ? ran.filter((o) => o.status && FAILED.has(o.status) && o.at > now - DAY_MS).at(-1) : undefined
    if (last?.status && WAITS.has(last.status)) needs.push({ routine: r, occ: last, kind: 'waiting', okSince: 0 })
    else if (failedAt) needs.push({ routine: r, occ: failedAt, kind: 'failed', okSince: ran.filter((o) => o.at > failedAt.at && o.status === 'done').length })
    else if (r.enabled) next.push({ routine: r, next: nextOf(r, now), last })
    else off.push(r)
  }
  needs.sort((a, b) => (a.kind === b.kind ? b.occ.at - a.occ.at : a.kind === 'waiting' ? -1 : 1))
  next.sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity) || a.routine.name.localeCompare(b.routine.name))
  off.sort((a, b) => a.name.localeCompare(b.name))
  return { needs, next, off }
}

export { firstLine } from '../../../shared/titles'

// ---------- words ----------

const DAY_LONG = (): string[] => (lang() === 'en' ? ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'] : ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'])
const DAY_SHORT = (): string[] => (lang() === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'])
const and = (list: string[]): string => (list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')}${L(' e ', ' and ')}${list.at(-1)}`)

// "seg a sex", "todo dia", "segunda", "seg, qua e sex"
function daysWords(days: number[]): string {
  const d = [...new Set(days)].sort()
  if (d.length === 7) return L('todo dia', 'every day')
  if (d.join() === '1,2,3,4,5') return L('seg a sex', 'Mon–Fri')
  if (d.join() === '0,6') return L('fim de semana', 'weekends')
  if (d.length === 1) return DAY_LONG()[d[0]!]!
  return and(d.map((x) => DAY_SHORT()[x]!))
}

// "9h", "9h30" in Portuguese; "9:00", "9:30" in English.
const hourWord = (t: string): string => {
  const [h, m] = t.split(':')
  return L(`${Number(h)}h${m === '00' ? '' : m}`, `${Number(h)}:${m}`)
}
const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

// Several times a day: "de hora em hora, 9h–17h", "de 2 em 2 horas, 10h–16h", or the times themselves.
function timesWords(times: string[]): string {
  const m = times.map(minutesOf)
  const step = (m[1] ?? 0) - (m[0] ?? 0)
  const even = m.length > 2 && step > 0 && m.every((x, i) => i === 0 || x - m[i - 1]! === step)
  const span = `${hourWord(times[0]!)}–${hourWord(times.at(-1)!)}`
  if (even && step === 60) return L(`de hora em hora, ${span}`, `every hour, ${span}`)
  if (even && step % 60 === 0) return L(`de ${step / 60} em ${step / 60} horas, ${span}`, `every ${step / 60} hours, ${span}`)
  if (even) return L(`de ${step} em ${step} min, ${span}`, `every ${step} min, ${span}`)
  if (times.length > 4) return L(`${times.length} vezes, ${span}`, `${times.length} times, ${span}`)
  return and(times)
}

const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

// A schedule in a few words, for a row: "seg a sex, 08:30", "segunda, 09:00",
// "seg a sex, de hora em hora, 9h–17h", "todo dia 5, 09:00", "uma vez, 17 nov, 09:00".
export function scheduleWords(s: Schedule): string {
  if (s.date !== undefined && validDate(s.date)) {
    const day = new Date(dateAt(s.date, '12:00')).toLocaleDateString(lang() === 'en' ? 'en-US' : 'pt-BR', { day: 'numeric', month: 'short' }).replace(/\./g, '').replace(' de ', ' ')
    return L(`uma vez, ${day}, ${s.time}`, `once, ${day}, ${s.time}`)
  }
  if (s.once) return s.days.length === 7 || s.days.length === 0 ? L(`uma vez, ${s.time}`, `once, ${s.time}`) : L(`uma vez, ${[...s.days].sort().map((d) => DAY_LONG()[d]).join(' ou ')}, ${s.time}`, `once, ${[...s.days].sort().map((d) => DAY_SHORT()[d]).join(' or ')}, ${s.time}`)
  const times = timesOf(s)
  const at = times.length > 1 ? timesWords(times) : s.time
  if (s.monthDay !== undefined) return L(`todo dia ${s.monthDay}, ${at}`, `monthly on the ${ordinal(s.monthDay)}, ${at}`)
  return s.days.length === 7 && times.length > 1 ? at : `${daysWords(s.days)}, ${at}`
}

// A routine's schedule or what it watches, in a few words: also "quando chega um e-mail".
export function routineWords(r: Pick<Routine, 'schedule' | 'trigger'>, connectorName?: string): string {
  const t = r.trigger
  if (!t) return scheduleWords(r.schedule)
  if (t.kind === 'webhook') return L('quando chamada neste computador', 'when called on this computer')
  if (connectorName && /mail|outlook/i.test(connectorName)) return L('quando chega um e-mail', 'when an email arrives')
  return L(`quando aparece algo novo em ${connectorName ?? 'um conector'}`, `when something new shows up in ${connectorName ?? 'a connector'}`)
}

const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const daysApart = (at: number, now: number): number => Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY_MS)
const weekday = (at: number): string => DAY_SHORT()[new Date(at).getDay()]!

// When it runs next, at the right of a row: "hoje, 14:00", "amanhã, 08:30", "qui, 15:00", "seg 23, 09:00".
export function nextWords(at: number, now: number): string {
  const n = daysApart(at, now)
  if (n === 0) return L(`hoje, ${clock(at)}`, `today, ${clock(at)}`)
  if (n === 1) return L(`amanhã, ${clock(at)}`, `tomorrow, ${clock(at)}`)
  if (n > 1 && n < 7) return `${weekday(at)}, ${clock(at)}`
  return `${weekday(at)} ${new Date(at).getDate()}, ${clock(at)}`
}

// When it failed: "falhou às 11:00", "falhou ontem às 11:00", "falhou qua às 11:00".
export function failedWords(at: number, now: number): string {
  const n = daysApart(at, now)
  if (n === 0) return L(`falhou às ${clock(at)}`, `failed at ${clock(at)}`)
  if (n === -1) return L(`falhou ontem às ${clock(at)}`, `failed yesterday at ${clock(at)}`)
  return L(`falhou ${weekday(at)} às ${clock(at)}`, `failed ${weekday(at)} at ${clock(at)}`)
}

// What waits on me, in a few words.
export const waitWords = (status: RunStatus | undefined): string => (status === 'waiting_input' ? L('esperando sua resposta', 'waiting for your answer') : L('esperando você aprovar', 'waiting for your approval'))
