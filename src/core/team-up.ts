// A team-up is a normal channel opened by `pedir` or by a person's @ in a DM. These are only rules:
// naming, clipping and expiry. The runner orchestrates; this module holds no database.
import { L } from '../shared/lang'
import { channelName, TEAM_UP_CHARS, TEAM_UP_DAYS, TEAM_UP_MESSAGES, TEAM_UP_NAME_MAX, TEAM_UP_REUSE_MS, type TeamUp } from '../shared/types'

export const DAY_MS = 86_400_000 // a quiet day, in milliseconds
export const TEAM_UP_LINE = 900 // one long reply cannot take the whole carry budget
export const TEAM_UP_HEAD_ROOM = 500 // characters kept for the handoff's heading and labels
export { TEAM_UP_CHARS, TEAM_UP_DAYS, TEAM_UP_MESSAGES, TEAM_UP_NAME_MAX, TEAM_UP_REUSE_MS }

// Who an agent called in, and how long the room stays quiet before it closes. `days` 0 never expires.
// A new message refreshes the deadline through the conversation's last message time; see staleTeamUps.
export const teamUpDays = (set: number | undefined): number => (typeof set === 'number' && Number.isFinite(set) ? Math.max(0, Math.round(set)) : TEAM_UP_DAYS)

// Rooms with a team_up whose last message (the handoff when nobody answered) is old enough. A newer
// message pushes the deadline out. A room with a reply running is left out by the caller.
export function staleTeamUps(
  conversations: { id: string; teamUp?: { at: number } }[],
  lastAt: (id: string) => number | undefined,
  opts: { days: number; now?: number }
): string[] {
  const days = teamUpDays(opts.days)
  if (!days) return []
  const now = opts.now ?? Date.now()
  return conversations.filter((c) => !!c.teamUp && now - (lastAt(c.id) ?? c.teamUp!.at) >= days * DAY_MS).map((c) => c.id)
}

// The name an agent chose, cut to what fits beside an unread badge in the sidebar, on a word boundary.
function cutTo(slug: string, max: number): string {
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max)
  const brk = Math.max(cut.lastIndexOf('-'), cut.lastIndexOf('_'))
  const whole = brk >= 4 ? cut.slice(0, brk) : cut
  return whole.replace(/^[-_]+|[-_]+$/g, '')
}

export const fitTeamUpName = (wanted: string): string => cutTo(channelName(wanted).replace(/^[-_]+|[-_]+$/g, ''), TEAM_UP_NAME_MAX)

// The channel name: the agent's name when it gave one, a handle list otherwise. A collision gets -2,
// -3 and so on inside the same 22-character limit.
export function teamUpName(guests: { handle: string }[], taken: (name: string) => boolean, wanted?: string): string {
  const chosen = wanted ? fitTeamUpName(wanted) : ''
  const base = chosen || channelName(`team-up ${guests.map((g) => g.handle).join(' ')}`) || 'team-up'
  if (!taken(base)) return base
  for (let n = 2; n < 100; n++) {
    const tail = `-${n}`
    const room = chosen ? cutTo(base, Math.max(1, TEAM_UP_NAME_MAX - tail.length)) || base.slice(0, 1) : base
    if (!taken(`${room}${tail}`)) return `${room}${tail}`
  }
  return `${base}-${Date.now()}`
}

export const teamUpTopic = (by: string, source: string): string => L(`Aberto por ${by}, vindo de ${source}`, `Opened by ${by}, from ${source}`)

export interface Carried {
  name: string
  text: string
  at: number
}

// The newest messages that fit: at most TEAM_UP_MESSAGES, at most TEAM_UP_CHARS characters, each reply
// clipped. `left` counts what stayed in the source room so the reader knows the start is missing.
export function pickCarried(messages: Carried[]): { kept: Carried[]; left: number; chars: number } {
  const kept: Carried[] = []
  let room = TEAM_UP_CHARS - TEAM_UP_HEAD_ROOM
  for (let i = messages.length - 1; i >= 0 && kept.length < TEAM_UP_MESSAGES; i--) {
    const m = messages[i]!
    const text = m.text.trim()
    if (!text) continue
    const cut = text.length > TEAM_UP_LINE ? `${text.slice(0, TEAM_UP_LINE).trimEnd()}…` : text
    if (cut.length > room) break
    room -= cut.length
    kept.unshift({ ...m, text: cut })
  }
  return { kept, left: messages.length - kept.length, chars: TEAM_UP_CHARS - room }
}

// The handoff posted by the calling agent, in its own voice. The doer's request is written separately
// in the same agent's name with the existing DelegationRef and its "Pediu a" label.
export function carriedText(opts: { by: string; guests: string[]; source: string; messages: Carried[] }): string {
  const { by, guests, source, messages } = opts
  const { kept, left } = pickCarried(messages)
  const names = guests.join(L(' e ', ' and '))
  const head = L(`Trouxe para cá o que já foi feito em ${source} e chamei ${names}.`, `I brought over what was already done in ${source} and called ${names} in.`)
  const body = kept.map((m) => `**${m.name}** · ${m.text}`).join('\n\n')
  const more = left > 0 ? L(`\n\n_(mais ${left} mensagem${left === 1 ? '' : 's'} antes destas, em ${source})_`, `\n\n_(and ${left} message${left === 1 ? '' : 's'} before these, in ${source})_`) : ''
  return L(`${head}\n\n— ${source} —\n\n${body}${more}`, `${head}\n\n— ${source} —\n\n${body}${more}`)
}

// A private audience passes from a private DM into the room and from one room into the next.
export function inheritedAudience(source: { kind: 'channel' | 'dm'; owner?: string; teamUp?: TeamUp }, ownerId: string): string | undefined {
  return source.teamUp?.privateTo ?? (source.kind === 'dm' ? source.owner ?? ownerId : undefined)
}

// Is this the same caller, from the same source, with the same set of guests, inside the reuse window?
export const reusable = (up: TeamUp, from: string, by: string, guests: string[], now: number): boolean =>
  up.from === from && up.by === by && up.guests.length === guests.length && [...up.guests].sort().join(',') === [...guests].sort().join(',') && now - up.at <= TEAM_UP_REUSE_MS
