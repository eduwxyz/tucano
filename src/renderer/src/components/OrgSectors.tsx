// Sectors on the board (src/shared/org.ts): each tree is a sector, tinted behind its cards with the
// head's color and name; heads ask other heads, drawn as a dashed line between them. The panel at the
// side says what a sector solves, so the other heads know when to send something its way.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { askKind, channelsOf, headsOf, reportsOf, sectorName, type AskKind } from '../../../shared/org'
import { BOARD, boundsOf, type Point } from '../../../shared/org-layout'
import { navigate, openDm, openThread, saveAgent, useStore, type Agent, type Delegation } from '../store'
import { ago, AgentAvatar, Icon, ownColor } from './ui'

const PAD_SIDE = 32 // what a zone keeps around its cards
const PAD_TOP = 68 // above the head card: the chip fits there
const PAD_BOTTOM = 32
const DOES_ROOM = 520 // a zone this wide has room for what it solves, beside the chip

const tint = (a: Agent): CSSProperties => ownColor(a)

// How a request goes; "sector" only between two heads, anything else unrelated is told as between colleagues.
// Matches core's askKind: 'sector' to a non-head only happens after the tree changed, so it shows as 'peer'.
export function askWay(agents: Agent[], d: Pick<Delegation, 'from' | 'to'>): AskKind {
  const kind = askKind(agents, d.from, d.to)
  return kind === 'sector' && !headsOf(agents).some((h) => h.id === d.to) ? 'peer' : kind
}

// The line of a request between two heads: out of the asker's side facing the other, into the other's side,
// and the middle, where its label sits.
export function sectorLink(from: Point, to: Point): { d: string; mid: Point; end: Point } {
  const right = to.x >= from.x
  const a = { x: from.x + (right ? BOARD.w : 0), y: from.y + BOARD.h / 2 }
  const b = { x: to.x + (right ? 0 : BOARD.w), y: to.y + BOARD.h / 2 }
  const bend = Math.max(48, Math.abs(b.x - a.x) / 2)
  const dir = right ? 1 : -1
  return { d: `M${a.x} ${a.y}C${a.x + dir * bend} ${a.y} ${b.x - dir * bend} ${b.y} ${b.x} ${b.y}`, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, end: b }
}

