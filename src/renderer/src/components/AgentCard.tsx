// An agent's profile card, like Slack's: a click on its face or name (on a message, a mention,
// the faces of a channel, the top of its DM) opens a small card next to the click with who it
// is, what it's doing now and where it works, and the way to talk to it or see its whole page.
// One card at a time; Esc, a click outside or leaving it with Tab closes it.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ENGINES } from '../../../shared/types'
import { agentById, modelById, navigate, openDialog, openDm, useStore } from '../store'
import { agentChannels, agentNow, placeCard, type AgentNow } from '../agent-card'
import { AgentAvatar, Icon, ago, ownColor } from './ui'

interface Open {
  agentId: string
  anchor: HTMLElement
  settingsOf?: string // opened from the top of a DM: the card also leads to that conversation's settings
  below?: boolean // opened from a top bar: under it, like a menu
}

let current: Open | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())
const subscribe = (l: () => void): (() => void) => (listeners.add(l), () => void listeners.delete(l))

export function openAgentCard(agentId: string, anchor: HTMLElement, opts: { settingsOf?: string; below?: boolean } = {}): void {
  // The same face clicked again closes its card, as a toggle does.
  current = current?.anchor === anchor ? null : { agentId, anchor, ...opts }
  emit()
}

export function closeAgentCard(restoreFocus = false): void {
  const was = current
  if (!was) return
  current = null
  emit()
  if (restoreFocus && was.anchor.isConnected) was.anchor.focus()
}

// A real button that opens the card. `tabIndex={-1}` for a face next to a name that opens the
// same card: one stop for the keyboard, a bigger target for the mouse.
export function AgentCardButton({ agentId, settingsOf, below, className, style, title, label, tabIndex, children }: { agentId: string; settingsOf?: string; below?: boolean; className?: string; style?: CSSProperties; title?: string; label?: string; tabIndex?: number; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLButtonElement>(null)
  const expanded = useSyncExternalStore(subscribe, () => !!ref.current && current?.anchor === ref.current)
  return (
    <button ref={ref} type="button" className={className} style={style} title={title} aria-label={label} aria-haspopup="dialog" aria-expanded={expanded} tabIndex={tabIndex} onClick={(e) => openAgentCard(agentId, e.currentTarget, { settingsOf, below })}>
      {children}
    </button>
  )
}

// Mounted once, over the app.
export function AgentCardLayer(): ReactNode {
  const open = useSyncExternalStore(subscribe, () => current)
  // Going somewhere else closes it.
  const view = useStore((s) => s.view)
  useEffect(() => closeAgentCard(), [view])
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
  const now = useMemo(() => (agent ? agentNow(agent, messages) : undefined), [agent, messages])
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

  // The card takes focus once it's placed (hidden, it can't), so a screen reader reads it and Tab walks its buttons.
  const placed = !!place
  useEffect(() => {
    if (placed) card.current?.focus({ preventScroll: true })
  }, [placed])

  // Esc closes it before anything under it (a thread panel) takes the key; a click outside,
  // or a scroll under it, closes it too.
  useEffect(() => {
    const inside = (t: EventTarget | null): boolean => t instanceof Node && (!!card.current?.contains(t) || open.anchor.contains(t))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeAgentCard(true)
    }
    const onDown = (e: PointerEvent): void => void (!inside(e.target) && closeAgentCard())
    const onScroll = (e: Event): void => void (!(e.target instanceof Node && card.current?.contains(e.target)) && closeAgentCard())
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

      <NowLine now={now} titleOf={titleOf} />

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

function NowLine({ now, titleOf }: { now: AgentNow; titleOf: (conversationId: string) => string }): ReactNode {
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
        <b>{now.on === 'input' ? L(`Esperando sua resposta ${where}`, `Waiting for your answer ${where}`) : L(`Esperando sua aprovação ${where}`, `Waiting for your approval ${where}`)}</b>
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
