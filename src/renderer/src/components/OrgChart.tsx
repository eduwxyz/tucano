// The organogram (src/shared/org.ts) as a board: every agent is a card that goes where I put it, me
// at the top, and a line from whoever is above to whoever answers to them. The board pans and zooms.
// A line is made by pulling one from a card's dot to another card, and unmade from the line itself.
// Work handed down (src/core/delegations.ts) shows as it happens: the line it travels lights up and a
// dot runs along it, the card says what its agent is doing right now. A click on a card opens what
// there is to know and change about it; the box at the bottom asks it something without leaving.
import { L } from '../../../shared/lang'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { bossOf, channelsOf, depthBelow, directReports, loops, MAX_LINE, orgTree, overLine, possibleBosses, reportsOf } from '../../../shared/org'
import { above, BOARD, boundsOf, curve, fitView, MAX_K, ME, MIN_K, pathBetween, spotsOf, tidyBoard, toBoard, under, zoomAt, type Point, type Spots, type View } from '../../../shared/org-layout'
import { amAdmin, askAgent, isTeam, navigate, openDm, openThread, openTuca, saveAgent, setTab, updateSettings, useStore, workingOn, type Agent, type Conversation, type Delegation, type Message } from '../store'
import { Sheet } from './Pages'
import { Select } from './Select'
import { ago, AgentAvatar, Icon, MeAvatar } from './ui'

const UNDO_MS = 9000 // how long a change to who answers to whom can be taken back from the board
const SLOP = 4 // px a pointer moves before a press becomes a drag
const ASK_ROOM = 64 // what the box that asks takes at the bottom of the board
const SIDE_ROOM = 352 // and the agent picked, at its right
const NO_VIEW: View = { x: 0, y: 0, k: 1 }

const snip = (text: string, max = 70): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
// What a reply at work is doing right now, in a few words.
const doingNow = (m: Message | undefined): string => {
  const step = m?.run?.steps.at(-1)
  return step ? snip(step.detail ? `${step.label}: ${step.detail}` : step.label, 46) : L('trabalhando agora', 'working now')
}
// What the pointer is doing between a press and its release.
type Gesture =
  | { kind: 'pan'; x: number; y: number; view: View }
  | { kind: 'card'; id: string; ids: string[]; x: number; y: number; k: number; dragged: boolean }
  | { kind: 'link'; from: string; side: 'out' | 'in' }

