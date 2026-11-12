// The screen in the page's address, for Tucano in a browser: a phone that puts the tab
// away reloads it when it comes back, and the page opens where it was, not on the first
// channel. "#/c/<id>", "#/agent/<id>", "#/wiki/page/<title>", "#/settings"… The desktop app
// has no address bar and keeps its screen in memory, so it doesn't use this.
import type { View } from './store'

type Simple = Extract<View['kind'], 'approvals' | 'usage' | 'connectors' | 'memory' | 'routines' | 'skills' | 'report' | 'settings' | 'missions' | 'new-agent'>
const SIMPLE: readonly Simple[] = ['approvals', 'usage', 'connectors', 'memory', 'routines', 'skills', 'report', 'settings', 'missions', 'new-agent']
const WIKI_TABS = ['pages', 'pending', 'sources', 'review'] as const

const part = (s: string): string => encodeURIComponent(s)

// The address of a screen, or undefined for one that can't come back from a reload (the
// builder with the Tuca: its conversation lives only in this page).
export function viewToHash(view: View): string | undefined {
  switch (view.kind) {
    case 'conversation':
      return `#/c/${part(view.id)}`
    case 'agent':
      return `#/agent/${part(view.id)}`
    case 'wiki':
      if (view.source) return `#/wiki/source/${part(view.source)}`
      if (view.title) return `#/wiki/page/${part(view.title)}`
      if (view.tab) return `#/wiki/tab/${view.tab}`
      return '#/wiki'
    case 'tuca':
      return undefined
    default:
      return `#/${view.kind}`
  }
}

// The screen an address names, or undefined (nothing, or a hash that isn't one of these,
// like a #wiki/… link in a message).
export function hashToView(hash: string): View | undefined {
  if (!hash.startsWith('#/')) return undefined
  let parts: string[]
  try {
    parts = hash.slice(2).split('/').map(decodeURIComponent)
  } catch {
    return undefined
  }
  const [kind, a, ...rest] = parts
  const tail = [a, ...rest].filter((p) => p !== undefined).join('/')
  if (kind === 'c' && a) return { kind: 'conversation', id: a }
  if (kind === 'agent' && a) return { kind: 'agent', id: a }
  if (kind === 'wiki') {
    if (!a) return { kind: 'wiki' }
    const value = rest.join('/')
    if (a === 'source' && value) return { kind: 'wiki', source: value }
    if (a === 'page' && value) return { kind: 'wiki', title: value }
    if (a === 'tab' && (WIKI_TABS as readonly string[]).includes(value)) return { kind: 'wiki', tab: value as (typeof WIKI_TABS)[number] }
    return { kind: 'wiki' }
  }
  if ((SIMPLE as readonly string[]).includes(kind ?? '') && !tail) return { kind: kind as Simple }
  return undefined
}
