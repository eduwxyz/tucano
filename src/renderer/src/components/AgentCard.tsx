// An agent's profile card, like Slack's: a click on its face or name (on a message, a mention,
// the faces of a channel, the top of its DM) opens a small card next to the click with who it
// is, what it's doing now and where it works, and the way to talk to it or see its whole page.
// The mouse resting on a face opens it too, after a moment, and it goes when the mouse leaves the
// face and the card. One card at a time; Esc, a click outside or leaving it with Tab closes it.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ENGINES } from '../../../shared/types'
import { agentById, canDecide, modelById, navigate, openDialog, openDm, personName, useStore } from '../store'
import { agentChannels, agentNow, cardState, placeCard, scrollMovesAnchor, type AgentNow, type CardOpen, type CardOptions } from '../agent-card'
import { AgentAvatar, Icon, ago, ownColor } from './ui'

type Open = CardOpen<HTMLElement>

const cards = cardState<HTMLElement>()

export const openAgentCard = (agentId: string, anchor: HTMLElement, opts: CardOptions = {}): void => cards.click(agentId, anchor, opts)

export function closeAgentCard(restoreFocus = false): void {
  const was = cards.close()
  if (restoreFocus && was?.anchor.isConnected) was.anchor.focus()
}

// A real button that opens the card on a click (or Enter), and on a mouse resting on it.
// `tabIndex={-1}` for a face next to a name that opens the same card: one stop for the
// keyboard, a bigger target for the mouse. Touch has no hover: a tap is a click.
export function AgentCardButton({ agentId, settingsOf, below, className, style, title, label, tabIndex, children }: { agentId: string; settingsOf?: string; below?: boolean; className?: string; style?: CSSProperties; title?: string; label?: string; tabIndex?: number; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLButtonElement>(null)
  const expanded = useSyncExternalStore(cards.subscribe, () => !!ref.current && cards.get()?.anchor === ref.current)
  return (
    <button
      ref={ref}
      type="button"
      className={className}
      style={style}
      title={title}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      tabIndex={tabIndex}
      onClick={(e) => cards.click(agentId, e.currentTarget, { settingsOf, below })}
      onPointerEnter={(e) => e.pointerType === 'mouse' && cards.hoverEnter(agentId, e.currentTarget, { settingsOf, below })}
      onPointerLeave={(e) => e.pointerType === 'mouse' && cards.hoverLeave()}
    >
      {children}
    </button>
  )
}

// Mounted once, over the app.
export function AgentCardLayer(): ReactNode {
  const open = useSyncExternalStore(cards.subscribe, cards.get)
  // Going somewhere else closes it.
  const view = useStore((s) => s.view)
  useEffect(() => closeAgentCard(), [view])
  // A face passing under a still pointer while the page scrolls isn't a hover.
  useEffect(() => {
    window.addEventListener('scroll', cards.scrolled, true)
    return () => window.removeEventListener('scroll', cards.scrolled, true)
  }, [])
  if (!open) return null
  return <AgentCard key={`${open.agentId}-${open.settingsOf ?? ''}`} open={open} />
}

const CHANNELS_SHOWN = 4

function AgentCard({ open }: { open: Open }): ReactNode {
  const agent = useStore((s) => agentById(s, open.agentId))
  const messages = useStore((s) => s.messages)
  const conversations = useStore((s) => s.conversations)
  const model = useStore((s) => (agent ? modelById(s, agent.modelId) : undefined))
  // Already in its DM: "Message" would lead right here.
  const inItsDm = useStore((s) => {
    if (s.view?.kind !== 'conversation') return false
    const id = s.view.id
    const c = s.conversations.find((x) => x.id === id)
    return c?.kind === 'dm' && c.members[0] === open.agentId
  })
  const now = useMemo(() => (agent ? agentNow(agent, Object.values(messages).flat()) : undefined), [agent, messages])
  // With a team, what an agent waits on may be someone else's: a question to another person,
  // an approval only the admins or the agent's person decide.
  const waitsOn = useStore((s): string | undefined => {
    if (now?.kind !== 'waiting') return undefined
    if (now.on === 'approval') return canDecide(s, { agentId: open.agentId }) ? undefined : ''
    return now.askedTo && s.you && now.askedTo !== s.you ? personName(s, now.askedTo) : undefined
  })
  const channels = useMemo(() => agentChannels(open.agentId, conversations), [open.agentId, conversations])
  const titleOf = (id: string): string => {
    const c = conversations.find((x) => x.id === id)
    return !c ? '' : c.kind === 'channel' ? L(`em #${c.name}`, `in #${c.name}`) : L('na DM', 'in the DM')
  }

  const card = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; width?: number } | null>(null)
  const nameId = useId()

  // Next to what was clicked, measured once the card is laid out (hidden until then).
  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const measure = (): void => {
      if (!open.anchor.isConnected) return closeAgentCard()
      const r = open.anchor.getBoundingClientRect()
      setPlace(placeCard({ left: r.left, top: r.top, width: r.width, height: r.height }, { width: 320, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, open.below ? 'below' : 'side'))
    }
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      resize.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open.anchor])

  // A clicked card takes focus once it's placed (hidden, it can't), so a screen reader reads it
  // and Tab walks its buttons. A hovered one doesn't take focus from where you're typing.
  const placed = !!place
  const clicked = open.via === 'click'
  useEffect(() => {
    if (placed && clicked) card.current?.focus({ preventScroll: true })
  }, [placed, clicked])

  // Esc closes it before anything under it (a thread panel) takes the key; a click outside,
  // or a scroll under it, closes it too.
  useEffect(() => {
    const inside = (t: EventTarget | null): boolean => t instanceof Node && (!!card.current?.contains(t) || open.anchor.contains(t))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeAgentCard(open.via === 'click') // a hovered card never had the focus to give back
    }
    const onDown = (e: PointerEvent): void => void (!inside(e.target) && closeAgentCard())
    const onScroll = (e: Event): void => void (scrollMovesAnchor(e.target, open.anchor) && closeAgentCard())
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open.anchor])

  if (!agent || !now) return null
  const tuca = agent.kind === 'tuca'
  const go = (fn: () => void): void => {
    closeAgentCard()
    fn()
  }

  return (
    <div
      ref={card}
      className={`agent-card c-${agent.color}`}
      style={{ ...ownColor(agent), ...(place ? { left: place.left, top: place.top, width: place.width } : { visibility: 'hidden' }) }}
      role="dialog"
      aria-labelledby={nameId}
      tabIndex={-1}
      onPointerEnter={(e) => e.pointerType === 'mouse' && cards.cardEnter()}
      onPointerLeave={(e) => e.pointerType === 'mouse' && cards.cardLeave()}
      onBlur={(e) => {
        // Tab out of the card closes it; a click elsewhere is the pointer's job.
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget) && !open.anchor.contains(e.relatedTarget)) closeAgentCard()
      }}
    >
      <div className="agent-card__band" aria-hidden />
      <div className="agent-card__head">
        <span className="agent-card__face">
          <AgentAvatar agent={agent} size={64} busy={now.kind === 'working'} />
        </span>
        <div className="agent-card__who">
          <h2 id={nameId} className="agent-card__name">
            {agent.name}
          </h2>
          <div className="agent-card__handle">@{agent.handle}</div>
          {(agent.role || tuca) && <div className="agent-card__role">{agent.role || L('Monta os agentes do time', 'Builds the team’s agents')}</div>}
        </div>
      </div>

      <NowLine now={now} titleOf={titleOf} waitsOn={waitsOn} />

      <dl className="agent-card__facts">
        <div>
          <dt>{L('Modelo', 'Model')}</dt>
          <dd>
            {model?.label ?? agent.modelId}
            {model && <span className="muted"> · {ENGINES[model.engine].label}</span>}
          </dd>
        </div>
        {agent.computer && (
          <div>
            <dt>{L('Computador', 'Computer')}</dt>
            <dd>{agent.computerKind === 'mac' ? L('Roda no seu computador', 'Runs on your computer') : L('Um computador só dele, isolado', 'One of its own, isolated')}</dd>
          </div>
        )}
        {!tuca && (
          <div>
            <dt>{L('Canais', 'Channels')}</dt>
            <dd className="agent-card__channels">
              {channels.length === 0 && <span className="muted">{L('Só na DM', 'Only in its DM')}</span>}
              {channels.slice(0, CHANNELS_SHOWN).map((c) => (
                <button key={c.id} type="button" className="agent-card__channel" onClick={() => go(() => navigate({ kind: 'conversation', id: c.id }))}>
                  #{c.name}
                </button>
              ))}
              {channels.length > CHANNELS_SHOWN && <span className="muted">+{channels.length - CHANNELS_SHOWN}</span>}
            </dd>
          </div>
        )}
      </dl>

      <div className="agent-card__actions">
        {!inItsDm && !agent.archived && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => go(() => void openDm(agent.id))}>
            <Icon name="send" size={13} /> {L('Mensagem', 'Message')}
          </button>
        )}
        <button type="button" className={`btn btn--sm ${inItsDm || agent.archived ? 'btn--primary' : ''}`} onClick={() => go(() => navigate({ kind: 'agent', id: agent.id }))}>
          <Icon name="user" size={13} /> {L('Ver perfil completo', 'View full profile')}
        </button>
        {open.settingsOf && (
          <button type="button" className="icon-btn agent-card__settings" title={L('Configurações da conversa', 'Conversation settings')} aria-label={L('Configurações da conversa', 'Conversation settings')} onClick={() => go(() => openDialog({ kind: 'settings', id: open.settingsOf! }))}>
            <Icon name="gear" size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

// `waitsOn`: unset, it waits on me; a name, on that person; empty, on someone who decides (not me).
function NowLine({ now, titleOf, waitsOn }: { now: AgentNow; titleOf: (conversationId: string) => string; waitsOn?: string }): ReactNode {
  const where = 'conversationId' in now ? titleOf(now.conversationId) : ''
  const go = (): void => {
    if (!('conversationId' in now)) return
    closeAgentCard()
    navigate({ kind: 'conversation', id: now.conversationId })
  }
  if (now.kind === 'working')
    return (
      <button type="button" className="agent-card__now is-working" onClick={go}>
        <span className="agent-card__dot" aria-hidden />
        <span>
          <b>{L(`Trabalhando agora ${where}`, `Working now ${where}`)}</b>
          {now.doing && <span className="agent-card__doing">{now.doing}…</span>}
        </span>
      </button>
    )
  if (now.kind === 'waiting')
    return (
      <button type="button" className="agent-card__now is-waiting" onClick={go}>
        <span className="agent-card__dot" aria-hidden />
        <b>
          {now.on === 'input'
            ? waitsOn
              ? L(`Esperando ${waitsOn} responder ${where}`, `Waiting for ${waitsOn} to answer ${where}`)
              : L(`Esperando sua resposta ${where}`, `Waiting for your answer ${where}`)
            : waitsOn === undefined
              ? L(`Esperando sua aprovação ${where}`, `Waiting for your approval ${where}`)
              : L(`Esperando aprovação ${where}`, `Waiting for approval ${where}`)}
        </b>
      </button>
    )
  return (
    <p className={`agent-card__now is-${now.kind}`}>
      <span className="agent-card__dot" aria-hidden />
      {now.kind === 'archived'
        ? L('Arquivado: não responde', 'Archived: it doesn’t reply')
        : now.kind === 'limit'
          ? L('Bateu o limite do mês', 'Hit the monthly limit')
          : now.lastAt
            ? L(`Disponível · falou ${ago(now.lastAt)}`, `Available · last spoke ${ago(now.lastAt)}`)
            : L('Disponível', 'Available')}
    </p>
  )
}
