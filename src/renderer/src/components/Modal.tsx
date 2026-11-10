import { useEffect, useRef, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { Icon } from './ui'

// Open windows, newest last: Esc and Tab belong to the one on top only.
const openModals: object[] = []
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// `className`: a card of another size (the news after an update). `variant: 'form'`: a form
// that draws its own heading (a routine, a skill). `actions`: buttons beside the close one.
export function Modal({ title, onClose, children, className, variant = 'dialog', actions }: {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
  variant?: 'dialog' | 'form'
  actions?: ReactNode
}): ReactNode {
  const card = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const me = {}
    openModals.push(me)
    const before = document.activeElement as HTMLElement | null
    if (!card.current?.contains(document.activeElement)) card.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    // Captured before the page's own keys, so an Esc here doesn't also close what's behind.
    const keys = (e: KeyboardEvent): void => {
      if (openModals[openModals.length - 1] !== me) return
      // Esc with a select's menu open closes just the menu (it's in a portal, outside the card).
      if (e.key === 'Escape' && e.target instanceof Element && e.target.closest('.select__menu')) return
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        e.preventDefault()
        close.current()
      } else if (e.key === 'Tab' && card.current) {
        const all = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        if (!all.length) return
        const [first, last] = [all[0]!, all[all.length - 1]!]
        const inside = card.current.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) (e.preventDefault(), last.focus())
        else if (!e.shiftKey && (document.activeElement === last || !inside)) (e.preventDefault(), first.focus())
      }
    }
    window.addEventListener('keydown', keys, true)
    return () => {
      window.removeEventListener('keydown', keys, true)
      openModals.splice(openModals.indexOf(me), 1)
      if (before?.isConnected) before.focus()
    }
  }, [])
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${variant === 'form' ? 'form-modal' : 'modal__card'} ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={title} ref={card}>
        {variant === 'dialog' && (
          <header className="modal__head">
            <strong>{title}</strong>
            <div className="modal__actions">
              {actions}
              <button className="icon-btn icon-btn--sm" title={L('Fechar', 'Close')} onClick={onClose}>
                <Icon name="x" size={14} />
              </button>
            </div>
          </header>
        )}
        {children}
      </div>
    </div>
  )
}
