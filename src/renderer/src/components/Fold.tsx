import type { ReactNode } from 'react'
import { updateSettings, useStore } from '../store'
import { Icon } from './ui'

// Anything that folds keeps its id in one list in settings, so it stays folded after a restart. One that
// starts folded (`startFolded`) keeps the opposite there, `+id` once it's opened, so new ones start closed.
export function useFold(id: string, startFolded = false): { open: boolean; toggle: () => void } {
  const folded = useStore((s) => s.settings.folded) ?? []
  const key = startFolded ? `+${id}` : id
  const marked = folded.includes(key)
  return { open: startFolded ? marked : !marked, toggle: () => updateSettings({ folded: marked ? folded.filter((f) => f !== key) : [...folded, key] }) }
}

export function FoldToggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }): ReactNode {
  return (
    <button className="fold-toggle" aria-expanded={open} onClick={onToggle}>
      <Icon name="chevron" size={12} />
      <span>{children}</span>
    </button>
  )
}
