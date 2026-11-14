import { useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { RECOMMENDED_SKILL_BODY_LENGTH, skillLengthNote } from '../../../../shared/skills'
import { saveSkill, type SkillInput } from '../../store'
import { Card, Field } from '../Pages'
import { AgentPicker } from './SkillPeople'

export function SkillForm({ draft, onChange, onClose }: { draft: SkillInput; onChange: (d: SkillInput) => void; onClose: () => void }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<SkillInput>): void => onChange({ ...draft, ...patch })
  const save = (): void => {
    setError(null)
    saveSkill(draft).then(onClose, (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))
  }
  return (
    <div className="agent-form">
      <Card title={draft.id ? L(`Editar ${draft.name}`, `Edit ${draft.name}`) : L('Nova skill', 'New skill')}>
        <div className="grid2">
          <Field label={L('Nome', 'Name')} hint={L('Curto, vira algo como testes-do-core.', 'Short; becomes something like core-tests.')}>
            <input autoFocus value={draft.name} placeholder={L('testes do core', 'core tests')} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={L('Quando usar', 'When to use')} hint={L('Uma frase. Vai no prompt de cada agente.', 'One sentence. It goes in every agent’s prompt.')}>
            <input value={draft.description} placeholder={L('Ao rodar ou consertar os testes do Core', 'When running or fixing the Core tests')} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>
        {draft.source ? (
          <p className="hint">
            {L('Ligada a', 'Linked to')} <span className="mono">{draft.source}</span>: {L('a receita muda lá, e os agentes leem sempre a versão de agora. Aqui você escolhe quem usa.', 'the recipe changes there, and agents always read the current version. Here you pick who uses it.')}
          </p>
        ) : (
          <>
            <Field label={L('Receita', 'Recipe')} hint={L('Os passos, em Markdown: comandos exatos, armadilhas, como conferir.', 'The steps, in Markdown: exact commands, pitfalls, how to check.')}>
              <textarea rows={10} className="mono" value={draft.body} onChange={(e) => set({ body: e.target.value })} />
            </Field>
            {draft.body.length > RECOMMENDED_SKILL_BODY_LENGTH && <p className="hint hint--warn" role="status">{skillLengthNote(draft.body.length)}</p>}
          </>
        )}
        <Field label={L('Quem usa', 'Who uses it')}>
          <AgentPicker value={draft.agents} onChange={(agents) => set({ agents })} />
        </Field>
        <div className="row row--between">
          <span className="hint">{draft.id ? L('A versão de agora fica no histórico: dá pra voltar.', 'The current version stays in the history: you can go back.') : ''}</span>
          <div className="row">
            {error && <span className="field__error">{error}</span>}
            <button className="btn btn--sm btn--ghost" onClick={onClose}>
              {L('Cancelar', 'Cancel')}
            </button>
            <button className="btn btn--sm btn--primary" disabled={!draft.source && (!draft.name.trim() || !draft.description.trim() || !draft.body.trim())} onClick={save}>
              {draft.id ? L('Salvar', 'Save') : L('Criar skill', 'Create skill')}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
