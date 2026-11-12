// Routines (spec §14, §17): requests for an agent that run on their own, at a
// time or when something happens (a new item in a connector, a call on the Mac).
import { L, lang, locale } from '../../../shared/lang'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  agentById,
  checkTrigger,
  dateAt,
  describeSchedule,
  isoDay,
  nextRun,
  POLL_MINUTES,
  WEBHOOK_PORT,
  dmWith,
  navigate,
  removeRoutine,
  runRoutine,
  saveRoutine,
  useStore,
  type Message,
  type Routine,
  type State,
  type RoutineInput,
  type RunStatus,
  type Schedule,
  type Trigger,
  isTeam,
  amAdmin,
  personById,
  teamMode,
  watchRoutine
} from '../store'
import { AdminOnly } from './People'
import { Card, Field, Sheet, Toggle } from './Pages'
import { AgentAvatar, Icon, ownColor, shiftWeek, startOfWeek, weekRange } from './ui'
import { Modal } from './Modal'
import { Select } from './Select'

const DAYS = (): string[] => (lang() === 'en' ? ['S', 'M', 'T', 'W', 'T', 'F', 'S'] : ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'])
const DAY_NAMES = (): string[] => (lang() === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'])
const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

type Example = { name: string; prompt: string; days: number[]; time: string }
const EXAMPLES = (): Example[] => [
  {
    name: L('Bom dia', 'Good morning'),
    prompt: L('Me dá um resumo do que está aberto no Linear pra mim: o que venceu, o que vence hoje e o que está parado há mais de uma semana.', 'Give me a summary of what’s open for me in Linear: what’s overdue, what’s due today and what’s been stuck for over a week.'),
    days: WEEKDAYS,
    time: '09:00'
  },
  {
    name: L('Fechamento da semana', 'Week wrap-up'),
    prompt: L('Resume o que a gente fez nesta semana nesta conversa: decisões, o que ficou pendente e o que eu deveria olhar segunda.', 'Sum up what we did this week in this conversation: decisions, what’s still pending and what I should look at on Monday.'),
    days: [5],
    time: '17:00'
  },
  {
    name: L('Notícias de IA', 'AI news'),
    prompt: L('Tira um print da página inicial do news.ycombinator.com e me diz as 5 notícias sobre IA ou agentes que valem meu tempo, com o porquê em uma linha.', 'Take a screenshot of the news.ycombinator.com front page and tell me the 5 stories about AI or agents worth my time, with why in one line.'),
    days: EVERY_DAY,
    time: '08:30'
  }
]

const LAST = (): Partial<Record<RunStatus, { label: string; tone: string }>> => ({
  working: { label: L('rodando agora', 'running now'), tone: 'is-live' },
  done: { label: L('respondeu', 'replied'), tone: 'is-ok' },
  waiting_approval: { label: L('esperando aprovação', 'waiting for approval'), tone: 'is-warn' },
  waiting_input: { label: L('fez uma pergunta', 'asked a question'), tone: 'is-warn' },
  limit_reached: { label: L('parou no limite', 'stopped at the limit'), tone: 'is-danger' },
  failed: { label: L('falhou', 'failed'), tone: 'is-danger' },
  stopped: { label: L('interrompida', 'interrupted'), tone: '' },
  interrupted: { label: L('interrompida', 'interrupted'), tone: '' }
})

export const webhookUrl = (token: string, port = WEBHOOK_PORT): string => `http://127.0.0.1:${port}/gatilho/${token}`

// "Todo dia às 9h", "A cada 5 min, quando aparecer algo novo em Linear · list_issues"
export function describeRoutine(r: Pick<Routine, 'schedule' | 'trigger'>, connectorName?: string): string {
  const t = r.trigger
  if (!t) return describeSchedule(r.schedule)
  if (t.kind === 'webhook') return L('Quando chamada neste computador', 'When called on this computer')
  return L(`A cada ${t.everyMinutes} min, quando aparecer algo novo em ${connectorName ?? 'um conector'} · ${t.tool}`, `Every ${t.everyMinutes} min, when something new shows up in ${connectorName ?? 'a connector'} · ${t.tool}`)
}

// "hoje 9:00", "amanhã 9:00", "seg, 20/10 9:00"
export function when(at: number): string {
  const d = new Date(at)
  const hm = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toDateString()
  if (d.toDateString() === day(0)) return L(`hoje ${hm}`, `today ${hm}`)
  if (d.toDateString() === day(1)) return L(`amanhã ${hm}`, `tomorrow ${hm}`)
  if (d.toDateString() === day(-1)) return L(`ontem ${hm}`, `yesterday ${hm}`)
  return `${d.toLocaleDateString(locale(), { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '')} ${hm}`
}

type Repeat = 'week' | 'once' | 'date' | 'month'

type Draft = RoutineInput & { conversationId: string } // '' while the agent's DM doesn't exist yet: created on save

// A fresh copy to open in the form: same content, but no id (saves as new) and no owner (it's yours).
// It starts off, so it doesn't run next to the original until it's turned on; a webhook gets its own address on save.
export function duplicateDraft(r: Routine): Draft {
  return {
    name: `${r.name} ${L('(cópia)', '(copy)')}`,
    prompt: r.prompt,
    agentId: r.agentId,
    conversationId: r.conversationId,
    schedule: { ...r.schedule, days: [...r.schedule.days] },
    enabled: false,
    trigger: r.trigger?.kind === 'webhook' ? { kind: 'webhook', token: '' } : r.trigger ? { ...r.trigger } : undefined
  }
}

export function RoutinesPage(): ReactNode {
  const routines = useStore((s) => s.routines)
  const agents = useStore((s) => s.agents.filter(isTeam))
  const runs = useStore(allRuns)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [week, setWeek] = useState(() => startOfWeek(Date.now()))
  const [open, setOpen] = useState<{ occ: Occ; rect: DOMRect } | null>(null)
  const [only, setOnly] = useState<string | null>(null)
  const [showOff, setShowOff] = useState(false)
  const now = useNow()

  const blank = (patch: Partial<Draft> = {}, example?: Example): Draft => ({
    name: example?.name ?? '',
    prompt: example?.prompt ?? '',
    agentId: agents[0]?.id ?? '',
    conversationId: '',
    schedule: { days: example?.days ?? WEEKDAYS, time: example?.time ?? '09:00' },
    enabled: true,
    ...patch
  })
  const create = (patch: Partial<Draft> = {}): void => {
    if (agents.length === 0) return
    setOpen(null)
    setDraft(blank(patch))
  }

  // ← → change the week, T comes back to this one, N creates, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]')
      if (draft || typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft') setWeek((w) => shiftWeek(w, -1))
      else if (e.key === 'ArrowRight') setWeek((w) => shiftWeek(w, 1))
      else if (e.key.toLowerCase() === 't') setWeek(startOfWeek(Date.now()))
      else if (e.key.toLowerCase() === 'n') create()
      else if (e.key === 'Escape') setOpen(null)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const days = Array.from({ length: 7 }, (_, i) => dayAt(week, i))
  const end = dayAt(week, 7)
  const occs = [...runs, ...planned(routines, week, now)].filter((o) => o.at >= week && o.at < end)
  const watching = routines.filter((r) => r.enabled && r.trigger)
  const finished = (r: Routine): boolean => !r.enabled && !!r.schedule.once && !!r.lastAt && !r.trigger
  const off = routines.filter((r) => !r.enabled && !finished(r))
  const people = agents.filter((a) => routines.some((r) => r.agentId === a.id))

  // Only the hours that have something, with some room, and at least a working day.
  const hours = occs.map((o) => new Date(o.at).getHours())
  if (now >= week && now < end) hours.push(new Date(now).getHours())
  let h0 = hours.length ? Math.max(0, Math.min(...hours) - 1) : 8
  let h1 = hours.length ? Math.min(24, Math.max(...hours) + 2) : 18
  if (h1 - h0 < 9) (h1 = Math.min(24, h0 + 9)), (h0 = Math.max(0, h1 - 9))

  const range = weekRange(week)
  const thisWeek = week === startOfWeek(now)

  return (
    <Sheet
      fill
      title={L('Rotinas', 'Routines')}
      lede={
        <>
          {range}
          {!thisWeek && (
            <>
              {' · '}
              <button className="text-btn" onClick={() => setWeek(startOfWeek(Date.now()))}>
                {L('voltar pra esta semana', 'back to this week')}
              </button>
            </>
          )}
        </>
      }
      actions={
        <>
          {people.length > 1 && (
            <div className="cal-people" role="group" aria-label={L('Mostrar só as de um agente', 'Show only one agent’s')}>
              {people.map((a) => (
                <button key={a.id} className={only === a.id ? 'is-on' : only ? 'is-dim' : ''} title={only === a.id ? L('Mostrar todas', 'Show all') : L(`Só as de ${a.name}`, `Only ${a.name}'s`)} onClick={() => setOnly(only === a.id ? null : a.id)}>
                  <AgentAvatar agent={a} size={22} />
                </button>
              ))}
            </div>
          )}
          <div className="cal-nav">
            <button title={L('Semana anterior (←)', 'Previous week (←)')} onClick={() => setWeek(shiftWeek(week, -1))}>
              <Icon name="back" size={14} />
            </button>
            <button title={L('Esta semana (T)', 'This week (T)')} onClick={() => setWeek(startOfWeek(Date.now()))}>
              {L('Hoje', 'Today')}
            </button>
            <button title={L('Próxima semana (→)', 'Next week (→)')} onClick={() => setWeek(shiftWeek(week, 1))}>
              <Icon name="back" size={14} />
            </button>
          </div>
          <button className="btn btn--primary btn--sm" disabled={agents.length === 0} title={L('Nova rotina (N)', 'New routine (N)')} onClick={() => create()}>
            <Icon name="plus" size={14} /> {L('Nova rotina', 'New routine')}
          </button>
        </>
      }
    >
      {watching.length > 0 && (
        <div className="cal-watch">
          <span className="cal-watch__label">{L('De olho, sem horário', 'Watching, no set time')}</span>
          {watching.map((r) => {
            const a = agents.find((x) => x.id === r.agentId)
            return (
              <button
                key={r.id}
                className={`cal-watch__chip ${only && only !== r.agentId ? 'is-dim' : ''}`}
                onClick={(e) => setOpen({ occ: { key: `watch-${r.id}`, routine: r, name: r.name, agentId: r.agentId, at: 0, conversationId: r.conversationId }, rect: e.currentTarget.getBoundingClientRect() })}
              >
                <i />
                {a && <AgentAvatar agent={a} size={15} />}
                {r.name}
              </button>
            )
          })}
        </div>
      )}

      <Calendar
        days={days}
        occs={occs}
        h0={h0}
        h1={h1}
        now={now}
        only={only}
        selected={open?.occ.key}
        empty={routines.length === 0}
        onPick={(occ, rect) => setOpen({ occ, rect })}
        onSlot={(day, time) => create({ schedule: { days: [new Date(day).getDay()], time } })}
        onExample={(ex) => agents.length > 0 && (setOpen(null), setDraft(blank({}, ex)))}
      />

      {off.length > 0 && (
        <footer className="cal-foot">
          <button className="text-btn" onClick={() => setShowOff(!showOff)}>
            {off.length === 1 ? L('1 rotina desligada', '1 routine off') : L(`${off.length} rotinas desligadas`, `${off.length} routines off`)} {showOff ? '▾' : '▸'}
          </button>
        </footer>
      )}
      {showOff && off.length > 0 && (
        <div className="cal-off">
          {off.map((r) => {
            const a = agents.find((x) => x.id === r.agentId)
            return (
              <div key={r.id} className="cal-off__row">
                {a && <AgentAvatar agent={a} size={18} />}
                <strong className="truncate">{r.name}</strong>
                <span className="muted small truncate">{describeRoutine(r)}</span>
                <span className="grow" />
                <button className="text-btn" onClick={() => setDraft({ ...r })}>
                  {L('Editar', 'Edit')}
                </button>
                <Toggle on={r.enabled} onChange={(enabled) => void saveRoutine({ ...r, enabled })} />
              </div>
            )
          })}
        </div>
      )}

      {open && <Popover occ={open.occ} rect={open.rect} now={now} onClose={() => setOpen(null)} onEdit={(r) => (setOpen(null), setDraft({ ...r }))} onDuplicate={(r) => (setOpen(null), setDraft(duplicateDraft(r)))} />}

      {draft && (
        <Modal title={draft.id ? L('Editar rotina', 'Edit routine') : L('Nova rotina', 'New routine')} variant="form" onClose={() => setDraft(null)}>
          <RoutineForm key={draft.id ?? 'new'} draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />
        </Modal>
      )}
    </Sheet>
  )
}

// ---------- the week ----------

const DAY = 86_400_000
const HOUR = 56 // px per hour
const BLOCK = 26 // px, one line

// One routine at one time: a run that happened (with how it went), or one still to come.
type Occ = { key: string; routine?: Routine; name: string; agentId: string; at: number; conversationId: string; status?: RunStatus; replyId?: string; upcoming?: boolean }

function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

const dayAt = (week: number, i: number): number => {
  const d = new Date(week)
  d.setDate(d.getDate() + i)
  return d.getTime()
}
const hm = (t: number): string => new Date(t).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })

// What actually ran: each request a routine posted, with the agent's reply after it. Worked out per
// conversation, once per change of it, so a reply elsewhere doesn't redo the calendar.
const runsCache = new WeakMap<Message[], { routines: Routine[]; occs: Occ[] }>()
function allRuns(s: State): Occ[] {
  return Object.values(s.messages).flatMap((list) => {
    const had = runsCache.get(list)
    if (had?.routines === s.routines) return had.occs
    const occs = runsOf(list, s.routines)
    runsCache.set(list, { routines: s.routines, occs })
    return occs
  })
}

// In one conversation's messages, oldest first.
function runsOf(messages: Message[], routines: Routine[]): Occ[] {
  const out: Occ[] = []
  messages.forEach((ask, i) => {
    if (ask.author.kind !== 'routine') return
    const id = ask.author.id
    const r = routines.find((x) => x.id === id)
    let reply: Message | undefined
    for (let j = i + 1; j < messages.length && !reply; j++) {
      const m = messages[j]!
      if (m.author.kind === 'agent' && (!r || m.author.id === r.agentId)) reply = m
    }
    const agentId = r?.agentId ?? (reply?.author.kind === 'agent' ? reply.author.id : undefined)
    if (!agentId) return
    out.push({ key: ask.id, routine: r, name: r?.name ?? ask.routine?.name ?? L('Rotina', 'Routine'), agentId, at: ask.at, conversationId: ask.conversationId, status: reply?.run?.status, replyId: reply?.id })
  })
  return out
}

// What's still to come this week, from each routine's clock.
function planned(routines: Routine[], week: number, now: number): Occ[] {
  const out: Occ[] = []
  for (const r of routines) {
    if (!r.enabled || r.trigger) continue
    // A one-off (a date too) is at its next time; a repeating one, each time it falls in the week.
    const times: number[] = []
    if (r.schedule.once) {
      if (r.nextAt) times.push(r.nextAt)
    } else for (let t = nextRun(r.schedule, Math.max(week, now) - 1); t !== undefined && t < dayAt(week, 7); t = nextRun(r.schedule, t)) times.push(t)
    for (const t of times) if (t > now) out.push({ key: `${r.id}-${t}`, routine: r, name: r.name, agentId: r.agentId, at: t, conversationId: r.conversationId, upcoming: true })
  }
  return out
}

function Calendar({
  days,
  occs,
  h0,
  h1,
  now,
  only,
  selected,
  empty,
  onPick,
  onSlot,
  onExample
}: {
  days: number[]
  occs: Occ[]
  h0: number
  h1: number
  now: number
  only: string | null
  selected?: string
  empty: boolean
  onPick: (occ: Occ, rect: DOMRect) => void
  onSlot: (day: number, time: string) => void
  onExample: (ex: Example) => void
}): ReactNode {
  const agents = useStore((s) => s.agents)
  const scroller = useRef<HTMLDivElement>(null)
  const [ghost, setGhost] = useState<{ day: number; min: number } | null>(null)
  const today = new Date(now).toDateString()

  // A crowded hour grows taller (same for all seven days, so rows stay aligned) instead of
  // pushing its routines into the next hours. Extra room accrues at the end of the hour.
  const { offsets, total } = useMemo(() => {
    const n = h1 - h0
    const heights = Array.from({ length: n }, () => HOUR)
    for (const d of days) {
      const last = Array.from({ length: n }, () => -Infinity)
      for (const o of occs.filter((x) => x.at >= d && x.at < d + DAY).sort((a, b) => a.at - b.at)) {
        const t = new Date(o.at)
        const i = t.getHours() - h0
        if (i < 0 || i >= n) continue
        const top = Math.max((t.getMinutes() / 60) * HOUR, (last[i] ?? -Infinity) + BLOCK + 2)
        last[i] = top
        heights[i] = Math.max(heights[i] ?? HOUR, Math.ceil(top + BLOCK + 2)) // whole pixels keep the hour lines sharp
      }
    }
    const offsets: number[] = []
    let sum = 0
    for (const h of heights) {
      offsets.push(sum)
      sum += h
    }
    return { offsets, total: sum }
  }, [days, occs, h0, h1])
  const y = (hour: number, minute: number): number => (offsets[Math.max(0, Math.min(offsets.length - 1, hour - h0))] ?? 0) + (minute / 60) * HOUR

  // Opens on the first thing of the week (or now, when the week is empty).
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const focus = occs.length ? Math.min(...occs.map((o) => new Date(o.at).getHours())) : days.some((d) => new Date(d).toDateString() === today) ? new Date(now).getHours() : h0
    el.scrollTop = Math.max(0, y(focus, 0) - 1.5 * HOUR)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]])

  const slot = (e: React.MouseEvent<HTMLDivElement>): number => {
    const py = e.clientY - e.currentTarget.getBoundingClientRect().top
    let row = offsets.length - 1
    while (row > 0 && (offsets[row] ?? 0) > py) row--
    const half = Math.min(1, Math.floor(((py - (offsets[row] ?? 0)) / HOUR) * 2))
    return Math.max(h0 * 60, Math.min(h1 * 60 - 30, (h0 + row) * 60 + half * 30))
  }
  const time = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

  return (
    <div className="cal">
      <div className="cal__days">
        <span />
        {days.map((d) => {
          const date = new Date(d)
          const isToday = date.toDateString() === today
          return (
            <div key={d} className={`cal__day ${isToday ? 'is-today' : d + DAY <= now ? 'is-past' : ''}`}>
              <span>{date.toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '')}</span>
              <b>{date.getDate()}</b>
            </div>
          )
        })}
      </div>
      <div className="cal__scroll" ref={scroller}>
        <div className="cal__grid" style={{ height: total }}>
          <div className="cal__hours">
            {Array.from({ length: h1 - h0 }, (_, i) => (
              <span key={i} style={{ top: offsets[i] }}>
                {String(h0 + i).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {days.map((d) => {
            const isToday = new Date(d).toDateString() === today
            const list = occs.filter((o) => o.at >= d && o.at < d + DAY).sort((a, b) => a.at - b.at)
            // Blocks closer than their height stack down under each other, but only inside their own hour (its row is tall enough).
            let bottom = -Infinity
            let rowHour = -1
            const placed = list.map((o) => {
              const t = new Date(o.at)
              if (t.getHours() !== rowHour) {
                rowHour = t.getHours()
                bottom = -Infinity
              }
              const top = Math.max(y(rowHour, t.getMinutes()), bottom + 2)
              bottom = top + BLOCK
              return { o, top }
            })
            return (
              <div
                key={d}
                className={`cal__col ${isToday ? 'is-today' : ''}`}
                onMouseMove={(e) => e.target === e.currentTarget && setGhost({ day: d, min: slot(e) })}
                onMouseLeave={() => setGhost(null)}
                onClick={(e) => e.target === e.currentTarget && onSlot(d, time(slot(e)))}
              >
                {offsets.map((top, i) => (
                  <div key={i} className="cal__line" style={{ top }} />
                ))}
                {ghost?.day === d && (
                  <div className="cal__ghost" style={{ top: y(Math.floor(ghost.min / 60), ghost.min % 60) }}>
                    <Icon name="plus" size={11} /> {time(ghost.min)}
                  </div>
                )}
                {placed.map(({ o, top }) => {
                  const a = agents.find((x) => x.id === o.agentId)
                  const live = o.status === 'working'
                  const ok = o.status && ['done', 'waiting_input', 'waiting_approval'].includes(o.status)
                  const bad = o.status && ['failed', 'limit_reached'].includes(o.status)
                  return (
                    <button
                      key={o.key}
                      className={`cal__ev ${o.upcoming ? '' : 'is-past'} ${live ? 'is-live' : ''} ${selected === o.key ? 'is-selected' : ''} ${only && only !== o.agentId ? 'is-dim' : ''} c-${a?.color ?? 'graphite'}`}
                      style={{ ...(a ? ownColor(a) : {}), top }}
                      title={`${hm(o.at)} · ${o.name}`}
                      onMouseEnter={() => setGhost(null)}
                      onClick={(e) => onPick(o, e.currentTarget.getBoundingClientRect())}
                    >
                      {a && <AgentAvatar agent={a} size={15} busy={live} />}
                      <span className="cal__ev-time">{hm(o.at)}</span>
                      <strong>{o.name}</strong>
                      {ok && (
                        <span className="cal__ev-ok">
                          <Icon name="check" size={11} />
                        </span>
                      )}
                      {bad && (
                        <span className="cal__ev-bad">
                          <Icon name="x" size={11} />
                        </span>
                      )}
                    </button>
                  )
                })}
                {isToday && now >= d && <div className="cal__now" style={{ top: y(new Date(now).getHours(), new Date(now).getMinutes()) }} />}
              </div>
            )
          })}
        </div>
        {empty && (
          <div className="cal__empty">
            <strong>{L('Clique num horário pra criar uma rotina.', 'Click a time slot to create a routine.')}</strong>
            <span>{L('Ou comece por um destes:', 'Or start from one of these:')}</span>
            <div>
              {EXAMPLES().map((ex) => (
                <button key={ex.name} onClick={() => onExample(ex)}>
                  {ex.name} <span>{describeSchedule(ex)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Hook({ token }: { token: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const port = useStore((s) => s.webhookPort)
  const cmd = `curl -d "${L('o que aconteceu', 'what happened')}" ${webhookUrl(token, port)}`
  return (
    <div className="row row--center routine__hook">
      <code className="small grow truncate">{cmd}</code>
      <button className="btn btn--xs" onClick={() => void navigator.clipboard.writeText(cmd).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
        {copied ? L('Copiado', 'Copied') : L('Copiar', 'Copy')}
      </button>
    </div>
  )
}

const OK = new Set<RunStatus>(['done', 'waiting_input', 'waiting_approval'])

// A routine's card, next to the block: what it does, how it's been going, and what to do with it.
function Popover({ occ, rect, now, onClose, onEdit, onDuplicate }: { occ: Occ; rect: DOMRect; now: number; onClose: () => void; onEdit: (r: Routine) => void; onDuplicate: (r: Routine) => void }): ReactNode {
  const r = useStore((s) => (occ.routine ? s.routines.find((x) => x.id === occ.routine!.id) : undefined))
  const agent = useStore((s) => agentById(s, occ.agentId))
  const conv = useStore((s) => s.conversations.find((c) => c.id === (r?.conversationId ?? occ.conversationId)))
  const history = useStore((s) => (r ? allRuns(s).filter((o) => o.routine?.id === r.id) : []))
  const connector = useStore((s) => (r?.trigger?.kind === 'poll' ? s.connectors.find((c) => c.id === (r.trigger as { connectorId: string }).connectorId) : undefined))
  const [confirm, setConfirm] = useState(false)
  // Someone else's own routine, or the channel's for a member: seen, not changed here (the editor says why).
  const mayChange = useStore((s) => !r || amAdmin(s) || (r.scope !== 'channel' && (!r.owner || r.owner === s.you)))
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Beside the block, inside the window; closes on a click elsewhere.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = rect.right + 10 + w < window.innerWidth - 12 ? rect.right + 10 : Math.max(12, rect.left - 10 - w)
    const top = Math.min(Math.max(12, rect.top - 12), window.innerHeight - h - 12)
    setPos({ left, top })
  }, [rect, occ.key])
  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.cal__ev, .cal-watch__chip')) onClose()
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [onClose])

  const live = occ.status === 'working' || history.at(-1)?.status === 'working'
  const where = conv?.kind === 'channel' ? `#${conv.name}` : 'DM'
  const status = occ.status ? LAST()[occ.status] : undefined
  const happened = !occ.upcoming && occ.at > 0
  const go = (o: { conversationId: string; replyId?: string }): void => (onClose(), navigate({ kind: 'conversation', id: o.conversationId, message: o.replyId }))

  return (
    <div ref={ref} className="cal-pop" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}>
      <div className="cal-pop__top">
        {agent && <AgentAvatar agent={agent} size={18} busy={live} />}
        <span className="truncate">
          {agent?.name ?? L('Agente', 'Agent')} · {where}
        </span>
        <span className="grow" />
        {r && !(r.schedule.once && !r.enabled && r.lastAt) && <Toggle on={r.enabled} onChange={(enabled) => void saveRoutine({ ...r, enabled })} />}
        <button className="icon-btn" title={L('Fechar (Esc)', 'Close (Esc)')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <h3>{occ.name}</h3>
      <p className="cal-pop__when">
        {happened ? (
          <span>
            {L('Rodou', 'Ran')} {when(occ.at)}
            {status && <span className={`cal-pop__status ${status.tone}`}> · {status.label}</span>}
          </span>
        ) : occ.upcoming ? (
          <span>{L('Vai rodar', 'Will run')} {when(occ.at)}</span>
        ) : null}
        {r && <span className="cal-pop__rule">{describeRoutine(r, connector?.name)}</span>}
        {!r && <span className="cal-pop__rule">{L('Esta rotina foi apagada.', 'This routine was deleted.')}</span>}
      </p>
      {r && <p className="cal-pop__prompt">{r.prompt}</p>}
      {r?.trigger?.kind === 'webhook' && <Hook token={r.trigger.token} />}
      {r?.trigger?.kind === 'poll' && r.trigger.error && (
        <p className="cal-pop__error" title={r.trigger.error}>
          {L(`Não deu pra ler o ${connector?.name ?? 'conector'}: confira se ele está conectado em Conectores.`, `Couldn’t read ${connector?.name ?? 'the connector'}: check that it’s connected in Connectors.`)}
          <span className="muted small"> ({r.trigger.error})</span>
        </p>
      )}
      {history.length > 0 && (
        <div className="cal-pop__runs">
          {history.slice(-14).map((h) => (
            <button
              key={h.key}
              className={h.status === 'working' ? 'is-live' : h.status && OK.has(h.status) ? 'is-ok' : h.status ? 'is-bad' : ''}
              title={`${when(h.at)}${h.status && LAST()[h.status] ? ` · ${LAST()[h.status]!.label}` : ''}`}
              onClick={() => go(h)}
            />
          ))}
          <span>{history.length === 1 ? L('rodou 1 vez', 'ran once') : L(`rodou ${history.length} vezes`, `ran ${history.length} times`)}</span>
        </div>
      )}
      <div className="cal-pop__acts">
        {confirm ? (
          <>
            <span className="small">{L(`Apagar “${occ.name}”? As respostas que ela já gerou ficam nas conversas.`, `Delete “${occ.name}”? The replies it already produced stay in the conversations.`)}</span>
            <span className="grow" />
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirm(false)}>
              {L('Cancelar', 'Cancel')}
            </button>
            <button className="btn btn--sm btn--danger" onClick={() => (r && removeRoutine(r.id), onClose())}>
              {L('Apagar', 'Delete')}
            </button>
          </>
        ) : (
          <>
            {r && mayChange && (
              <button className="btn btn--sm btn--primary" disabled={live} onClick={() => runRoutine(r.id)}>
                <Icon name="play" size={12} /> {L('Rodar agora', 'Run now')}
              </button>
            )}
            {(happened || history.length > 0) && (
              <button className="btn btn--sm" onClick={() => go(happened ? occ : history.at(-1)!)}>
                {happened ? L('Ver a resposta', 'See the reply') : L('Ver a última', 'See the last one')}
              </button>
            )}
            <span className="grow" />
            {r && (
              <>
                <button className="icon-btn" title={L('Duplicar', 'Duplicate')} onClick={() => onDuplicate(r)}>
                  <Icon name="copy" size={14} />
                </button>
                <button className="icon-btn" title={L('Editar', 'Edit')} onClick={() => onEdit(r)}>
                  <Icon name="edit" size={14} />
                </button>
                {mayChange && (
                  <button className="icon-btn" title={L('Apagar', 'Delete')} onClick={() => setConfirm(true)}>
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function RoutineForm({ draft, onChange, onClose }: { draft: Draft; onChange: (d: Draft) => void; onClose: () => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter(isTeam))
  const conversations = useStore((s) => s.conversations)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const agent = agents.find((a) => a.id === draft.agentId)
  // With a team: a routine is one's own ("só pra mim") or the channel's (admins make those, and
  // they tell only who asks to be told). Someone else's own routine is theirs (or an admin's) to change.
  const team = useStore(teamMode)
  const admin = useStore(amAdmin)
  const you = useStore((s) => s.you)
  const saved = draft.id ? (draft as Partial<Routine>) : undefined
  const ownerName = useStore((s) => personById(s, saved?.owner)?.name)
  const locked = team && !!saved && !admin && (saved.scope === 'channel' || (!!saved.owner && saved.owner !== you))
  const scope = draft.scope ?? 'me'
  const [watch, setWatch] = useState(() => !!saved?.watchers?.includes(you))
  const dm = conversations.find((c) => c.kind === 'dm' && c.name === draft.agentId)
  const channels = conversations.filter((c) => c.kind === 'channel' && c.members.includes(draft.agentId))
  // An empty or stale choice means the agent's DM.
  const target = channels.some((c) => c.id === draft.conversationId) ? draft.conversationId : ''
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch })
  const days = draft.schedule.days
  // How a routine at a time repeats: the days of each week, once, on a date, or a day of every month.
  const mode: Repeat = draft.schedule.date !== undefined ? 'date' : draft.schedule.monthDay !== undefined ? 'month' : draft.schedule.once ? 'once' : 'week'
  const repeat = (m: Repeat): void => {
    const time = draft.schedule.time
    const schedule: Schedule =
      m === 'date'
        ? { days: [], time, once: true, date: isoDay(Date.now() + 86_400_000) }
        : m === 'month'
          ? { days: EVERY_DAY, time, monthDay: new Date().getDate() }
          : m === 'once'
            ? { days: EVERY_DAY, time, once: true }
            : { days: mode === 'week' ? days : WEEKDAYS, time }
    set({ schedule })
  }
  const past = mode === 'date' && !!draft.schedule.date && dateAt(draft.schedule.date, draft.schedule.time || '00:00') <= Date.now()
  const toggleDay = (d: number): void => set({ schedule: { ...draft.schedule, days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d] } })
  const connectors = useStore((s) => s.connectors.filter((c) => c.tools.some((t) => t.cls === 'read' && t.enabled)))
  const t = draft.trigger
  const [argsText, setArgsText] = useState(t?.kind === 'poll' ? JSON.stringify(t.args, null, 1) : '{}')
  const [preview, setPreview] = useState<string | null>(null)
  const pollTrigger = (patch: Partial<Extract<Trigger, { kind: 'poll' }>> = {}): Trigger => {
    const c = connectors.find((x) => x.id === (patch.connectorId ?? (t?.kind === 'poll' ? t.connectorId : ''))) ?? connectors[0]
    const tools = c?.tools.filter((x) => x.cls === 'read' && x.enabled) ?? []
    const prev = t?.kind === 'poll' ? t : undefined
    const tool = tools.some((x) => x.name === (patch.tool ?? prev?.tool)) ? (patch.tool ?? prev!.tool) : (tools.find((x) => /list|search/.test(x.name))?.name ?? tools[0]?.name ?? '')
    return { kind: 'poll', connectorId: c?.id ?? '', tool, args: prev?.args ?? {}, everyMinutes: prev?.everyMinutes ?? 5, ...patch, ...(patch.connectorId ? { tool } : {}) }
  }
  let argsError = ''
  try {
    const parsed: unknown = JSON.parse(argsText || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) argsError = L('Use um objeto JSON, ex.: {"label": "agente"}', 'Use a JSON object, e.g. {"label": "agent"}')
  } catch {
    argsError = L('JSON inválido', 'Invalid JSON')
  }
  const withArgs = (x: Trigger | undefined): Trigger | undefined => (x?.kind === 'poll' && !argsError ? { ...x, args: JSON.parse(argsText || '{}') as Record<string, unknown> } : x)
  const test = (): void => {
    const x = withArgs(t)
    if (!x) return
    setPreview(L('Olhando…', 'Checking…'))
    const name = x.kind === 'poll' ? connectors.find((c) => c.id === x.connectorId)?.name : undefined
    checkTrigger(x).then(setPreview, (e: unknown) =>
      setPreview(
        `${L(`Não deu pra ler o ${name ?? 'conector'}: confira se ele está conectado em Conectores.`, `Couldn’t read ${name ?? 'the connector'}: check that it’s connected in Connectors.`)} (${e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)})`
      )
    )
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const conversationId = target || dm?.id || (await dmWith(draft.agentId))
      const r = await saveRoutine({ ...draft, trigger: withArgs(draft.trigger), conversationId })
      if (team && r.scope === 'channel' && watch !== !!r.watchers?.includes(you)) watchRoutine(r.id, watch)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agent-form routine-form">
      <Card title={draft.id ? L('Editar rotina', 'Edit routine') : L('Nova rotina', 'New routine')}>
        <div className="grid2">
          <Field label={L('Nome', 'Name')}>
            <input autoFocus value={draft.name} placeholder={L('Bom dia', 'Good morning')} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={L('Agente', 'Agent')}>
            <Select
              value={draft.agentId ?? null}
              onChange={(v) => { if (v) set({ agentId: v, conversationId: '' }) }}
              options={agents.map((a) => ({ value: a.id, label: a.name + (a.role ? ` · ${a.role}` : '') }))}
              placeholder={L('Escolha um agente', 'Pick an agent')}
            />
          </Field>
        </div>
        <Field label={L('O que fazer', 'What to do')} hint={L('Como você escreveria numa mensagem. Ele usa as ferramentas, os conectores e o computador que já tem.', 'As you’d write it in a message. It uses the tools, connectors and computer it already has.')}>
          <textarea rows={4} value={draft.prompt} placeholder={L('Ex.: Me dá um resumo do que está aberto no Linear pra mim.', 'E.g. Give me a summary of what’s open for me in Linear.')} onChange={(e) => set({ prompt: e.target.value })} />
        </Field>
        <Field group label={L('Quando roda', 'When it runs')}>
          <div className="segmented segmented--wide" role="radiogroup" aria-label={L('Quando roda', 'When it runs')}>
            {(
              [
                ['clock', L('Num horário', 'At a time')],
                ['poll', L('Quando aparece algo novo', 'When something new shows up')],
                ['webhook', L('Quando chamada neste computador', 'When called on this computer')]
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={(t?.kind ?? 'clock') === k}
                className={(t?.kind ?? 'clock') === k ? 'is-active' : ''}
                onClick={() => (setPreview(null), set({ trigger: k === 'clock' ? undefined : k === 'poll' ? pollTrigger() : { kind: 'webhook', token: '' } }))}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {t?.kind === 'poll' &&
          (connectors.length === 0 ? (
            <p className="hint">{L('Conecte um conector (Linear, GitHub, Gmail…) primeiro: a rotina olha uma ferramenta de leitura dele.', 'Connect a connector (Linear, GitHub, Gmail…) first: the routine checks one of its read tools.')}</p>
          ) : (
            <>
              <div className="grid2">
                <Field label={L('Conector', 'Connector')}>
                  <Select
                    value={t.connectorId ?? null}
                    onChange={(v) => { if (v) { setPreview(null); set({ trigger: pollTrigger({ connectorId: v }) }) } }}
                    options={connectors.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder={L('Escolha um conector', 'Pick a connector')}
                  />
                </Field>
                <Field label={L('Ferramenta de leitura', 'Read tool')}>
                  <Select
                    value={t.tool ?? null}
                    onChange={(v) => { if (v) { setPreview(null); set({ trigger: pollTrigger({ tool: v }) }) } }}
                    options={connectors.find((c) => c.id === t.connectorId)?.tools.filter((x) => x.cls === 'read' && x.enabled).map((x) => ({ value: x.name, label: x.name }))}
                    placeholder={L('Escolha uma ferramenta', 'Pick a tool')}
                  />
                </Field>
              </div>
              <div className="grid2">
                <Field label={L('Argumentos (JSON)', 'Arguments (JSON)')} hint={argsError || L('O filtro da busca, ex.: {"label": "agente", "state": "Todo"}.', 'The search filter, e.g. {"label": "agent", "state": "Todo"}.')}>
                  <textarea rows={2} className="mono" value={argsText} onChange={(e) => (setPreview(null), setArgsText(e.target.value))} />
                </Field>
                <Field label={L('Olhar a cada', 'Check every')}>
                  <Select
                    value={String(t.everyMinutes)}
                    onChange={(v) => { if (v) set({ trigger: pollTrigger({ everyMinutes: Number(v) }) }) }}
                    options={POLL_MINUTES.map((m) => ({ value: String(m), label: m < 60 ? `${m} min` : L('1 hora', '1 hour') }))}
                    placeholder={L('Escolha um intervalo', 'Pick an interval')}
                  />
                </Field>
              </div>
              <div className="row row--center routine-test">
                <button type="button" className="btn btn--sm" disabled={!!argsError || !t.tool} onClick={test}>
                  {L('Testar agora', 'Test now')}
                </button>
                {preview && <span className="small muted grow">{preview}</span>}
              </div>
            </>
          ))}
        {t?.kind === 'webhook' && (
          <p className="hint hint--text">
            {L('Depois de salvar, a rotina ganha um endereço neste computador (só ele mesmo acessa). Um script, um hook do git ou uma fase de build do Xcode chama com', 'Once saved, the routine gets an address on this computer (only the computer itself can reach it). A script, a git hook or an Xcode build phase calls it with')}{' '}
            <code>curl -d "{L('o que aconteceu', 'what happened')}" …</code>{L(', e o texto enviado chega pro agente.', ', and the text sent reaches the agent.')}
          </p>
        )}
        {!t && (
          <div className="grid2">
            <Field group label={mode === 'date' ? L('Data', 'Date') : mode === 'month' ? L('Dia do mês', 'Day of the month') : L('Dias', 'Days')}>
              <div className="segmented routine-once" role="radiogroup" aria-label={L('Repetição', 'Repeat')}>
                {(
                  [
                    ['week', L('Repete', 'Repeats')],
                    ['once', L('Uma vez', 'Once')],
                    ['date', L('Numa data', 'On a date')],
                    ['month', L('Todo mês', 'Monthly')]
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'is-active' : ''} onClick={() => repeat(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {mode === 'date' ? (
                <div className="row row--center routine-days">
                  <input
                    type="date"
                    aria-label={L('Data', 'Date')}
                    min={isoDay(Date.now())}
                    value={draft.schedule.date ?? ''}
                    onChange={(e) => e.target.value && set({ schedule: { ...draft.schedule, date: e.target.value, days: [new Date(dateAt(e.target.value, '12:00')).getDay()] } })}
                  />
                </div>
              ) : mode === 'month' ? (
                <div className="row row--center routine-days">
                  <Select
                    value={String(draft.schedule.monthDay ?? 1)}
                    onChange={(v) => { if (v) set({ schedule: { ...draft.schedule, monthDay: Number(v) } }) }}
                    options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: L(`Dia ${i + 1}`, `Day ${i + 1}`) }))}
                    placeholder={L('Escolha um dia', 'Pick a day')}
                  />
                </div>
              ) : (
              <div className="row row--center routine-days">
                <div className="days" role="group" aria-label={L('Dias da semana', 'Days of the week')}>
                  {DAYS().map((label, d) => (
                    <button key={d} type="button" title={DAY_NAMES()[d]} aria-pressed={days.includes(d)} className={days.includes(d) ? 'is-on' : ''} onClick={() => toggleDay(d)}>
                      {label}
                    </button>
                  ))}
                </div>
                <button type="button" className="link small" onClick={() => set({ schedule: { ...draft.schedule, days: WEEKDAYS } })}>
                  {L('seg a sex', 'Mon–Fri')}
                </button>
                <button type="button" className="link small" onClick={() => set({ schedule: { ...draft.schedule, days: EVERY_DAY } })}>
                  {L('todo dia', 'every day')}
                </button>
              </div>
              )}
            </Field>
            <Field label={L('Horário', 'Time')} hint={mode === 'once' ? L('No próximo dia marcado em que esse horário ainda não passou.', 'On the next checked day this time hasn’t passed yet.') : mode === 'month' ? L('Hora do seu computador. Num mês sem esse dia, roda no último.', 'Your computer’s time. In a month without that day, it runs on the last one.') : L('Hora do seu computador.', 'Your computer’s time.')}>
              <input type="time" value={draft.schedule.time} onChange={(e) => set({ schedule: { ...draft.schedule, time: e.target.value } })} />
            </Field>
          </div>
        )}
        {team && (
          <Field group label={L('De quem é', 'Whose it is')} hint={scope === 'channel' ? L('Do time: posta no canal e não avisa ninguém, a não ser quem pedir “me avise”.', 'The team’s: it posts in the channel and tells no one, except who asks “let me know”.') : L(`Sua: roda em seu nome${saved?.owner && saved.owner !== you && ownerName ? ` (de ${ownerName})` : ''} e avisa só você. As aprovações dizem “rotina de quem”.`, `Yours: it runs on your behalf${saved?.owner && saved.owner !== you && ownerName ? ` (${ownerName}'s)` : ''} and tells only you. Approvals say whose routine it is.`)}>
            <div className="segmented segmented--wide" role="radiogroup" aria-label={L('De quem é', 'Whose it is')}>
              <button type="button" role="radio" aria-checked={scope === 'me'} className={scope === 'me' ? 'is-active' : ''} disabled={locked} onClick={() => set({ scope: 'me' })}>
                {saved?.owner && saved.owner !== you && ownerName ? L(`Só pra ${ownerName}`, `Only for ${ownerName}`) : L('Só pra mim', 'Just for me')}
              </button>
              <button type="button" role="radio" aria-checked={scope === 'channel'} className={scope === 'channel' ? 'is-active' : ''} disabled={!admin || locked} onClick={() => set({ scope: 'channel', conversationId: target || channels[0]?.id || '' })}>
                {L('Do canal', 'The channel’s')}
              </button>
            </div>
          </Field>
        )}
        {team && !admin && !locked && <AdminOnly>{L('Só um admin cria rotinas do canal.', 'Only an admin creates channel routines.')}</AdminOnly>}
        <Field label={L('Onde postar', 'Where to post')}>
          <Select
            value={target ?? null}
            onChange={(v) => set({ conversationId: v ?? '' })}
            options={[
              ...(team && scope === 'channel' ? [] : [{ value: '', label: L(`DM com ${agent?.name ?? 'o agente'}`, `DM with ${agent?.name ?? 'the agent'}`) }]),
              ...channels.map((c) => ({ value: c.id, label: `#${c.name}` }))
            ]}
            placeholder={team && scope === 'channel' ? L('Escolha um canal', 'Pick a channel') : L(`DM com ${agent?.name ?? 'o agente'}`, `DM with ${agent?.name ?? 'the agent'}`)}
          />
        </Field>
        {team && scope === 'channel' && (
          <div className="key-row">
            <Icon name="volume" />
            <div className="grow">
              <strong>{L('Me avise', 'Let me know')}</strong>
              <p className="muted small">{L('Você recebe um aviso quando ela rodar. Só muda pra você.', 'You get a notice when it runs. It changes only for you.')}</p>
            </div>
            <Toggle on={watch} onChange={(v) => (setWatch(v), saved?.id && watchRoutine(saved.id, v))} />
          </div>
        )}
        {locked && <AdminOnly>{scope === 'channel' ? L('Só um admin muda as rotinas do canal. O que você muda aqui é só o “Me avise”, que vale só pra você.', 'Only an admin changes channel routines. All you can change here is “Let me know”, which is only for you.') : L(`Esta rotina é de ${ownerName ?? 'outra pessoa'}: só ela ou um admin muda.`, `This routine is ${ownerName ?? 'someone else'}'s: only they or an admin change it.`)}</AdminOnly>}
        <div className="row row--between">
          <span className="hint">
            {t?.kind === 'poll'
              ? L('O que já existe agora não dispara: ela roda uma vez pra cada item novo, um de cada vez. O agente recebe o item, marcado como vindo de fora.', 'What exists now doesn’t trigger it: it runs once per new item, one at a time. The agent gets the item, marked as coming from outside.')
              : t?.kind === 'webhook'
                ? L('Roda uma vez por chamada; se ainda estiver rodando, a chamada é recusada.', 'Runs once per call; if it’s still running, the call is refused.')
                : past
                  ? L('Essa data já passou: escolha um dia e horário que ainda vão chegar.', 'That date has already passed: pick a day and time still to come.')
                  : `${mode !== 'week' && mode !== 'once' ? `${describeSchedule(draft.schedule)}.` : days.length > 0 ? `${describeSchedule(draft.schedule)}.` : L('Escolha pelo menos um dia.', 'Pick at least one day.')}${draft.schedule.once ? L(' Depois de rodar, desliga sozinha.', ' After it runs, it turns itself off.') : ''}${L(' Se o app estiver fechado no horário, roda quando abrir (até 12 h depois).', ' If the app is closed at that time, it runs when it opens (up to 12 h later).')}`}
          </span>
          <div className="row">
            {error && <span className="field__error">{error}</span>}
            <button className="btn btn--sm btn--ghost" onClick={onClose}>
              {L('Cancelar', 'Cancel')}
            </button>
            <button className="btn btn--sm btn--primary" disabled={locked || saving || !draft.name.trim() || !draft.prompt.trim() || (!t && (mode === 'week' || mode === 'once') && days.length === 0) || (!t && past && draft.enabled) || (t?.kind === 'poll' && (!!argsError || !t.tool))} onClick={() => void save()}>
              {draft.id ? L('Salvar', 'Save') : L('Criar rotina', 'Create routine')}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
