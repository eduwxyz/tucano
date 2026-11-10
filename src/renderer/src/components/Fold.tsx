import type { ReactNode } from 'react'
import { getState, updateSettings, useStore } from '../store'
import { Icon } from './ui'

// Anything that folds keeps its id in one list in settings, so it stays folded after a restart.
export function useFold(id: string): { open: boolean; toggle: () => void } {
  const folded = useStore((s) => s.settings.folded) ?? []
  const open = !folded.includes(id)
  return { open, toggle: () => setFolded(id, open) }
}

// Fold or unfold one id from outside a render (a double-click on a handle, a shortcut). It writes
// nothing when the list already says so, so folding twice costs no round trip.
export function setFolded(id: string, folded: boolean): void {
  const now = getState().settings.folded ?? []
  if (now.includes(id) === folded) return
  updateSettings({ folded: folded ? [...now, id] : now.filter((f: string) => f !== id) })
}

export function FoldToggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }): ReactNode {
  return (
    <button className="fold-toggle" aria-expanded={open} onClick={onToggle}>
      <Icon name="chevron" size={12} />
      <span>{children}</span>
    </button>
  )
}
