import { L } from '../../../../shared/lang'
import type { VaultAccess } from '../../../../shared/types'
import { type ReactNode } from 'react'
import { agentById, useStore, isTeam } from '../../store'
import { AgentAvatar, Icon } from '../ui'


// Who uses a skill, as faces and names.
export function Who({ ids }: { ids: string[] }): ReactNode {
  const agents = useStore((s) => ids.map((id) => agentById(s, id)).filter((a) => !!a))
  if (ids.length === 0) return <span className="who">{L('todos os agentes', 'all agents')}</span>
  return (
    <span className="who">
      {agents.map((a) => (
        <span key={a.id} className="who__one">
          <AgentAvatar agent={a} size={14} /> {a.name}
        </span>
      ))}
    </span>
  )
}

// Who uses a skill: every agent, or the ones picked (always at least one;
// an empty list means everyone).
export function AgentPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter(isTeam))
  const everyone = value.length === 0
  const toggle = (id: string): void => {
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id]
    if (next.length) onChange(next)
  }
  return (
    <div className="agent-picker">
      <div className="segmented">
        <button type="button" className={everyone ? 'is-active' : ''} onClick={() => onChange([])}>
          {L('Todos os agentes', 'All agents')}
        </button>
        <button type="button" className={everyone ? '' : 'is-active'} onClick={() => everyone && onChange(agents.map((a) => a.id))}>
          {L('Só alguns', 'Only some')}
        </button>
      </div>
      {!everyone && (
        <div className="agent-picker__list">
          {agents.map((a) => {
            const on = value.includes(a.id)
            return (
              <button key={a.id} type="button" className={`agent-pill ${on ? 'is-on' : ''}`} title={on && value.length === 1 ? L('Pelo menos um agente usa a skill', 'At least one agent uses the skill') : undefined} onClick={() => toggle(a.id)}>
                <AgentAvatar agent={a} size={18} />
                {a.name}
                {on && <Icon name="check" size={12} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Who uses something where "everyone" must be said in so many words (a vault item): every agent,
// those made later too, or the ones picked, even none. Never "an empty list means everyone".
export function AccessPicker({ value, onChange }: { value: VaultAccess; onChange: (a: VaultAccess) => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter((a) => isTeam(a) && !a.archived))
  const ids = value.all ? [] : value.agentIds
  const toggle = (id: string): void => onChange({ all: false, agentIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] })
  return (
    <div className="agent-picker">
      <div className="segmented">
        <button type="button" className={value.all ? 'is-active' : ''} onClick={() => onChange({ all: true })}>
          {L('Todos os agentes', 'All agents')}
        </button>
        <button type="button" className={value.all ? '' : 'is-active'} onClick={() => value.all && onChange({ all: false, agentIds: [] })}>
          {L('Só alguns', 'Only some')}
        </button>
      </div>
      {value.all ? (
        <span className="hint">{L('Vale também pros agentes que você criar depois.', 'It also counts for the agents you create later.')}</span>
      ) : (
        <div className="agent-picker__list">
          {agents.map((a) => {
            const on = ids.includes(a.id)
            return (
              <button key={a.id} type="button" aria-pressed={on} className={`agent-pill ${on ? 'is-on' : ''}`} onClick={() => toggle(a.id)}>
                <AgentAvatar agent={a} size={18} />
                {a.name}
                {on && <Icon name="check" size={12} />}
              </button>
            )
          })}
          {!ids.length && <span className="hint">{L('Nenhum agente usa ainda.', 'No agent uses it yet.')}</span>}
        </div>
      )}
    </div>
  )
}