export function OrgPage(): ReactNode {
  const all = useStore((s) => s.agents)
  const conversations = useStore((s) => s.conversations)
  const me = useStore((s) => s.me)
  const saved = useStore((s) => s.settings?.orgLayout)
  const admin = useStore(amAdmin)
  const on = useStore(workingOn)
  const delegations = useStore((s) => s.delegations)
  const agents = all.filter(isTeam)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const { roots, loose } = orgTree(agents)
  const open = delegations.filter((d) => d.state === 'open' && byId.has(d.from) && byId.has(d.to))
  const base = spotsOf([ME, ...agents.map((a) => a.id)], tidyBoard(roots, loose), saved)

  const board = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const hover = useRef<string | null>(null)
  const [room, setRoom] = useState({ w: 0, h: 0 })
  const [stored, setView] = useState<View | null>(null)
  const [sent, setSent] = useState<string | null>(null) // whoever was just asked something, for a moment
  const mine = useRef(false) // I moved or zoomed the board: it stays where I left it
  const [moved, setMoved] = useState<{ ids: string[]; dx: number; dy: number } | null>(null)
  const [link, setLink] = useState<{ from: string; side: 'out' | 'in'; to: Point } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [edge, setEdge] = useState<string | null>(null) // the one below, of the line picked
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  // The last change to who answers to whom: what it was, in words, and how each one stood before it.
  const [undo, setUndo] = useState<{ text: string; was: [string, string | null][] } | null>(null)
  const view = stored ?? NO_VIEW
  const spot = (id: string): Point => {
    const p = base[id] ?? { x: 0, y: 0 }
    return moved?.ids.includes(id) ? { x: p.x + moved.dx, y: p.y + moved.dy } : p
  }
  // With nobody answering to anybody a word on how it works takes the left of the board: the cards fit beside it.
  const fitTo = (spots: Spots, coach = roots.length === 0): void => {
    if (!room.w) return
    const wide = room.w > 900
    const left = coach && wide ? 380 : 0
    const right = picked && wide ? SIDE_ROOM : 0
    const v = fitView(boundsOf(Object.values(spots)), { w: room.w - left - right, h: room.h - ASK_ROOM })
    mine.current = false
    setView({ ...v, x: v.x + left })
  }
  const fit = (): void => fitTo(base)

  useLayoutEffect(() => {
    const el = board.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = (): void => setRoom({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Everything in sight when the page opens, when the window changes (unless I moved the board myself),
  // and when the first line is made or the last one goes: the cards change places then.
  const bare = roots.length === 0
  useEffect(() => {
    if (!mine.current) fit()
  }, [room.w, room.h]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (stored) fit()
  }, [bare]) // eslint-disable-line react-hooks/exhaustive-deps
  // The agent picked opens at the side: the cards make room, unless the board is where I left it.
  const sided = !!picked
  useEffect(() => {
    if (stored && !mine.current) fit()
  }, [sided]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => setUndo(null), UNDO_MS)
    return () => clearTimeout(t)
  }, [undo])
  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setSent(null), 2600)
    return () => clearTimeout(t)
  }, [sent])
  // Two fingers move the board; a pinch (or ⌘/Ctrl and the wheel) zooms where the pointer is.
  useEffect(() => {
    const el = board.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if ((e.target as Element).closest?.('.org-side, .org-ask, .org-coach')) return
      e.preventDefault()
      mine.current = true
      const r = el.getBoundingClientRect()
      setView((v) => {
        const now = v ?? NO_VIEW
        return e.ctrlKey || e.metaKey ? zoomAt(now, { x: e.clientX - r.left, y: e.clientY - r.top }, now.k * Math.exp(-e.deltaY * 0.01)) : { ...now, x: now.x - e.deltaX, y: now.y - e.deltaY }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const channels = (id: string): Conversation[] => channelsOf(conversations, id)
  const put = async (id: string, to: string | null): Promise<boolean> => {
    const agent = byId.get(id)
    if (!agent || (agent.reportsTo ?? null) === to) return false
    try {
      await saveAgent({ ...agent, reportsTo: to ?? undefined }, channels(id).map((c) => c.id))
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }
  // One change (several agents at once, from the start's pick), which can be taken back for a moment.
  const moveAll = async (ids: string[], to: string | null, said?: string): Promise<void> => {
    setError(null)
    const was: [string, string | null][] = []
    for (const id of ids) {
      const before = byId.get(id)?.reportsTo ?? null
      if (await put(id, to)) was.push([id, before])
    }
    if (!was.length) return
    const who = byId.get(was[0]![0])?.name ?? ''
    const boss = to ? byId.get(to)?.name : undefined
    setUndo({ was, text: said ?? (boss ? L(`${who} agora responde a ${boss}.`, `${who} answers to ${boss} now.`) : L(`${who} não responde mais a ninguém.`, `${who} answers to no one now.`)) })
  }
  const move = (id: string, to: string | null): Promise<void> => moveAll([id], to)
  const takeBack = async (): Promise<void> => {
    if (!undo) return
    setUndo(null)
    setError(null)
    // Latest first, so a line that depended on another is undone before it.
    for (const [id, to] of [...undo.was].reverse()) await put(id, to)
  }
  // Why a line can't end there, when it's the length of the line and not a loop: worth saying, since nothing on the card shows it.
  const tooLong = (boss: string, id: string): boolean => boss !== ME && id !== ME && boss !== id && byId.has(boss) && byId.has(id) && byId.get(id)?.reportsTo !== boss && !loops(agents, id, boss) && overLine(agents, id, boss)
  // `id` may answer to `boss` unless it already does or that closes a loop.
  const takes = (boss: string, id: string): boolean => {
    const agent = byId.get(id)
    return !!agent && agent.reportsTo !== boss && possibleBosses(agents, id).some((a) => a.id === boss)
  }
  // A line pulled from under a card ends on whoever will answer to it; from above, on whoever it will
  // answer to (on me: to no one).
  const lands = (from: string, side: 'out' | 'in', target: string): boolean =>
    target !== from && (side === 'out' ? target !== ME && takes(from, target) : target === ME ? !!byId.get(from)?.reportsTo : takes(target, from))

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = board.current?.getBoundingClientRect?.()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }
  const begin = (g: Gesture): void => {
    gesture.current = g
    const onMove = (e: PointerEvent): void => {
      if (g.kind === 'pan') (mine.current = true), setView({ ...g.view, x: g.view.x + e.clientX - g.x, y: g.view.y + e.clientY - g.y })
      else if (g.kind === 'link') setLink({ from: g.from, side: g.side, to: toBoard(view, local(e)) })
      else {
        const dx = e.clientX - g.x
        const dy = e.clientY - g.y
        if (!g.dragged && Math.hypot(dx, dy) < SLOP) return
        g.dragged = true // a drag, not a click, even for whoever can't move anything
        if (admin) setMoved({ ids: g.ids, dx: dx / g.k, dy: dy / g.k })
      }
    }
    const onUp = (e: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      gesture.current = null
      if (g.kind === 'link') {
        const target = hover.current
        setLink(null)
        setOver(null)
        if (target && lands(g.from, g.side, target)) void (g.side === 'out' ? move(target, g.from) : move(g.from, target === ME ? null : target))
        else if (target && (g.side === 'out' ? tooLong(g.from, target) : tooLong(target, g.from))) setError(L(`Uma linha tem no máximo ${MAX_LINE} agentes, de cima a baixo. Quem está acima já alcança todos os de baixo, sem precisar de mais um no meio.`, `A line holds at most ${MAX_LINE} agents, top to bottom. Whoever is above already reaches everyone below, with no need for one more in between.`))
      } else if (g.kind === 'card') {
        setMoved(null)
        if (!g.dragged) return void (g.id !== ME && (setEdge(null), setPicked((p) => (p === g.id ? null : g.id))))
        if (!admin) return
        // Once something is placed by hand, everything stays where it is: the board is mine from then on.
        const dx = (e.clientX - g.x) / g.k
        const dy = (e.clientY - g.y) / g.k
        const next: Spots = {}
        for (const [id, p] of Object.entries(base)) next[id] = g.ids.includes(id) ? { x: Math.round(p.x + dx), y: Math.round(p.y + dy) } : { x: Math.round(p.x), y: Math.round(p.y) }
        updateSettings({ orgLayout: next })
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }
  const press = (e: ReactPointerEvent): boolean => (e.button ?? 0) === 0
  const onBoard = (e: ReactPointerEvent): void => {
    if (!press(e) || (e.target as Element).closest('.org-card, .org-side, .org-ask, .org-coach, .org-tools, .org-edge-x, .orgb__hit')) return
    setPicked(null)
    setEdge(null)
    begin({ kind: 'pan', x: e.clientX, y: e.clientY, view })
  }
  // A card takes everyone below along, like a branch; with ⌥, it goes alone.
  const onCard = (id: string) => (e: ReactPointerEvent): void => {
    if (!press(e)) return
    begin({ kind: 'card', id, ids: id === ME || e.altKey ? [id] : [id, ...reportsOf(agents, id).map((a) => a.id)], x: e.clientX, y: e.clientY, k: view.k, dragged: false })
  }
  const onPort = (id: string, side: 'out' | 'in') => (e: ReactPointerEvent): void => {
    if (!press(e)) return
    e.stopPropagation()
    setPicked(null)
    setEdge(null)
    setLink({ from: id, side, to: toBoard(view, local(e)) })
    begin({ kind: 'link', from: id, side })
  }
  const enter = (id: string) => (): void => {
    hover.current = id
    if (gesture.current?.kind === 'link') setOver(id)
  }
  const leave = (id: string) => (): void => {
    if (hover.current === id) hover.current = null
    setOver((o) => (o === id ? null : o))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')
      if (e.key === 'Escape') (setPicked(null), setEdge(null))
      else if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && undo && !typing) (e.preventDefault(), void takeBack())
      else if ((e.key === 'Backspace' || e.key === 'Delete') && edge && admin && !typing) (void move(edge, null), setEdge(null))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The lines each open request travels, and which way: down while it's being done, up while a question waits.
  // Between colleagues it goes up to the agent both answer to and down the other side.
  const flowing = new Map<string, 'down' | 'up'>()
  const bossId = (id: string): string | undefined => bossOf(agents, byId.get(id)!)?.id
  for (const d of open) {
    const hops = pathBetween(bossId, d.from, d.to)
    const shared = hops.length ? undefined : bossId(d.from)
    const way: [string, 'down' | 'up'][] = hops.length
      ? hops.map(([boss, below]) => [`${boss}>${below}`, d.asking ? 'up' : 'down'])
      : shared && shared === bossId(d.to)
        ? [[`${shared}>${d.from}`, d.asking ? 'down' : 'up'], [`${shared}>${d.to}`, d.asking ? 'up' : 'down']]
        : []
    for (const [line, dir] of way) flowing.set(line, dir === 'up' ? 'up' : flowing.get(line) ?? 'down')
  }
  const lines = [
    ...roots.map((r) => ({ from: ME, to: r.agent.id })),
    ...agents.flatMap((a) => {
      const boss = bossOf(agents, a)
      return boss ? [{ from: boss.id, to: a.id }] : []
    })
  ].map((l) => ({ ...l, a: under(spot(l.from)), b: above(spot(l.to)) }))

  const levels = roots.length ? 1 + Math.max(...roots.map((r) => depthBelow(agents, r.agent.id))) : 0
  const inTree = agents.length - loose.length
  const lede = roots.length
    ? [
        inTree === 1 ? L('1 agente', '1 agent') : L(`${inTree} agentes`, `${inTree} agents`),
        levels === 1 ? L('1 nível', '1 level') : L(`${levels} níveis`, `${levels} levels`),
        open.length ? (open.length === 1 ? L('1 pedido em andamento', '1 request under way') : L(`${open.length} pedidos em andamento`, `${open.length} requests under way`)) : L('nenhum pedido em andamento', 'no request under way')
      ].join(' · ')
    : L('Quem responde a quem, e o que está andando agora.', 'Who answers to whom, and what is under way right now.')
  const goThread = (d: Delegation): void => (navigate({ kind: 'conversation', id: d.conversationId, message: d.rootId }), openThread(d.rootId))
  const goLive = (m: Message): void => (navigate({ kind: 'conversation', id: m.conversationId, message: m.threadId ?? m.id }), void (m.threadId && openThread(m.threadId)))
  const chosen = picked ? byId.get(picked) : undefined
  // Whoever the box at the bottom talks to: the card picked, or else whoever is at the top.
  const asked = chosen ?? roots[0]?.agent
  const send = (): void => {
    const what = text.trim()
    if (!asked || !what) return
    setText('')
    askAgent(asked.id, what).then(
      () => setSent(asked.name),
      (e: unknown) => (setText(what), setError(e instanceof Error ? e.message : String(e)))
    )
  }
  const zoom = (f: number): void => ((mine.current = true), setView(zoomAt(view, { x: room.w / 2, y: room.h / 2 }, view.k * f)))
  const size = { width: BOARD.w, height: BOARD.h }
  const cut = lines.find((l) => l.to === edge && l.from !== ME)

  return (
    <Sheet
      fill
      title={L('Time', 'Team')}
      lede={lede}
      actions={
        admin ? (
          <>
            {saved && (
              <button className="btn btn--ghost btn--sm org-tidy" title={L('Volta cada cartão pro lugar dele na árvore', 'Puts each card back in its place in the tree')} onClick={() => (updateSettings({ orgLayout: null as unknown as undefined }), fitTo(tidyBoard(roots, loose)))}>
                {L('Organizar', 'Tidy up')}
              </button>
            )}
            <button className="btn btn--primary btn--sm" title={L('Novo agente: abre o Tuca', 'New agent: opens Tuca')} onClick={openTuca}>
              <Icon name="plus" size={14} /> {L('Novo agente', 'New agent')}
            </button>
          </>
        ) : undefined
      }
    >
      {open.length > 0 && (
        <div className="cal-watch org-now">
          <span className="cal-watch__label">{L('Agora', 'Now')}</span>
          {open.map((d) => (
            <button key={d.id} className="cal-watch__chip" title={d.text} onClick={() => goThread(d)}>
              <i className={d.asking ? 'is-asking' : ''} />
              <AgentAvatar agent={byId.get(d.from)!} size={15} />
              <Icon name="back" size={11} />
              <AgentAvatar agent={byId.get(d.to)!} size={15} busy={on.has(d.to)} />
              {snip(d.text, 48)}
              <span className="org-now__when">{d.asking ? L('pergunta esperando', 'a question waits') : ago(d.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="field__error org-error" role="alert">{error}</p>}

      <div
        ref={board}
        className={`orgb ${moved ? 'is-moving' : ''} ${link ? 'is-linking' : ''} ${chosen ? 'has-side' : ''}`}
        style={{ backgroundSize: `${24 * view.k}px ${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={onBoard}
      >
        <div className="orgb__stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="orgb__lines" width="1" height="1" aria-hidden="true">
            {lines.map((l) => {
              const flow = flowing.get(`${l.from}>${l.to}`)
              const d = curve(l.a, l.b)
              const mine = l.from === ME
              return (
                <g key={`${l.from}>${l.to}`} className={`${mine ? 'is-me' : ''} ${flow ? `is-flow is-${flow}` : ''} ${edge === l.to && !mine ? 'is-picked' : ''}`}>
                  <path d={d} className="orgb__line" />
                  {flow && (
                    <circle r="4.5" className="orgb__dot">
                      <animateMotion dur="1.6s" repeatCount="indefinite" path={d} keyPoints={flow === 'up' ? '1;0' : '0;1'} keyTimes="0;1" calcMode="linear" />
                    </circle>
                  )}
                  {admin && !mine && <path d={d} className="orgb__hit" onPointerDown={(e) => (e.stopPropagation(), setPicked(null), setEdge(edge === l.to ? null : l.to))} />}
                </g>
              )
            })}
            {link && <path className="orgb__line is-new" d={link.side === 'out' ? curve(under(spot(link.from)), link.to) : curve(link.to, above(spot(link.from)))} />}
          </svg>
          {cut && admin && (
            <button
              className="org-edge-x"
              style={{ left: (cut.a.x + cut.b.x) / 2, top: (cut.a.y + cut.b.y) / 2 }}
              title={L(`${byId.get(cut.to)?.name} deixa de responder a ${byId.get(cut.from)?.name} (Delete)`, `${byId.get(cut.to)?.name} stops answering to ${byId.get(cut.from)?.name} (Delete)`)}
              aria-label={L('Desfazer a ligação', 'Remove the link')}
              onClick={() => (void move(cut.to, null), setEdge(null))}
            >
              <Icon name="x" size={12} />
            </button>
          )}
          {(() => {
            const p = spot(ME)
            const target = !!link && lands(link.from, link.side, ME)
            return (
              <div
                className={`org-card org-card--me ${moved?.ids.includes(ME) ? 'is-moving' : ''} ${target ? 'is-target' : ''} ${target && over === ME ? 'is-over' : ''} ${link && !target ? 'is-dim' : ''}`}
                data-org={ME}
                style={{ left: p.x, top: p.y, ...size }}
                onPointerDown={onCard(ME)}
                onPointerEnter={enter(ME)}
                onPointerLeave={leave(ME)}
              >
                <MeAvatar initials={me.initials} size={40} />
                <span className="org-card__who">
                  <strong>{me.name || L('Você', 'You')}</strong>
                  <span>{L('pede, decide e aprova', 'asks, decides and approves')}</span>
                </span>
              </div>
            )
          })()}
          {agents.map((a) => {
            const p = spot(a.id)
            const target = !!link && lands(link.from, link.side, a.id)
            return (
              <Card
                key={a.id}
                agent={a}
                style={{ left: p.x, top: p.y, ...size }}
                admin={admin}
                channels={channels(a.id)}
                live={on.get(a.id)}
                doing={open.filter((d) => d.to === a.id)}
                asked={open.filter((d) => d.from === a.id).length}
                team={directReports(agents, a.id).length}
                bossName={a.reportsTo ? byId.get(a.reportsTo)?.name : undefined}
                moving={!!moved?.ids.includes(a.id)}
                picked={picked === a.id}
                linking={link?.from === a.id}
                target={target}
                over={target && over === a.id}
                dim={!!link && !target && link.from !== a.id}
                onPointerDown={onCard(a.id)}
                onPointerEnter={enter(a.id)}
                onPointerLeave={leave(a.id)}
                onPort={(side) => onPort(a.id, side)}
                onPick={() => (setEdge(null), setPicked(picked === a.id ? null : a.id))}
                onOpen={() => void openDm(a.id)}
              />
            )
          })}
        </div>

        {roots.length === 0 && <Coach agents={agents} admin={admin} onPick={(top) => void moveAll(agents.filter((a) => a.id !== top && !a.reportsTo).map((a) => a.id), top, L(`Todos respondem a ${byId.get(top)?.name} agora.`, `Everyone answers to ${byId.get(top)?.name} now.`))} />}

        <div className="org-tools" role="toolbar" aria-label={L('Zoom', 'Zoom')}>
          <button className="icon-btn" title={L('Afastar', 'Zoom out')} disabled={view.k <= MIN_K} onClick={() => zoom(1 / 1.2)}>
            −
          </button>
          <button className="org-tools__k" title={L('Tamanho real', 'Actual size')} onClick={() => setView(zoomAt(view, { x: room.w / 2, y: room.h / 2 }, 1))}>
            {Math.round(view.k * 100)}%
          </button>
          <button className="icon-btn" title={L('Aproximar', 'Zoom in')} disabled={view.k >= MAX_K} onClick={() => zoom(1.2)}>
            +
          </button>
          <i />
          <button className="icon-btn" title={L('Ver tudo', 'See everything')} onClick={fit}>
            <Icon name="expand" size={14} />
          </button>
        </div>
        {admin && (
          <span className="org-hint">
            {L('Arraste um cartão pra mover · puxe a bolinha de um até outro pra ligar · clique numa linha pra desfazer', 'Drag a card to move it · pull a card’s dot onto another to link them · click a line to remove it')}
          </span>
        )}

        {undo && (
          <div className="org-undo" role="status">
            <span>{undo.text}</span>
            <button className="link" title={L('Desfazer (⌘Z)', 'Undo (⌘Z)')} onClick={() => void takeBack()}>
              {L('Desfazer', 'Undo')}
            </button>
          </div>
        )}

        {asked && (
          <form className="org-ask" onSubmit={(e) => (e.preventDefault(), send())}>
            <AgentAvatar agent={asked} size={24} busy={on.has(asked.id)} />
            <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={sent === asked.name ? L(`Enviado a ${sent}. Acompanhe pelas linhas.`, `Sent to ${sent}. Follow it on the lines.`) : L(`Pedir algo a ${asked.name}…`, `Ask ${asked.name} something…`)} aria-label={L(`Pedir algo a ${asked.name}`, `Ask ${asked.name} something`)} />
            <button className="btn btn--primary btn--sm" disabled={!text.trim()} title={L('Enviar na DM dele (Enter)', 'Send in their DM (Enter)')}>
              <Icon name="send" size={14} />
            </button>
          </form>
        )}

        {chosen && (
          <Details
            agent={chosen}
            admin={admin}
            bosses={possibleBosses(agents, chosen.id)}
            below={directReports(agents, chosen.id)}
            reach={reportsOf(agents, chosen.id).length}
            channels={channels(chosen.id)}
            live={on.get(chosen.id)}
            doing={open.filter((d) => d.to === chosen.id)}
            asked={open.filter((d) => d.from === chosen.id)}
            nameOf={(id) => byId.get(id)?.name ?? L('um agente', 'an agent')}
            channelOf={(id) => {
              const c = conversations.find((c) => c.id === id)
              return !c ? '?' : c.kind === 'dm' ? 'DM' : `#${c.name}`
            }}
            onBoss={(to) => void move(chosen.id, to)}
            onThread={goThread}
            onLive={goLive}
            onClose={() => setPicked(null)}
          />
        )}
      </div>

    </Sheet>
  )
}

function Card({
  agent,
  style,
  admin,
  channels,
  live,
  doing,
  asked,
  team,
  bossName,
  moving,
  picked,
  linking,
  target,
  over,
  dim,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onPort,
  onPick,
  onOpen
}: {
  agent: Agent
  style: CSSProperties
  admin: boolean
  channels: Conversation[]
  live?: Message // the reply it is on right now
  doing: Delegation[] // open requests it is on
  asked: number // open requests it made
  team: number // how many answer to it
  bossName?: string
  moving: boolean
  picked: boolean
  linking: boolean // a line is being pulled from it
  target: boolean // the line being pulled may end here
  over: boolean
  dim: boolean
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerEnter: () => void
  onPointerLeave: () => void
  onPort: (side: 'out' | 'in') => (e: ReactPointerEvent) => void
  onPick: () => void
  onOpen: () => void
}): ReactNode {
  const waits = doing.some((d) => d.asking)
  // One line of what it's up to: waiting on an answer, what it is doing this second, what it has to do,
  // what it asked for, or where its work arrives.
  const state: { text: string; tone: string } = waits
    ? { text: L(`esperando ${bossName ?? 'resposta'}`, `waiting on ${bossName ?? 'an answer'}`), tone: 'is-warn' }
    : live
      ? { text: doingNow(live), tone: 'is-live' }
      : doing.length
        ? { text: snip(doing[0]!.text, 46), tone: 'is-live' }
        : asked
          ? { text: asked === 1 ? L('1 pedido com o time', '1 request with the team') : L(`${asked} pedidos com o time`, `${asked} requests with the team`), tone: 'is-live' }
          : channels.length
            ? { text: `#${channels[0]!.name}${channels.length > 1 ? ` +${channels.length - 1}` : ''}`, tone: '' }
            : { text: L('disponível', 'available'), tone: '' }
  return (
    <div
      className={`org-card ${moving ? 'is-moving' : ''} ${picked ? 'is-picked' : ''} ${live ? 'is-working' : ''} ${linking ? 'is-linking' : ''} ${target ? 'is-target' : ''} ${over ? 'is-over' : ''} ${dim ? 'is-dim' : ''}`}
      data-org={agent.id}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`${agent.name}${agent.role ? `, ${agent.role}` : ''}`}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick())}
    >
      {admin && <span className="org-port org-port--in" title={L('Puxe até quem ele vai responder', 'Pull onto whoever it will answer to')} onPointerDown={onPort('in')} />}
      <AgentAvatar agent={agent} size={40} busy={!!live} />
      <span className="org-card__who">
        <strong>{agent.name}</strong>
        {agent.role && <span>{agent.role}</span>}
        <span className={`org-card__state ${state.tone}`}>
          <i />
          {state.text}
        </span>
      </span>
      {team > 0 && (
        <span className="org-card__team" title={team === 1 ? L('1 responde a ele', '1 answers to it') : L(`${team} respondem a ele`, `${team} answer to it`)}>
          <Icon name="users" size={11} />
          {team}
        </span>
      )}
      {live && <span className="org-card__bar" />}
      {admin && <span className="org-port org-port--out" title={L('Puxe até quem vai responder a ele', 'Pull onto whoever will answer to it')} onPointerDown={onPort('out')} />}
    </div>
  )
}

// What there is to know and change about one agent, at the side of the board.
function Details({
  agent,
  admin,
  bosses,
  below,
  reach,
  channels,
  live,
  doing,
  asked,
  nameOf,
  channelOf,
  onBoss,
  onThread,
  onLive,
  onClose
}: {
  agent: Agent
  admin: boolean
  bosses: Agent[]
  below: Agent[]
  reach: number // everyone below, not only the next level
  channels: Conversation[]
  live?: Message
  doing: Delegation[]
  asked: Delegation[]
  nameOf: (id: string) => string
  channelOf: (id: string) => string
  onBoss: (to: string | null) => void
  onThread: (d: Delegation) => void
  onLive: (m: Message) => void
  onClose: () => void
}): ReactNode {
  const none = L('Ninguém', 'No one')
  const boss = bosses.find((a) => a.id === agent.reportsTo)
  const row = (d: Delegation, label: string): ReactNode => (
    <button key={d.id} className="org-pop__ask" title={d.text} onClick={() => onThread(d)}>
      <span className="org-pop__ask-top">
        <i className={d.asking ? 'is-asking' : ''} />
        {label} · {channelOf(d.conversationId)} · {d.asking ? L('pergunta esperando', 'a question waits') : ago(d.createdAt)}
      </span>
      <span className="org-pop__ask-text">{snip(d.text, 96)}</span>
    </button>
  )
  return (
    <aside className="org-side" aria-label={agent.name}>
      <div className="org-side__top">
        <AgentAvatar agent={agent} size={44} busy={!!live} />
        <span className="org-side__who">
          <h3>{agent.name}</h3>
          <span className="truncate">{agent.role || `@${agent.handle}`}</span>
        </span>
        <button className="icon-btn" title={L('Fechar (Esc)', 'Close (Esc)')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {live && (
        <button className="org-side__live" title={L('Ver a resposta sendo escrita', 'See the reply as it is written')} onClick={() => onLive(live)}>
          <i />
          <span className="truncate">{doingNow(live)}</span>
          <b>{L('Ver ao vivo', 'Watch')}</b>
        </button>
      )}
      <label className="field org-pop__boss">
        <span className="field__label">{L('Responde a', 'Answers to')}</span>
        <Select
          value={boss?.id ?? null}
          disabled={!admin}
          onChange={(v) => onBoss(v || null)}
          options={[{ value: '', label: none }, ...bosses.map((a) => ({ value: a.id, label: a.role ? `${a.name} · ${a.role}` : a.name }))]}
          placeholder={none}
        />
      </label>
      <dl className="org-pop__facts">
        <dt>{L('Canais', 'Channels')}</dt>
        <dd>
          {channels.length ? channels.map((c) => `#${c.name}`).join(', ') : boss ? L('Nenhum: os pedidos chegam na DM dele', 'None: requests arrive in their DM') : L('Nenhum', 'None')}
        </dd>
        {below.length > 0 && (
          <>
            <dt>{L('Time', 'Team')}</dt>
            <dd>
              {below.map((a) => a.name).join(', ')}
              {reach > below.length && L(` e mais ${reach - below.length} abaixo`, ` and ${reach - below.length} more below`)}
            </dd>
          </>
        )}
      </dl>
      {(doing.length > 0 || asked.length > 0) && (
        <div className="org-pop__asks">
          {doing.map((d) => row(d, L(`Pedido de ${nameOf(d.from)}`, `Asked by ${nameOf(d.from)}`)))}
          {asked.map((d) => row(d, L(`Pediu a ${nameOf(d.to)}`, `Asked ${nameOf(d.to)}`)))}
        </div>
      )}
      <div className="org-side__acts">
        <button className="btn btn--sm" onClick={() => void openDm(agent.id)}>
          {L('Abrir DM', 'Open DM')}
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => (setTab('agent', 'perfil'), navigate({ kind: 'agent', id: agent.id }))}>
          {L('Página do agente', 'Agent’s page')}
        </button>
      </div>
    </aside>
  )
}

// No line yet: what the board is for, and a way in. Picking who stays at the top puts everyone else
// below them, which is how most teams start; from there it's pulling lines.
function Coach({ agents, admin, onPick }: { agents: Agent[]; admin: boolean; onPick: (id: string) => void }): ReactNode {
  return (
    <div className="org-coach">
      <h2>{L('Fale com um só. Ele divide o trabalho.', 'Talk to one. They split the work.')}</h2>
      <p>
        {L(
          'Escolha quem fica no topo. Você pede a ele, ele passa a parte de cada um no canal certo, junta as respostas e te devolve pronto. As dúvidas do time chegam a você por ele.',
          'Pick who stays at the top. You ask them, they hand each one their part in the right channel, gather the answers and bring it back done. The team’s doubts reach you through them.'
        )}
      </p>
      {!admin ? (
        <p className="muted small">{L('Só um admin monta o organograma.', 'Only an admin sets up the organogram.')}</p>
      ) : agents.length < 2 ? (
        <div className="wk-empty__actions">
          <button className="btn btn--primary" onClick={openTuca}>
            <Icon name="plus" size={14} /> {L('Criar agentes com o Tuca', 'Create agents with Tuca')}
          </button>
        </div>
      ) : (
        <>
          <span className="org-start__ask">{L('Quem fica no topo?', 'Who stays at the top?')}</span>
          <div className="org-start__picks">
            {agents.map((a) => (
              <button key={a.id} className="org-chip org-chip--pick" title={L(`Os outros passam a responder a ${a.name}`, `The others answer to ${a.name} from then on`)} onClick={(e) => (e.stopPropagation(), onPick(a.id))}>
                <AgentAvatar agent={a} size={22} />
                <span>
                  <strong>{a.name}</strong>
                  {a.role && <small>{a.role}</small>}
                </span>
              </button>
            ))}
          </div>
          <span className="muted small">{L('Ou puxe a bolinha de baixo de um cartão até outro.', 'Or pull the dot under a card onto another.')}</span>
        </>
      )}
    </div>
  )
}
