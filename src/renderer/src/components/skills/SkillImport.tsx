import { L } from '../../../../shared/lang'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { linkSkill, localSkills, useStore, type LocalSkill } from '../../store'
import { RECOMMENDED_SKILL_BODY_LENGTH, skillLengthNote } from '../../../../shared/skills'
import { Icon } from '../ui'
import { AgentPicker } from './SkillPeople'

// The skills of the user's Claude Code (and its plugins) and Codex: find one, say who uses it.
export function AddFromTerminal({ onClose }: { onClose: () => void }): ReactNode {
  const skills = useStore((s) => s.skills)
  const [found, setFound] = useState<LocalSkill[] | null>(null)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [picked, setPicked] = useState<LocalSkill | null>(null)
  const [agents, setAgents] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void localSkills().then(setFound, () => setFound([]))
  }, [])
  const needle = q.trim().toLowerCase()
  const shown = (found ?? []).filter((l) => !needle || `${l.name} ${l.description} ${l.origin}`.toLowerCase().includes(needle))
  const linked = (l: LocalSkill): boolean => skills.some((k) => k.source === l.source && k.state === 'active')
  useEffect(() => setAt(0), [q])
  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const use = (): void => {
    if (!picked) return
    setError(null)
    linkSkill(picked.source, agents).then(onClose, (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))
  }

  return (
    <div className="modal modal--top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search skill-add" role="dialog" aria-label={L('Buscar skills existentes', 'Find existing skills')}>
        {!picked ? (
          <>
            <div className="search__input">
              <Icon name="search" />
              <input
                autoFocus
                value={q}
                placeholder={L('Buscar nas skills do seu Claude Code e do Codex', 'Search the skills of your Claude Code and Codex')}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onClose()
                  else if (e.key === 'ArrowDown') e.preventDefault(), setAt(Math.min(shown.length - 1, at + 1))
                  else if (e.key === 'ArrowUp') e.preventDefault(), setAt(Math.max(0, at - 1))
                  else if (e.key === 'Enter' && shown[at] && !linked(shown[at]!)) setPicked(shown[at]!)
                }}
              />
            </div>
            <div className="skill-add__list" ref={list}>
              {!found && <p className="skill-add__none">{L('Procurando…', 'Looking…')}</p>}
              {found && shown.length === 0 && <p className="skill-add__none">{L('Nenhuma skill com', 'No skill matching')} “{q.trim()}”.</p>}
              {shown.map((l, i) => {
                const on = linked(l)
                return (
                  <button key={l.source} className={`skill-add__item ${i === at ? 'is-at' : ''}`} disabled={on} onMouseEnter={() => setAt(i)} onClick={() => setPicked(l)}>
                    <span className="skill-add__head">
                      <strong>{l.name}</strong>
                      <span>{l.origin}</span>
                      {l.scripts && <span className="warn-text">{L('precisa de computador', 'needs a computer')}</span>}
                      {on && <span className="tag tag--ok">{L('em uso', 'in use')}</span>}
                    </span>
                    <span className="skill-add__desc">{l.description}</span>
                    {l.bodyLength > RECOMMENDED_SKILL_BODY_LENGTH && <span className="warn-text small" role="status">{skillLengthNote(l.bodyLength)}</span>}
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <div className="skill-add__step">
            <button className="text-btn" onClick={() => setPicked(null)}>
              {L('← Voltar', '← Back')}
            </button>
            <h3>{picked.name}</h3>
            <p>{picked.description}</p>
            {picked.bodyLength > RECOMMENDED_SKILL_BODY_LENGTH && <p className="warn-text small" role="status">{skillLengthNote(picked.bodyLength)}</p>}
            {picked.scripts && <p className="warn-text small">{L('Tem scripts: só roda com um agente que tenha computador (Linux ou este computador).', 'Scripts require an agent with computer access (Linux or this computer).')}</p>}
            <span className="skill-add__label">{L('Quem usa?', 'Assign agents')}</span>
            <AgentPicker value={agents} onChange={setAgents} />
            {error && <p className="note note--error">{error}</p>}
            <div className="skill-add__acts">
              <span className="muted small">{L('Lida direto do arquivo: o que você mudar nela vale na próxima vez.', 'Read from the source file on each use. File edits apply next time.')}</span>
              <button className="btn btn--primary btn--sm" onClick={use}>
                {L('Usar', 'Use')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
