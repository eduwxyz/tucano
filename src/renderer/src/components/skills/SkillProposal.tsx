import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L } from '../../../../shared/lang'
import { RECOMMENDED_SKILL_BODY_LENGTH, skillLengthNote } from '../../../../shared/skills'
import { useStore, agentById, decideSkill, type Skill } from '../../store'
import { safeUrl } from '../../links'
import { AgentAvatar, ago } from '../ui'
import { Who } from './SkillPeople'
import { Diff } from './SkillDiff'

export function Proposal({ proposal: p }: { proposal: Skill }): ReactNode {
  const agent = useStore((s) => (p.proposedBy ? agentById(s, p.proposedBy) : undefined))
  const current = useStore((s) => (p.replaces ? s.skills.find((k) => k.id === p.replaces) : undefined))
  return (
    <section className="proposal">
      <header>
        {agent && <AgentAvatar agent={agent} size={20} />}
        <strong>{current ? L(`Mudar ${p.name}`, `Change ${p.name}`) : L(`Nova: ${p.name}`, `New: ${p.name}`)}</strong>
        <span>
          {L(`${agent?.name ?? 'Um agente'} propôs ${ago(p.createdAt)}`, `${agent?.name ?? 'An agent'} proposed ${ago(p.createdAt)}`)}
        </span>
      </header>
      {p.reason && <p className="proposal__why">“{p.reason}”</p>}
      {p.body.length > RECOMMENDED_SKILL_BODY_LENGTH && <p className="hint hint--warn" role="status">{skillLengthNote(p.body.length)}</p>}
      {current ? (
        <Diff before={`${current.description}\n\n${current.body}`} after={`${p.description}\n\n${p.body}`} />
      ) : (
        <>
          <p className="proposal__when">
            <span>{L('Quando usar:', 'When to use:')}</span> {p.description}
          </p>
          <article className="recipe recipe--box">
            <Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]}>{p.body}</Markdown>
          </article>
          <p className="proposal__who">
            {L('Vale pra', 'For')} <Who ids={p.agents} />. {L('Depois de aprovar, dá pra liberar pra outros agentes.', 'After approving, you can open it to other agents.')}
          </p>
        </>
      )}
      <div className="proposal__acts">
        <button className="btn btn--sm btn--primary" onClick={() => decideSkill(p.id, true)}>
          {L('Aprovar', 'Approve')}
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => decideSkill(p.id, false)}>
          {L('Recusar', 'Refuse')}
        </button>
      </div>
    </section>
  )
}
