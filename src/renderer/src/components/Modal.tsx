import { useEffect, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { Icon } from './ui'

// Forms already draw their own Card heading; small dialogs share the header.
// Both use the same backdrop, dismissal behavior and entrance animation.
export function Modal({ title, onClose, children, className = '', variant = 'dialog', actions }: {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
  variant?: 'dialog' | 'form'
  actions?: ReactNode
}): ReactNode {
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])

  return (
    <div className="modal" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`${variant === 'form' ? 'form-modal' : 'modal__card'} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        {variant === 'dialog' && <header className="modal__head">
          <strong>{title}</strong>
          <div className="modal__actions">
            {actions}
            <button className="icon-btn icon-btn--sm" title={L('Fechar', 'Close')} onClick={onClose}>
              <Icon name="x" size={14} />
            </button>
          </div>
        </header>}
        {children}
      </div>
    </div>
  )
}
