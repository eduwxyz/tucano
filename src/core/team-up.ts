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

// How much of a channel name the sidebar shows whole. Measured in the built app on this box: the
// sidebar is 248 px, a channel row leaves its name 179 px, and 143.9 px once the row carries an
// unread badge — which is what a channel has the moment it opens. In the sidebar's own font
// (Inter Variable, 14 px, weight 500) that is 27 characters of an ordinary lowercase slug, 22 with
// the badge. Past that the sidebar cuts the name with an ellipsis, so 22 is what keeps it whole in
// the state it is born in.
export const TEAM_UP_NAME_MAX = 22

// The name an agent chose for its team-up, made into a channel name that fits: lower case, no
// accents, one word per hyphen, and cut back to a whole word instead of in the middle of one.
// Cut to `max`, on a word boundary when there is one late enough to be a name rather than a stub:
// "audit-of-the-retry-path" loses "path", not "pat".
function cutTo(slug: string, max: number): string {
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max)
  const brk = Math.max(cut.lastIndexOf('-'), cut.lastIndexOf('_'))
  const whole = brk >= 4 ? cut.slice(0, brk) : cut
  return whole.replace(/^[-_]+|[-_]+$/g, '')
}

export function fitTeamUpName(wanted: string, max: number = TEAM_UP_NAME_MAX): string {
  return cutTo(channelName(wanted).replace(/^[-_]+|[-_]+$/g, ''), max)
}

// The channel's name: the one the agent gave it when it called the team (that is the whole point —
// "audit-do-retry" says what the work is, "team-up-auditor-tinker" says who was in it), and the
// fallback from the handles when it gave none. `taken` says which channel names already exist, so two
// team-ups never collide; a suffix still has to fit the sidebar.
export function teamUpName(guests: { handle: string }[], taken: (name: string) => boolean = () => false, wanted?: string): string {
  const chosen = wanted ? fitTeamUpName(wanted) : ''
  const fallback = channelName(`team-up ${guests.map((g) => g.handle).join(' ')}`) || 'team-up'
  const base = chosen || fallback
  if (!taken(base)) return base
  for (let n = 2; n < 100; n++) {
    const tail = `-${n}`
    // A name the agent chose stays inside what the sidebar shows even with the suffix: the tail eats
    // into it, and a whole word goes before half of one does.
    const room = chosen ? cutTo(base, Math.max(1, TEAM_UP_NAME_MAX - tail.length)) || base.slice(0, 1) : base
    if (!taken(`${room}${tail}`)) return `${room}${tail}`
  }
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
