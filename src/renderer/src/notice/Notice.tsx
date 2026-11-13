// The cards over every window, as Telegram's own notifications behave: they arrive in a stack at the
// place the person chose, push the ones before them along, fold into a tray when a swarm arrives,
// hold still under the pointer, and fade out once their seconds are up. What waits on a decision (an
// approval, a question) is decided from the card itself while Settings says so.
// The look is the app's own: src/shared/notice.ts holds the rules, styles.css its palette.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { gsap } from 'gsap'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L } from '../../../shared/lang'
import {
  NOTICE_MAX,
  NOTICE_MAX_FULL,
  NOTICE_SECONDS,
  clockFading,
  clockGone,
  clockPart,
  deckOrder,
  demoCards,
  noticeWhere,
  pushCard,
  runClock,
  stackCards,
  startClock,
  waitingCards,
  type NoticeCard,
  type NoticeClock,
  type NoticeFeed,
  type NoticePush,
  type NoticeRules
} from '../../../shared/notice'
import type { Answer, Decision } from '../../../shared/questions'
import { ACCESS_REQUEST } from '../../../shared/types'
import { call } from '../rpc'
import { AgentAvatar, Icon } from '../components/ui'
import { AskCard } from '../components/Decisions'
import { toolWords } from '../components/Conversation'
import { startFeed } from './feed'

const RULES: NoticeRules = { on: true, act: true, seconds: NOTICE_SECONDS, hover: true, skin: 'system', stack: false }

const KIND_LABEL: Record<NoticeCard['kind'], () => string> = {
  approval: () => L('Aprovação', 'Approval'),
  ask: () => L('Pergunta', 'Question'),
  done: () => L('Pronto', 'Done'),
  note: () => L('Aviso', 'Notice')
}

