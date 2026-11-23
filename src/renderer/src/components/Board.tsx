// The board (Quadro): every agent's work as cards, in four columns — A fazer (my to-dos, and today's
// routines still to run), Fazendo, Precisa de você, Feito (today) — with what got stuck above them and
// the team's rings on top. A card opens at the side with everything about it: the decision first, the
// result, the parts it was split into, each step, and the conversation, where one more word goes.
// The cards are read off the conversations (../board.ts); only the to-dos are kept for the board.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { L, locale } from '../../../shared/lang'
import { timeOpts } from '../../../shared/clock'
import { MAX_TASK_NOTES, MAX_TASK_TITLE, type Approval, type Inbox, type Task } from '../../../shared/types'
import { headsOf, sectorName, sectorOf } from '../../../shared/org'
import { canContinue } from '../../../shared/run-progress'
import { boardCards, costOf, dayStart, liveStep, stepsOf, storyOf, tasksOf, type BoardCard, type BoardTask, type CrewMember } from '../board'
import { call } from '../rpc'
import { answerDecision, continueRun, isTeam, loadTasks, navigate, openThread, personName, retryRun, sendMessage, stopRun, submitDecisions, toast, useStore, type Agent, type Conversation } from '../store'
import { ApprovalCard, QuestionCard, ReplyText } from './Conversation'
import { ArtifactCard } from './Panel'
import { ago, AgentAvatar, tokens as tokenWords } from './ui'

type Col = 'todo' | 'doing' | 'you' | 'done'
type Group = 'none' | 'agent' | 'sector'
const COLS: { id: Col; name: () => string; hint?: () => string }[] = [
  { id: 'todo', name: () => L('A fazer', 'To do') },
  { id: 'doing', name: () => L('Fazendo', 'Doing'), hint: () => L('anda sozinho', 'runs on its own') },
  { id: 'you', name: () => L('Precisa de você', 'Needs you') },
  { id: 'done', name: () => L('Feito', 'Done'), hint: () => L('hoje', 'today') }
]
const RETRYABLE = new Set(['failed', 'stopped', 'interrupted', 'limit_reached'])
const NO_TASKS: Task[] = []

// ---------- small pieces ----------

function Glyph({ col }: { col: Col }): ReactNode {
  if (col === 'todo') return <svg className="bd-glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--text-3)" strokeWidth="1.6" strokeDasharray="2.4 2.4" /></svg>
  if (col === 'doing') return <svg className="bd-glyph doing" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--bd-line2)" strokeWidth="1.8" /><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" /></svg>
  if (col === 'you') return <svg className="bd-glyph wait" viewBox="0 0 16 16" aria-hidden="true"><circle className="p" cx="8" cy="8" r="6" fill="var(--warn)" /><circle cx="8" cy="8" r="4" fill="var(--warn)" /></svg>
  return <svg className="bd-glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--ok)" /><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
const Check = (): ReactNode => <svg className="bd-ck" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" /><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
const Hourglass = (): ReactNode => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2h7M4.5 14h7M5 2c0 3 3 4 3 6s-3 3-3 6M11 2c0 3-3 4-3 6s3 3 3 6" fill="none" stroke="var(--text-3)" strokeWidth="1.4" strokeLinecap="round" /></svg>
const Clock = (): ReactNode => <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
const Typing = (): ReactNode => <span className="bd-typing" aria-hidden="true"><i /><i /><i /></span>
const Send = (): ReactNode => <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
const Search = (): ReactNode => <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>

function Face({ agent, size = 22, busy }: { agent: Agent | undefined; size?: number; busy?: boolean }): ReactNode {
  return agent ? <span className="bd-av"><AgentAvatar agent={agent} size={size} busy={busy} /></span> : <span className={`bd-none ${size > 24 ? 'md' : ''}`} />
}

