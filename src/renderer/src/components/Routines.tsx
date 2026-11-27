// Routines (spec §14, §17): requests for an agent that run on their own, at a
// time or when something happens (a new item in a connector, a call on the Mac).
// Two ways to see them: the week (the default), where every run sits at its own hour, and a light
// list that starts with what needs me.
import { L, lang, locale } from '../../../shared/lang'
import { nodeOf } from '../../../shared/node-link'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  agentById,
  checkTrigger,
  cleanTimes,
  dateAt,
  describeSchedule,
  isoDay,
  MAX_TIMES,
  nextRun,
  POLL_MINUTES,
  timesOf,
  toast,
  validTime,
  WEBHOOK_PORT,
  dmWith,
  navigate,
  removeRoutine,
  runRoutine,
  saveRoutine,
  useStore,
  type Agent,
  type Message,
  type Routine,
  type State,
  type RoutineInput,
  OK_STATUSES,
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
import { FAILED, failedWords, finished, firstLine, isOff, listSections, markOf, nextWords, routineWords, waitWords, WAITS, type Need, type Occ } from './routines-view'

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

// On or off from a list or the card; when the server refuses (a date that has passed), it says why.
const turn = (r: Routine, enabled: boolean): void => void saveRoutine({ ...r, enabled }).catch((e: unknown) => toast(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))

type View = 'week' | 'list'
// The way of seeing them picked last, kept while the app is open: the week, the first time.
let lastView: View = 'week'

