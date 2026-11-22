// A piece of work: what a message sets off, from the first reply to the last. The agents work on it by
// themselves, passing the turn with @, handing parts on with pedir, called in when it's theirs, until a
// reply passes the turn to no one and has nothing left out: that reply is the answer. There is no count of
// replies to stop at. What stops it is the work no longer moving: replies in a row that changed nothing,
// the same reply or the same request coming around again, hours with nothing new, and a last backstop.
// Each way out leaves a note in the conversation, with why, what got done and a way to go on. A job is
// kept in the database, so it outlives the app closing.
import { L } from '../shared/lang'
import { WORKLESS_LABELS } from '../shared/run-progress'
import type { Run } from '../shared/types'

export const IDLE_STOP = 3 // replies in a row that moved nothing
export const SAME_STOP = 3 // the same reply by the same agent, or the same request to the same agent
export const QUIET_STOP_MS = 2 * 3_600_000 // hours with nothing new
export const JOB_MAX_REPLIES = 100 // the backstop
export const MAX_CHIMES = 3 // agents the router calls in on its own, per job
const DONE_KEPT = 12
const DELIVERY_MIN = 300 // a reply this long, and new, is something delivered even with no tool

export type JobStopWhy = 'idle' | 'circle' | 'quiet' | 'cap'
export type JobState = 'running' | 'done' | 'stopped'

export interface Job {
  id: string // the message that set it off (or the reply, when nothing else did)
  conversationId: string
  threadId?: string
  requestedBy?: string // the person it is for
  text: string // what was asked
  state: JobState
  replies: number
  idle: number // replies in a row with nothing new
  lastProgressAt: number
  createdAt: number
  endedAt?: number
  why?: JobStopWhy
  circleBy?: string // who went around: an agent's name, or "Dev → Bia"
  stoppedAt?: string // the reply it stopped on: Continuar goes on from there
  noteId?: string // the note left where it stopped
  last: Record<string, string> // each agent's last reply here
  repeats: Record<string, number> // the same reply said again, by agent
  asks: Record<string, number> // the same request to the same agent, by "to:text"
  chimed: string[] // agents the router called in on its own
  done: string[] // what got done, newest last
}

export const newJob = (j: Pick<Job, 'id' | 'conversationId' | 'text'> & Partial<Job>, now = Date.now()): Job => ({
  state: 'running',
  replies: 0,
  idle: 0,
  lastProgressAt: now,
  createdAt: now,
  last: {},
  repeats: {},
  asks: {},
  chimed: [],
  done: [],
  ...j
})

// "/objetivo …" from before: it reads as the message itself, since every message now runs until it's done.
export const withoutGoal = (typed: string): string => {
  const m = /^\s*\/(objetivo|goal)\b\s*([\s\S]*)$/i.exec(typed)
  return m ? m[2]!.trim() : typed
}

// The same reply, read loosely: spacing, case and punctuation don't make it a different one.
const loose = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
export const sameReply = (a: string, b: string): boolean => !!loose(a) && loose(a) === loose(b)

// How much two texts share, by their words: 1 the same words, 0 none in common.
export function overlap(a: string, b: string): number {
  const wa = new Set(loose(a).split(' ').filter((w) => w.length > 2))
  const wb = new Set(loose(b).split(' ').filter((w) => w.length > 2))
  if (!wa.size || !wb.size) return 0
  let both = 0
  for (const w of wa) if (wb.has(w)) both++
  return both / (wa.size + wb.size - both)
}

// Steps that only looked, asked or waited: they move nothing by themselves.
const LOOKS = /^(Leu|Read|Viu|Looked|Buscou|Searched|Pesquisou|Consultou|Abriu na wiki|Opened in the wiki|Perguntou|Asked|Pediu|Chamou|Called|Esperando|Waiting|Foi pro modelo reserva|Moved to the reserve|Chegou no teto|Reached the reply cap|Continuou|Went on|Ninguém precisa|No one needs|Parado|Stopped|Parou|Falhou|Failed|Respondeu|Replied)/

// What a reply got done that changed something: a tool that did something and came back well, a file made.
export function progressOf(run: Run | undefined): string[] {
  const steps = (run?.steps ?? []).filter((s) => s.status === 'done' && !WORKLESS_LABELS.includes(s.label) && !LOOKS.test(s.label))
  const made = run?.artifactIds?.length ? [L(`Entregou ${run.artifactIds.length === 1 ? 'um arquivo' : `${run.artifactIds.length} arquivos`}`, `Delivered ${run.artifactIds.length === 1 ? 'a file' : `${run.artifactIds.length} files`}`)] : []
  return [...steps.map((s) => (s.detail ? `${s.label}: ${s.detail.replace(/\s+/g, ' ').slice(0, 120)}` : s.label)), ...made]
}

const key = (to: string, text: string): string => `${to}:${loose(text).slice(0, 300)}`

// A request handed on within the job: the third time the same one goes to the same agent, it's going in circles.
export function countAsk(job: Job, to: string, text: string): number {
  const k = key(to, text)
  job.asks[k] = (job.asks[k] ?? 0) + 1
  return job.asks[k]!
}

