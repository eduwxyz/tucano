import { L, lang, locale } from '../../../shared/lang'
import { examples, type AvatarDefinition } from 'open-bot-avatar'
import { mountAvatar, type AvatarOptions, type MountedAvatar } from 'open-bot-avatar/dom'
import { useEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react'
import type { Agent, AgentColor } from '../store'
import gallery from '../assets/bot-avatars.json'

const PATHS: Record<string, ReactNode> = {
  hash: <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  at: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  mic: <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5L5 20" />
    </>
  ),
  check: <path d="m5 12 5 5L20 7" />,
  copy: (
    <>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  caret: <path d="m6 9 6 6 6-6" />,
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  plug: <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  send: <path d="M4 12 20 4l-6 16-3-7-7-1Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4Z" />,
  book: <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15ZM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  terminal: <path d="m5 7 5 5-5 5M12 17h7" />,
  zap: <path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="M7 4v16l13-8L7 4Z" />,
  report: <path d="M4 20V4M4 20h16M8 16l4-5 3 3 5-6" />,
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18.5h2" />
    </>
  ),
  layers: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  clip: <path d="m21 11.5-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  laptop: <path d="M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1-1ZM2 19h20" />,
  pointer: <path d="m5 3 14 7-6 2-2 6L5 3Z" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  keyboard: <path d="M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7ZM7 10h.01M11 10h.01M15 10h.01M8 14h8" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  hand: <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15.5a1.6 1.6 0 0 1 2.6-1.8L8 16" />,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </>
  ),
  volume: <path d="M4 9v6h4l5 4V5L8 9H4ZM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  archive: <path d="M3 4h18v4H3V4ZM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />,
  thread: <path d="M4 5h16v11H10l-4 4v-4H4V5ZM8 9h8M8 12h5" />,
  ask: <path d="M4 5h16v11H10l-4 4v-4H4V5ZM10 8.6a2 2 0 0 1 3.9.6c0 1.4-1.9 1.7-1.9 3M12 14.2h.01" />
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactNode {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  )
}

// The Tuca wears the app's own toucan: he belongs to the app, not to the team.
// busy: his lower beak goes while he works; happy: one squint when he's done.
export function TucaMark({ size = 32, busy, happy }: { size?: number; busy?: boolean; happy?: boolean }): ReactNode {
  return (
    <svg className={`avatar avatar--tuca ${busy ? 'is-busy' : ''} ${happy ? 'is-happy' : ''}`} width={size} height={size} viewBox="0 0 100 100" aria-label="Tuca">
      <defs>
        <clipPath id="tuca-clip">
          <rect width="100" height="100" rx="28" />
        </clipPath>
      </defs>
      <g clipPath="url(#tuca-clip)">
        <rect width="100" height="100" fill="#F1ECE2" />
        <circle cx="27" cy="73" r="48" fill="#121212" />
        <g className="tuca__eye">
          <circle cx="38" cy="47" r="14" fill="#fff" />
          <circle cx="43" cy="47" r="5.5" fill="#121212" />
        </g>
        <path className="tuca__jaw" d="M53 57 L95 57 Q86 70 53 71 Z" fill="#E5531F" />
        <path d="M53 24 Q84 25 93 44 L96 57 L53 57 Z" fill="#FF8C24" />
        <path d="M83 57 A9 12 0 0 1 97 47 L97 57 Z" fill="#121212" />
      </g>
    </svg>
  )
}

