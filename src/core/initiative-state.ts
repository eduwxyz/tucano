// What a check-in may do right now, and what it is told. Pure: the clock, the records and the runner
// are read by the caller, so every rule here can be read on its own and tested without one.
import { L, locale } from '../shared/lang'
import { backoffMinutes, isClosed, MAX_QUIET_BACKOFF, type Commitment, type InitiativeConfig, type InitiativeWake, type LinkSnapshot, type WakeOutcome } from '../shared/initiative'
import { linkLine } from './initiative-links'

// How often the clock looks. A cadence is in minutes, so a minute is close enough, and a tick that
// finds a review due a few seconds late costs nothing.
export const TICK_MS = 60_000
// The most responsibilities one check-in is told about; the rest come in the ones after.
export const BRIEFED_COMMITMENTS = 12
// Work that moved is news now, but not news every minute: a resumed check-in waits this long after the
// one before it, so a failed or paused attempt cannot turn into a hot loop.
export const RESUME_FLOOR_MINUTES = 5

export type Refusal = 'off' | 'paused' | 'busy' | 'not-due' | 'cap' | 'allowance' | 'quiet-hours'

// What a check-in that ran counts as: these are the attempts, not the ones admitted and refused.
export const RAN: readonly WakeOutcome[] = ['quiet', 'reported', 'failed', 'interrupted']
export const attemptsOf = (wakes: InitiativeWake[]): InitiativeWake[] => wakes.filter((w) => RAN.includes(w.outcome))

// Quiet check-ins in a row, newest first: each one doubles the wait before the next.
export const quietStreakOf = (wakes: InitiativeWake[]): number => {
  let n = 0
  for (const w of wakes) {
    if (w.outcome === 'skipped') continue
    if (w.outcome !== 'quiet') break
    n++
    if (n >= MAX_QUIET_BACKOFF) break
  }
  return n
}

export interface AdmissionInput {
  config: InitiativeConfig
  now: number
  lastAt?: number // when its last check-in ran
  quietStreak: number // check-ins in a row that found nothing
  reviewsToday: number // check-ins today that ran (whatever came of them)
  tokensToday: number
  busy: boolean // one of this person's check-ins is already under way
  paused: boolean // the app is paused (Settings, or "Pausar tudo")
  quietHours: boolean
  // Work behind a responsibility changed since the coordinator last read it: it is due now, whatever
  // the cadence says, but never twice inside RESUME_FLOOR_MINUTES.
  resume?: boolean
  // What this person's own wait is: the cadence, or longer while something of the bot's waits on them.
  floorMinutes?: number
  // The person asked for this one ("Conferir agora"): no wait to respect, theirs to skip. The caps,
  // the allowance and the pause still hold.
  manual?: boolean
  // The last word in that DM was theirs, and the bot has not answered yet: a review of the thread they
  // are in the middle of waits, and their own turn never queues behind the coordinator's.
  personTalking?: boolean
}

export type Admission = { run: false; why: Refusal } | { run: true; at: number; resume: boolean }

// The minute a coordinator is next due: its cadence after the last check-in, doubled for each quiet
// one in a row. Before any check-in, the cadence counts from the last edit, so turning it on does not
// spend anything on the spot.
export const dueAt = (config: InitiativeConfig, lastAt: number | undefined, quietStreak: number, floorMinutes?: number): number => {
  const minutes = floorMinutes ? Math.max(floorMinutes, config.cadenceMinutes) : backoffMinutes(config.cadenceMinutes, quietStreak)
  return (lastAt ?? config.updatedAt) + minutes * 60_000
}