export function RoutinesPage(): ReactNode {
  const routines = useStore((s) => s.routines)
  const agents = useStore((s) => s.agents.filter(isTeam))
  const runs = useStore(allRuns)
  const [view, setView] = useState<View>(lastView)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [week, setWeek] = useState(() => startOfWeek(Date.now()))
  const [open, setOpen] = useState<{ occ: Occ; rect: DOMRect } | null>(null)
  const [only, setOnly] = useState<string | null>(null)
  const [problems, setProblems] = useState(false)
  const [showOff, setShowOff] = useState(false)
  const now = useNow()

  const show = (v: View): void => {
    lastView = v
    setView(v)
    setOpen(null)
  }
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
  const fromExample = (ex: Example): void => {
    if (agents.length === 0) return
    setOpen(null)
    setDraft(blank({}, ex))
  }

  // ← → change the week, T comes back to this one (in the week), N creates, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]')
      if (draft || typing || e.metaKey || e.ctrlKey || e.altKey) return
      const inWeek = view === 'week'
      if (inWeek && e.key === 'ArrowLeft') setWeek((w) => shiftWeek(w, -1))
      else if (inWeek && e.key === 'ArrowRight') setWeek((w) => shiftWeek(w, 1))
      else if (inWeek && e.key.toLowerCase() === 't') setWeek(startOfWeek(Date.now()))
      else if (e.key.toLowerCase() === 'n') create()
      else if (e.key === 'Escape') setOpen(null)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const mine = (agentId: string): boolean => !only || only === agentId
  const days = Array.from({ length: 7 }, (_, i) => dayAt(week, i))
  const end = dayAt(week, 7)
  // A routine that's off keeps its place in the week; a deleted one leaves it with its runs.
  const occs = [...runs, ...planned(routines, week, now)].filter((o) => o.routine && o.at >= week && o.at < end)
  const grid = occs
  const failedHere = occs.filter((o) => !o.upcoming && o.status && FAILED.has(o.status) && mine(o.agentId)).length
  const onlyProblems = problems && failedHere > 0
  // Dimmed: another agent's (with one picked), or one that went fine while looking at what failed.
  const dim = (list: Occ[]): boolean => list.every((o) => !mine(o.agentId)) || (onlyProblems && !list.some((o) => markOf(o) === 'bad'))
  const watching = routines.filter((r) => r.enabled && r.trigger)
  const off = routines.filter((r) => !r.enabled && !finished(r))
  const people = agents.filter((a) => routines.some((r) => r.agentId === a.id))

  // Only the hours that have something, with some room, and at least a working day.
  const hours = grid.map((o) => new Date(o.at).getHours())
  if (now >= week && now < end) hours.push(new Date(now).getHours())
  let h0 = hours.length ? Math.max(0, Math.min(...hours) - 1) : 8
  let h1 = hours.length ? Math.min(24, Math.max(...hours) + 2) : 18
  if (h1 - h0 < 9) (h1 = Math.min(24, h0 + 9)), (h0 = Math.max(0, h1 - 9))

  const pick = (occ: Occ, rect: DOMRect): void => setOpen({ occ, rect })

  return (
    <Sheet
      fill
      title={L('Rotinas', 'Routines')}
      actions={
        <button className="btn btn--primary btn--sm" disabled={agents.length === 0} title={L('Nova rotina (N)', 'New routine (N)')} onClick={() => create()}>
          <Icon name="plus" size={14} /> {L('Nova rotina', 'New routine')}
        </button>
      }
    >
      <div className="rt-bar">
        <div className="segmented rt-bar__views" role="radiogroup" aria-label={L('Como ver', 'How to see them')}>
          {(
            [
              ['week', L('Semana', 'Week')],
              ['list', L('Lista', 'List')]
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-active' : ''} onClick={() => show(k)}>
              {label}
            </button>
          ))}
        </div>
        {view === 'week' && (
          <>
            <span className="rt-bar__range">{weekRange(week)}</span>
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
          </>
        )}
        <span className="grow" />
        {view === 'week' && failedHere > 0 && (
          <button
            className={`rt-failed ${onlyProblems ? 'is-on' : ''}`}
            aria-pressed={onlyProblems}
            title={onlyProblems ? L('Mostrar todas', 'Show all') : L('Destacar só as que falharam', 'Highlight only the ones that failed')}
            onClick={() => setProblems(!onlyProblems)}
          >
            <i />
            {failedHere === 1 ? L('1 falhou', '1 failed') : L(`${failedHere} falharam`, `${failedHere} failed`)}
            {onlyProblems && <Icon name="x" size={11} />}
          </button>
        )}
        {people.length > 1 && (
          <div className="rt-agent">
            <Select
              aria-label={L('Mostrar só as de um agente', "Filter routines by agent")}
              value={only ?? ''}
              onChange={(v) => setOnly(v || null)}
              options={[{ value: '', label: L('Todos os agentes', 'All agents') }, ...people.map((a) => ({ value: a.id, label: a.name }))]}
            />
          </div>
        )}
      </div>

      {view === 'week' ? (
        <>
          {watching.length > 0 && (
            <div className="cal-watch">
              <span className="cal-watch__label">{L('De olho, sem horário', "Event-triggered routines")}</span>
              {watching.map((r) => {
                const a = agents.find((x) => x.id === r.agentId)
                return (
                  <button
                    key={r.id}
                    className={`cal-watch__chip ${!mine(r.agentId) || onlyProblems ? 'is-dim' : ''}`}
                    onClick={(e) => pick({ key: `watch-${r.id}`, routine: r, name: r.name, agentId: r.agentId, at: 0, conversationId: r.conversationId }, e.currentTarget.getBoundingClientRect())}
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
            grid={grid}
            h0={h0}
            h1={h1}
            now={now}
            dim={dim}
            selected={open?.occ.key}
            empty={routines.length === 0}
            onPick={pick}
            onSlot={(day, time) => create({ schedule: { days: [new Date(day).getDay()], time } })}
            onExample={fromExample}
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
                    <Toggle on={r.enabled} onChange={(enabled) => turn(r, enabled)} />
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : (
        <RoutineList routines={routines.filter((r) => mine(r.agentId))} runs={runs} now={now} empty={routines.length === 0} onPick={pick} onEdit={(r) => (setOpen(null), setDraft({ ...r }))} onExample={fromExample} />
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

const HOUR = 56 // px per hour
const BLOCK = 34 // px, two lines: the name, then the agent and the time

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
// The next midnight: a day is 23 or 25 hours long when the clock changes.
const dayEnd = (d: number): number => dayAt(d, 1)
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
    out.push({ key: ask.id, routine: r, name: r?.name ?? ask.routine?.name ?? L('Rotina', 'Routine'), agentId, at: ask.at, conversationId: ask.conversationId, status: reply?.run?.status, replyId: reply?.id, reply })
  })
  return out
}

// What's still to come this week, from each routine's clock — the ones that are off too: a routine
// the person turned off keeps its place in the week, greyed, so it can be turned back on from its
// own panel. Only a deleted routine leaves the timetable.
function planned(routines: Routine[], week: number, now: number): Occ[] {
  const out: Occ[] = []
  for (const r of routines) {
    if (r.trigger) continue
    // A one-off (a date too) is at its next time; a repeating one, each time it falls in the week.
    // While it's off the core keeps no next time, so it is read from its own clock — unless it ran.
    const times: number[] = []
    if (r.schedule.once) {
      const at = r.nextAt ?? (r.lastAt ? undefined : nextRun(r.schedule, Math.max(week, now) - 1))
      if (at !== undefined) times.push(at)
    } else for (let t = nextRun(r.schedule, Math.max(week, now) - 1); t !== undefined && t < dayAt(week, 7); t = nextRun(r.schedule, t)) times.push(t)
    for (const t of times) if (t > now) out.push({ key: `${r.id}-${t}`, routine: r, name: r.name, agentId: r.agentId, at: t, conversationId: r.conversationId, upcoming: true })
  }
  return out
}

// A run's state in words, for a tick's or a block's tooltip.
const statusWords = (o: Occ): string => (o.upcoming ? (isOff(o) ? L('desligada', 'off') : L('vai rodar', 'will run')) : (o.status && LAST()[o.status]?.label) || '')

function Calendar({
  days,
  grid,
  h0,
  h1,
  now,
  dim,
  selected,
  empty,
  onPick,
  onSlot,
  onExample
}: {
  days: number[]
  grid: Occ[]
  h0: number
  h1: number
  now: number
  dim: (list: Occ[]) => boolean
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
  const occs = grid

  // A crowded hour grows taller (same for all seven days, so rows stay aligned) instead of
  // pushing its routines into the next hours. Extra room accrues at the end of the hour.
  const { offsets, total } = useMemo(() => {
    const n = h1 - h0
    const heights = Array.from({ length: n }, () => HOUR)
    for (const d of days) {
      const last = Array.from({ length: n }, () => -Infinity)
      for (const o of occs.filter((x) => x.at >= d && x.at < dayEnd(d)).sort((a, b) => a.at - b.at)) {
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
            <div key={d} className={`cal__day ${isToday ? 'is-today' : dayEnd(d) <= now ? 'is-past' : ''}`}>
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
            const list = occs.filter((o) => o.at >= d && o.at < dayEnd(d)).sort((a, b) => a.at - b.at)
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
                  const mark = markOf(o)
                  const live = mark === 'live'
                  const off = isOff(o)
                  return (
                    <button
                      key={o.key}
                      className={`cal__ev cal__ev--two ${o.upcoming ? '' : 'is-past'} ${live ? 'is-live' : ''} ${off ? 'is-off' : ''} ${selected === o.key ? 'is-selected' : ''} ${dim([o]) ? 'is-dim' : ''} c-${a?.color ?? 'graphite'}`}
                      style={{ ...(a ? ownColor(a) : {}), top }}
                      title={`${hm(o.at)} · ${o.name}${statusWords(o) ? ` · ${statusWords(o)}` : ''}`}
                      onMouseEnter={() => setGhost(null)}
                      onClick={(e) => onPick(o, e.currentTarget.getBoundingClientRect())}
                    >
                      <span className="cal__ev-top">
                        <strong>{o.name}</strong>
                        {(mark === 'ok' || mark === 'wait' || mark === 'bad') && <i className={`cal__mark is-${mark}`} />}
                      </span>
                      <span className="cal__ev-sub">
                        {a && <AgentAvatar agent={a} size={12} busy={live} />}
                        <span className="truncate">
                          {a ? `${a.name} · ` : ''}
                          {hm(o.at)}
                        </span>
                      </span>
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
            <Examples onExample={onExample} />
          </div>
        )}
      </div>
    </div>
  )
}

function Examples({ onExample }: { onExample: (ex: Example) => void }): ReactNode {
  return (
    <div>
      {EXAMPLES().map((ex) => (
        <button key={ex.name} onClick={() => onExample(ex)}>
          {ex.name} <span>{describeSchedule(ex)}</span>
        </button>
      ))}
    </div>
  )
}

// ---------- the list ----------

// Someone else's own routine, or the channel's for a member: seen, not changed here (the editor says why).
const mayChangeIn = (admin: boolean, you: string | undefined) => (r: Routine): boolean => admin || (r.scope !== 'channel' && (!r.owner || r.owner === you))

// What a row opens the card on: its last run, or the next one, or the routine itself.
const occOf = (r: Routine, last: Occ | undefined, next: number | undefined): Occ =>
  last ?? { key: next ? `${r.id}-${next}` : `routine-${r.id}`, routine: r, name: r.name, agentId: r.agentId, at: next ?? 0, conversationId: r.conversationId, upcoming: !!next }

// The card opens beside the name, not beside the whole row.
const nameRect = (e: React.MouseEvent<HTMLElement>): DOMRect => (e.currentTarget.querySelector('.rt-row__name') ?? e.currentTarget).getBoundingClientRect()

function RoutineList({
  routines,
  runs,
  now,
  empty,
  onPick,
  onEdit,
  onExample
}: {
  routines: Routine[]
  runs: Occ[]
  now: number
  empty: boolean
  onPick: (occ: Occ, rect: DOMRect) => void
  onEdit: (r: Routine) => void
  onExample: (ex: Example) => void
}): ReactNode {
  const agents = useStore((s) => s.agents)
  const connectors = useStore((s) => s.connectors)
  const admin = useStore(amAdmin)
  const you = useStore((s) => s.you)
  const mayChange = mayChangeIn(admin, you)
  const { needs, next, off } = useMemo(() => listSections(routines, runs, now), [routines, runs, now])
  // One problem is open at a time: the first, until another is picked (or it's closed).
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const expanded = picked === undefined ? needs[0]?.routine.id : picked
  const [showOff, setShowOff] = useState(false)

  const agentOf = (r: Routine): Agent | undefined => agents.find((a) => a.id === r.agentId)
  const words = (r: Routine): string => routineWords(r, r.trigger?.kind === 'poll' ? connectors.find((c) => c.id === (r.trigger as { connectorId: string }).connectorId)?.name : undefined)
  const who = (r: Routine): ReactNode => {
    const a = agentOf(r)
    return (
      <>
        {a ? <AgentAvatar agent={a} size={20} /> : <span className="rt-row__noavatar" />}
        <span className="rt-row__name">{r.name}</span>
        <span className="rt-row__sub">
          {a ? `${a.name} · ` : ''}
          {words(r)}
        </span>
      </>
    )
  }

  if (empty)
    return (
      <div className="rt-list">
        <div className="rt-empty">
          <strong>{L('Nenhuma rotina ainda.', 'No routines yet.')}</strong>
          <span>{L('Crie uma em “Nova rotina”, ou comece por um destes:', 'Create a routine with “New routine”, or start from one of these:')}</span>
          <Examples onExample={onExample} />
        </div>
      </div>
    )

  return (
    <div className="rt-list">
      <div className="rt-list__inner">
        {needs.length > 0 && (
          <section className="rt-sec">
            <h2 className="rt-sec__title">
              {L('Precisa de você', 'Needs you')} · {needs.length}
            </h2>
            {needs.map((n) => (
              <NeedRow key={n.routine.id} need={n} now={now} open={expanded === n.routine.id} mayChange={mayChange(n.routine)} who={who(n.routine)} onToggle={() => setPicked(expanded === n.routine.id ? null : n.routine.id)} onPick={onPick} />
            ))}
          </section>
        )}

        {(next.length > 0 || off.length > 0) && (
          <section className="rt-sec">
            {next.length > 0 && <h2 className="rt-sec__title">{L('Próximas', 'Coming up')}</h2>}
            {next.map(({ routine: r, next: at, last }) => {
              const live = last?.status === 'working'
              return (
                <div key={r.id} className="rt-row">
                  <button className="rt-row__open rt-open" onClick={(e) => onPick(occOf(r, last, at), nameRect(e))}>
                    {who(r)}
                    <span className="rt-row__last">{live ? L('rodando agora…', 'running now…') : last ? (last.reply?.text ? firstLine(last.reply.text) : statusWords(last)) : L('ainda não rodou', 'hasn’t run yet')}</span>
                  </button>
                  <span className="rt-row__acts">
                    {mayChange(r) && (
                      <button className="text-btn" disabled={live} onClick={() => runRoutine(r.id)}>
                        {L('Rodar agora', 'Run now')}
                      </button>
                    )}
                    <Toggle on={r.enabled} label={L(`Ligar ou desligar ${r.name}`, `Turn ${r.name} on or off`)} onChange={(enabled) => turn(r, enabled)} />
                  </span>
                  <span className={`rt-row__next ${r.trigger ? 'is-watch' : ''}`}>
                    {r.trigger ? (
                      <>
                        <i />
                        {L('de olho', 'watching')}
                      </>
                    ) : at ? (
                      nextWords(at, now)
                    ) : (
                      ''
                    )}
                  </span>
                </div>
              )
            })}
            {off.length > 0 && (
              <button className="text-btn rt-offbtn" aria-expanded={showOff} onClick={() => setShowOff(!showOff)}>
                {off.length === 1 ? L('1 desligada', '1 off') : L(`${off.length} desligadas`, `${off.length} off`)} <span className={showOff ? 'is-open' : ''}>›</span>
              </button>
            )}
            {showOff &&
              off.map((r) => (
                <div key={r.id} className="rt-row is-off">
                  <button className="rt-row__open rt-open" onClick={(e) => onPick(occOf(r, runs.filter((o) => o.routine?.id === r.id).at(-1), undefined), nameRect(e))}>
                    {who(r)}
                    <span className="rt-row__last" />
                  </button>
                  <span className="rt-row__acts is-shown">
                    <button className="text-btn" onClick={() => onEdit(r)}>
                      {L('Editar', 'Edit')}
                    </button>
                    {finished(r) ? <span className="rt-row__done">{L(`rodou ${when(r.lastAt!)}`, `ran ${when(r.lastAt!)}`)}</span> : <Toggle on={r.enabled} label={L(`Ligar ${r.name}`, `Turn ${r.name} on`)} onChange={(enabled) => turn(r, enabled)} />}
                  </span>
                </div>
              ))}
          </section>
        )}
      </div>
    </div>
  )
}

// A routine that failed or waits on me: what happened at the right; opened, why, and what to do.
function NeedRow({ need, now, open, mayChange, who, onToggle, onPick }: { need: Need; now: number; open: boolean; mayChange: boolean; who: ReactNode; onToggle: () => void; onPick: (occ: Occ, rect: DOMRect) => void }): ReactNode {
  const { routine: r, occ, kind, okSince } = need
  const failed = kind === 'failed'
  const later = okSince === 0 ? '' : okSince === 1 ? L(' Depois, rodou 1 vez normalmente.', ' After that, it ran once as usual.') : L(` Depois, rodou ${okSince} vezes normalmente.`, ` After that, it ran ${okSince} times as usual.`)
  const why = failed
    ? `${occ.reply?.run?.error ?? (occ.status === 'limit_reached' ? L('Parou no limite de uso do agente.', 'It stopped at the agent’s usage limit.') : L('Não deu certo, e não ficou dito por quê.', 'The run failed without reporting a reason.'))}${later}`
    : occ.status === 'waiting_input'
      ? L('Ela fez uma pergunta na conversa e está esperando a resposta.', 'It asked a question in the conversation and is waiting for the answer.')
      : L('Ela parou num passo que precisa da sua aprovação.', 'It stopped at a step that needs your approval.')
  const go = (): void => navigate({ kind: 'conversation', id: occ.conversationId, message: occ.replyId })
  return (
    <div className={`rt-need ${open ? 'is-open' : ''}`}>
      <button className="rt-row__open rt-need__head" aria-expanded={open} onClick={onToggle}>
        {who}
        <span className="grow" />
        <span className={`rt-need__what ${failed ? 'is-bad' : 'is-wait'}`}>
          <i />
          {failed ? failedWords(occ.at, now) : waitWords(occ.status)}
        </span>
      </button>
      {open && (
        <div className="rt-need__body">
          <p>{why}</p>
          <div className="rt-need__acts">
            {failed && mayChange && (
              <button className="btn btn--sm btn--primary" onClick={() => runRoutine(r.id)}>
                <Icon name="play" size={12} /> {L('Rodar agora', 'Run now')}
              </button>
            )}
            <button className={`btn btn--sm ${failed ? '' : 'btn--primary'}`} onClick={go}>
              {L('Abrir conversa', 'Open the conversation')}
            </button>
            <button className="icon-btn rt-more" title={L('Mais', 'More')} aria-label={L('Mais', 'More')} onClick={(e) => onPick(occ, e.currentTarget.getBoundingClientRect())}>
              •••
            </button>
          </div>
        </div>
      )}
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
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.cal__ev, .cal-watch__chip, .rt-open, .rt-more')) onClose()
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
        {r && !(r.schedule.once && !r.enabled && r.lastAt) && <Toggle on={r.enabled} onChange={(enabled) => turn(r, enabled)} />}
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
          <span>{isOff(occ) ? L('Desligada · rodaria', 'Off · would run') : L('Vai rodar', 'Will run')} {when(occ.at)}</span>
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
              className={h.status === 'working' ? 'is-live' : h.status && WAITS.has(h.status) ? 'is-wait' : h.status && OK_STATUSES.has(h.status) ? 'is-ok' : h.status ? 'is-bad' : ''}
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
  // Several times a day go with a week's days and a day of the month; once and a date run at one.
  const several = mode === 'week' || mode === 'month'
  const times = several ? timesOf(draft.schedule) : [draft.schedule.time]
  const repeat = (m: Repeat): void => {
    const time = draft.schedule.time
    const many = (m === 'week' || m === 'month') && draft.schedule.times ? { times: draft.schedule.times } : {}
    const schedule: Schedule =
      m === 'date'
        ? { days: [], time, once: true, date: isoDay(Date.now() + 86_400_000) }
        : m === 'month'
          ? { days: EVERY_DAY, time, ...many, monthDay: new Date().getDate() }
          : m === 'once'
            ? { days: EVERY_DAY, time, once: true }
            : { days: mode === 'week' ? days : WEEKDAYS, time, ...many }
    set({ schedule })
  }
  // The list as it's typed (put in order once a field is left); the first is also `time`.
  const setTimes = (list: string[]): void => set({ schedule: { ...draft.schedule, time: list[0] ?? '', times: list.length > 1 ? list : undefined } })
  // Once every one is a time: one left empty stays, and says so, rather than going quietly.
  const tidyTimes = (): void => {
    if (!times.every(validTime)) return
    const clean = cleanTimes(times)
    if (clean.length && clean.join() !== times.join()) setTimes(clean)
  }
  // A new time an hour after the last one, or the next free hour.
  const addTime = (): void => {
    const last = Number((times.at(-1) ?? '08:00').slice(0, 2))
    const min = (times.at(-1) ?? '08:00').slice(3, 5)
    for (let h = 1; h < 24; h++) {
      const next = `${String((last + h) % 24).padStart(2, '0')}:${min}`
      if (!times.includes(next)) return setTimes(cleanTimes([...times, next]))
    }
  }
  const repeated = times.filter((x, i) => times.indexOf(x) !== i)
  const timeError = !times.every(validTime)
    ? times.length > 1
      ? L('Preencha cada horário, ou tire o que sobrou.', 'Fill in each time, or remove the extra one.')
      : L('Escolha um horário.', 'Pick a time.')
    : repeated.length
      ? L('Esse horário já está na lista.', 'That time is already on the list.')
      : null
  const noDays = (mode === 'week' || mode === 'once') && days.length === 0
  const perWeek = days.length * times.length
  const past = mode === 'date' && !!draft.schedule.date && validTime(draft.schedule.time) && dateAt(draft.schedule.date, draft.schedule.time) <= Date.now()
  const toggleDay = (d: number): void => set({ schedule: { ...draft.schedule, days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d] } })
  // A lent computer isn't offered: a check that runs on its own would read it for someone else (core/routines.ts).
  const connectors = useStore((s) => s.connectors.filter((c) => !nodeOf(c.url) && c.tools.some((t) => t.cls === 'read' && t.enabled)))
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
      // Every time it has, even one: without them, the server would keep the ones it had.
      const schedule = draft.trigger ? draft.schedule : { ...draft.schedule, times: cleanTimes(timesOf(draft.schedule)) }
      const r = await saveRoutine({ ...draft, schedule, trigger: withArgs(draft.trigger), conversationId })
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
          <div className="routine-when">
            <div className="routine-when__row">
              <span className="routine-when__k">{L('Repete', 'Repeats')}</span>
              <div className="segmented" role="radiogroup" aria-label={L('Repetição', 'Repeat')}>
                {(
                  [
                    ['week', L('Toda semana', 'Every week')],
                    ['month', L('Todo mês', 'Monthly')],
                    ['once', L('Uma vez', 'Once')],
                    ['date', L('Numa data', 'On a date')]
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'is-active' : ''} onClick={() => repeat(k)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="routine-when__row">
              <span className="routine-when__k">{mode === 'date' ? L('Data', 'Date') : mode === 'month' ? L('Dia', 'Day') : L('Dias', 'Days')}</span>
              {mode === 'date' ? (
                <input
                  type="date"
                  aria-label={L('Data', 'Date')}
                  min={isoDay(Date.now())}
                  value={draft.schedule.date ?? ''}
                  onChange={(e) => e.target.value && set({ schedule: { ...draft.schedule, date: e.target.value, days: [new Date(dateAt(e.target.value, '12:00')).getDay()] } })}
                />
              ) : mode === 'month' ? (
                <div className="routine-when__pick">
                  <Select
                    value={String(draft.schedule.monthDay ?? 1)}
                    onChange={(v) => { if (v) set({ schedule: { ...draft.schedule, monthDay: Number(v) } }) }}
                    options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: L(`Dia ${i + 1}`, `Day ${i + 1}`) }))}
                    placeholder={L('Escolha um dia', 'Pick a day')}
                  />
                </div>
              ) : (
                <>
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
                </>
              )}
            </div>
            <div className="routine-when__row">
              <span className="routine-when__k">{L('Às', 'At')}</span>
              <div className="time-pills" role="group" aria-label={times.length > 1 ? L('Horários', 'Times') : L('Horário', 'Time')}>
                {times.map((time, i) => (
                  <span key={i} className={`time-pill ${!validTime(time) || repeated.includes(time) ? 'is-bad' : ''}`}>
                    <input
                      type="time"
                      required
                      aria-label={times.length > 1 ? L(`Horário ${i + 1}`, `Time ${i + 1}`) : L('Horário', 'Time')}
                      value={time}
                      onChange={(e) => setTimes(times.map((x, j) => (j === i ? e.target.value : x)))}
                      onBlur={tidyTimes}
                    />
                    {times.length > 1 && (
                      <button type="button" className="time-pill__x" title={L('Tirar este horário', 'Remove this time')} aria-label={L(`Tirar ${time}`, `Remove ${time}`)} onClick={() => setTimes(times.filter((_, j) => j !== i))}>
                        <Icon name="x" size={12} />
                      </button>
                    )}
                  </span>
                ))}
                {several && times.length < MAX_TIMES && (
                  <button type="button" className="time-pills__add" onClick={addTime}>
                    {L('+ horário', '+ time')}
                  </button>
                )}
              </div>
            </div>
            <p className={`routine-when__sum ${timeError || past || noDays ? 'is-bad' : ''}`} role={timeError || past ? 'alert' : undefined}>
              {timeError ? (
                timeError
              ) : past ? (
                L('Essa data já passou: escolha um dia e horário que ainda vão chegar.', 'That date has already passed: pick a day and time still to come.')
              ) : noDays ? (
                L('Escolha pelo menos um dia.', 'Pick at least one day.')
              ) : (
                <>
                  <b>{describeSchedule(draft.schedule)}</b>
                  {' · '}
                  {mode === 'week' && perWeek > 1
                    ? L(`${perWeek} vezes por semana, na hora do seu computador.`, `${perWeek} times a week, on your computer’s clock.`)
                    : mode === 'once'
                      ? L('No próximo dia marcado em que o horário ainda não passou. Depois, desliga sozinha.', 'Runs once at the next scheduled time on a selected day, then turns itself off.')
                      : mode === 'date'
                        ? L('Roda uma vez e desliga sozinha.', 'Runs once, then turns itself off.')
                        : mode === 'month'
                          ? L('Num mês sem esse dia, roda no último.', 'In shorter months, runs on the last day of the month.')
                          : L('Na hora do seu computador.', 'On your computer’s clock.')}
                </>
              )}
            </p>
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
                : L('Se o app estiver fechado no horário, roda quando abrir (até 12 h depois).', 'If the app is closed at that time, it runs when it opens (up to 12 h later).')}
          </span>
          <div className="row">
            {error && <span className="field__error">{error}</span>}
            <button className="btn btn--sm btn--ghost" onClick={onClose}>
              {L('Cancelar', 'Cancel')}
            </button>
            <button className="btn btn--sm btn--primary" disabled={locked || saving || !draft.name.trim() || !draft.prompt.trim() || (!t && (noDays || !!timeError)) || (!t && past && draft.enabled) || (t?.kind === 'poll' && (!!argsError || !t.tool))} onClick={() => void save()}>
              {draft.id ? L('Salvar', 'Save') : L('Criar rotina', 'Create routine')}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
