import type { ReactNode } from 'react'
import { updateSettings, useStore } from '../store'
import { Icon } from './ui'

// Anything that folds keeps its id in one list in settings, so it stays folded after a restart.
export function useFold(id: string): { open: boolean; toggle: () => void } {
  const folded = useStore((s) => s.settings.folded) ?? []
  const open = !folded.includes(id)
  return { open, toggle: () => updateSettings({ folded: open ? [...folded, id] : folded.filter((f) => f !== id) }) }
}

export function FoldToggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }): ReactNode {
  return (
    <button className="fold-toggle" aria-expanded={open} onClick={onToggle}>
      <Icon name="chevron" size={12} />
      <span>{children}</span>
    </button>
  )
}
