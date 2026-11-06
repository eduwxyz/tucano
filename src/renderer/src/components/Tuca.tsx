// The Tuca's proposals: a card under his message with Criar, Editar antes and
// Descartar. In the introduction the same card says "Usar esse" and fills the
// first agent instead (the introduction then sets its powers and first task).
import { L } from '../../../shared/lang'
import { createContext, useContext, useState, type ReactNode } from 'react'
import {
  ENGINES,
  applyProposal,
  createFromDraft,
  dismissProposal,
  modelInfo,
  navigate,
  newAgentDraft,
  openDm,
  sendMessage,
  settleDraft,
  slug,
  useStore,
  type Agent,
  type AgentDraft,
  type AgentChanges,
  type Message
} from '../store'
import { AgentAvatar, Icon, tokens } from './ui'
import { describeRoutine } from './Routines'

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
  const by = useStore((s) => (message.author.kind === 'agent' && s.agents.find((a) => a.id === (message.author as { id: string }).id)?.name) || 'Tuca')
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
      if (d.task) sendMessage(conversationId, d.task)
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
        <span className="tag">{L(`proposta de ${by}`, `proposed by ${by}`)}</span>
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
            <span className="tag tag--ok">{created ? L(`${created.name} entrou no time`, `${created.name} joined the team`) : L('criado', 'created')}</span>
            {created && (
              <>
                <button className="btn btn--primary btn--sm" onClick={() => void openDm(created.id)}>
                  {L('Abrir conversa', 'Open conversation')}
                </button>
                <button className="link" onClick={() => navigate({ kind: 'agent', id: created.id })}>
                  {L('Ver perfil', 'See profile')}
                </button>
              </>
            )}
          </>
        ) : d.state === 'dismissed' ? (
          <span className="tag">{L('descartado', 'discarded')}</span>
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
              {L('Descartar', 'Discard')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// A change the Tuca proposes to what exists (an agent), or a new routine or channel: what it would
// be, with Aplicar and Descartar. Nothing changes until the person applies it.
export function ProposalCard({ message }: { message: Message }): ReactNode {
  const p = message.run!.proposal!
  const agents = useStore((s) => s.agents)
  const connectors = useStore((s) => s.connectors)
  const conversations = useStore((s) => s.conversations)
  // A newer proposal in the same conversation replaces this one.
  const replaced = useStore((s) => s.messages.some((m) => m.conversationId === message.conversationId && m.at > message.at && !!m.run?.proposal))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const agentOf = (id: string): Agent | undefined => agents.find((a) => a.id === id)
  const by = (message.author.kind === 'agent' && agentOf(message.author.id)?.name) || 'Tuca'
  const grantList = (g: Record<string, string>): string =>
    Object.entries(g).map(([id, level]) => `${connectors.find((c) => c.id === id)?.name ?? L('conector', 'connector')} (${level === 'read_write' ? L('leitura e escrita', 'read and write') : L('leitura', 'read')})`).join(', ') || L('nenhum', 'none')
  const modelName = (id: string): string => {
    const m = modelInfo(id)
    return m ? `${ENGINES[m.engine].label} · ${m.label}` : id
  }

  async function apply(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await applyProposal(message.id)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  let head: ReactNode
  let body: ReactNode
  let done: ReactNode
  if (p.kind === 'agent') {
    const agent = agentOf(p.agentId)
    const rows: [string, string, string][] = []
    const c: AgentChanges = p.changes
    // As they were when proposed (once applied, the agent already has the new ones).
    const was = { ...agent, ...p.before }
    const level = (e: Agent['effort']): string => ({ low: L('baixo', 'low'), medium: L('médio', 'medium'), high: L('alto', 'high'), xhigh: L('máximo', 'max') })[e]
    if (agent) {
      if (c.name !== undefined) rows.push([L('Nome', 'Name'), was.name ?? '', c.name])
      if (c.role !== undefined) rows.push([L('Função', 'Role'), was.role || '—', c.role])
      if (c.modelId !== undefined) rows.push([L('Modelo', 'Model'), modelName(was.modelId ?? ''), modelName(c.modelId)])
      if (c.effort !== undefined) rows.push([L('Esforço', 'Effort'), level(was.effort ?? agent.effort), level(c.effort)])
      if (c.web !== undefined) rows.push(['Web', was.web !== false ? L('ligada', 'on') : L('desligada', 'off'), c.web ? L('ligada', 'on') : L('desligada', 'off')])
      if (c.grants !== undefined) rows.push([L('Conectores', 'Connectors'), grantList(was.grants ?? {}), grantList(c.grants)])
      if (c.limit !== undefined) rows.push([L('Limite do mês', "Month's limit"), tokens(was.limit ?? agent.limit), tokens(c.limit)])
    }
    head = (
      <>
        {agent && <AgentAvatar agent={agent} size={40} />}
        <div className="grow">
          <strong>{L(`Ajustar ${agent?.name ?? 'agente'}`, `Change ${agent?.name ?? 'agent'}`)}</strong>
          <span className="muted small">{agent?.role || L('Agente', 'Agent')}</span>
        </div>
      </>
    )
    body = (
      <>
        {rows.length > 0 && (
          <div className="proposal-rows small">
            {rows.map(([label, before, after]) => (
              <div key={label}>
                <span className="muted">{label}</span>
                <span>
                  <s className="muted">{before}</s> → <b>{after}</b>
                </span>
              </div>
            ))}
          </div>
        )}
        {c.instructions !== undefined && (
          <>
            <span className="muted small">{L('Instruções novas', 'New instructions')}</span>
            <p className={`draft-card__instructions ${open ? 'is-open' : ''}`} onClick={() => setOpen(!open)} title={open ? undefined : L('Ver tudo', 'Show all')}>
              {c.instructions}
            </p>
          </>
        )}
      </>
    )
    done = agent && (
      <button className="link" onClick={() => navigate({ kind: 'agent', id: agent.id })}>
        {L('Ver perfil', 'See profile')}
      </button>
    )
  } else if (p.kind === 'routine') {
    const agent = agentOf(p.routine.agentId)
    const conv = conversations.find((c) => c.id === p.routine.conversationId)
    head = (
      <>
        <span className="proposal-icon">
          <Icon name="clock" size={18} />
        </span>
        <div className="grow">
          <strong>{p.routine.name}</strong>
          <span className="muted small">{L('Rotina nova', 'New routine')}</span>
        </div>
      </>
    )
    body = (
      <>
        <div className="draft-card__facts small">
          <span>{agent && <AgentAvatar agent={agent} size={14} />} {agent?.name ?? L('agente', 'agent')}</span>
          <span>
            <Icon name="clock" size={12} /> {describeRoutine(p.routine)}
          </span>
          <span>{conv && conv.kind === 'channel' ? `#${conv.name}` : L('na DM', 'in the DM')}</span>
        </div>
        <p className={`draft-card__instructions ${open ? 'is-open' : ''}`} onClick={() => setOpen(!open)} title={open ? undefined : L('Ver tudo', 'Show all')}>
          {p.routine.prompt}
        </p>
      </>
    )
    done = (
      <button className="link" onClick={() => navigate({ kind: 'routines' })}>
        {L('Ver em Rotinas', 'See in Routines')}
      </button>
    )
  } else if (p.kind === 'team') {
    const channel = p.appliedId ? conversations.find((c) => c.id === p.appliedId) : undefined
    head = (
      <>
        <span className="proposal-icon">
          <Icon name="users" size={18} />
        </span>
        <div className="grow">
          <strong>{p.channel ? `#${p.channel.name}` : L(`Um time de ${p.agents.length}`, `A team of ${p.agents.length}`)}</strong>
          <span className="muted small">{p.channel?.topic || L(`Time de ${p.agents.length} agentes`, `Team of ${p.agents.length} agents`)}</span>
        </div>
      </>
    )
    body = (
      <div className="team-card">
        {p.agents.map((d) => {
          const m = modelInfo(d.modelId)
          return (
            <div key={d.name} className="team-card__agent">
              <AgentAvatar agent={{ name: d.name, color: d.color }} size={28} />
              <div className="grow">
                <strong>{d.name}</strong> <span className="muted small">{d.role}</span>
                <p className="muted small">{d.instructions.split('\n')[0]}</p>
              </div>
              <span className="muted small">{m ? m.label : d.modelId}</span>
            </div>
          )
        })}
      </div>
    )
    done = channel ? (
      <button className="btn btn--primary btn--sm" onClick={() => navigate({ kind: 'conversation', id: channel.id })}>
        {L('Abrir canal', 'Open channel')}
      </button>
    ) : undefined
  } else {
    const members = p.members.map(agentOf).filter((a): a is Agent => !!a)
    head = (
      <>
        <span className="proposal-icon">#</span>
        <div className="grow">
          <strong>#{p.name}</strong>
          <span className="muted small">{p.topic || L('Canal novo', 'New channel')}</span>
        </div>
      </>
    )
    body = (
      <div className="draft-card__facts small">
        <span>{members.map((a) => a.name).join(', ')}</span>
        <span>{p.threads ? L('Em threads, uma por mensagem', 'In threads, one per message') : L('Na conversa, como um chat', 'In the conversation, like a chat')}</span>
      </div>
    )
    done = p.appliedId && (
      <button className="btn btn--primary btn--sm" onClick={() => navigate({ kind: 'conversation', id: p.appliedId! })}>
        {L('Abrir canal', 'Open channel')}
      </button>
    )
  }

  return (
    <div className={`draft-card ${p.state || replaced ? 'is-settled' : ''}`}>
      <div className="draft-card__head">
        {head}
        <span className="tag">{L(`proposta de ${by}`, `proposed by ${by}`)}</span>
      </div>
      {body}
      {p.reason && <p className="hint">{p.reason}</p>}
      {error && <p className="note note--error">{error}</p>}
      <div className="draft-card__actions">
        {p.state === 'applied' ? (
          <>
            <span className="tag tag--ok">{L('aplicado', 'applied')}</span>
            {done}
          </>
        ) : p.state === 'dismissed' ? (
          <span className="tag">{L('descartado', 'discarded')}</span>
        ) : replaced ? (
          <span className="muted small">{L('Trocada por uma proposta mais nova.', 'Replaced by a newer proposal.')}</span>
        ) : (
          <>
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void apply()}>
              {p.kind === 'team' ? L('Criar time', 'Create team') : L('Aplicar', 'Apply')}
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => dismissProposal(message.id)}>
              {L('Descartar', 'Discard')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
