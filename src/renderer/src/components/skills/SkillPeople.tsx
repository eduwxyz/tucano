import { L } from '../../../../shared/lang'
import { useStore, agentById, isTeam, type Skill, type SkillReport } from '../../store'
import { AgentAvatar, Icon, ago } from '../ui'
import type { ReactNode } from 'react'
import { skillHarnessName } from '../../../../shared/skill-groups'

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

export function result(r?: SkillReport): string {
  const n = r?.reads.replies ?? 0
  if (!r || n === 0) return L('ainda não foi lida', 'not read yet')
  const ok = r.reads.ok
  return L(
    `lida ${n} ${n === 1 ? 'vez' : 'vezes'} · ${ok === n ? (n === 1 ? 'terminou bem' : 'todas terminaram bem') : `${Math.round((ok / n) * 100)}% terminaram bem`}`,
    `read ${n} ${n === 1 ? 'time' : 'times'} · ${ok === n ? (n === 1 ? 'it ended well' : 'all ended well') : `${Math.round((ok / n) * 100)}% ended well`}`
  )
}

export const from = (k: Skill): string => {
  const who = skillHarnessName(k.source)
  if (!who) return L(`mudou ${ago(k.updatedAt)}`, `changed ${ago(k.updatedAt)}`)
  return L(`do seu ${who}`, `from your ${who}`)
}
