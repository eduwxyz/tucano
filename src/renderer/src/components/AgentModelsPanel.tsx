import { useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ENGINES, modelInfo, type Agent } from '../../../shared/types'
import { amAdmin, setAgentModels, useStore } from '../store'
import { ModelPicker } from './Harness'
import { AgentAvatar } from './ui'

export function AgentModelsPanel(): ReactNode {
  const agents = useStore((s) => s.agents)
  const admin = useStore(amAdmin)
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const scope = agents.filter((a) => archived || !a.archived)
  const visible = scope.filter((a) => `${a.name} ${a.handle}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const targets = scope.filter((a) => selected.includes(a.id))
  const allVisible = visible.length > 0 && visible.every((a) => selected.includes(a.id))
  const save = async (ids: string[], value: string): Promise<boolean> => {
    if (saving.current || !admin || !ids.length || !modelInfo(value)?.id) return false
    saving.current = true
    setBusy(true)
    setError('')
    setResult('')
    try {
      const count = await setAgentModels(ids, value)
      setResult(count ? L(`Modelo atualizado em ${count} ${count === 1 ? 'agente' : 'agentes'}.`, `Model updated for ${count} ${count === 1 ? 'agent' : 'agents'}.`) : L('Os agentes já estavam usando esse modelo.', 'The agents were already using this model.'))
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  if (!admin) return null
  return (
    <section className="card agent-models" aria-label={L('Modelos dos agentes', 'Agent models')}>
      <div className="card__head">
        <h2>{L('Modelos dos agentes', 'Agent models')}</h2>
        <p className="muted">{L('Troque o modelo de cada agente ou aplique o mesmo a vários de uma vez. Vale para as próximas respostas; as que já começaram seguem como estão.', 'Change each agent’s model or apply one to several at once. Applies to future replies; replies already running continue as they are.')}</p>
      </div>
      <fieldset disabled={busy} className="agent-models__controls">
        <div className="agent-models__bulk">
          <strong>{L('Alterar em lote', 'Bulk change')}</strong>
          <ModelPicker value={model} onChange={setModel} />
          <p className="hint">{L('Ao trocar de harness, o agente passa a usar o login padrão dele. O modelo reserva continua igual.', "Switching runtimes uses the default login. The fallback model stays unchanged.")}</p>
          <div className="row">
            <button type="button" className="btn btn--primary btn--sm" disabled={!targets.length || !modelInfo(model)?.id} onClick={() => void save(targets.map((a) => a.id), model)}>
              {L(`Aplicar aos selecionados (${targets.length})`, `Apply to selected (${targets.length})`)}
            </button>
            <span className="muted small">{L(`${scope.length} ${scope.length === 1 ? 'agente disponível' : 'agentes disponíveis'}`, `${scope.length} ${scope.length === 1 ? 'agent' : 'agents'} available`)}</span>
          </div>
        </div>
        <div className="agent-models__filters">
          <input type="search" aria-label={L('Buscar agentes', 'Search agents')} placeholder={L('Buscar por nome ou @identificador', 'Search by name or @handle')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="row"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />{L('Incluir arquivados', 'Include archived')}</label>
        </div>
        <div className="row row--between">
          <label className="row"><input type="checkbox" checked={allVisible} disabled={!visible.length} onChange={() => setSelected((ids) => allVisible ? ids.filter((id) => !visible.some((a) => a.id === id)) : [...new Set([...ids, ...visible.map((a) => a.id)])])} />{L('Selecionar todos os exibidos', 'Select all displayed')}</label>
          {selected.length > 0 && <button type="button" className="link" onClick={() => setSelected([])}>{L('Limpar seleção', 'Clear selection')}</button>}
        </div>
        <p className="hint">{L('A aplicação em lote inclui os selecionados que estiverem fora da busca. Arquivados só entram com a opção acima marcada.', 'Bulk changes include selected agents outside the search. Archived agents are included only when the option above is checked.')}</p>
        <div className="agent-models__list">
          {visible.map((agent) => <AgentModelRow key={agent.id} agent={agent} selected={selected.includes(agent.id)} onSelect={() => setSelected((ids) => ids.includes(agent.id) ? ids.filter((id) => id !== agent.id) : [...ids, agent.id])} onSave={save} />)}
          {!visible.length && <p className="muted">{agents.length ? L('Nenhum agente encontrado.', 'No agents found.') : L('Crie um agente para escolher o modelo dele aqui.', 'Create an agent to choose its model here.')}</p>}
        </div>
      </fieldset>
      <div aria-live="polite" role="status">{busy ? L('Salvando modelos…', 'Saving models…') : result}</div>
      {error && <p className="field__error" role="alert">{error}</p>}
    </section>
  )
}

function AgentModelRow({ agent, selected, onSelect, onSave }: { agent: Agent; selected: boolean; onSelect: () => void; onSave: (ids: string[], model: string) => Promise<boolean> }): ReactNode {
  // Only unsaved choices live here; external updates remain visible when no edit is pending.
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? agent.modelId
  const current = modelInfo(agent.modelId)
  return (
    <div className="agent-models__row" role="group" aria-label={agent.name}>
      <div className="agent-models__identity">
        <input type="checkbox" aria-label={L(`Selecionar ${agent.name}`, `Select ${agent.name}`)} checked={selected} onChange={onSelect} />
        <AgentAvatar agent={agent} size={32} />
        <div><strong>{agent.name}</strong><div className="muted small">@{agent.handle}{agent.archived ? L(' · Arquivado', ' · Archived') : ''}{agent.kind === 'tuca' ? L(' · Assistente do app', ' · App assistant') : ''}</div></div>
      </div>
      <div className="agent-models__choice">
        <span className="muted small">{L('Em uso:', 'Current:')} {current ? `${ENGINES[current.engine].label} · ${current.label}` : agent.modelId}</span>
        <ModelPicker value={value} onChange={setDraft} />
      </div>
      <button type="button" className="btn btn--sm" disabled={value === agent.modelId || !modelInfo(value)?.id} onClick={async () => { if (await onSave([agent.id], value)) setDraft(null) }}>{L('Salvar', 'Save')}</button>
    </div>
  )
}
