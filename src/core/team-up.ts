// A team-up: an agent's reply calls agents that aren't in the conversation it was answering in. That
// conversation can't take them (a DM has one agent; a channel's agents are the person's to change), so
// the work moves to a channel of its own that starts with what was already done — nobody re-explains,
// and the person sees it in the sidebar like any other channel.
//
// Everything here is a plan: no database, no model. runs.ts decides when to open one (see `openTeamUp`).
import { channelName, TEAM_UP_DAYS } from '../shared/types'
import { L } from '../shared/lang'

const DAY = 86_400_000

// Agents one reply can call in: the same ceiling as agents it can hand the turn to (runs.ts MAX_MENTIONS).
export const TEAM_UP_GUESTS = 3
// How much of the conversation travels with them: the last messages, and a ceiling in characters.
export const TEAM_UP_MESSAGES = 24
export const TEAM_UP_CHARS = 12_000
// Per message, so one long reply can't take the whole budget.
export const TEAM_UP_LINE = 900
// The same agent calling the same agents from the same conversation within this is the same room,
// reused: a second mention an hour later isn't a second channel.
export const TEAM_UP_REUSE_MS = 6 * 60 * 60_000

// Which team-up channels have been quiet long enough to close themselves: the ones whose last message
// (the hand-off, when nobody ever answered) is `days` old. `days` 0 or less keeps every one of them, and
// a channel with a reply still running is never one: the clock only runs while nothing is happening.
export function staleTeamUps(
  conversations: { id: string; teamUp?: { at: number } }[],
  lastAt: (id: string) => number | undefined,
  opts: { days: number; now?: number }
): string[] {
  const days = Math.round(opts.days)
  if (!(days > 0)) return []
  const now = opts.now ?? Date.now()
  return conversations.filter((c) => !!c.teamUp && now - (lastAt(c.id) ?? c.teamUp.at) >= days * DAY).map((c) => c.id)
}

// How long a team-up stays, in days, from what the person set (unset: a week).
export const teamUpDays = (set: number | undefined): number => (Number.isFinite(set) ? Math.max(0, Math.round(set as number)) : TEAM_UP_DAYS)

export interface Carried {
  name: string // who said it, as the person would read it
  text: string
  at: number
}

// "team-up-tinker-auditor": the agents it was opened for, in a name that reads in the sidebar. `taken`
// says which channel names already exist, so two team-ups never collide.
export function teamUpName(guests: { handle: string }[], taken: (name: string) => boolean = () => false): string {
  const base = channelName(`team-up ${guests.map((g) => g.handle).join(' ')}`) || 'team-up'
  if (!taken(base)) return base
  for (let n = 2; n < 100; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`
  return `${base}-${Date.now()}`
}

// The one line under the channel's name: where it came from, so a channel that appeared on its own
// explains itself without anyone asking.
export function teamUpTopic(by: string, source: string): string {
  return L(`Aberto por ${by}, vindo de ${source}`, `Opened by ${by}, from ${source}`)
}

// The ceiling on the carried conversation: the newest messages that fit, each clipped, and the count of
// what was left behind so whoever reads it knows the start is missing.
export function pickCarried(messages: Carried[]): { kept: Carried[]; left: number } {
  const kept: Carried[] = []
  let room = TEAM_UP_CHARS
  for (let i = messages.length - 1; i >= 0 && kept.length < TEAM_UP_MESSAGES; i--) {
    const m = messages[i]!
    const text = m.text.trim()
    if (!text) continue
    const cut = text.length > TEAM_UP_LINE ? `${text.slice(0, TEAM_UP_LINE).trimEnd()}…` : text
    if (cut.length > room) break
    room -= cut.length
    kept.unshift({ ...m, text: cut })
  }
  return { kept, left: messages.length - kept.length }
}

// What the calling agent posts as the channel's first message: the work already done, then the ask.
// Written in that agent's voice because that is what it is — its own hand-off, not a machine log.
export function carriedText(opts: { by: string; guests: string[]; source: string; messages: Carried[]; said: string }): string {
  const { by, guests, source, messages, said } = opts
  const { kept, left } = pickCarried(messages)
  const names = guests.map((g) => `@${g}`).join(L(' e ', ' and '))
  const head = L(
    `Trouxe para cá o que já foi feito em ${source} e chamei ${names}.`,
    `I brought over what was already done in ${source} and called ${names} in.`
  )
  const body = kept.map((m) => `**${m.name}** · ${m.text}`).join('\n\n')
  const more = left > 0 ? L(`\n\n_(mais ${left} mensagem${left === 1 ? '' : 's'} antes destas, em ${source})_`, `\n\n_(and ${left} message${left === 1 ? '' : 's'} before these, in ${source})_`) : ''
  const ask = said.trim() ? L(`\n\n**O que falta agora**: ${said.trim()}`, `\n\n**What's left to do**: ${said.trim()}`) : ''
  return L(
    `${head}\n\n— o que já foi dito em ${source} —\n\n${body}${more}${ask}`,
    `${head}\n\n— what was said in ${source} —\n\n${body}${more}${ask}`
  )
}

// The first thing each agent called in is told: why it's here, and where its context is.
export function teamUpTask(opts: { by: string; source: string; channel: string; said: string }): string {
  const { by, source, channel, said } = opts
  const quote = said.trim() ? ` ${L('Foi por causa disto:', 'It was over this:')} "${said.trim().slice(0, 600)}"` : ''
  return L(
    `${by} chamou você e mais gente para #${channel}, vindo de ${source}. A primeira mensagem do canal traz o que já foi feito ali: leia antes de responder. Você está aqui para trabalhar junto com quem foi chamado, não para responder ${by} em particular.${quote}`,
    `${by} called you and others into #${channel}, from ${source}. The channel's first message carries what was already done there: read it before replying. You're here to work with the others who were called, not to answer ${by} alone.${quote}`
  )
}