// "4:07" since `at`, ticking by itself (only this span redraws each second).
function Since({ at }: { at: number }): ReactNode {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  return <>{s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</>
}

const span = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim()
}
const names = (list: string[]): string => (list.length > 1 ? `${list.slice(0, -1).join(', ')} ${L('e', 'and')} ${list.at(-1)}` : (list[0] ?? ''))
const firstLine = (text: string): string => text.split('\n').map((l) => l.replace(/[*_`#>]+/g, '').trim()).find(Boolean) ?? ''
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

function Where({ conv }: { conv: Conversation | undefined }): ReactNode {
  if (!conv) return null
  return <span className="where">{conv.kind === 'channel' ? `#${conv.name}` : 'DM'}</span>
}

// ---------- the page ----------

interface Ctx {
  agents: Map<string, Agent>
  convs: Map<string, Conversation>
  cards: Map<string, BoardCard>
  tasks: Map<string, BoardTask>
  inbox: ReturnType<typeof useInbox>
}
const useInbox = (): { approvals: Map<string, Approval>; questions: Map<string, Inbox['questions'][number]> } => {
  const inbox = useStore((s) => s.inbox)
  const all = useStore((s) => s.approvals)
  return useMemo(() => ({ approvals: new Map([...all, ...inbox.approvals].map((a) => [a.id, a])), questions: new Map(inbox.questions.map((q) => [q.id, q])) }), [inbox, all])
}

export function BoardPage(): ReactNode {
  const agentsAll = useStore((s) => s.agents)
  const messages = useStore((s) => s.messages)
  const delegations = useStore((s) => s.delegations)
  const inboxRaw = useStore((s) => s.inbox)
  const you = useStore((s) => s.you)
  const people = useStore((s) => s.people)
  const me = useStore((s) => s.me)
  const former = useStore((s) => s.former)
  const conversations = useStore((s) => s.conversations)
  const routines = useStore((s) => s.routines)
  const tasks = useStore((s) => s.tasks) ?? NO_TASKS
  const inbox = useInbox()
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000))
  useEffect(() => {
    void loadTasks()
    const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 30_000)
    return () => clearInterval(t)
  }, [])

  const team = useMemo(() => agentsAll.filter(isTeam).sort((a, b) => a.name.localeCompare(b.name, locale())), [agentsAll])
  const agents = useMemo(() => new Map(agentsAll.map((a) => [a.id, a])), [agentsAll])
  const convs = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations])
  const cards = useMemo(
    () => boardCards({ you, agents: agentsAll, messages, delegations, inbox: inboxRaw, name: (id) => personName({ you, people, me, former }, id) }, minute * 60_000),
    [you, agentsAll, messages, delegations, inboxRaw, people, me, former, minute]
  )
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  // One task, one card: a request split among agents shows once, in every view.
  const tasksAll = useMemo(() => tasksOf(cards), [cards])
  const taskById = useMemo(() => new Map(tasksAll.map((t) => [t.id, t])), [tasksAll])
  const ctx: Ctx = { agents, convs, cards: byId, tasks: taskById, inbox }

  const [group, setGroup] = useState<Group>('none')
  const [allDone, setAllDone] = useState(false)
  const [showTeam, setShowTeam] = useState(false)
  const [allStuck, setAllStuck] = useState(false)
  const [only, setOnly] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null) // a card's id, or "t:<task id>"
  const [focus, setFocus] = useState<string | null>(null)
  const [hover, setHover] = useState<Set<string> | null>(null)
  const [pop, setPop] = useState<{ x: number; y: number; kind: 'pick' | 'help'; task?: string } | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null) // the to-dos' order while one is dragged
  const [moved, setMoved] = useState<Record<string, number>>({}) // a to-do's new place, until the list comes back
  const [over, setOver] = useState<string | null>(null) // the column or agent a dragged to-do is over
  const root = useRef<HTMLDivElement>(null)
  const colsRef = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => setMoved({}), [tasks])
  const sortedTasks = useMemo(() => {
    const list = tasks.map((t) => (t.id in moved ? { ...t, position: moved[t.id]! } : t)).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)
    return preview ? preview.map((id) => list.find((t) => t.id === id)!).filter(Boolean) : list
  }, [tasks, moved, preview])
  const now = minute * 60_000
  const end = dayStart(now) + 86_400_000
  const todayRoutines = useMemo(() => routines.filter((r) => r.enabled && r.nextAt && r.nextAt <= end && agents.has(r.agentId)).sort((a, b) => a.nextAt! - b.nextAt!), [routines, end, agents])

  // Fresh in Feito: the check draws itself once.
  const lastCol = useRef(new Map<string, string>())
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  useEffect(() => {
    const now = new Set<string>()
    for (const c of cards) {
      const was = lastCol.current.get(c.id)
      if (c.column === 'done' && was && was !== 'done') now.add(c.id)
    }
    lastCol.current = new Map(cards.map((c) => [c.id, c.column]))
    if (!now.size) return
    setFresh(now)
    const t = setTimeout(() => setFresh(new Set()), 1600)
    return () => clearTimeout(t)
  }, [cards])

  // ---------- what shows ----------
  const matches = (title: string, agentId?: string): boolean => (!only || agentId === only) && (!q || fold(`${title} ${agentId ? (agents.get(agentId)?.name ?? '') : ''}`).includes(fold(q)))
  // A task matches by its title or by anyone on it.
  const visible = (c: BoardTask): boolean => matches(c.title, c.agentId) || (!!only && c.crew.some((m) => m.agentId === only) && matches(c.title))
  const shownCards = tasksAll.filter((c) => c.column !== 'stuck' && visible(c))
  const shownTasks = sortedTasks.filter((t) => matches(`${t.title} ${t.notes ?? ''}`, t.agentId))
  const shownRoutines = todayRoutines.filter((r) => matches(r.name, r.agentId))
  const stuck = cards.filter((c) => c.column === 'stuck' && matches(c.title, c.agentId))

  type Lane = { key: string; label?: ReactNode; has: (agentId: string | undefined) => boolean }
  const lanes: Lane[] = useMemo(() => {
    if (group === 'agent') return [...team.map((a) => ({ key: a.id, label: <><Face agent={a} size={28} />{a.name}<small>{a.role}</small></>, has: (id: string | undefined) => id === a.id })), { key: '_', label: <><Face agent={undefined} size={28} />{L('Sem agente', 'No agent')}</>, has: (id: string | undefined) => !id || !team.some((a) => a.id === id) }]
    if (group === 'sector') {
      const heads = headsOf(team)
      const head = (id: string | undefined): string | undefined => (id ? sectorOf(team, id)?.id : undefined)
      return [...heads.map((h) => ({ key: h.id, label: <>{sectorName(h, L('Setor de', 'Sector of'))}</>, has: (id: string | undefined) => head(id) === h.id })), { key: '_', label: <>{L('Sem setor', 'No sector')}</>, has: (id: string | undefined) => !head(id) }]
    }
    return [{ key: 'all', has: () => true }]
  }, [group, team])

  // ---------- cards moving: each slides from where it was ----------
  const rects = useRef(new Map<string, { x: number; y: number }>())
  useLayoutEffect(() => {
    const box = colsRef.current?.getBoundingClientRect()
    if (!box) return
    const next = new Map<string, { x: number; y: number }>()
    const first = rects.current.size === 0
    for (const el of colsRef.current!.querySelectorAll<HTMLElement>('[data-card]')) {
      const id = el.dataset.card!
      if (el.classList.contains('ghost')) continue
      const r = el.getBoundingClientRect()
      const p = { x: r.left - box.left, y: r.top - box.top }
      next.set(id, p)
      const was = rects.current.get(id)
      if (!was) {
        if (!first) el.animate([{ opacity: 0, transform: 'translateY(-8px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.22,1.2,.36,1)' })
        continue
      }
      const dx = was.x - p.x
      const dy = was.y - p.y
      if (Math.abs(dx) + Math.abs(dy) < 2) continue
      const far = Math.abs(dx) > 40
      el.animate(
        far ? [{ transform: `translate(${dx}px, ${dy}px) scale(1.02)` }, { transform: `translate(${dx * 0.06}px, ${dy * 0.06}px) scale(1.012)`, offset: 0.78 }, { transform: 'none' }] : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: far ? 640 : 380, easing: 'cubic-bezier(.22,1,.36,1)' }
      )
    }
    rects.current = next
  })

  // ---------- to-dos ----------
  const save = async (task: Partial<Task> & { title: string }): Promise<Task | undefined> => {
    try {
      return await call('saveTask', { task })
    } catch (e) {
      toast(e instanceof Error ? e.message : L('Não consegui salvar a tarefa.', "Couldn't save the task."))
      return undefined
    }
  }
  const start = async (t: Task, anchor?: HTMLElement | null): Promise<void> => {
    if (!t.agentId) {
      const r = (anchor ?? root.current!.querySelector(`[data-card="t:${t.id}"]`))?.getBoundingClientRect()
      setPop({ x: r?.left ?? 200, y: r?.bottom ?? 200, kind: 'pick', task: t.id })
      return
    }
    try {
      await call('startTask', { id: t.id })
      if (open === `t:${t.id}`) setOpen(null)
      toast(L(`${agents.get(t.agentId)?.name ?? 'O agente'} começou.`, `${agents.get(t.agentId)?.name ?? 'The agent'} started.`))
    } catch (e) {
      toast(e instanceof Error ? e.message : L('Não consegui começar.', "Couldn't start the task."))
    }
  }
  const create = async (text: string): Promise<boolean> => {
    let agentId: string | undefined
    const title = text
      .replace(/@([\p{L}\p{N}_.-]+)/gu, (all, n: string) => {
        const a = team.find((x) => fold(x.name) === fold(n) || fold(x.handle) === fold(n))
        if (!a) return all
        agentId = a.id
        return ''
      })
      .replace(/\s+/g, ' ')
      .trim()
    if (!title) return false
    const t = await save({ title: title.charAt(0).toUpperCase() + title.slice(1), ...(agentId ? { agentId } : {}) })
    return !!t
  }

  // ---------- dragging a to-do: to Fazendo starts it, onto an agent gives it, within A fazer moves it ----------
  const drag = useRef<{ id: string; el: HTMLElement; x0: number; y0: number; on: boolean; dx: number; dy: number; clone?: HTMLElement } | null>(null)
  const justDragged = useRef(false)
  const onTaskDown = (e: ReactPointerEvent, t: Task): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    drag.current = { id: t.id, el: e.currentTarget as HTMLElement, x0: e.clientX, y0: e.clientY, on: false, dx: 0, dy: 0 }
  }
  useEffect(() => {
    const target = (x: number, y: number): { who?: string; col?: string; el: Element | null } => {
      const el = document.elementFromPoint(x, y)
      return { el, who: (el?.closest('[data-who]') as HTMLElement | null)?.dataset.who, col: (el?.closest('[data-col]') as HTMLElement | null)?.dataset.col }
    }
    const move = (e: PointerEvent): void => {
      const d = drag.current
      if (!d) return
      if (!d.on) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return
        d.on = true
        const r = d.el.getBoundingClientRect()
        d.dx = d.x0 - r.left
        d.dy = d.y0 - r.top
        const clone = d.el.cloneNode(true) as HTMLElement
        clone.classList.add('bd-clone')
        clone.removeAttribute('data-card')
        clone.style.width = `${r.width}px`
        root.current!.appendChild(clone)
        clone.animate([{ transform: 'rotate(0) scale(1)' }, { transform: 'rotate(2deg) scale(1.04)' }], { duration: 220, fill: 'forwards', easing: 'cubic-bezier(.22,1.2,.36,1)' })
        d.clone = clone
        d.el.classList.add('ghost')
        setPreview(sortedTasks.map((t) => t.id))
      }
      d.clone!.style.left = `${e.clientX - d.dx}px`
      d.clone!.style.top = `${e.clientY - d.dy}px`
      const { who, col, el } = target(e.clientX, e.clientY)
      setOver(who ? `who:${who}` : col === 'doing' || col === 'todo' ? col : null)
      if (col === 'todo' && !who) {
        const others = [...(el?.closest('[data-col]')?.querySelectorAll<HTMLElement>('[data-card^="t:"]') ?? [])].filter((x) => x.dataset.card !== `t:${d.id}`)
        const after = others.find((o) => {
          const r = o.getBoundingClientRect()
          return e.clientY < r.top + r.height / 2
        })
        setPreview((p) => {
          const list = (p ?? sortedTasks.map((t) => t.id)).filter((x) => x !== d.id)
          const at = after ? list.indexOf(after.dataset.card!.slice(2)) : list.length
          const next = [...list.slice(0, at), d.id, ...list.slice(at)]
          return p && p.join() === next.join() ? p : next
        })
      }
    }
    const up = (e: PointerEvent): void => {
      const d = drag.current
      drag.current = null
      if (!d?.on) return
      justDragged.current = true
      setTimeout(() => (justDragged.current = false), 60)
      const { who, col } = target(e.clientX, e.clientY)
      const t = tasks.find((x) => x.id === d.id)
      const order = preview
      setOver(null)
      const land = (): void => {
        d.clone?.remove()
        d.el.classList.remove('ghost')
        setPreview(null)
      }
      if (!t) return land()
      if (who) {
        land()
        void save({ id: t.id, title: t.title, agentId: who }).then((x) => x && toast(L(`Agora é ${agents.get(who)?.name ? `de ${agents.get(who)!.name}` : 'dele'}.`, `It's ${agents.get(who)?.name ?? 'theirs'} now.`)))
        return
      }
      if (col === 'doing') {
        land()
        void start(t)
        return
      }
      // Within A fazer: its new place, between its neighbours.
      setPreview((p) => {
        const list = p ?? order ?? []
        const i = list.indexOf(t.id)
        const pos = (id: string | undefined): number | undefined => (id ? sortedTasks.find((x) => x.id === id)?.position : undefined)
        const before = pos(list[i - 1])
        const after = pos(list[i + 1])
        const position = before !== undefined && after !== undefined ? (before + after) / 2 : before !== undefined ? before + 1 : after !== undefined ? after - 1 : t.position
        if (position !== t.position) {
          setMoved((m) => ({ ...m, [t.id]: position }))
          void save({ id: t.id, title: t.title, position })
        }
        return p
      })
      const home = root.current?.querySelector<HTMLElement>(`[data-card="t:${t.id}"]`)?.getBoundingClientRect()
      if (home && d.clone) {
        d.clone.animate([{ left: d.clone.style.left, top: d.clone.style.top, transform: 'rotate(2deg) scale(1.04)' }, { left: `${home.left}px`, top: `${home.top}px`, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.22,1.2,.36,1)' }).onfinish = land
      } else land()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    return () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
  })

  // ---------- keys ----------
  const openCard = (id: string): void => {
    setFocus(id)
    setOpen(id)
  }
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (pop) return setPop(null)
        if (open) return setOpen(null)
        return
      }
      const el = e.target as HTMLElement | null
      if (el?.closest?.('input,textarea,select,[contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('.modal, .dialog, [role="dialog"]:not(.bd-side)')) return
      if (e.key === '/') return void (e.preventDefault(), searchRef.current?.focus())
      if (e.key.toLowerCase() === 'n') return void (e.preventDefault(), addRef.current?.focus())
      if (e.key === '?') {
        const r = root.current?.querySelector('.bd-help-btn')?.getBoundingClientRect()
        return setPop(pop?.kind === 'help' ? null : { x: (r?.right ?? 600) - 300, y: r?.bottom ?? 80, kind: 'help' })
      }
      if (open) return
      const order = COLS.map((c) => [...(colsRef.current?.querySelectorAll<HTMLElement>(`[data-col="${c.id}"] [data-card]`) ?? [])].map((x) => x.dataset.card!))
      const ci = order.findIndex((l) => focus && l.includes(focus))
      const ri = ci >= 0 ? order[ci]!.indexOf(focus!) : -1
      const go = (c: number, r: number): boolean => {
        const l = order[c]
        if (!l?.length) return false
        const id = l[Math.max(0, Math.min(l.length - 1, r))]!
        setFocus(id)
        const node = colsRef.current?.querySelector<HTMLElement>(`[data-card="${id}"]`)
        node?.focus({ preventScroll: true })
        node?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
        return true
      }
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'j', 'k'].includes(e.key)) {
        e.preventDefault()
        if (ci < 0) return void go(order.findIndex((l) => l.length), 0)
        if (e.key === 'ArrowDown' || e.key === 'j') go(ci, ri + 1)
        else if (e.key === 'ArrowUp' || e.key === 'k') go(ci, ri - 1)
        else {
          const dir = e.key === 'ArrowRight' ? 1 : -1
          for (let c = ci + dir; c >= 0 && c < order.length; c += dir) if (go(c, ri)) break
        }
        return
      }
      if (!focus) return
      if (e.key === 'Enter') return openCard(focus)
      if (focus.startsWith('t:')) {
        const t = tasks.find((x) => `t:${x.id}` === focus)
        if (t && e.key.toLowerCase() === 's') void start(t)
        return
      }
      const t = taskById.get(focus)
      const c = t?.asking ?? t ?? byId.get(focus)
      if (!c?.last) return
      if (e.key.toLowerCase() === 'a' && c.state === 'approval') {
        const a = inbox.approvals.get(c.last.run?.approvalId ?? '')
        if (a) decide(a.id, 'approved')
      } else if (/^[1-4]$/.test(e.key) && c.state === 'question') {
        const one = single(inbox.questions.get(c.last.id))
        if (one?.options?.[+e.key - 1]) answerOne(c.last.id, +e.key - 1)
      }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  })

  // ---------- the team, right now ----------
  const mates = team.map((a) => {
    const mine = cards.filter((c) => c.agentId === a.id)
    const waiting = mine.some((c) => c.column === 'you')
    const busy = mine.filter((c) => c.column === 'doing' && c.state === 'working')
    const parts = mine.some((c) => c.column === 'doing' && c.state === 'parts')
    const state = waiting ? 'wait' : busy.length ? 'busy' : 'idle'
    const line = waiting ? <small className="wait">{L('Esperando você', 'Waiting for you')}</small> : busy.length ? <small>{busy[0]!.title}{busy.length > 1 ? ` · +${busy.length - 1}` : ''}</small> : parts ? <small>{L('Esperando o time', 'Waiting on the team')}</small> : <small>{L('Livre', 'Free')}</small>
    return (
      <button key={a.id} className={`bd-mate ${only && only !== a.id ? 'dim' : ''} ${only === a.id ? 'on' : ''} ${over === `who:${a.id}` ? 'drop' : ''}`} data-who={a.id} aria-pressed={only === a.id} onClick={() => setOnly(only === a.id ? null : a.id)}>
        <span className={`bd-ring ${state}`}>
          <svg viewBox="0 0 40 40" aria-hidden="true"><circle className="track" cx="20" cy="20" r="18" fill="none" strokeWidth="2" /><circle className="arc" cx="20" cy="20" r="18" fill="none" strokeWidth="2" strokeDasharray={state === 'wait' ? '113 0' : '28 85'} /></svg>
          <AgentAvatar agent={a} size={30} busy={state === 'busy'} />
        </span>
        <span><b>{a.name}</b>{line}</span>
      </button>
    )
  })
  // The team in one line: who's on something now, who waits on me, how many are free.
  const busyIds = new Set(cards.filter((c) => c.column === 'doing' && c.state === 'working' && c.replies.length).map((c) => c.agentId))
  const askingIds = new Set(tasksAll.flatMap((t) => (t.asking ? [t.asking.agentId] : [])))
  const busyTeam = team.filter((a) => busyIds.has(a.id) && !askingIds.has(a.id))
  const askingTeam = team.filter((a) => askingIds.has(a.id))
  const freeN = team.length - busyTeam.length - askingTeam.length

  // ---------- actions on cards ----------
  const decide = (id: string, decision: 'approved' | 'refused'): void => {
    void call('decideApproval', { id, decision }).then(
      () => toast(decision === 'approved' ? L('Aprovado. O agente continua.', 'Approved. The agent continues.') : L('Recusado. Nada foi feito.', 'Refused. Nothing was done.')),
      (e: unknown) => toast(e instanceof Error ? e.message : L('Não consegui decidir.', "Couldn't record the decision."))
    )
  }
  const answerOne = (messageId: string, index: number): void => {
    answerDecision(messageId, 0, { chosen: [index] })
    void submitDecisions(messageId)
  }

  const renderCard = (c: BoardTask): ReactNode => (
    <CardView key={c.id} c={c} ctx={ctx} focus={focus === c.id} fresh={fresh.has(c.id)} fam={!!hover?.has(c.id)} onOpen={() => (justDragged.current ? undefined : openCard(c.id))} onDecide={decide} onAnswer={answerOne} />
  )
  const renderTask = (t: Task): ReactNode => {
    const a = t.agentId ? agents.get(t.agentId) : undefined
    const conv = t.conversationId ? convs.get(t.conversationId) : undefined
    return (
      <div key={t.id} data-card={`t:${t.id}`} tabIndex={0} className={`bd-card task ${focus === `t:${t.id}` ? 'focus' : ''}`} onPointerDown={(e) => onTaskDown(e, t)} onClick={() => !justDragged.current && openCard(`t:${t.id}`)} aria-label={t.title}>
        <div className="bd-c-top"><Face agent={a} /><span className="nm">{a?.name ?? L('Sem agente', 'No agent')}</span><span className="time">{ago(t.createdAt)}</span></div>
        <div className="bd-c-title">{t.title}</div>
        <div className="bd-c-foot">{t.dueAt ? <span>{L('até', 'by')} {new Date(t.dueAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</span> : <span>{L('Você', 'You')}</span>}{conv?.kind === 'channel' && <Where conv={conv} />}</div>
        <button className="bd-go" onClick={(e) => void start(t, e.currentTarget)}>{L('Começar', 'Start')} <kbd>S</kbd></button>
      </div>
    )
  }

  const DONE_SHOWN = 5
  const column = (col: Col, lane: Lane, first: boolean): ReactNode => {
    const all = col === 'todo' ? [] : shownCards.filter((c) => c.column === col && lane.has(c.agentId))
    // Feito shows the latest few; the rest are a click away.
    const list = col === 'done' && !allDone && group === 'none' ? all.slice(0, DONE_SHOWN) : all
    const ts = col === 'todo' ? shownTasks.filter((t) => lane.has(t.agentId)) : []
    const rs = col === 'todo' ? shownRoutines.filter((r) => lane.has(r.agentId)) : []
    const empty = !list.length && !ts.length && !rs.length
    return (
      <div key={`${lane.key}:${col}`} className={`bd-col ${col === 'you' && list.length ? 'wait-col' : ''} ${over === col && first ? 'over' : ''}`} data-col={col}>
        {col === 'todo' && first && <QuickAdd team={team} inputRef={addRef} onCreate={create} />}
        {ts.map(renderTask)}
        {rs.map((r) => {
          const a = agents.get(r.agentId)
          return (
            <div key={`r:${r.id}`} data-card={`r:${r.id}`} className="bd-card routine" aria-label={r.name}>
              <div className="bd-c-top"><Face agent={a} /><span className="nm">{a?.name}</span><span className="time"><Clock /> {new Date(r.nextAt!).toLocaleTimeString(locale(), timeOpts({ hour: '2-digit', minute: '2-digit' }))}</span></div>
              <div className="bd-c-title">{r.name}</div>
              <div className="bd-c-foot">{L('Rotina', 'Routine')}<Where conv={convs.get(r.conversationId)} /></div>
            </div>
          )
        })}
        {list.map(renderCard)}
        {all.length > list.length && <button className="bd-more-done" onClick={() => setAllDone(true)}>{L(`Ver os ${all.length} de hoje`, `See all ${all.length} from today`)} ›</button>}
        {col === 'done' && allDone && group === 'none' && all.length > DONE_SHOWN && <button className="bd-more-done" onClick={() => setAllDone(false)}>{L('Mostrar menos', 'Show fewer')}</button>}
        {empty && col !== 'todo' && group === 'none' && (
          <div className="bd-empty">
            {col === 'you' ? <><Glyph col="done" />{L('Nada esperando por você', 'Nothing waiting for you')}</> : col === 'doing' ? (over === 'doing' ? L('Solte aqui pra começar', 'Drop here to start') : L('Ninguém trabalhando agora', 'Nobody working right now')) : L('Nada ainda hoje', 'Nothing yet today')}
          </div>
        )}
      </div>
    )
  }

  const openTask = open?.startsWith('t:') ? tasks.find((t) => `t:${t.id}` === open) : undefined
  // A task opens as a task; a part (from a task's story) opens as itself.
  const openC = open && !open.startsWith('t:') ? (taskById.get(open) ?? byId.get(open)) : undefined
  useEffect(() => {
    if (open && !openTask && !openC) setOpen(null)
  }, [open, openTask, openC])

  return (
    <div className={`bd ${group === 'none' ? 'flat' : ''}`} ref={root}>
      <div className="bd-top">
        <header className="bd-head">
          <div>
            <h1>{L('Quadro', 'Board')}</h1>
            <div className="bd-date">{new Date(now).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          </div>
          <div className="bd-grow" />
          <div className="bd-tools">
            <div className="bd-seg" role="group" aria-label={L('Agrupar', 'Group')}>
              <button aria-pressed={group === 'none'} onClick={() => setGroup('none')}>{L('Tudo', 'All')}</button>
              <button aria-pressed={group === 'agent'} onClick={() => setGroup('agent')}>{L('Por agente', 'By agent')}</button>
              {headsOf(team).length > 0 && <button aria-pressed={group === 'sector'} onClick={() => setGroup('sector')}>{L('Por setor', 'By sector')}</button>}
            </div>
            <label className="bd-field">
              <Search />
              <input ref={searchRef} type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.currentTarget.blur(), setQ(''))} placeholder={L('Buscar', 'Search')} aria-label={L('Buscar cartões', 'Search cards')} />
              <kbd>/</kbd>
            </label>
            <button className="bd-icon-btn bd-help-btn" aria-label={L('Atalhos do teclado', 'Keyboard shortcuts')} onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setPop(pop?.kind === 'help' ? null : { x: r.right - 300, y: r.bottom + 8, kind: 'help' })
            }}>?</button>
            <button className="bd-btn ink" onClick={() => addRef.current?.focus()}>{L('Nova tarefa', 'New task')} <kbd>N</kbd></button>
          </div>
        </header>
        {team.length > 0 && (
          <div className="bd-now" role="group" aria-label={L('O time agora', 'The team now')}>
            <span className="bd-now-faces">
              {[...askingTeam, ...busyTeam].map((a) => (
                <button key={a.id} data-who={a.id} className={`${only === a.id ? 'on' : ''} ${over === `who:${a.id}` ? 'drop' : ''}`} title={a.name} aria-pressed={only === a.id} onClick={() => setOnly(only === a.id ? null : a.id)}>
                  <AgentAvatar agent={a} size={24} busy={busyIds.has(a.id)} />
                </button>
              ))}
            </span>
            <span><b>{busyTeam.length}</b> {L('fazendo', 'doing')}</span>
            {askingTeam.length > 0 && <span className="w">· {L(`${names(askingTeam.map((a) => a.name))} esperando você`, `${names(askingTeam.map((a) => a.name))} waiting for you`)}</span>}
            <span className="free">· {L(`${freeN} ${freeN === 1 ? 'livre' : 'livres'}`, `${freeN} free`)}</span>
            {only && <button className="bd-now-clear" onClick={() => setOnly(null)}>{L(`Só ${agents.get(only)?.name ?? ''}`, `Only ${agents.get(only)?.name ?? ''}`)} ✕</button>}
            <span className="bd-grow" />
            <button className="bd-now-toggle" aria-expanded={showTeam} onClick={() => setShowTeam(!showTeam)}>{showTeam ? L('Esconder o time', 'Hide the team') : L('Ver o time', 'See the team')} ›</button>
          </div>
        )}
        {team.length > 0 && showTeam && <div className="bd-team">{mates}</div>}
        {stuck.length > 0 && (
          <div className="bd-stuck">
            {(allStuck ? stuck : stuck.slice(0, 2)).map((c) => {
              const a = agents.get(c.agentId)
              const paused = c.state === 'paused'
              return (
                <div key={c.id} className={`bd-stuck-row ${paused ? 'paused' : ''}`}>
                  <span className="bd-bang">{paused ? '‖' : '!'}</span>
                  <Face agent={a} />
                  <span className="bd-stuck-msg"><b>{a?.name}</b> {paused ? L('pausou em', 'paused on') : L('parou em', 'stopped on')} “{c.title}” {c.last?.run?.error && <em>· {firstLine(c.last.run.error)}</em>}</span>
                  <span className="bd-grow" />
                  <button className="bd-btn quiet sm" onClick={() => openCard(c.id)}>{L('Ver', 'See')}</button>
                  {c.last && (paused || canContinue(c.last.run!) ? <button className="bd-btn ink sm" onClick={() => continueRun(c.last!.id)}>{L('Continuar', 'Continue')}</button> : RETRYABLE.has(c.last.run!.status) && <button className="bd-btn ink sm" onClick={() => retryRun(c.last!.id)}>{L('Tentar de novo', 'Try again')}</button>)}
                </div>
              )
            })}
            {stuck.length > 2 && (
              <button className="bd-stuck-more" onClick={() => setAllStuck(!allStuck)}>
                {allStuck ? L('Mostrar menos', 'Show fewer') : L(`+${stuck.length - 2} ${stuck.length - 2 === 1 ? 'parou' : 'pararam'}: ${names(stuck.slice(2).map((c) => agents.get(c.agentId)?.name ?? '').filter((n, i, all) => all.indexOf(n) === i))}`, `+${stuck.length - 2} stopped: ${names(stuck.slice(2).map((c) => agents.get(c.agentId)?.name ?? '').filter((n, i, all) => all.indexOf(n) === i))}`)} ›
              </button>
            )}
          </div>
        )}
      </div>
      <div className="bd-wrap" onPointerDown={(e) => open && !(e.target as HTMLElement).closest('[data-card], button, input, a') && setOpen(null)}>
        <div className={`bd-cols ${hover ? 'hovering' : ''}`} ref={colsRef}>
          {COLS.map((col) => {
            const n = col.id === 'todo' ? shownTasks.length + shownRoutines.length : shownCards.filter((c) => c.column === col.id).length
            return (
              <div key={`h:${col.id}`} className={`bd-ch ${col.id === 'you' && n ? 'wait' : ''}`}>
                <Glyph col={col.id} /><h2>{col.name()}</h2><span className="n">{n}</span>{col.hint && <span className="hint">{col.hint()}</span>}
              </div>
            )
          })}
          {lanes.map((lane, i) => {
            if (group !== 'none') {
              const count = shownCards.filter((c) => lane.has(c.agentId) && c.column !== 'done').length + shownTasks.filter((t) => lane.has(t.agentId)).length
              const any = count || shownCards.some((c) => lane.has(c.agentId)) || shownRoutines.some((r) => lane.has(r.agentId))
              // Nothing open and nothing done today: one line at the end, not a row of empty boxes.
              if (!any) return null
              return [
                <div key={`l:${lane.key}`} className="bd-lane">{lane.label}<small>{L(`${count} em aberto`, `${count} open`)}</small></div>,
                ...COLS.map((col) => column(col.id, lane, i === 0))
              ]
            }
            return COLS.map((col) => column(col.id, lane, true))
          })}
          {group !== 'none' && (() => {
            const idle = lanes.filter((lane) => lane.key !== '_' && !shownCards.some((c) => lane.has(c.agentId)) && !shownTasks.some((t) => lane.has(t.agentId)) && !shownRoutines.some((r) => lane.has(r.agentId)))
            if (!idle.length) return null
            const label = (lane: Lane): string => (group === 'agent' ? (agents.get(lane.key)?.name ?? '') : (() => { const h = agents.get(lane.key); return h ? sectorName(h, L('Setor de', 'Sector of')) : '' })())
            return <div className="bd-idle">{L('Sem nada em aberto: ', 'Nothing open: ')}{idle.map(label).filter(Boolean).join(', ')}</div>
          })()}
        </div>
      </div>

      {openC && <CardPanel key={openC.id} c={openC} ctx={ctx} onNav={setOpen} onClose={() => setOpen(null)} onAgain={async (c) => {
        const t = await save({ title: c.title, agentId: c.agentId, ...(convs.get(c.conversationId)?.kind === 'channel' ? { conversationId: c.conversationId } : {}) })
        if (t) {
          setOpen(null)
          void start(t)
        }
      }} />}
      {openTask && <TaskPanel key={openTask.id} t={openTask} team={team} conversations={conversations} onClose={() => setOpen(null)} save={save} onStart={(t) => void start(t)} onRemove={async (t) => {
        setOpen(null)
        await call('removeTask', { id: t.id }).catch(() => toast(L('Não consegui apagar a tarefa.', "Couldn't delete the task.")))
      }} />}

      {pop && (
        <Pop x={pop.x} y={pop.y} onClose={() => setPop(null)}>
          {pop.kind === 'help' ? (
            <div className="bd-help">
              <h4>{L('Atalhos', 'Shortcuts')}</h4>
              {([[L('Navegar', 'Move'), ['←', '↑', '↓', '→']], [L('Abrir o cartão', 'Open the card'), ['Enter']], [L('Aprovar', 'Approve'), ['A']], [L('Responder', 'Answer'), ['1', '2', '3']], [L('Começar', 'Start'), ['S']], [L('Nova tarefa', 'New task'), ['N']], [L('Buscar', 'Search'), ['/']], [L('Fechar', 'Close'), ['Esc']]] as [string, string[]][]).map(([what, keys]) => (
                <div key={what}><span>{what}</span><span>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</span></div>
              ))}
              <p style={{ margin: '10px 0 0' }}>{L('Arraste uma tarefa de “A fazer” pra “Fazendo”, ou pra cima de um agente lá no topo. Passe o mouse num pedido dividido pra ver as partes dele.', 'Drag a task from “To do” to “Doing” or onto an agent above. Hover over a split request to see its parts.')}</p>
            </div>
          ) : (
            <>
              <p>{L('Quem faz?', 'Who does it?')}</p>
              {team.map((a) => (
                <button key={a.id} onClick={async () => {
                  const t = tasks.find((x) => x.id === pop.task)
                  setPop(null)
                  if (!t) return
                  const saved = await save({ id: t.id, title: t.title, agentId: a.id })
                  if (saved) void start(saved)
                }}><AgentAvatar agent={a} size={26} /><span>{a.name} <span style={{ color: 'var(--text-3)' }}>· {a.role}</span></span></button>
              ))}
            </>
          )}
        </Pop>
      )}
    </div>
  )
}

