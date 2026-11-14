import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { useStore, skillVersions, restoreSkill, agentById, type Skill, type SkillVersion } from '../../store'
import { time } from '../ui'
import { Diff } from './SkillDiff'

export function History({ skill }: { skill: Skill }): ReactNode {
  const [versions, setVersions] = useState<SkillVersion[] | null>(null)
  const [showing, setShowing] = useState<number | null>(null)
  const who = useStore((s) => (by: string) => (by === 'me' ? s.me.name : (agentById(s, by)?.name ?? L('agente', 'agent'))))
  useEffect(() => {
    void skillVersions(skill.id).then(setVersions)
  }, [skill.id, skill.updatedAt])
  if (!versions) return <p className="muted small">{L('Buscando o histórico…', 'Fetching the history…')}</p>
  if (versions.length === 0) return <p className="muted small">{L('Nenhuma mudança ainda: esta é a primeira versão.', 'No changes yet: this is the first version.')}</p>
  return (
    <div className="skill__history">
      {versions.map((v) => (
        <div key={v.id}>
          <div className="row row--center small">
            <span className="grow">
              {L('Antes de', 'Before')} {time(v.at)} <span className="muted">· {v.by === 'me' ? L(`mudada por ${who(v.by)}`, `changed by ${who(v.by)}`) : L(`mudada por uma proposta de ${who(v.by)}`, `changed by a proposal from ${who(v.by)}`)}</span>
            </span>
            <button className="link small" onClick={() => setShowing(showing === v.id ? null : v.id)}>
              {showing === v.id ? L('esconder', 'hide') : L('o que mudou', 'what changed')}
            </button>
            <button className="btn btn--xs" onClick={() => restoreSkill(skill.id, v.id)}>
              {L('Voltar a esta', 'Restore this one')}
            </button>
          </div>
          {showing === v.id && <Diff before={`${v.description}\n\n${v.body}`} after={`${skill.description}\n\n${skill.body}`} />}
        </div>
      ))}
    </div>
  )
}