export function admit(i: AdmissionInput): Admission {
  const { config } = i
  if (!config.enabled) return { run: false, why: 'off' }
  if (i.paused) return { run: false, why: 'paused' }
  if (i.busy) return { run: false, why: 'busy' }
  if (!i.manual && i.personTalking) return { run: false, why: 'busy' }
  const resume = i.resume === true
  if (i.manual) {
    // Asked for by hand: the cadence and the quiet hours are theirs to skip. Nothing else is.
  } else if (resume) {
    // News, but on the clock too: one attempt per floor minutes, so a failing or paused run is retried
    // quietly instead of in a loop.
    if (i.lastAt !== undefined && i.now - i.lastAt < RESUME_FLOOR_MINUTES * 60_000) return { run: false, why: 'not-due' }
  } else if (i.now < dueAt(config, i.lastAt, i.quietStreak, i.floorMinutes)) {
    return { run: false, why: 'not-due' }
  }
  if (i.reviewsToday >= config.dailyReviews) return { run: false, why: 'cap' }
  if (i.tokensToday >= config.dailyTokens) return { run: false, why: 'allowance' }
  if (i.quietHours) return { run: false, why: 'quiet-hours' }
  return { run: true, at: i.now, resume }
}

// What a check-in is asked, in one block: who asked it, what they said to look after, what is owed
// now, the work those rest on and what moved since last time, and the rules that keep it quiet and
// keep it from asking the same question twice. Bounded: a brief and a dozen responsibilities, never
// the conversation's whole history (the runner brings the recent messages).
export function heartbeatTask(
  config: InitiativeConfig,
  commitments: Commitment[],
  me: string,
  opts: { links?: Map<string, LinkSnapshot[]>; moved?: LinkSnapshot[]; stalled?: string[] } = {}
): string {
  const live = commitments.filter((c) => !isClosed(c.state)).slice(0, BRIEFED_COMMITMENTS)
  const when = (at: number): string => new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const owed = live.map((c) => {
    const due = c.nextCheckAt ? ` · ${L('conferir', 'check')} ${when(c.nextCheckAt)}` : ''
    const note = c.note ? ` (${c.note})` : ''
    const deps = (opts.links?.get(c.id) ?? []).filter((l) => l.state !== 'gone').map((l) => linkLine(l))
    const rests = deps.length ? ` · ${L('depende de', 'rests on')}: ${deps.join('; ')}` : ''
    return `- [${c.state}] ${c.description}${note}${due}${rests}`
  })
  const moved = opts.moved ?? []
  const stalled = opts.stalled ?? []
  return [
    L(
      `Esta é uma conferida sua, não uma mensagem de ${me}: ninguém está falando com você agora. ${me} te pediu pra cuidar disto, nas palavras delas:`,
      `This is your own check-in, not a message from ${me}: nobody is talking to you right now. ${me} asked you to look after this, in their words:`
    ),
    `<pedido>\n${config.brief}\n</pedido>`,
    owed.length ? L(`O que ${me} espera de você agora:`, `What ${me} is waiting on now:`) + `\n${owed.join('\n')}` : L(`Nada em aberto na lista.`, `Nothing on the list is open.`),
    ...(moved.length
      ? [
          L(`Mudou desde a sua última conferida:`, `Changed since your last check-in:`) +
            '\n' +
            moved.map((l) => `- ${l.kind}${l.what ? ` (${l.what})` : ''}: ${linkLine(l)}`).join('\n')
        ]
      : []),
    ...(stalled.length
      ? [
          L(
            `Sem avanço em várias conferidas: ${stalled.join('; ')}. Ou dê um passo concreto nisto agora, ou feche, ou diga a ${me} o que está travando.`,
            `No progress across several check-ins: ${stalled.join('; ')}. Either take one concrete step on it now, close it, or tell ${me} what is blocking it.`
          )
        ]
      : []),
    L(
      `Faça o que o pedido diz, com o que você já pode fazer. Não peça permissão que não precisa, não invente trabalho e não repita uma pergunta que já está esperando ${me}: se ela não foi respondida, ela continua esperando. Se nada precisa de ${me} agora, responda só com [[quiet]] nesta linha e nada mais: a conferida não aparece na conversa. Se algo precisa, escreva o que você fez ou achou, em poucas linhas, e o que ${me} precisa olhar.`,
      `Do what the request says, with what you can already do. Do not ask for permission you do not need, do not invent work, and do not repeat a question already waiting on ${me}: if they have not answered it, it is still waiting. If nothing needs ${me} right now, answer with [[quiet]] on this line and nothing else: the check-in leaves no trace in the conversation. If something does, write what you did or found in a few lines, and what ${me} should look at.`
    )
  ].join('\n\n')
}
