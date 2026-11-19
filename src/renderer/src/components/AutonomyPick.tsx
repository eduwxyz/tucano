// "Quanto {nome} faz por conta própria?": the three answers of the introduction (and of the detailed
// form), each one of the autonomy levels, with a line under them saying what still asks. No guardrails
// asks the same confirmation as the agent's page and Settings. The finer rules and the outside-content
// guard stay on the agent's page.
import { L } from '../../../shared/lang'
import { AUTONOMY_CHOICES, autonomyChoiceHint } from '../../../shared/onboarding'
import type { Autonomy } from '../../../shared/actions'
import { useId, type ReactNode } from 'react'
import { confirmNoGuardrails } from './Pages'

export function AutonomyPick({ name, value, guard, onPick, compact }: { name: string; value: Autonomy; guard: boolean; onPick: (level: Autonomy) => void; compact?: boolean }): ReactNode {
  const q = useId()
  const pick = async (level: Autonomy): Promise<void> => {
    if (level === value) return
    if (level === 'free' && !(await confirmNoGuardrails())) return
    onPick(level)
  }
  return (
    <div className={`autonomy-pick ${compact ? 'autonomy-pick--compact' : ''}`}>
      <b id={q} className="autonomy-pick__q">
        {L(`Quanto ${name} faz por conta própria?`, `How much does ${name} do on its own?`)}
      </b>
      <div className="autonomy-pick__rows" role="radiogroup" aria-labelledby={q}>
        {AUTONOMY_CHOICES().map((c) => (
          <button key={c.level} type="button" role="radio" aria-checked={value === c.level} className={`autonomy-pick__row ${value === c.level ? 'is-on' : ''}`} onClick={() => void pick(c.level)}>
            <span className="autonomy-pick__dot" aria-hidden />
            <span className="grow">{c.title}</span>
            {c.recommended && <span className="autonomy-pick__tag">{L('Recomendado', 'Recommended')}</span>}
          </button>
        ))}
      </div>
      <p className="autonomy-pick__hint" aria-live="polite">
        {autonomyChoiceHint(value, guard)}
      </p>
    </div>
  )
}
