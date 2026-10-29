// Routines (spec §14, §17): requests for an agent that run on their own, at a
// time or when something happens (a new item in a connector, a call on the Mac).
import { L, lang, locale } from '../../../shared/lang'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  agentById,
  checkTrigger,
  describeSchedule,
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
  type RoutineInput,
  type RunStatus,
  type Trigger,
  isTeam
} from '../store'
import { Card, Field, Sheet, Toggle } from './Pages'
import { AgentAvatar, Icon, shiftWeek, startOfWeek, weekRange } from './ui'

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

export const webhookUrl = (token: string): string => `http://127.0.0.1:${WEBHOOK_PORT}/gatilho/${token}`

// "Todo dia às 9h", "A cada 5 min, quando aparecer algo novo em Linear · list_issues"
function describeRoutine(r: Pick<Routine, 'schedule' | 'trigger'>, connectorName?: string): string {
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

type Draft = RoutineInput & { conversationId: string } // '' while the agent's DM doesn't exist yet: created on save

export function RoutinesPage(): ReactNode {
  const routines = useStore((s) => s.routines)
  const agents = useStore((s) => s.agents.filter(isTeam))
  const messages = useStore((s) => s.messages)
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
      if (draft && e.key === 'Escape') return setDraft(null)
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
  const occs = [...runsOf(messages, routines), ...planned(routines, week, now)].filter((o) => o.at >= week && o.at < end)
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

      {open && <Popover occ={open.occ} rect={open.rect} now={now} onClose={() => setOpen(null)} onEdit={(r) => (setOpen(null), setDraft({ ...r }))} />}

      {draft && (
        <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setDraft(null)}>
          <div className="form-modal">
            <RoutineForm key={draft.id ?? 'new'} draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />
          </div>
        </div>
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

// What actually ran: each request a routine posted, with the agent's reply after it.
function runsOf(messages: Message[], routines: Routine[]): Occ[] {
  const out: Occ[] = []
  messages.forEach((ask, i) => {
    if (ask.author.kind !== 'routine') return
    const id = ask.author.id
    const r = routines.find((x) => x.id === id)
    const reply = messages.slice(i + 1).find((m) => m.conversationId === ask.conversationId && m.author.kind === 'agent' && (!r || m.author.id === r.agentId))
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
    const at = (day: number): number => {
      const [h, m] = r.schedule.time.split(':').map(Number)
      const d = new Date(day)
      d.setHours(h ?? 0, m ?? 0, 0, 0)
      return d.getTime()
    }
    const times = r.schedule.once ? (r.nextAt ? [r.nextAt] : []) : Array.from({ length: 7 }, (_, i) => dayAt(week, i)).filter((d) => r.schedule.days.includes(new Date(d).getDay())).map(at)
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

  // Opens on the first thing of the week (or now, when the week is empty).
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const focus = occs.length ? Math.min(...occs.map((o) => new Date(o.at).getHours())) : days.some((d) => new Date(d).toDateString() === today) ? new Date(now).getHours() : h0
    el.scrollTop = Math.max(0, (focus - h0 - 1.5) * HOUR)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]])

  const slot = (e: React.MouseEvent<HTMLDivElement>): number => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top
    return Math.max(h0 * 60, Math.min(h1 * 60 - 30, h0 * 60 + Math.floor(y / (HOUR / 2)) * 30))
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
        <div className="cal__grid" style={{ height: (h1 - h0) * HOUR }}>
          <div className="cal__hours">
            {Array.from({ length: h1 - h0 }, (_, i) => (
              <span key={i} style={{ top: i * HOUR }}>
                {String(h0 + i).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {days.map((d) => {
            const isToday = new Date(d).toDateString() === today
            const list = occs.filter((o) => o.at >= d && o.at < d + DAY).sort((a, b) => a.at - b.at)
            // Blocks closer than their height slide down under each other; each still shows its time.
            let bottom = -Infinity
            const placed = list.map((o) => {
              const t = new Date(o.at)
              const top = Math.max((t.getHours() - h0 + t.getMinutes() / 60) * HOUR, bottom + 2)
              bottom = top + BLOCK
              return { o, top }
            })
            return (
              <div
                key={d}
                className={`cal__col ${isToday ? 'is-today' : ''}`}
                style={{ backgroundSize: `100% ${HOUR}px` }}
                onMouseMove={(e) => e.target === e.currentTarget && setGhost({ day: d, min: slot(e) })}
                onMouseLeave={() => setGhost(null)}
                onClick={(e) => e.target === e.currentTarget && onSlot(d, time(slot(e)))}
              >
                {ghost?.day === d && (
                  <div className="cal__ghost" style={{ top: (ghost.min / 60 - h0) * HOUR }}>
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
                      style={{ top }}
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
                {isToday && now >= d && <div className="cal__now" style={{ top: (new Date(now).getHours() - h0 + new Date(now).getMinutes() / 60) * HOUR }} />}
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
  const cmd = `curl -d "${L('o que aconteceu', 'what happened')}" ${webhookUrl(token)}`
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
function Popover({ occ, rect, now, onClose, onEdit }: { occ: Occ; rect: DOMRect; now: number; onClose: () => void; onEdit: (r: Routine) => void }): ReactNode {
  const r = useStore((s) => (occ.routine ? s.routines.find((x) => x.id === occ.routine!.id) : undefined))
  const agent = useStore((s) => agentById(s, occ.agentId))
  const conv = useStore((s) => s.conversations.find((c) => c.id === (r?.conversationId ?? occ.conversationId)))
  const history = useStore((s) => (r ? runsOf(s.messages, [r]).filter((o) => o.routine) : []))
  const connector = useStore((s) => (r?.trigger?.kind === 'poll' ? s.connectors.find((c) => c.id === (r.trigger as { connectorId: string }).connectorId) : undefined))
  const [confirm, setConfirm] = useState(false)
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
          {L('A última olhada falhou', 'The last check failed')}: {r.trigger.error}
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
            <span className="small">{L('Apagar a rotina?', 'Delete the routine?')}</span>
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
            {r && (
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
                <button className="icon-btn" title={L('Editar', 'Edit')} onClick={() => onEdit(r)}>
                  <Icon name="edit" size={14} />
                </button>
                <button className="icon-btn" title={L('Apagar', 'Delete')} onClick={() => setConfirm(true)}>
                  <Icon name="trash" size={14} />
                </button>
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
  const dm = conversations.find((c) => c.kind === 'dm' && c.name === draft.agentId)
  const channels = conversations.filter((c) => c.kind === 'channel' && c.members.includes(draft.agentId))
  // An empty or stale choice means the agent's DM.
  const target = channels.some((c) => c.id === draft.conversationId) ? draft.conversationId : ''
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch })
  const days = draft.schedule.days
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
    checkTrigger(x).then(setPreview, (e: unknown) => setPreview(`${L('Falhou', 'Failed')}: ${e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)}`))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const conversationId = target || dm?.id || (await dmWith(draft.agentId))
      await saveRoutine({ ...draft, trigger: withArgs(draft.trigger), conversationId })
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
            <select value={draft.agentId} onChange={(e) => set({ agentId: e.target.value, conversationId: '' })}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.role ? ` · ${a.role}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={L('O que fazer', 'What to do')} hint={L('Como você escreveria numa mensagem. Ele usa as ferramentas, os conectores e o computador que já tem.', 'As you’d write it in a message. It uses the tools, connectors and computer it already has.')}>
          <textarea rows={4} value={draft.prompt} placeholder={L('Ex.: Me dá um resumo do que está aberto no Linear pra mim.', 'E.g. Give me a summary of what’s open for me in Linear.')} onChange={(e) => set({ prompt: e.target.value })} />
        </Field>
        <Field label={L('Quando roda', 'When it runs')}>
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
                  <select value={t.connectorId} onChange={(e) => (setPreview(null), set({ trigger: pollTrigger({ connectorId: e.target.value }) }))}>
                    {connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={L('Ferramenta de leitura', 'Read tool')}>
                  <select value={t.tool} onChange={(e) => (setPreview(null), set({ trigger: pollTrigger({ tool: e.target.value }) }))}>
                    {connectors
                      .find((c) => c.id === t.connectorId)
                      ?.tools.filter((x) => x.cls === 'read' && x.enabled)
                      .map((x) => (
                        <option key={x.name} value={x.name}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              <div className="grid2">
                <Field label={L('Argumentos (JSON)', 'Arguments (JSON)')} hint={argsError || L('O filtro da busca, ex.: {"label": "agente", "state": "Todo"}.', 'The search filter, e.g. {"label": "agent", "state": "Todo"}.')}>
                  <textarea rows={2} className="mono" value={argsText} onChange={(e) => (setPreview(null), setArgsText(e.target.value))} />
                </Field>
                <Field label={L('Olhar a cada', 'Check every')}>
                  <select value={t.everyMinutes} onChange={(e) => set({ trigger: pollTrigger({ everyMinutes: Number(e.target.value) }) })}>
                    {POLL_MINUTES.map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m} min` : L('1 hora', '1 hour')}
                      </option>
                    ))}
                  </select>
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
            <Field label={L('Dias', 'Days')}>
              <div className="segmented routine-once" role="radiogroup" aria-label={L('Repetição', 'Repeat')}>
                {[false, true].map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    role="radio"
                    aria-checked={!!draft.schedule.once === v}
                    className={!!draft.schedule.once === v ? 'is-active' : ''}
                    onClick={() => set({ schedule: { ...draft.schedule, once: v || undefined, days: v ? EVERY_DAY : draft.schedule.days } })}
                  >
                    {v ? L('Uma vez', 'Once') : L('Repete', 'Repeats')}
                  </button>
                ))}
              </div>
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
            </Field>
            <Field label={L('Horário', 'Time')} hint={draft.schedule.once ? L('No próximo dia marcado em que esse horário ainda não passou.', 'On the next checked day this time hasn’t passed yet.') : L('Hora do seu computador.', 'Your computer’s time.')}>
              <input type="time" value={draft.schedule.time} onChange={(e) => set({ schedule: { ...draft.schedule, time: e.target.value } })} />
            </Field>
          </div>
        )}
        <Field label={L('Onde postar', 'Where to post')}>
          <select value={target} onChange={(e) => set({ conversationId: e.target.value })}>
            <option value="">{L(`DM com ${agent?.name ?? 'o agente'}`, `DM with ${agent?.name ?? 'the agent'}`)}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row row--between">
          <span className="hint">
            {t?.kind === 'poll'
              ? L('O que já existe agora não dispara: ela roda uma vez pra cada item novo, um de cada vez. O agente recebe o item, marcado como vindo de fora.', 'What exists now doesn’t trigger it: it runs once per new item, one at a time. The agent gets the item, marked as coming from outside.')
              : t?.kind === 'webhook'
                ? L('Roda uma vez por chamada; se ainda estiver rodando, a chamada é recusada.', 'Runs once per call; if it’s still running, the call is refused.')
                : `${days.length > 0 ? `${describeSchedule(draft.schedule)}.` : L('Escolha pelo menos um dia.', 'Pick at least one day.')}${draft.schedule.once ? L(' Depois de rodar, desliga sozinha.', ' After it runs, it turns itself off.') : ''}${L(' Se o app estiver fechado no horário, roda quando abrir (até 12 h depois).', ' If the app is closed at that time, it runs when it opens (up to 12 h later).')}`}
          </span>
          <div className="row">
            {error && <span className="field__error">{error}</span>}
            <button className="btn btn--sm btn--ghost" onClick={onClose}>
              {L('Cancelar', 'Cancel')}
            </button>
            <button className="btn btn--sm btn--primary" disabled={saving || !draft.name.trim() || !draft.prompt.trim() || (!t && days.length === 0) || (t?.kind === 'poll' && (!!argsError || !t.tool))} onClick={() => void save()}>
              {draft.id ? L('Salvar', 'Save') : L('Criar rotina', 'Create routine')}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
