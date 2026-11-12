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
  messagesIn,
  useStore,
  type Agent,
  type AgentDraft,
  type AgentChanges,
  type Message,
  type Proposal,
  type ProposalsResult,
  type State,
  amAdmin,
  applyOrder,
  applyProposals,
  dismissProposals,
  proposalKey,
  proposalsOf
} from '../store'
import { AgentAvatar, Icon, monthlyLimitText } from './ui'
import { instructionLengthNote } from '../../../shared/instructions'
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
  const replaced = useStore((s) => messagesIn(s, message.conversationId).some((m) => m.at > message.at && !!m.run?.agentDraft))
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
      {instructionLengthNote(d.instructions.length) && <p className="hint hint--warn">{instructionLengthNote(d.instructions.length)}</p>}
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
// `index`: which of the reply's cards; `proposal`: the card itself, when it comes from elsewhere (the inbox).
export function ProposalCard({ message, index = 0, proposal }: { message: Message; index?: number; proposal?: Proposal }): ReactNode {
  const p = proposal ?? proposalsOf(message.run)[index]!
  const agents = useStore((s) => s.agents)
  const connectors = useStore((s) => s.connectors)
  const conversations = useStore((s) => s.conversations)
  const replaced = useStore((s) => replacedLater(s, message, p))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState('')
  const [open, setOpen] = useState(false)
  // Agents and teams are the admins': a member's card goes to them instead (the core tells them).
  const forAdmin = useStore((s) => (p.kind === 'agent' || p.kind === 'team') && !amAdmin(s))
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
      await applyProposal(message.id, index)
    } catch (e) {
      const why = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      if (forAdmin) setSent(L('Mandei pros admins aplicarem. Você recebe um aviso quando decidirem.', 'Sent to the admins to apply. You’ll hear when they decide.'))
      else setError(why)
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
      // 0 is no limit, so the card says that instead of a figure that reads as "set it to zero".
      if (c.limit !== undefined) rows.push([L('Limite do mês', "Month's limit"), monthlyLimitText(was.limit ?? agent.limit), monthlyLimitText(c.limit)])
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
            {instructionLengthNote(c.instructions.length) && <p className="hint hint--warn">{instructionLengthNote(c.instructions.length)}</p>}
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
    // For an agent proposed in the same reply: its name, until it's made.
    const agent = agentOf(p.routine.agentId)
    const newName = !agent ? p.needs?.[0] : undefined
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
          <span>{agent && <AgentAvatar agent={agent} size={14} />} {agent?.name ?? newName ?? L('agente', 'agent')}</span>
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
                {instructionLengthNote(d.instructions.length) && <p className="hint hint--warn">{instructionLengthNote(d.instructions.length)}</p>}
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
    const members = [...p.members.map(agentOf).filter((a): a is Agent => !!a).map((a) => a.name), ...(p.needs ?? [])]
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
        <span>{members.join(', ')}</span>
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
      {p.needs?.length && !p.state ? (
        <p className="hint proposal__needs">
          <Icon name="layers" size={12} /> {L(`Depende de ${p.needs.join(', ')}, proposto nesta mesma resposta: é criado antes.`, `Depends on ${p.needs.join(', ')}, proposed in this same reply: it's made first.`)}
        </p>
      ) : null}
      {(error || (!p.state && p.error)) && <p className="note note--error">{error || p.error}</p>}
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
        ) : sent ? (
          <span className="muted small">{sent}</span>
        ) : (
          <>
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void apply()}>
              {forAdmin ? L('Pedir a um admin', 'Ask an admin') : p.kind === 'team' ? L('Criar time', 'Create team') : L('Aplicar', 'Apply')}
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => dismissProposal(message.id, index)}>
              {L('Descartar', 'Discard')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// A newer card about the same thing (a later reply in the conversation) replaces this one.
const replacedLater = (s: State, message: Message, p: Proposal): boolean => {
  if (!message.conversationId) return false
  const key = proposalKey(p)
  return messagesIn(s, message.conversationId).some((m) => m.at > message.at && proposalsOf(m.run).some((x) => proposalKey(x) === key))
}

// What's under a reply: its new-agent card and its proposals. One card shows as it always did;
// several, as a group to go through ("1 de 5") and apply one by one or all at once. Where the
// new-agent card fills a form instead (the introduction, the builder), it stays out of the group,
// unless other cards need that agent: then "Aplicar todos" creates it as proposed, first.
export function Proposals({ message }: { message: Message }): ReactNode {
  const use = useContext(UseDraft)
  const list = proposalsOf(message.run)
  const draft = message.run?.agentDraft
  const inGroup = !!draft && (!use || list.some((p) => p.needs?.some((n) => n.toLowerCase() === draft.name.toLowerCase())))
  if (list.length + (inGroup ? 1 : 0) <= 1)
    return (
      <>
        {draft && <AgentProposal message={message} />}
        {list[0] && <ProposalCard message={message} index={0} />}
      </>
    )
  return (
    <>
      {draft && !inGroup && <AgentProposal message={message} />}
      <ProposalGroup message={message} withDraft={inGroup} />
    </>
  )
}

type Item = { draft: true } | { draft?: false; index: number }

function ProposalGroup({ message, withDraft }: { message: Message; withDraft: boolean }): ReactNode {
  const list = proposalsOf(message.run)
  const draft = message.run?.agentDraft
  const agents = useStore((s) => s.agents)
  const admin = useStore(amAdmin)
  const replaced = useStore((s) => list.map((p) => replacedLater(s, message, p)))
  const draftReplaced = useStore((s) => !!draft && messagesIn(s, message.conversationId).some((m) => m.at > message.at && !!m.run?.agentDraft))
  // In the order "apply all" goes: the new agent first, then teams, changes, channels, routines.
  const items: Item[] = [...(withDraft ? [{ draft: true } as const] : []), ...applyOrder(list).map((index) => ({ index }))]
  const [at, setAt] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ProposalsResult | null>(null)
  const [error, setError] = useState('')
  const now = Math.min(at, items.length - 1)
  const item = items[now]!
  const stateOf = (it: Item): 'applied' | 'dismissed' | 'replaced' | 'failed' | 'open' => {
    if (it.draft) return draft?.state === 'created' ? 'applied' : draft?.state === 'dismissed' ? 'dismissed' : draftReplaced ? 'replaced' : 'open'
    const p = list[it.index]!
    return p.state ?? (replaced[it.index] ? 'replaced' : p.error ? 'failed' : 'open')
  }
  const open = items.filter((it) => ['open', 'failed'].includes(stateOf(it)))
  const applied = items.filter((it) => stateOf(it) === 'applied').length
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? L('um agente', 'an agent')
  const FIELDS = (): Record<string, string> => ({ name: L('nome', 'name'), role: L('função', 'role'), instructions: L('instruções', 'instructions'), modelId: L('modelo', 'model'), effort: L('esforço', 'effort'), web: 'web', grants: L('conectores', 'connectors'), limit: L('limite', 'limit') })
  // One line per card, as "apply all" will do it.
  const line = (it: Item): string => {
    if (it.draft) return L(`Criar o agente ${draft!.name}`, `Create the agent ${draft!.name}`)
    const p = list[it.index]!
    if (p.kind === 'agent') return L(`Ajustar ${nameOf(p.agentId)}: ${Object.keys(p.changes).map((k) => FIELDS()[k] ?? k).join(', ')}`, `Change ${nameOf(p.agentId)}: ${Object.keys(p.changes).map((k) => FIELDS()[k] ?? k).join(', ')}`) + (admin ? '' : L(' (vai pros admins)', ' (goes to the admins)'))
    if (p.kind === 'team') return L(`Criar o time ${p.agents.map((a) => a.name).join(', ')}${p.channel ? ` e #${p.channel.name}` : ''}`, `Create the team ${p.agents.map((a) => a.name).join(', ')}${p.channel ? ` and #${p.channel.name}` : ''}`) + (admin ? '' : L(' (vai pros admins)', ' (goes to the admins)'))
    if (p.kind === 'channel') return L(`Criar o canal #${p.name}`, `Create the #${p.name} channel`)
    const who = p.routine.agentId ? nameOf(p.routine.agentId) : (p.needs?.[0] ?? L('um agente', 'an agent'))
    return L(`Criar a rotina “${p.routine.name}” de ${who} (${describeRoutine(p.routine)})`, `Create the routine “${p.routine.name}” for ${who} (${describeRoutine(p.routine)})`)
  }

  async function applyAll(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const r = await applyProposals(message.id, withDraft && open.some((it) => it.draft))
      setResult(r)
      setConfirming(false)
      // The first that didn't work, to see why.
      const failed = items.findIndex((it) => (it.draft ? !!r.draft?.error : r.failed.some((f) => f.index === it.index)))
      if (failed >= 0) setAt(failed)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  const ok = result ? result.applied.length + (result.draft?.agentId ? 1 : 0) : 0
  const outcome = result && (
    <div className={`proposal-group__result ${result.failed.length || result.draft?.error ? 'is-partial' : ''}`} role="status">
      <strong>
        {[
          ok > 0 && L(`${ok} ${ok === 1 ? 'aplicada' : 'aplicadas'}`, `${ok} applied`),
          result.failed.length + (result.draft?.error ? 1 : 0) > 0 && L(`${result.failed.length + (result.draft?.error ? 1 : 0)} não deu certo`, `${result.failed.length + (result.draft?.error ? 1 : 0)} didn't work`),
          result.forwarded.length > 0 && L(`${result.forwarded.length} ${result.forwarded.length === 1 ? 'enviada' : 'enviadas'} aos admins`, `${result.forwarded.length} sent to the admins`)
        ]
          .filter(Boolean)
          .join(' · ') || L('Nada a aplicar.', 'Nothing to apply.')}
      </strong>
      {(result.draft?.error || result.failed.length > 0) && (
        <ul>
          {result.draft?.error && (
            <li>
              {line({ draft: true })}: {result.draft.error}
            </li>
          )}
          {result.failed.map((f) => (
            <li key={f.index}>
              <button className="link" onClick={() => setAt(items.findIndex((it) => !it.draft && it.index === f.index))}>
                {line({ index: f.index })}
              </button>
              : {f.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div className="proposal-group" aria-label={L(`${items.length} propostas`, `${items.length} proposals`)}>
      <div className="proposal-group__bar">
        <span className="proposal-group__count small">
          <b>{L(`${items.length} propostas`, `${items.length} proposals`)}</b>
          {applied > 0 && <span className="muted"> · {L(`${applied} ${applied === 1 ? 'aplicada' : 'aplicadas'}`, `${applied} applied`)}</span>}
        </span>
        <div className="proposal-group__dots" role="tablist">
          {items.map((it, i) => (
            <button key={it.draft ? 'draft' : it.index} role="tab" aria-selected={i === now} className={`is-${stateOf(it)} ${i === now ? 'is-now' : ''}`} title={line(it)} onClick={() => setAt(i)} />
          ))}
        </div>
        <div className="proposal-group__pager">
          <button className="icon-btn icon-btn--sm" aria-label={L('Anterior', 'Previous')} disabled={now === 0} onClick={() => setAt(now - 1)}>
            ←
          </button>
          <span className="small">{L(`${now + 1} de ${items.length}`, `${now + 1} of ${items.length}`)}</span>
          <button className="icon-btn icon-btn--sm" aria-label={L('Próxima', 'Next')} disabled={now === items.length - 1} onClick={() => setAt(now + 1)}>
            →
          </button>
        </div>
      </div>
      <div className="proposal-group__card" key={item.draft ? 'draft' : item.index}>
        {item.draft ? <AgentProposal message={message} /> : <ProposalCard message={message} index={item.index} />}
      </div>
      {outcome}
      {confirming ? (
        <div className="proposal-group__confirm">
          <strong className="small">{L(`Aplicar ${open.length === 1 ? 'a proposta que falta' : `as ${open.length} propostas que faltam`}, nesta ordem:`, `Apply the ${open.length === 1 ? 'proposal left' : `${open.length} proposals left`}, in this order:`)}</strong>
          <ol className="small">
            {open.map((it) => (
              <li key={it.draft ? 'draft' : it.index}>{line(it)}</li>
            ))}
          </ol>
          <p className="hint">{L('Se uma não der certo, as outras seguem e você vê o porquê.', "If one doesn't work, the others go on and you see why.")}</p>
          {error && <p className="note note--error">{error}</p>}
          <div className="draft-card__actions">
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void applyAll()}>
              {busy ? L('Aplicando…', 'Applying…') : L('Confirmar', 'Confirm')}
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirming(false)}>
              {L('Cancelar', 'Cancel')}
            </button>
          </div>
        </div>
      ) : (
        open.length > 1 && (
          <div className="draft-card__actions proposal-group__all">
            <button className="btn btn--sm" onClick={() => (setConfirming(true), setResult(null))}>
              {L(`Aplicar todos (${open.length})`, `Apply all (${open.length})`)}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => dismissProposals(message.id, withDraft)}>
              {L('Descartar todos', 'Discard all')}
            </button>
          </div>
        )
      )}
    </div>
  )
}
