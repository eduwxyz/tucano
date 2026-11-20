import { useSyncExternalStore } from 'react'
import type { OmarchyState } from '../../shared/omarchy'

// The Omarchy desktop's theme as main last told it (src/main/omarchy.ts): null off Omarchy,
// in a browser, and until main answers.
let state: OmarchyState | null = null
const listeners = new Set<() => void>()
const publish = (next: OmarchyState | null): void => {
  state = next
  for (const l of listeners) l()
}

let started = false
function start(): void {
  if (started) return
  started = true
  const api = window.tucano.omarchy
  if (!api) return
  api.onChanged(publish)
  void api.state().then(publish, () => {})
}

export function useOmarchy(): OmarchyState | null {
  start()
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state
  )
}

export function followOmarchy(on: boolean): void {
  void window.tucano.omarchy?.set(on).then(publish, () => {})
}

// The tokens go on the page's own style, over both of styles.css's blocks, and data-theme
// says which side they are so the rules written per side (color-scheme, images) agree.
let applied: string[] = []
export function paintOmarchy(theme: OmarchyState | null, fallback: 'system' | 'light' | 'dark'): void {
  const root = document.documentElement
  for (const key of applied) root.style.removeProperty(key)
  applied = []
  const followed = theme?.on ? theme : null
  if (followed) {
    for (const [key, value] of Object.entries(followed.vars)) root.style.setProperty(key, value)
    applied = Object.keys(followed.vars)
  }
  const side = followed?.mode ?? fallback
  if (side === 'system') delete root.dataset['theme']
  else root.dataset['theme'] = side
}