// A tinted box behind each head's whole branch. Only the chip takes the pointer, so cards and board keep theirs.
export function SectorZones({ agents, spot, admin, picked, onPick }: { agents: Agent[]; spot: (id: string) => Point; admin: boolean; picked: string | null; onPick: (head: string) => void }): ReactNode {
  return (
    <>
      {headsOf(agents).map((head) => {
        const b = boundsOf([head, ...reportsOf(agents, head.id)].map((a) => spot(a.id)))
        const name = sectorName(head, L('Setor de', 'Sector of'))
        const does = head.sectorDoes?.trim()
        const wide = b.w + PAD_SIDE * 2 > DOES_ROOM
        return (
          <div
            key={head.id}
            className={`org-zone c-${head.color} ${picked === head.id ? 'is-picked' : ''}`}
            style={{ ...tint(head), left: b.x - PAD_SIDE, top: b.y - PAD_TOP, width: b.w + PAD_SIDE * 2, height: b.h + PAD_TOP + PAD_BOTTOM }}
          >
            <div className="org-zone__tag">
              <button className="org-zone__name" title={L('Ver o setor', 'See the sector')} onClick={() => onPick(head.id)}>
                <Icon name="users" size={14} />
                {name}
              </button>
              {wide && does && (
                <span className="org-zone__does" title={does}>
                  <b>{L('Resolve:', 'Solves:')}</b> {does}
                </span>
              )}
              {wide && !does && admin && (
                <button className="org-zone__does is-empty" onClick={() => onPick(head.id)}>
                  {L('Diga o que este setor resolve', 'Say what this sector solves')}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}

// The side panel of one sector: its name, what it solves, who takes requests from outside, and those waiting.
export function SectorPanel({ head, agents, admin, asks, onClose }: { head: Agent; agents: Agent[]; admin: boolean; asks: Delegation[]; onClose: () => void }): ReactNode {
  const conversations = useStore((s) => s.conversations)
  const [name, setName] = useState(head.sectorName ?? '')
  const [does, setDoes] = useState(head.sectorDoes ?? '')
  const [saved, setSaved] = useState(false)
  // Latest draft and props, read by the save: Esc or a board click unmounts the panel, maybe before any blur.
  const draft = useRef({ name, does })
  const latest = useRef({ head, admin, conversations })
  latest.current = { head, admin, conversations }
  // Last values written or loaded. Blur and unmount both call save, so only a real change goes out once.
  const lastSaved = useRef({ name: name.trim(), does: does.trim() })
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 1800)
    return () => clearTimeout(t)
  }, [saved])
  const members = reportsOf(agents, head.id).length + 1
  const shown = sectorName({ ...head, sectorName: name }, L('Setor de', 'Sector of'))
  const save = (): void => {
    const { head: h, admin: canSave, conversations: convs } = latest.current
    const next = { name: draft.current.name.trim(), does: draft.current.does.trim() }
    const prev = lastSaved.current
    if (!canSave || (next.name === prev.name && next.does === prev.does)) return
    lastSaved.current = next
    const run = async (): Promise<void> => {
      try {
        await saveAgent({ ...h, sectorName: next.name, sectorDoes: next.does }, channelsOf(convs, h.id).map((c) => c.id))
        setSaved(true)
      } catch {
        lastSaved.current = prev
        setSaved(false)
      }
    }
    void run()
  }
  // Unmount saves whatever is still unsaved; a blur before it already saved the rest.
  useEffect(() => () => save(), [])
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? L('um agente', 'an agent')
  return (
    <aside className="org-side" aria-label={shown}>
      <div className="org-side__top">
        <span className={`org-sector__mark c-${head.color}`} style={tint(head)}>
          <Icon name="users" size={20} />
        </span>
        <span className="org-side__who">
          <h3 className="truncate">{shown}</h3>
          <span className="truncate">{L(`${members} agentes · chefe: ${head.name}`, `${members} agents · head: ${head.name}`)}</span>
        </span>
        <button className="icon-btn" title={L('Fechar (Esc)', 'Close (Esc)')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {admin ? (
        <>
          <label className="field">
            <span className="field__label">{L('Nome do setor', 'Sector name')}</span>
            <input
              type="text"
              value={name}
              maxLength={40}
              placeholder={sectorName(head, L('Setor de', 'Sector of'))}
              onChange={(e) => ((draft.current.name = e.target.value), setName(e.target.value))}
              onBlur={save}
            />
          </label>
          <label className="field">
            <span className="field__label">{L('O que este setor resolve', 'What this sector solves')}</span>
            <textarea rows={3} value={does} maxLength={200} onChange={(e) => ((draft.current.does = e.target.value), setDoes(e.target.value))} onBlur={save} />
            <span className="hint">{L('Os outros chefes leem isto para saber quando mandar algo pra cá.', 'The other heads read this to know when to send something here.')}</span>
          </label>
          <span className={`org-sector__saved ${saved ? 'is-on' : ''}`} role="status">
            {saved && (
              <>
                <Icon name="check" size={12} /> {L('Salvo', 'Saved')}
              </>
            )}
          </span>
        </>
      ) : (
        <>
          <div className="field">
            <span className="field__label">{L('O que este setor resolve', 'What this sector solves')}</span>
            <p className="org-sector__text">{head.sectorDoes?.trim() || L('Ainda não foi escrito.', 'Not written yet.')}</p>
          </div>
        </>
      )}
      <div className="field">
        <span className="field__label">{L('Quem recebe os pedidos de fora', 'Who takes requests from outside')}</span>
        <span className="org-sector__head">
          <AgentAvatar agent={head} size={28} />
          <span className="truncate">
            <strong>{head.name}</strong>
            {head.role && ` · ${head.role}`}
          </span>
        </span>
        <span className="hint">{L('É quem fica no topo do ramo. Ele decide quem do setor faz.', 'They are at the top of the branch. They decide who in the sector does it.')}</span>
      </div>
      <div className="field">
        <span className="field__label">{L('Pedidos de outros setores', 'Requests from other sectors')}</span>
        {asks.length ? (
          <div className="org-pop__asks">
            {asks.map((d) => (
              <button key={d.id} className="org-pop__ask" title={d.text} onClick={() => (navigate({ kind: 'conversation', id: d.conversationId, message: d.rootId }), openThread(d.rootId))}>
                <span className="org-pop__ask-top">
                  <i className={d.asking ? 'is-asking' : ''} />
                  {L(`Pedido de ${nameOf(d.from)}`, `Asked by ${nameOf(d.from)}`)} · {d.asking ? L('pergunta esperando', 'a question waits') : ago(d.createdAt)}
                </span>
                <span className="org-pop__ask-text">{d.text.replace(/\s+/g, ' ').trim().slice(0, 96)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="org-sector__text is-calm">{L('Nenhum pedido de outro setor agora.', 'No request from another sector right now.')}</p>
        )}
      </div>
      <div className="org-side__acts">
        <button className="btn btn--sm" onClick={() => void openDm(head.id)}>
          {L(`Abrir DM do ${head.name}`, `Open ${head.name}’s DM`)}
        </button>
      </div>
    </aside>
  )
}
