// The Tuca's proposals: a card under his message with Criar, Editar antes and
// Descartar. In the introduction the same card says "Usar esse" and fills the
// first agent instead (the introduction then sets its powers and first task).
import { L } from '../../../shared/lang'
import { createContext, useContext, useState, type ReactNode } from 'react'
import {
  ENGINES,
  createFromDraft,
  modelInfo,
  navigate,
  newAgentDraft,
  sendMessage,
  settleDraft,
  slug,
  useStore,
  type Agent,
  type AgentDraft,
  type Message
} from '../store'
import { AgentAvatar, Icon } from './ui'

const EFFORT = (): Record<AgentDraft['effort'], string> => ({ low: L('esforço baixo', 'low effort'), medium: L('esforço médio', 'medium effort'), high: L('esforço alto', 'high effort'), xhigh: L('esforço máximo', 'max effort') })

// Set by the introduction: a card there fills the first agent instead of creating one.
export const UseDraft = createContext<((draft: AgentDraft, messageId: string) => void) | null>(null)

export function draftAgent(d: AgentDraft): Agent {
  return { ...newAgentDraft(), name: d.name, handle: slug(d.name), role: d.role, color: d.color, instructions: d.instructions, modelId: d.modelId, effort: d.effort, web: d.web, grants: d.grants }
}

export function AgentProposal({ message }: { message: Message }): ReactNode {
  const d = message.run!.agentDraft!
  const use = useContext(UseDraft)
  const connectors = useStore((s) => s.connectors)
  const created = useStore((s) => (d.agentId ? s.agents.find((a) => a.id === d.agentId) : undefined))
  // A newer proposal in the same conversation replaces this one.
  const replaced = useStore((s) => s.messages.some((m) => m.conversationId === message.conversationId && m.at > message.at && !!m.run?.agentDraft))
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const model = modelInfo(d.modelId)
  const access = Object.entries(d.grants).map(([id, level]) => `${connectors.find((c) => c.id === id)?.name ?? L('conector', 'connector')} (${level === 'read_write' ? L('leitura e escrita', 'read and write') : L('leitura', 'read')})`)

  async function create(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const { conversationId } = await createFromDraft(message.id)
      navigate({ kind: 'conversation', id: conversationId })
      if (d.task) await sendMessage(conversationId, d.task)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`draft-card ${d.state || replaced ? 'is-settled' : ''}`}>
      <div className="draft-card__head">
        <AgentAvatar agent={{ name: d.name, color: d.color }} size={40} />
        <div className="grow">
          <strong>{d.name}</strong>
          <span className="muted small">{d.role || L('Agente', 'Agent')}</span>
        </div>
        <span className="tag">{L('proposta do Tuca', 'proposed by Tuca')}</span>
      </div>
      <p className={`draft-card__instructions ${open ? 'is-open' : ''}`} onClick={() => setOpen(!open)} title={open ? undefined : L('Ver tudo', 'Show all')}>
        {d.instructions}
      </p>
      <div className="draft-card__facts small">
        {model && (
          <span>
            <Icon name="spark" size={12} /> {ENGINES[model.engine].label} · {model.label} · {EFFORT()[d.effort]}
          </span>
        )}
        <span>
          <Icon name="globe" size={12} /> {d.web ? L('Web ligada', 'Web on') : L('Sem web', 'No web')}
        </span>
        <span>
          <Icon name="plug" size={12} /> {access.length ? access.join(', ') : L('Sem conectores', 'No connectors')}
        </span>
      </div>
      {d.reason && <p className="hint">{d.reason}</p>}
      {d.task && <p className="hint">{L('Primeira tarefa', 'First task')}: “{d.task}”</p>}
      {error && <p className="note note--error">{error}</p>}
      <div className="draft-card__actions">
        {d.state === 'created' ? (
          <>
            <span className="tag tag--ok">{L('criado', 'created')}</span>
            {created && (
              <button className="link" onClick={() => navigate({ kind: 'agent', id: created.id })}>
                {L('Ver', 'See')} {created.name}
              </button>
            )}
          </>
        ) : d.state === 'dismissed' ? (
          <span className="tag">{L('descartado', 'dismissed')}</span>
        ) : replaced ? (
          <span className="muted small">{L('Trocada por uma proposta mais nova.', 'Replaced by a newer proposal.')}</span>
        ) : use ? (
          <button className="btn btn--primary btn--sm" onClick={() => use(d, message.id)}>
            {L('Usar esse agente', 'Use this agent')}
          </button>
        ) : (
          <>
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void create()}>
              {d.task ? L('Criar e testar', 'Create and try it') : L('Criar', 'Create')}
            </button>
            <button className="btn btn--sm" onClick={() => navigate({ kind: 'new-agent', draft: draftAgent(d), fromMessage: message.id })}>
              {L('Editar antes', 'Edit first')}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => settleDraft(message.id)}>
              {L('Descartar', 'Dismiss')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