// True for `ms` right after `on` goes from true to false (a run just ended), never on
// mount: the cue for a small "done" moment, which then goes back to rest.
export function useJustEnded(on: boolean, ms: number): boolean {
  const was = useRef(on)
  const [ended, setEnded] = useState(false)
  useEffect(() => {
    const fell = was.current && !on
    was.current = on
    setEnded(fell)
    if (!fell) return
    const t = setTimeout(() => setEnded(false), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return ended
}

// The toucan asleep: an empty page with nothing waiting. The z's drift up.
export function SleepingToucan({ size = 120 }: { size?: number }): ReactNode {
  return (
    <svg className="sleeping-toucan" width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <rect x="20" y="56" width="96" height="96" rx="30" fill="#1d1a16" />
      <path d="M102 78 C 132 62, 172 66, 190 92 C 193 97, 190 103, 184 104 C 160 108, 130 114, 106 124 C 100 110, 98 92, 102 78 Z" fill="#FF8C24" />
      <path d="M106 103 C 130 101, 160 99, 186 100 C 175 104, 140 110, 106 124 Z" fill="#E5531F" />
      <path d="M190 92 C 193 97, 190 103, 184 104 C 179 104.8, 175 105.4, 171 106 C 175 99, 182 93, 190 92 Z" fill="#1d1a16" />
      <path d="M51 98 C 55 103, 61 103, 65 98" stroke="#fff" strokeWidth="4" strokeLinecap="round" fill="none" />
      <path d="M75 98 C 79 103, 85 103, 89 98" stroke="#fff" strokeWidth="4" strokeLinecap="round" fill="none" />
      <text className="sleeping-toucan__z" x="112" y="58" fontSize="22" fontWeight="600">z</text>
      <text className="sleeping-toucan__z sleeping-toucan__z--2" x="128" y="40" fontSize="30" fontWeight="600">z</text>
    </svg>
  )
}

// An agent's own color, over its class's, wherever the agent's color shows.
export const ownColor = (agent: Partial<Pick<Agent, 'customColor'>>): CSSProperties => (agent.customColor ? ({ '--agent': agent.customColor } as CSSProperties) : {})

// The drawn characters an agent can take (Open Bot Avatar's starters and gallery, MIT).
export const AVATARS: AvatarDefinition[] = [...examples, ...(gallery as AvatarDefinition[])]

// The eight colors as the drawn avatar takes them (it wants #rrggbb, not a CSS variable).
const HEX: Record<AgentColor, string> = { sky: '#3b9eea', indigo: '#5b6cf0', violet: '#8b5cf6', rose: '#e5557a', amber: '#e3a008', green: '#22a35a', teal: '#14a3a3', graphite: '#5d6470' }

// A drawn avatar. Big ones and busy ones move (busy: thinking); the rest are one still SVG,
// so a long chat stays light. The biggest follow the pointer with their eyes.
function DrawnAvatar({ definition, color, size, busy, happy }: { definition: AvatarDefinition; color: string; size: number; busy?: boolean; happy?: boolean }): ReactNode {
  const host = useRef<HTMLSpanElement>(null)
  const avatar = useRef<MountedAvatar | null>(null)
  const options: AvatarOptions = { definition, color, mood: busy ? 'thinking' : happy ? 'happy' : 'idle', still: size < 40 && !busy && !happy, followPointer: size >= 64, label: '' }
  useEffect(() => {
    avatar.current = mountAvatar(host.current!, options)
    return () => avatar.current?.destroy()
  }, [])
  useEffect(() => avatar.current?.update(options), [definition, color, options.mood, options.still, options.followPointer])
  return <span ref={host} className="avatar__drawn" />
}

// busy: the eyes read, left to right, while the agent works. Otherwise they blink now and then.
// Right after the work ends, one happy squint. A picture wins over a drawn avatar, and both over the face.
export function AgentAvatar({ agent, size = 32, busy }: { agent: Pick<Agent, 'name' | 'color'> & Partial<Pick<Agent, 'kind' | 'customColor' | 'picture' | 'avatar'>>; size?: number; busy?: boolean }): ReactNode {
  const happy = useJustEnded(!!busy, 600)
  if (agent.kind === 'tuca') return <TucaMark size={size} busy={busy} happy={happy} />
  if (!agent.picture && agent.avatar)
    return (
      <span className="avatar avatar--drawn" style={{ width: size, height: size }}>
        <DrawnAvatar definition={agent.avatar} color={agent.customColor ?? HEX[agent.color]} size={size} busy={busy} happy={happy} />
        <span className="sr-only">{agent.name}</span>
      </span>
    )
  return (
    <span className={`avatar avatar--agent c-${agent.color} ${busy ? 'is-busy' : ''} ${happy ? 'is-happy' : ''}`} style={{ width: size, height: size, fontSize: size * 0.42, ...ownColor(agent) }}>
      {agent.picture ? (
        <img className="avatar__photo" src={agent.picture} alt="" />
      ) : (
        <span className="avatar__eyes" aria-hidden>
          <i />
          <i />
        </span>
      )}
      <span className="sr-only">{agent.name}</span>
    </span>
  )
}

export function MeAvatar({ initials, size = 32 }: { initials: string; size?: number }): ReactNode {
  return (
    <span className="avatar avatar--me" style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {initials}
    </span>
  )
}

export const usd = (v: number): string =>
  v < 0.01 && v > 0 ? `US$ ${v.toLocaleString(locale(), { minimumFractionDigits: 4, maximumFractionDigits: 4 })}` : `US$ ${v.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const tokens = (n: number): string =>
  n >= 1_000_000
    ? n >= 1_000_000_000
      ? `${(n / 1_000_000_000).toLocaleString(locale(), { maximumFractionDigits: 2 })}${L(' bi', 'B')}`
      : `${(n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 2 })}${L(' mi', 'M')}`
    : n >= 1000
      ? `${(n / 1000).toLocaleString(locale(), { maximumFractionDigits: n >= 100_000 ? 0 : 1 })}k`
      : String(n)

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)} min ${s % 60}s`
}

// Monday 00:00 of the week `t` is in, and the Monday `n` weeks away.
export const startOfWeek = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}
export const shiftWeek = (week: number, n: number): number => {
  const d = new Date(week)
  d.setDate(d.getDate() + 7 * n)
  return d.getTime()
}
// "26 de out a 1 de novembro", "19 a 25 de outubro"; "Oct 26 – Nov 1", "October 19 – 25"
export function weekRange(week: number): string {
  const last = new Date(shiftWeek(week, 1) - 86_400_000)
  const first = new Date(week)
  const f = (d: Date, o: Intl.DateTimeFormatOptions): string => d.toLocaleDateString(locale(), o).replace('.', '')
  const sameMonth = first.getMonth() === last.getMonth()
  if (lang() === 'en') return sameMonth ? `${f(first, { month: 'long', day: 'numeric' })} – ${f(last, { day: 'numeric' })}` : `${f(first, { month: 'short', day: 'numeric' })} – ${f(last, { month: 'short', day: 'numeric' })}`
  return `${f(first, { day: 'numeric' })}${!sameMonth ? ` de ${f(first, { month: 'short' })}` : ''} a ${f(last, { day: 'numeric', month: 'long' })}`
}