function Glyph({ kind }: { kind: NoticeCard['kind'] }): ReactNode {
  const path =
    kind === 'approval'
      ? 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z'
      : kind === 'ask'
        ? 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.6 9.2a2.5 2.5 0 114.1 2c-.8.7-1.7 1.2-1.7 2.3M12 17h.01'
        : kind === 'done'
          ? 'M20 6L9 17l-5-5'
          : 'M12 3a6 6 0 00-3.6 10.8c.5.4.8 1 .9 1.6l.1.9h5.2l.1-.9c.1-.6.4-1.2.9-1.6A6 6 0 0012 3zM9.5 19.5h5'
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

// Prose from an agent, drawn as it was written: the cards were showing its markdown as plain text.
function Prose({ text }: { text: string }): ReactNode {
  return (
    <div className="nc__body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={['img']}
        unwrapDisallowed
        components={{
          // Nothing in a card navigates: the card itself opens the conversation, where the links live.
          a: ({ children }) => <span className="nc__link">{children}</span>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

// Approving, as the conversation's own card does it: the button fills while it's held, and the
// approval happens at the end of it. A stray click on a card that was about to fade approves nothing.
function HoldApprove({ onApprove }: { onApprove: () => void }): ReactNode {
  const [holding, setHolding] = useState(false)
  useEffect(() => {
    if (!holding) return
    const t = setTimeout(onApprove, 1_500)
    return () => clearTimeout(t)
  }, [holding, onApprove])
  return (
    <button
      className={`btn btn--xs btn--primary nc__hold ${holding ? 'is-holding' : ''}`}
      title={L('Segure pra aprovar', 'Hold to approve')}
      onPointerDown={() => setHolding(true)}
      onPointerUp={() => setHolding(false)}
      onPointerLeave={() => setHolding(false)}
    >
      <span>{L('Aprovar', 'Approve')}</span>
    </button>
  )
}

// One card: what happened, what it shows, and what can be done with it without leaving the stack.
export interface CardViewProps {
  card: NoticeCard
  feed: NoticeFeed | null
  full: boolean // at full height, or folded to a row in the tray
  open: boolean // grown by the wheel: the whole text, the pictures bigger, every action
  act: boolean // Settings says a decision is made from the card
  onOpen: (card: NoticeCard) => void
  onClose: (id: string) => void
  onDecide: (card: NoticeCard, decision: 'approved' | 'refused', always?: boolean) => void
}

export function CardView({ card, feed, full, open, act, onOpen, onClose, onDecide }: CardViewProps): ReactNode {
  const agents = feed?.agents ?? []
  const agent = card.preview && card.previewAgent !== undefined && agents.length ? agents[card.previewAgent % agents.length] : agents.find((a) => a.id === card.agentId)
  const who = agent?.name ?? card.agentName
  const where = card.conversationId ? noticeWhere(feed?.conversations ?? [], card.conversationId, who) : ''
  const approval = card.approval
  const pictures = card.pictures ?? []
  const shown = pictures.slice(0, open ? 4 : 3)
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation()
  return (
    // The agent's own face leans on the card's corner, half outside it, and the card keeps its kind
    // at the other corner: the one fun thing an overlay of this kind can afford.
    <div className="nc-wrap" data-card={card.id}>
      {agent && (
        <span className="nc__badge">
          <AgentAvatar agent={agent} size={26} />
        </span>
      )}
      <article className={`nc nc--${card.kind} ${full ? '' : 'nc--compact'} ${open ? 'is-open' : ''}`} onClick={() => onOpen(card)}>
        <header className="nc__head">
          <div className="nc__titles">
            <p className="nc__title">{card.title}</p>
            <p className="nc__where">
              {where || KIND_LABEL[card.kind]()}
              {where && card.kind !== 'note' && card.kind !== 'done' ? ` · ${KIND_LABEL[card.kind]()}` : ''}
            </p>
          </div>
          <span className={`nc__kind nc__kind--${card.kind}`} title={KIND_LABEL[card.kind]()}>
            <Glyph kind={card.kind} />
          </span>
          <button
            className="nc__x"
            aria-label={L('Fechar', 'Close')}
            onClick={(e) => {
              stop(e)
              onClose(card.id)
            }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

      <Prose text={card.body} />
      {open && card.meta && <p className="nc__meta">{card.meta}</p>}

      {!!shown.length && (
        <div className={`nc__pics ${open ? 'is-open' : ''}`}>
          {shown.map((p, at) => (
            <span key={p.url} className="nc__pic">
              {p.kind === 'image' ? <img src={p.url} alt={p.title} /> : <span className="nc__file">{p.title}</span>}
              {!open && at === 2 && pictures.length > 3 && <span className="nc__more">+{pictures.length - 2}</span>}
            </span>
          ))}
        </div>
      )}

      {card.kind === 'approval' && approval && (
        <div className="nc__block">
          <div className="ask__head">
            <span className="ask__badge">
              <Icon name="shield" size={13} />
              {L('Esperando você', 'Waiting for you')}
            </span>
            {approval.highRisk && <span className="tag tag--danger">{L('alto risco', 'high risk')}</span>}
          </div>
          {/* Who asks and why are already the card's title and body: here is what it would do. */}
          <div className="approval__call">
            <code>
              {toolWords(approval.tool)} · {approval.connectorName}
            </code>
            {Object.keys(approval.args).length > 0 && <pre>{JSON.stringify(approval.args).slice(0, 240)}</pre>}
          </div>
        </div>
      )}

      {act && card.kind === 'approval' && approval && (
        <div className="nc__actions" onClick={stop}>
          <HoldApprove onApprove={() => onDecide(card, 'approved')} />
          <button className="btn btn--xs" onClick={() => onDecide(card, 'refused')}>
            {L('Recusar', 'Refuse')}
          </button>
          {!approval.highRisk && (
            <button
              className="btn btn--xs btn--ghost"
              title={L('Aprovar e daqui pra frente sem pedir, sempre que for esta ferramenta', 'Approve, and from now on without asking, whenever it is this tool')}
              onClick={() => onDecide(card, 'approved', true)}
            >
              {L('Sempre permitir', 'Always allow')}
            </button>
          )}
        </div>
      )}

      {act && card.kind === 'ask' && card.ask?.decisions?.length ? (
        <div className="nc__block nc__block--ask" onClick={stop}>
          {/* The app's own card: the decisions one at a time, its options, the arrows, and Send. */}
          <AskCard id={card.ask.id} questions={card.ask.decisions} saved={card.ask.answers} mode="answer" badge={L('Esperando você', 'Waiting for you')} />
        </div>
      ) : null}

        <span className="nc__ring" aria-hidden="true" />
      </article>
    </div>
  )
}

export function NoticeWindow(): ReactNode {
  const [feed, setFeed] = useState<NoticeFeed | null>(null)
  const [pushed, setPushed] = useState<NoticeCard[]>([])
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [up, setUp] = useState(true) // the newest card nearest the edge the person chose
  const [system, setSystem] = useState({ dark: false, accent: '#d9581a' }) // what the system's skin is now
  const rules = feed?.rules ?? RULES
  // The sky the cards are painted with: the system's, or the one the person pinned.
  const skin = rules.skin === 'system' ? (system.dark ? 'dark' : 'light') : rules.skin
  const upRef = useRef(up)
  upRef.current = up

  const stack = useRef<HTMLDivElement | null>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const rects = useRef(new Map<string, { top: number; height: number }>())
  const held = useRef(new Set<string>())
  const openIds = useRef(open)
  const shown = useRef<NoticeCard[]>([])
  const seconds = useRef(rules.seconds)
  const feedRef = useRef<NoticeFeed | null>(null)
  const focusRef = useRef<string | null>(null)
  const [leaving, setLeaving] = useState<NoticeCard | null>(null)

  const cards = useMemo(() => (rules.on && feed ? stackCards(waitingCards(feed), pushed, closed) : []), [feed, pushed, closed, rules.on])
  shown.current = cards
  feedRef.current = feed
  focusRef.current = rules.stack ? (cards.length ? deckOrder(cards)[0]!.id : null) : null
  openIds.current = open
  seconds.current = rules.seconds

  // The whole card, or the small one again: its own height eases, and the cards beside it follow it.
  const grow = (id: string, want: boolean): void => {
    const el = nodes.current.get(id)
    const is = openIds.current.has(id)
    if (!el || is === want) return
    const from = el.offsetHeight
    setOpen((was) => {
      const next = new Set(was)
      if (want) next.add(id)
      else next.delete(id)
      return next
    })
    requestAnimationFrame(() => {
      const node = nodes.current.get(id)
      if (!node) return
      const to = node.offsetHeight
      if (Math.abs(to - from) < 1) return
      gsap.fromTo(node, { height: from }, { height: to, duration: 0.42, ease: 'power3.out', overwrite: 'auto', onComplete: () => void node.style.removeProperty('height') })
    })
  }

  // The feed, and what the main process sends as it happens.
  useEffect(() => startFeed(setFeed), [])
  useEffect(() => {
    window.tucano.notice.onPush((p) => {
      const card = pushCard(p as NoticePush)
      if (card) setPushed((was) => [card, ...was.filter((c) => c.id !== card.id)].slice(0, NOTICE_MAX))
    })
    window.tucano.notice.onClear(() => setPushed([]))
    window.tucano.notice.onDemo(() =>
      setPushed((was) => [...demoCards(), ...was].slice(0, NOTICE_MAX))
    )
    window.tucano.notice.onPlace((p) => {
      setUp(p.up !== false)
      setSystem({ dark: p.dark === true, accent: typeof p.accent === 'string' && p.accent ? p.accent : '#d9581a' })
    })
  }, [])

  // The window shows itself only while there's something on it (main hides it otherwise), and the
  // page follows the app's theme.
  useEffect(() => {
    window.tucano.notice.count(cards.length)
  }, [cards.length])
  useEffect(() => {
    document.documentElement.dataset['skin'] = skin
  }, [skin])
  useEffect(() => {
    document.documentElement.style.setProperty('--os-accent', system.accent)
  }, [system.accent])

  // Each card's own seconds, counted on the card's node: the line drains, the fade begins, and a
  // pointer coming back stops both. Nothing here redraws React unless a card is actually gone.
  useEffect(() => {
    const clocks = new Map<string, NoticeClock>()
    const dead = new Set<string>()
    let raf = 0
    let last = performance.now()
    const step = (now: number): void => {
      const dt = Math.min(200, now - last)
      last = now
      const list = shown.current
      const secs = seconds.current
      const dying: string[] = []
      for (const c of list) {
        if (dead.has(c.id)) continue
        const waiting = focusRef.current !== null && c.id !== focusRef.current
        const clock = runClock(clocks.get(c.id) ?? startClock(secs), dt, waiting || held.current.has(c.id) || openIds.current.has(c.id))
        clocks.set(c.id, clock)
        if (clockGone(clock)) {
          dead.add(c.id)
          dying.push(c.id)
        }
        const el = nodes.current.get(c.id)
        if (el) {
          el.style.setProperty('--left', clockPart(clock, secs).toFixed(4))
          el.classList.toggle('is-fading', clockFading(clock))
        }
      }
      for (const id of [...clocks.keys()]) if (!list.some((c) => c.id === id)) clocks.delete(id)
      if (dying.length)
        setClosed((was) => {
          const next = new Set(was)
          for (const id of dying) next.add(id)
          return next
        })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  // The pointer: over a card the window takes the clicks (everywhere else they go through to what's
  // behind it, which main arranges), and that card holds its place.
  useEffect(() => {
    let inside = false
    let over: string | null = null
    const move = (e: PointerEvent): void => {
      const card = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.nc-wrap')
      const id = card?.dataset['card'] ?? null
      if (!!card !== inside) {
        inside = !!card
        window.tucano.notice.hit(inside)
      }
      if (id !== over) {
        if (over) held.current.delete(over)
        if (id) held.current.add(id)
        over = id
      }
    }
    const leave = (): void => {
      if (inside) {
        inside = false
        window.tucano.notice.hit(false)
      }
      if (over) held.current.delete(over)
      over = null
    }
    window.addEventListener('pointermove', move)
    document.addEventListener('pointerleave', leave)
    window.addEventListener('blur', leave)
    return () => {
      window.removeEventListener('pointermove', move)
      document.removeEventListener('pointerleave', leave)
      window.removeEventListener('blur', leave)
    }
  }, [])

  // The wheel over a card opens it, and closes it again: the small card grows to the whole thing,
  // pictures and all, without leaving the stack.
  useEffect(() => {
    const el = stack.current
    if (!el) return
    let at = 0
    const turn = (e: WheelEvent): void => {
      const card = (e.target as HTMLElement | null)?.closest<HTMLElement>('.nc-wrap')
      const id = card?.dataset['card']
      if (!id || Math.abs(e.deltaY) < 2) return
      e.preventDefault()
      const now = performance.now()
      if (now - at < 220) return
      at = now
      grow(id, e.deltaY < 0)
    }
    el.addEventListener('wheel', turn, { passive: false })
    return () => el.removeEventListener('wheel', turn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // What moves the stack: a card arriving comes in from the edge it grows from and pushes the others
  // along; one leaving lets the rest slide (measured before and after, then drawn back into place).
  const ids = cards.map((c) => c.id).join('|')
  useLayoutEffect(() => {
    const el = stack.current
    if (!el) return
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const from = upRef.current ? 14 : -14
    const seen = new Set<string>()
    for (const node of el.querySelectorAll<HTMLElement>('[data-card]')) {
      const id = node.dataset['card']
      if (!id) continue
      seen.add(id)
      nodes.current.set(id, node)
      const rect = node.getBoundingClientRect()
      const before = rects.current.get(id)
      if (!before) {
        if (!still) gsap.fromTo(node, { y: from, opacity: 0, scale: 0.96 }, { y: 0, opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(1.25)', overwrite: 'auto', clearProps: 'transform,opacity' })
      } else if (Math.abs(before.top - rect.top) > 0.5) {
        if (!still) gsap.fromTo(node, { y: before.top - rect.top }, { y: 0, duration: 0.45, ease: 'power3.out', overwrite: 'auto', clearProps: 'transform' })
      }
      rects.current.set(id, { top: rect.top, height: rect.height })
    }
    for (const id of [...rects.current.keys()]) if (!seen.has(id)) rects.current.delete(id)
    for (const id of [...nodes.current.keys()]) if (!seen.has(id)) nodes.current.delete(id)
  }, [ids])

  const close = (id: string): void => {
    const card = shown.current.find((c) => c.id === id)
    // In the stack mode the one in front goes with a swipe, and the next one comes up behind it.
    if (card && rules.stack && !card.preview) {
      setLeaving(card)
      window.setTimeout(() => setLeaving(null), 300)
    }
    setClosed((was) => {
      const next = new Set(was)
      next.add(id)
      return next
    })
  }

  const openInApp = (card: NoticeCard): void => {
    window.tucano.notice.open({ ...(card.conversationId ? { conversationId: card.conversationId } : {}), ...(card.threadId ? { threadId: card.threadId } : {}), ...(card.page ? { page: card.page } : {}) })
    close(card.id)
  }

  const decide = (card: NoticeCard, decision: 'approved' | 'refused', always = false): void => {
    // A card from Settings' test has nothing behind it: it goes away, and decides nothing.
    if (card.preview) return close(card.id)
    if (!card.approval) return
    void call('decideApproval', { id: card.approval.id, decision, always }).catch(() => undefined)
    close(card.id)
  }

  const deck = rules.stack ? deckOrder(cards) : cards
  const focus = deck[0]

  return (
    <div className="nc-screen" data-up={up ? 'true' : 'false'}>
      {rules.stack ? (
        <div className="nc-deck" ref={stack}>
          <div className="nc-deck__ghosts" aria-hidden="true">
            {deck.slice(1, 4).map((c, i) => (
              <span key={c.id} className="nc-ghost" style={{ '--depth': i } as CSSProperties} />
            ))}
          </div>
          {leaving && (
            <div className="nc-leaving" aria-hidden="true">
              <CardView card={leaving} feed={feed} full open={false} act={false} onOpen={() => {}} onClose={() => {}} onDecide={() => {}} />
            </div>
          )}
          {focus && <CardView key={focus.id} card={focus} feed={feed} full open={open.has(focus.id)} act={rules.act} onOpen={openInApp} onClose={close} onDecide={decide} />}
          {deck.length > 1 && (
            <span className="nc-deck__count" title={L(`${deck.length} avisos`, `${deck.length} notifications`)}>
              {deck.length}
            </span>
          )}
        </div>
      ) : (
        <div className="nc-stack" ref={stack}>
          {cards.map((card, i) => (
            <CardView key={card.id} card={card} feed={feed} full={i < NOTICE_MAX_FULL || open.has(card.id) || card.kind === 'approval' || card.kind === 'ask'} open={open.has(card.id)} act={rules.act} onOpen={openInApp} onClose={close} onDecide={decide} />
          ))}
        </div>
      )}
    </div>
  )
}