// One more reply on the job: whether it moved, and whether the job stops here. A reply moved when it did
// something that changed something (progressOf), delivered a text that is long and new for its agent,
// answered a request handed to it (`answers`: its part, however short, goes back to whoever asked), or
// handed on a request not asked before on the job (`handedOn`: the work split and routed; the same one
// again is counted by countAsk, and the chain of requests has its own cap).
export function jobTurn(job: Job, turn: { agentId: string; agentName: string; text: string; run?: Run; answers?: boolean; handedOn?: number }, now = Date.now()): JobStopWhy | undefined {
  job.replies++
  const before = job.last[turn.agentId]
  const text = turn.text.trim()
  const did = progressOf(turn.run)
  const delivered = (text.length >= DELIVERY_MIN || (turn.answers === true && !!text)) && (before === undefined || overlap(before, text) < 0.8)
  const handed = (turn.handedOn ?? 0) > 0
  const moved = did.length > 0 || delivered || handed
  if (moved) {
    job.idle = 0
    job.lastProgressAt = now
    const line = did.length ? did.slice(-2).join('; ') : handed && !delivered ? L(`passou ${turn.handedOn === 1 ? 'uma parte' : `${turn.handedOn} partes`} adiante`, `handed ${turn.handedOn === 1 ? 'a part' : `${turn.handedOn} parts`} on`) : L(`escreveu: ${text.replace(/\s+/g, ' ').slice(0, 100)}…`, `wrote: ${text.replace(/\s+/g, ' ').slice(0, 100)}…`)
    job.done = [...job.done, `${turn.agentName}: ${line}`].slice(-DONE_KEPT)
  } else job.idle++
  const same = before !== undefined && !!text && (sameReply(before, text) || overlap(before, text) >= 0.9)
  job.repeats[turn.agentId] = same ? (job.repeats[turn.agentId] ?? 1) + 1 : 1
  if (text) job.last[turn.agentId] = text
  let why: JobStopWhy | undefined
  if ((job.repeats[turn.agentId] ?? 0) >= SAME_STOP) {
    why = 'circle'
    job.circleBy = turn.agentName
  } else if (Object.values(job.asks).some((n) => n >= SAME_STOP)) {
    why = 'circle'
    job.circleBy ??= turn.agentName
  } else if (job.idle >= IDLE_STOP) why = 'idle'
  else if (now - job.lastProgressAt >= QUIET_STOP_MS) why = 'quiet'
  else if (job.replies >= JOB_MAX_REPLIES) why = 'cap'
  if (why) {
    job.state = 'stopped'
    job.why = why
    job.endedAt = now
  }
  return why
}

// Going on after a stop, by hand: the count of what moved nothing starts over, and so does the backstop.
export function resumeJob(job: Job, now = Date.now()): void {
  job.state = 'running'
  job.idle = 0
  job.replies = 0
  job.lastProgressAt = now
  job.repeats = {}
  job.asks = {}
  delete job.why
  delete job.circleBy
  delete job.endedAt
}

// The note left where the job stopped: why, what got done, and how to go on.
export function stopNote(job: Job, lastWord?: { name: string; text: string }): string {
  const why = {
    idle: L(`foram ${IDLE_STOP} respostas seguidas sem nada novo: nenhuma ação mudou algo, nenhuma entrega nova`, `${IDLE_STOP} replies in a row brought nothing new: no action changed anything, nothing new was delivered`),
    circle: L(`parecia que o trabalho estava andando em círculos${job.circleBy ? ` (${job.circleBy} voltou ao mesmo ponto)` : ''}`, `the work seemed to be going around in circles${job.circleBy ? ` (${job.circleBy} came back to the same point)` : ''}`),
    quiet: L(`faz ${Math.round(QUIET_STOP_MS / 3_600_000)} horas que nada avança`, `nothing has moved for ${Math.round(QUIET_STOP_MS / 3_600_000)} hours`),
    cap: L(`chegou a ${JOB_MAX_REPLIES} respostas neste trabalho`, `this work reached ${JOB_MAX_REPLIES} replies`)
  }[job.why ?? 'idle']
  const done = job.done.length ? `\n\n${L('**Feito até aqui**', '**Done so far**')}\n${job.done.map((d) => `- ${d}`).join('\n')}` : `\n\n${L('Nada ficou pronto ainda.', 'Nothing is done yet.')}`
  const left = lastWord?.text.trim() ? `\n\n${L(`**Onde parou**: ${lastWord.name} disse por último`, `**Where it stopped**: ${lastWord.name} said last`)}: “${lastWord.text.replace(/\s+/g, ' ').trim().slice(0, 280)}${lastWord.text.trim().length > 280 ? '…' : ''}”` : ''
  return `${L(`**Parei este trabalho**: ${why}.`, `**I stopped this work**: ${why}.`)}${done}${left}\n\n${L('Pra seguir, clique em Continuar, ou escreva aqui o que mudar.', 'To go on, click Continue, or write here what to change.')}`
}