// "agora", "há 5 min", "ontem", "há 3 dias"; older than a month, the date.
export function ago(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return L('agora', 'just now')
  if (min < 60) return L(`há ${min} min`, `${min} min ago`)
  const h = Math.round(min / 60)
  if (h < 24) return L(`há ${h} h`, `${h} h ago`)
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 1) return L('ontem', 'yesterday')
  if (days < 7) return L(`há ${days} dias`, `${days} days ago`)
  const weeks = Math.round(days / 7)
  if (days < 30) return L(`há ${weeks} semana${weeks > 1 ? 's' : ''}`, `${weeks} week${weeks > 1 ? 's' : ''} ago`)
  return new Date(at).toLocaleDateString(locale(), { day: '2-digit', month: 'short' }).replace('.', '')
}

export function time(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const hm = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return hm
  return `${d.toLocaleDateString(locale(), { day: '2-digit', month: 'short' })} · ${hm}`
}

export function UsageBar({ used, limit }: { used: number; limit: number }): ReactNode {
  // No limit draws an empty bar: a full red one reads as "already spent it all".
  const unlimited = !(limit > 0)
  const pct = unlimited ? 0 : Math.min(100, (used / limit) * 100)
  const tone = unlimited ? 'ok' : pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : 'ok'
  return (
    <span
      className={`budget budget--${tone}`}
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(unlimited ? { 'aria-valuetext': L('sem limite', 'no limit') } : {})}
    >
      <span className="budget__fill" style={{ transform: `scaleX(${pct / 100})` }} />
    </span>
  )
}

// A number field that holds the text while you type it: on its own, an emptied
// input hands back '' and Number('') is 0, so the field refills with 0 and you
// can't type over it. The number goes out on every keystroke that parses.
export function NumberInput({ value, onChange, ...rest }: { value: number; onChange: (n: number) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>): ReactNode {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      type="number"
      {...rest}
      value={text ?? String(value)}
      onFocus={() => setText(String(value))}
      onBlur={() => setText(null)}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n)
      }}
    />
  )
}
