import { L } from '../../../../shared/lang'
import { skillOrigin } from '../../../../shared/skill-groups'
import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import { safeUrl } from '../../links'
import remarkGfm from 'remark-gfm'
import { archiveSkill, saveSkill, useStore, type Skill, type SkillReport, amAdmin } from '../../store'
import { RECOMMENDED_SKILL_BODY_LENGTH, skillLengthNote } from '../../../../shared/skills'
import { Sheet } from '../Pages'
import { ago } from '../ui'
import { Who, AgentPicker } from './SkillPeople'
import { History } from './SkillHistory'

// "lida 3 vezes · todas terminaram bem"
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
  const origin = skillOrigin(k.source)
  if (!origin) return L(`mudou ${ago(k.updatedAt)}`, `changed ${ago(k.updatedAt)}`)
  const who = origin === 'codex' ? 'Codex' : origin === 'claude' ? 'Claude Code' : 'Hermes'
  return L(`do seu ${who}`, `from your ${who}`)
}

// One skill as a page: when to use it, who does, how it's going, the recipe and its history.
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
          <dt>{L('Quem usa', 'Assigned agents')}</dt>
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
          <dt>{L('Como está indo', 'Performance')}</dt>
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
        <h2>{L('Receita', 'Instructions')}</h2>
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
