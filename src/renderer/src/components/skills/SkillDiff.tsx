import { useMemo, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { compareSkill } from '../../../../shared/skill-diff'

// Line by line: what was removed and what was added.
export function Diff({ before, after }: { before: string; after: string }): ReactNode {
  const comparison = useMemo(() => compareSkill(before, after), [before, after])
  if (comparison.kind === 'full') return (
    <div className="diff-full">
      <p className="hint">{L('Mudança grande: as duas versões aparecem por inteiro.', 'Large change: both versions are shown in full.')}</p>
      <section aria-label={L('Antes', 'Before')}>
        <h4 className="field__label">{L('Antes', 'Before')}</h4>
        <pre className="diff">{before}</pre>
      </section>
      <section aria-label={L('Depois', 'After')}>
        <h4 className="field__label">{L('Depois', 'After')}</h4>
        <pre className="diff">{after}</pre>
      </section>
    </div>
  )
  return (
    <pre className="diff">
      {comparison.lines.map((line, key) => (
        <div key={key} className={line.kind === '+' ? 'diff__add' : line.kind === '-' ? 'diff__del' : 'diff__same'}>
          {line.kind} {line.text}
        </div>
      ))}
    </pre>
  )
}
