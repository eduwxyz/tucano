import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L } from '../../../../shared/lang'
import { RECOMMENDED_SKILL_BODY_LENGTH, skillLengthNote } from '../../../../shared/skills'
import { archiveSkill, saveSkill, useStore, amAdmin, type Skill, type SkillReport } from '../../store'
import { safeUrl } from '../../links'
import { Sheet } from '../Pages'
import { AgentPicker, Who, result, from } from './SkillPeople'
import { History } from './SkillHistory'

export function SkillPage({ skill: k, stat, onBack, onEdit }: { skill: Skill; stat?: SkillReport; onBack: () => void; onEdit: () => void }): ReactNode {
  const [picking, setPicking] = useState(false)
  const admin = useStore(amAdmin)
  const setAgents = (agents: string[]): void => void saveSkill({ id: k.id, name: k.name, description: k.description, body: k.body, agents, source: k.source })
  const changed = stat?.changedAt && stat.before && stat.since && stat.before.replies + stat.since.replies > 0
  const pct = (r: { replies: number; ok: number }): string => (r.replies ? `${Math.round((r.ok / r.replies) * 100)}%` : '—')
  return (
    <Sheet
      back={{ label: 'Skills', onClick: onBack }}
      title={k.name}
      lede={k.description}
      actions={
        admin && (
          <>
            <button className="text-btn" onClick={onEdit}>
              {L('Editar', 'Edit')}
            </button>
            <button className="text-btn" onClick={() => (archiveSkill(k.id, true), onBack())}>
              {L('Arquivar', 'Archive')}
            </button>
          </>
        )
      }
    >
      <dl className="skill-facts">
        <div>
          <dt>{L('Quem usa', 'Who uses it')}</dt>
          <dd>
            <Who ids={k.agents} />
            {admin && (
              <button className="text-btn" onClick={() => setPicking(!picking)}>
                {picking ? L('pronto', 'done') : L('mudar', 'change')}
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>{L('Como está indo', 'How it’s going')}</dt>
          <dd>
            {result(stat)}
            {changed && (
              <span className="muted">
                {' '}
                · {L('desde a última mudança', 'since the last change')}, {pct(stat.before!)} → {pct(stat.since!)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{L('De onde', 'Source')}</dt>
          <dd>{k.source ? <span title={k.source}>{L(`Lida do arquivo, ${from(k)}: o que você muda lá vale na próxima vez`, `Read from the file, ${from(k)}: what you change there applies next time`)}</span> : L(`Escrita aqui, ${from(k)}`, `Written here, ${from(k)}`)}</dd>
        </div>
      </dl>
      {picking && (
        <div className="skill-pick">
          <AgentPicker value={k.agents} onChange={setAgents} />
        </div>
      )}
      <section className="read-group">
        <h2>{L('Receita', 'Recipe')}</h2>
        {k.source && k.body.length > RECOMMENDED_SKILL_BODY_LENGTH && <p className="hint hint--warn" role="status">{skillLengthNote(k.body.length)}</p>}
        {k.body.trim() ? (
          <article className="recipe">
            <Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]}>{k.body}</Markdown>
          </article>
        ) : (
          <p className="read-empty">{L(`A receita é lida de ${k.source} a cada uso.`, `The recipe is read from ${k.source} on every use.`)}</p>
        )}
      </section>
      {admin && !k.source && (
        <section className="read-group">
          <h2>{L('Histórico', 'History')}</h2>
          <History skill={k} />
        </section>
      )}
    </Sheet>
  )
}