function Pop({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setAt({ left: Math.max(12, Math.min(x, innerWidth - w - 12)), top: y + h > innerHeight - 12 ? Math.max(12, y - h - 16) : y })
  }, [x, y])
  useEffect(() => {
    const away = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const t = setTimeout(() => addEventListener('pointerdown', away))
    return () => {
      clearTimeout(t)
      removeEventListener('pointerdown', away)
    }
  }, [onClose])
  return <div className="bd-pop" ref={ref} style={at}>{children}</div>
}

// ---------- quick add, with @ for the agent ----------

function QuickAdd({ team, inputRef, onCreate }: { team: Agent[]; inputRef: RefObject<HTMLInputElement | null>; onCreate: (text: string) => Promise<boolean> }): ReactNode {
  const [text, setText] = useState('')
  const [mention, setMention] = useState<{ at: number; hits: Agent[]; sel: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const tagged = (() => {
    const m = /@([\p{L}\p{N}_.-]+)/u.exec(text)
    return m ? team.find((a) => fold(a.name) === fold(m[1]!) || fold(a.handle) === fold(m[1]!)) : undefined
  })()
  const look = (value: string, caret: number): void => {
    const m = /@([\p{L}\p{N}_.-]*)$/u.exec(value.slice(0, caret))
    if (!m) return setMention(null)
    const hits = team.filter((a) => fold(a.name).startsWith(fold(m[1]!)) || fold(a.handle).startsWith(fold(m[1]!)))
    setMention(hits.length ? { at: caret - m[0].length, hits, sel: 0 } : null)
  }
  const pick = (a: Agent): void => {
    const el = inputRef.current!
    const caret = el.selectionStart ?? text.length
    const next = `${text.slice(0, mention!.at)}@${a.name} ${text.slice(caret).trimStart()}`
    setText(next)
    setMention(null)
    requestAnimationFrame(() => {
      el.focus()
      const at = mention!.at + a.name.length + 2
      el.setSelectionRange(at, at)
    })
  }
  const key = async (e: ReactKeyboardEvent<HTMLInputElement>): Promise<void> => {
    if (mention) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = mention.hits.length
        return setMention({ ...mention, sel: (mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return pick(mention.hits[mention.sel]!)
      }
      if (e.key === 'Escape') return void (e.stopPropagation(), setMention(null))
    }
    if (e.key === 'Escape') return e.currentTarget.blur()
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && text.trim() && !busy) {
      e.preventDefault()
      setBusy(true)
      const ok = await onCreate(text)
      setBusy(false)
      if (ok) setText('')
    }
  }
  return (
    <label className="bd-add">
      <span className="plus">+</span>
      <input ref={inputRef} value={text} maxLength={MAX_TASK_TITLE + 40} placeholder={L('Nova tarefa, @ pra escolher quem faz', 'New task, @ to pick who does it')} aria-label={L('Nova tarefa', 'New task')} autoComplete="off" onChange={(e) => (setText(e.target.value), look(e.target.value, e.target.selectionStart ?? e.target.value.length))} onKeyDown={(e) => void key(e)} onBlur={() => setTimeout(() => setMention(null), 120)} />
      {tagged && <span className="bd-who-tag"><AgentAvatar agent={tagged} size={18} />{tagged.name}</span>}
      {mention && (
        <div className="bd-mention" onMouseDown={(e) => e.preventDefault()}>
          {mention.hits.map((a, i) => (
            <button key={a.id} type="button" aria-selected={i === mention.sel} onClick={() => pick(a)}><AgentAvatar agent={a} size={26} />{a.name}<small>{a.role}</small></button>
          ))}
        </div>
      )}
    </label>
  )
}

// ---------- a card ----------

// Where a card is, in a few words (a part in the open card's team, an agent's line on top).
function statusOf(k: BoardCard, ctx: Ctx): string {
  if (k.column === 'done') return k.state === 'stopped' ? L('parado', 'stopped') : firstLine(k.last?.text ?? '') || L('pronto', 'done')
  if (k.column === 'you') return k.state === 'approval' ? L('quer sua aprovação', 'wants your approval') : L('perguntou pra você', 'asked you')
  if (k.column === 'stuck') return firstLine(k.last?.run?.error ?? '') || L('parou', 'stopped')
  if (k.state === 'asked-up') return L(`perguntou pra ${k.waitingOn}`, `asked ${k.waitingOn}`)
  if (k.state === 'other') return L(`esperando ${k.waitingOn}`, `waiting for ${k.waitingOn}`)
  if (k.state === 'parts') {
    const open = k.parts.map((p) => ctx.cards.get(p)).filter((x) => x && x.column !== 'done').map((x) => ctx.agents.get(x!.agentId)?.name ?? '')
    return L(`esperando ${names(open)}`, `waiting on ${names(open)}`)
  }
  return liveStep(k) ?? L('trabalhando', 'working')
}

const single = (q: { decisions?: { kind: string; options?: { label: string }[] }[] } | undefined): { options?: { label: string }[] } | undefined => (q?.decisions?.length === 1 && q.decisions[0]!.kind === 'single' ? q.decisions[0] : undefined)

// Who's on a task, in a few words: "Otto e Xavi fazendo · Davi ✓", or just its agent.
function crewLine(c: BoardTask, ctx: Ctx): string {
  const name = (m: CrewMember): string => ctx.agents.get(m.agentId)?.name ?? ''
  if (c.family.length <= 1) return ctx.agents.get(c.agentId)?.name ?? L('Agente', 'Agent')
  const of = (s: CrewMember['state']): string[] => c.crew.filter((m) => m.state === s).map(name)
  const working = of('working')
  const done = of('done')
  const waiting = c.crew.filter((m) => m.state === 'waiting' && m.agentId !== c.agentId).map(name)
  const head = working.length ? L(`${names(working)} fazendo`, `${names(working)} on it`) : waiting.length ? L(`esperando ${names(waiting)}`, `waiting on ${names(waiting)}`) : (ctx.agents.get(c.agentId)?.name ?? '')
  return done.length && c.column !== 'done' ? `${head} · ${names(done)} ✓` : head
}

function Crew({ c, ctx, live }: { c: BoardTask; ctx: Ctx; live?: boolean }): ReactNode {
  // The ones on it now first; the one who split it shows only when nobody else is on it.
  const shown = c.family.length <= 1 ? [{ agentId: c.agentId, state: 'working' as const }] : c.crew.filter((m) => m.state !== 'done' && !(m.agentId === c.agentId && m.state === 'waiting' && c.crew.length > 1)).slice(0, 3)
  const list = shown.length ? shown : [{ agentId: c.agentId, state: 'done' as const }]
  return (
    <span className="bd-crew">
      {list.map((m) => <span key={m.agentId} className="bd-crew-face"><AgentAvatar agent={ctx.agents.get(m.agentId) ?? { name: '?', color: 'graphite' }} size={18} busy={live && m.state === 'working'} /></span>)}
    </span>
  )
}

function CardView({ c, ctx, focus, fresh, fam, onOpen, onDecide }: { c: BoardTask; ctx: Ctx; focus: boolean; fresh: boolean; fam: boolean; onOpen: () => void; onDecide: (id: string, d: 'approved' | 'refused') => void; onAnswer?: (messageId: string, i: number) => void }): ReactNode {
  const a = ctx.agents.get(c.agentId)
  const conv = ctx.convs.get(c.conversationId)
  const live = c.column === 'doing' && c.crew.some((m) => m.state === 'working')
  const cls = `bd-card ${live ? 'live' : ''} ${c.column === 'you' ? 'wait' : ''} ${c.column === 'done' ? 'done' : ''} ${fresh ? 'fresh' : ''} ${focus ? 'focus' : ''} ${fam ? 'fam' : ''}`
  const stop = (e: ReactMouseEvent): void => e.stopPropagation()
  const parts = c.family.length - 1
  const ready = c.family.slice(1).filter((k) => k.column === 'done').length
  let body: ReactNode
  if (c.column === 'done') {
    const result = c.state === 'stopped' ? L('Parado antes de terminar', 'Stopped before finishing') : firstLine(c.last?.text ?? '') || (c.parts.length ? L('O time entregou', 'The team delivered') : L('Pronto', 'Done'))
    body = (
      <>
        <div className="bd-done-row"><Face agent={a} /><div className="bd-c-title">{c.title}</div><span className="time">{c.endedAt ? new Date(c.endedAt).toLocaleTimeString(locale(), timeOpts({ hour: '2-digit', minute: '2-digit' })) : ''}</span></div>
        <div className={`bd-res ${c.state === 'stopped' ? 'stopped' : ''}`}><Check /><span>{result}</span></div>
      </>
    )
  } else if (c.column === 'you') {
    // What waits on me may be a part, deep in the task: the card says who asks, and what.
    const q = c.asking ?? c
    const asker = ctx.agents.get(q.agentId)
    const approval = q.state === 'approval' ? ctx.inbox.approvals.get(q.last?.run?.approvalId ?? '') : undefined
    const question = q.state === 'question' ? ctx.inbox.questions.get(q.last?.id ?? '') : undefined
    const text = approval ? approval.why || `${approval.connectorName} · ${approval.tool}` : (question?.decisions?.[0]?.question ?? question?.text ?? q.last?.run?.question ?? '')
    body = (
      <>
        <div className="bd-c-top"><Face agent={asker} /><span className="nm">{asker?.name ?? L('Agente', 'Agent')}</span><span className="st">{approval ? L('quer aprovação', 'wants approval') : L('perguntou', 'asked')}</span></div>
        <div className="bd-c-title">{c.title}</div>
        <div className="bd-ask"><b>{asker?.name}:</b> {text}</div>
        <div className="bd-acts" onClick={stop}>
          {approval ? (
            <>
              <button className="bd-btn go sm" onClick={() => onDecide(approval.id, 'approved')}>{L('Aprovar', 'Approve')}</button>
              <button className="bd-btn quiet sm" onClick={() => onDecide(approval.id, 'refused')}>{L('Recusar', 'Refuse')}</button>
            </>
          ) : (
            <button className="bd-btn ink sm" onClick={onOpen}>{L('Responder', 'Answer')}</button>
          )}
          {parts > 0 && <span className="bd-of">{L(`pedido a ${a?.name ?? ''} · ${ready} de ${parts} prontas`, `asked of ${a?.name ?? ''} · ${ready} of ${parts} done`)}</span>}
        </div>
      </>
    )
  } else {
    const waitLine =
      c.family.length <= 1 && c.state === 'asked-up' ? L(`Perguntou pra ${c.waitingOn}`, `Asked ${c.waitingOn}`)
      : c.family.length <= 1 && c.state === 'other' ? L(`Esperando ${c.waitingOn}`, `Waiting for ${c.waitingOn}`)
      : undefined
    const since = c.family.flatMap((k) => k.replies.map((r) => r.at))
    body = (
      <>
        <div className="bd-c-top">
          <Crew c={c} ctx={ctx} live={live} />
          <span className="nm">{crewLine(c, ctx)}</span>
          <span className="time">{live && <Typing />}<Since at={since.length ? Math.min(...since) : c.at} /></span>
        </div>
        <div className="bd-c-title">{c.title}</div>
        {waitLine && <div className="bd-c-wait"><Hourglass /><span>{waitLine}</span></div>}
        {(parts > 0 || conv?.kind === 'channel') && (
          <div className="bd-c-foot">
            {parts > 0 && <span className="bd-bar" aria-label={L(`${ready} de ${parts} partes prontas`, `${ready} of ${parts} parts done`)}><i style={{ width: `${Math.round((ready / parts) * 100)}%` }} /></span>}
            {parts > 0 && <span>{L(`${ready} de ${parts} ${parts === 1 ? 'parte' : 'partes'}`, `${ready} of ${parts} ${parts === 1 ? 'part' : 'parts'}`)}</span>}
            {conv?.kind === 'channel' && <Where conv={conv} />}
          </div>
        )}
      </>
    )
  }
  return (
    <div data-card={c.id} tabIndex={0} className={cls} onClick={onOpen} aria-label={`${c.title}, ${a?.name ?? ''}`} onKeyDown={(e) => e.key === ' ' && (e.preventDefault(), onOpen())}>
      {body}
    </div>
  )
}

// ---------- the open card ----------

const PILL: Record<BoardCard['column'], () => string> = { doing: () => L('Fazendo', 'Doing'), you: () => L('Precisa de você', 'Needs you'), done: () => L('Feito', 'Done'), stuck: () => L('Parou', 'Stopped') }

const BEAT_MARK: Record<CrewMember['state'], () => string> = { working: () => L('fazendo', 'on it'), you: () => L('esperando você', 'waiting for you'), waiting: () => L('na fila', 'queued'), done: () => '✓', stuck: () => L('parou', 'stopped') }

// A task's story, one line per step of the team: who asked, who split it, each part (nested when a
// part was handed on again). A line opens that agent's part, with its steps.
function Story({ task, ctx, onNav }: { task: BoardTask; ctx: Ctx; onNav: (id: string) => void }): ReactNode {
  const time = (at: number): string => new Date(at).toLocaleTimeString(locale(), timeOpts({ hour: '2-digit', minute: '2-digit' }))
  return (
    <ol className="bd-story">
      {storyOf(task).map((b, i) => {
        const ag = b.agentId ? ctx.agents.get(b.agentId) : undefined
        const who = b.kind === 'asked' ? (b.by?.kind === 'routine' ? L(`Rotina “${b.by.name}”`, `Routine “${b.by.name}”`) : (b.by?.name ?? '')) : (ag?.name ?? '')
        const to = ctx.agents.get(task.agentId)?.name ?? ''
        const what =
          b.kind === 'asked' ? (b.by?.kind === 'routine' ? L(`rodou pro ${to}`, `ran for ${to}`) : L(`pediu a ${to}`, `asked ${to}`))
          : b.kind === 'split' ? L(`dividiu em ${b.title}`, `split it into ${b.title}`)
          : b.kind === 'delivered' ? L('juntou as partes e entregou', 'put the parts together and delivered')
          : b.title
        const opens = b.kind === 'part'
        const line = (
          <>
            <span className="face">{ag ? <AgentAvatar agent={ag} size={20} busy={b.state === 'working'} /> : <span className="bd-me-dot" />}</span>
            <span className="tx"><b>{who}</b> {what}</span>
            {b.kind === 'part' && <span className={`mark ${b.state}`}>{BEAT_MARK[b.state]()}</span>}
            <span className="at">{time(b.at)}</span>
          </>
        )
        return (
          <li key={`${b.cardId}:${b.kind}:${i}`} style={{ paddingLeft: `${Math.max(0, b.depth - 1) * 22}px` }} className={b.state === 'you' && b.kind === 'part' ? 'you' : ''}>
            {opens ? <button onClick={() => onNav(b.cardId)}>{line}</button> : <div>{line}</div>}
          </li>
        )
      })}
    </ol>
  )
}

function CardPanel({ c, ctx, onNav, onClose, onAgain }: { c: BoardCard; ctx: Ctx; onNav: (id: string) => void; onClose: () => void; onAgain: (c: BoardCard) => void }): ReactNode {
  const task = ctx.tasks.get(c.id)
  const team = task && task.family.length > 1 ? task : undefined
  // What waits on me may be a part of it: the decision is that part's.
  const q = task?.asking ?? c
  const a = ctx.agents.get(c.agentId)
  const conv = ctx.convs.get(c.conversationId)
  const parent = c.parent ? ctx.cards.get(c.parent) : undefined
  const request = useStore((s) => (c.requestId ? (s.messages[c.conversationId] ?? []).find((m) => m.id === c.requestId) : undefined))
  const people = useStore((s) => s.people.length > 1)
  const [showSteps, setShowSteps] = useState(!team)
  const [details, setDetails] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const last = c.last
  const run = last?.run
  const approval = q.state === 'approval' ? ctx.inbox.approvals.get(q.last?.run?.approvalId ?? '') : undefined
  const question = q.state === 'question' && q.last ? ctx.inbox.questions.get(q.last.id) : undefined
  const qAgent = ctx.agents.get(q.agentId)
  const steps = stepsOf(c)
  const cost = costOf(c)
  const kids = c.parts.map((p) => ctx.cards.get(p)).filter((k): k is BoardCard => !!k)
  const artifacts = c.replies.flatMap((r) => r.run?.artifactIds ?? [])
  const plainQuestion = q === c && c.state === 'question' && !question?.decisions?.length
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(120, el.scrollHeight)}px`
  }, [draft])
  const send = (): void => {
    const t = draft.trim()
    if (!t) return
    sendMessage(c.conversationId, t, [], c.threadId)
    setDraft('')
    toast(L(`Mandei pra ${a?.name ?? 'o agente'}.`, `Sent to ${a?.name ?? 'the agent'}.`))
  }
  const goConversation = (): void => {
    navigate({ kind: 'conversation', id: c.conversationId, message: c.threadId ?? c.requestId ?? last?.id })
    if (c.threadId) openThread(c.threadId)
  }
  const chat: { me: boolean; text: string; id: string }[] = [
    ...(request && request.text.trim() ? [{ me: request.author.kind === 'person', text: request.text, id: request.id }] : []),
    ...c.replies.filter((r) => r.text.trim() && !(c.column === 'done' && r === last)).map((r) => ({ me: false, text: r.text, id: r.id }))
  ]
  const by = c.by.kind === 'routine' ? L(`Rodou pela rotina “${c.by.name}”`, `Run by the routine “${c.by.name}”`) : c.by.kind === 'agent' ? L(`Pedido por ${c.by.name}`, `Asked by ${c.by.name}`) : L(`Pedido por ${c.by.name}`, `Asked by ${c.by.name}`)
  const where = conv ? (conv.kind === 'channel' ? L(`em #${conv.name}`, `in #${conv.name}`) : L('na DM', 'in the DM')) : ''
  const working = c.column === 'doing' && c.state === 'working'
  return (
    <aside className="bd-side" role="dialog" aria-label={c.title}>
      <div className="bd-side-body">
        <div className="bd-side-top">
          {team ? (
            <>
              <span className="bd-crew big">{team.crew.map((m) => <span key={m.agentId} className="bd-crew-face"><AgentAvatar agent={ctx.agents.get(m.agentId) ?? { name: '?', color: 'graphite' }} size={30} busy={m.state === 'working'} /></span>)}</span>
              <div><b>{names(team.crew.map((m) => ctx.agents.get(m.agentId)?.name ?? ''))}</b><small>{L(`${team.family.length - 1} partes · ${team.family.slice(1).filter((k) => k.column === 'done').length} prontas`, `${team.family.length - 1} parts · ${team.family.slice(1).filter((k) => k.column === 'done').length} done`)}</small></div>
            </>
          ) : (
            <>
              <Face agent={a} size={44} busy={working} />
              <div><b>{a?.name}</b><small>{a?.role}</small></div>
            </>
          )}
          <span className="bd-grow" />
          <span className={`bd-pill ${c.column}`}>{PILL[c.column]()}</span>
          <button className="bd-icon-btn" onClick={onClose} aria-label={L('Fechar', 'Close')}>✕</button>
        </div>
        {parent && <div className="bd-crumb">↳ {L('parte de', 'part of')} <button onClick={() => onNav(parent.id)}>{parent.title}</button> · {ctx.agents.get(parent.agentId)?.name}</div>}
        <h3>{c.title}</h3>
        <div className="bd-by">
          {by} · {where} · {ago(c.at)}
          {working && c.replies[0] && <> · {L('trabalhando há', 'working for')} <Since at={c.replies[0].at} /></>}
        </div>

        {approval && <div className="bd-box">{q !== c && <div className="bd-box-who">{L(`${qAgent?.name ?? ''} pediu`, `${qAgent?.name ?? ''} asks`)}</div>}<ApprovalCard approval={approval} /></div>}
        {question && q.last && (
          <div className="bd-box">
            <QuestionCard id={q.last.id} agentName={qAgent?.name} askedTo={question.askedTo} question={question.text} {...(question.decisions ? { decisions: question.decisions, ...(question.answers ? { answers: question.answers } : {}) } : {})} answered={false} inbox />
          </div>
        )}
        {c.column === 'stuck' && run?.error && <div className="bd-box bad"><b>{c.state === 'paused' ? L('Pausou:', 'Paused:') : L('Parou:', 'Stopped:')}</b> {run.error}</div>}

        {c.column === 'done' && (
          <>
            <div className="bd-sec">{L('Resultado', 'Result')}</div>
            <div className="bd-reply">{last?.text.trim() ? <ReplyText text={last.text} /> : <p>{c.state === 'stopped' ? L('Parado antes de terminar.', 'Stopped before finishing.') : L('Pronto, sem texto na resposta.', 'Done, with no text in the reply.')}</p>}</div>
          </>
        )}
        {artifacts.length > 0 && <div className="bd-outs">{artifacts.map((id) => <ArtifactCard key={id} id={id} />)}</div>}

        {team ? (
          <>
            <div className="bd-sec">{L('Histórico', 'History')}</div>
            <Story task={team} ctx={ctx} onNav={onNav} />
          </>
        ) : kids.length > 0 && (
          <>
            <div className="bd-sec">{L(`O time · ${kids.filter((k) => k.column === 'done').length} de ${kids.length} partes prontas`, `The team · ${kids.filter((k) => k.column === 'done').length} of ${kids.length} parts done`)}</div>
            <div className="bd-tree">
              {kids.map((k) => {
                const ka = ctx.agents.get(k.agentId)
                return (
                  <button key={k.id} onClick={() => onNav(k.id)}>
                    <Face agent={ka} size={30} />
                    <span className="tx"><b>{k.title}</b><small>{ka?.name} · {statusOf(k, ctx)}</small></span>
                    <span className={`bd-pill ${k.column}`}>{PILL[k.column]()}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}

        {(steps.length > 0 || c.state === 'parts') && !showSteps && (
          <button className="bd-sec bd-sec-btn" onClick={() => setShowSteps(true)}>› {L(`Passos de ${a?.name ?? ''} · ${steps.length}`, `${a?.name ?? ''}'s steps · ${steps.length}`)}</button>
        )}
        {(steps.length > 0 || c.state === 'parts') && showSteps && (
          <>
            <div className="bd-sec">{L('Passos', 'Steps')}</div>
            <ul className="bd-tl">
              {steps.map((s) => {
                const key = `${s.replyId}:${s.id}`
                const more = [s.input, s.output && `→ ${s.output}`, s.detail, s.error].filter(Boolean).join('\n')
                const isLive = s.status === 'running' && working
                return (
                  <li key={key} className={s.status === 'error' ? 'error' : s.status === 'done' ? 'done' : isLive ? 'live' : ''}>
                    <span className="pt"><i /></span>
                    <span className="lbl">
                      {s.label}
                      {s.note && <span className="note">{s.note}</span>}
                      {more && <button className="more" onClick={() => setDetails((d) => { const n = new Set(d); if (n.has(key)) n.delete(key); else n.add(key); return n })}>{details.has(key) ? L('Esconder detalhes', 'Hide details') : L('Ver detalhes', 'See details')}</button>}
                      {more && details.has(key) && <pre>{more}</pre>}
                    </span>
                    <span className="dur">{isLive ? L('agora', 'now') : s.ms ? span(s.ms) : ''}</span>
                  </li>
                )
              })}
              {c.state === 'parts' && <li><span className="pt"><i /></span><span className="lbl" style={{ color: 'var(--text)' }}>{L('Esperando as partes do time', 'Waiting on the team’s parts')}</span><span className="dur" /></li>}
            </ul>
          </>
        )}

        <div className="bd-sec">{L('Na conversa', 'In the conversation')}</div>
        <div className="bd-chat">
          {chat.map((m) => (m.me ? <div key={m.id} className="bd-bub me">{m.text}</div> : <div key={m.id} className="bd-bub it"><Face agent={a} /><span>{m.text}</span></div>))}
          {working && <div className="bd-bub it"><Face agent={a} busy /><span className="bd-shimmer">{liveStep(c) ?? L('Pensando', 'Thinking')}…</span></div>}
        </div>
        {a && c.column !== 'stuck' && (!question || plainQuestion) && (
          <>
            <div className="bd-composer">
              <textarea ref={area} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} placeholder={plainQuestion ? L(`Responder pra ${a.name}…`, `Answer ${a.name}…`) : L(`Escrever pra ${a.name}…`, `Write to ${a.name}…`)} aria-label={L('Escrever pro agente', 'Write to the agent')} />
              <button onClick={send} disabled={!draft.trim()} aria-label={L('Enviar', 'Send')}><Send /></button>
            </div>
            <div className="bd-hint">{plainQuestion && !people ? L('A sua resposta vai pra conversa, e o agente continua.', 'Your answer goes to the conversation and the agent continues.') : c.threadId ? (c.column === 'done' ? L('Pede um ajuste: vai pra mesma thread.', 'Ask for a change: it goes to the same thread.') : L('Muda o rumo sem parar o trabalho: vai pra mesma thread.', 'Change course without stopping: it goes to the same thread.')) : L(`Vai pra ${where.replace(/^(em|na|in) /, '') || 'conversa'}, como uma mensagem sua.`, `Goes to ${where.replace(/^in (the )?/, '') || 'the conversation'}, as your message.`)}</div>
          </>
        )}
      </div>
      <div className="bd-side-foot">
        <span className="cost">{span(cost.ms)}{cost.tokens ? ` · ${tokenWords(cost.tokens)} tokens` : ''}</span>
        {working && last && <button className="bd-btn quiet danger" onClick={() => stopRun(last.id)}>{L('Parar', 'Stop')}</button>}
        {c.column === 'stuck' && last && (c.state === 'paused' || canContinue(run!) ? <button className="bd-btn soft" onClick={() => continueRun(last.id)}>{L('Continuar', 'Continue')}</button> : RETRYABLE.has(run!.status) && <button className="bd-btn soft" onClick={() => retryRun(last.id)}>{L('Tentar de novo', 'Try again')}</button>)}
        {c.column === 'done' && !c.parent && <button className="bd-btn soft" onClick={() => onAgain(c)}>{L('Fazer de novo', 'Do it again')}</button>}
        <button className="bd-btn ink" onClick={goConversation}>{L('Abrir na conversa', 'Open in the conversation')}</button>
      </div>
    </aside>
  )
}

// ---------- a to-do, being written ----------

function TaskPanel({ t, team, conversations, onClose, save, onStart, onRemove }: { t: Task; team: Agent[]; conversations: Conversation[]; onClose: () => void; save: (t: Partial<Task> & { title: string }) => Promise<Task | undefined>; onStart: (t: Task) => void; onRemove: (t: Task) => void }): ReactNode {
  const [title, setTitle] = useState(t.title)
  const [notes, setNotes] = useState(t.notes ?? '')
  const a = t.agentId ? team.find((x) => x.id === t.agentId) : undefined
  const places = conversations.filter((c) => c.kind === 'channel' && (!t.agentId || c.members.includes(t.agentId)))
  const due = t.dueAt ? new Date(t.dueAt) : undefined
  const dueValue = due ? `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}` : ''
  const words = async (): Promise<Task | undefined> => {
    const tt = title.trim()
    if (!tt) return t
    if (tt === t.title && notes === (t.notes ?? '')) return t
    return save({ id: t.id, title: tt, notes })
  }
  return (
    <aside className="bd-side" role="dialog" aria-label={t.title}>
      <div className="bd-side-body">
        <div className="bd-side-top">
          <Face agent={a} size={44} />
          <div><b>{a?.name ?? L('Sem agente', 'No agent')}</b><small>{a?.role ?? L('escolha quem faz', 'pick who does it')}</small></div>
          <span className="bd-grow" />
          <span className="bd-pill todo">{L('A fazer', 'To do')}</span>
          <button className="bd-icon-btn" onClick={() => void words().then(onClose)} aria-label={L('Fechar', 'Close')}>✕</button>
        </div>
        <div className="bd-form">
          <input className="title-in" value={title} maxLength={MAX_TASK_TITLE} onChange={(e) => setTitle(e.target.value)} onBlur={() => void words()} aria-label={L('Título', 'Title')} />
          <label>
            {L('Detalhes pro agente', 'Details for the agent')}
            <textarea value={notes} maxLength={MAX_TASK_NOTES} onChange={(e) => setNotes(e.target.value)} onBlur={() => void words()} placeholder={L('O que ele precisa saber: contexto, o que conta como pronto, onde estão as coisas.', 'Include context, completion criteria and relevant locations.')} />
          </label>
          <label>
            {L('Quem faz', 'Who does it')}
            <span className="bd-pick">
              {team.map((x) => (
                <button key={x.id} type="button" aria-pressed={t.agentId === x.id} onClick={() => void save({ id: t.id, title: title.trim() || t.title, agentId: x.id, ...(t.conversationId && !conversations.find((c) => c.id === t.conversationId)?.members.includes(x.id) ? { conversationId: '' } : {}) })}>
                  <AgentAvatar agent={x} size={22} />{x.name}
                </button>
              ))}
            </span>
          </label>
          <div className="bd-row2">
            <label>
              {L('Onde', 'Where')}
              <select value={t.conversationId ?? ''} onChange={(e) => void save({ id: t.id, title: title.trim() || t.title, conversationId: e.target.value })}>
                <option value="">{a ? L(`DM com ${a.name}`, `DM with ${a.name}`) : 'DM'}</option>
                {places.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            </label>
            <label>
              {L('Prazo', 'Due')}
              <input type="date" value={dueValue} onChange={(e) => {
                const [y, m, d] = e.target.value.split('-').map(Number)
                void save({ id: t.id, title: title.trim() || t.title, dueAt: y && m && d ? new Date(y, m - 1, d, 12).getTime() : 0 })
              }} />
            </label>
          </div>
        </div>
      </div>
      <div className="bd-side-foot">
        <span className="cost">{L(`Criada ${ago(t.createdAt)}`, `Created ${ago(t.createdAt)}`)}</span>
        <button className="bd-btn quiet danger" onClick={() => onRemove(t)}>{L('Apagar', 'Delete')}</button>
        <button className="bd-btn ink" onClick={() => void words().then((x) => x && onStart(x))}>{L('Começar', 'Start')}</button>
      </div>
    </aside>
  )
}

