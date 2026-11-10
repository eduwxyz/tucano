// A harness's failure on screen, the same everywhere (the introduction's list, Settings › Modelos):
// one plain line (src/shared/engine-errors.ts), "Entrar de novo" when it's the login and there's a
// way in, "Tentar de novo", and the raw text only under "Ver detalhes", in a small scrolling box.
import { L } from '../../../shared/lang'
import { explainEngineError } from '../../../shared/engine-errors'
import type { EngineId } from '../../../shared/types'
import type { ReactNode } from 'react'

export function EngineProblem({ engine, message, onSignIn, onRetry, look = 'app' }: { engine: EngineId; message: string; onSignIn?: () => void; onRetry?: () => void; look?: 'intro' | 'app' }): ReactNode {
  const p = explainEngineError(engine, message)
  const btn = look === 'intro' ? 'intro-link' : 'btn btn--ghost btn--sm'
  return (
    <div className={`engine-problem engine-problem--${look}`} role="alert">
      <span className="engine-problem__line">{p.line}</span>
      {(p.kind === 'login' && onSignIn) || onRetry || p.details ? (
        <span className="engine-problem__actions">
          {p.kind === 'login' && onSignIn && (
            <button className={btn} onClick={onSignIn}>
              {L('Entrar de novo', 'Sign in again')}
            </button>
          )}
          {onRetry && (
            <button className={btn} onClick={onRetry}>
              {L('Tentar de novo', 'Try again')}
            </button>
          )}
          {p.details && (
            <details className="engine-problem__more">
              <summary>{L('Ver detalhes', 'See details')}</summary>
              <pre>{p.details}</pre>
            </details>
          )}
        </span>
      ) : null}
    </div>
  )
}
