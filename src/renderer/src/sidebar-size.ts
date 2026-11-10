// The sidebar's width, which the person drags (the edge between the sidebar and the page). Kept in
// this browser or app, since it's about this screen: a wide monitor and a laptop want different ones.
export const SIDEBAR_DEFAULT = 248
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 480
const KEY = 'tucano.sidebar-width'

// Never so wide that the page has less than half the window.
export function clampSidebarWidth(width: number, windowWidth: number): number {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(windowWidth / 2)))
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, width)))
}

export function readSidebarWidth(storage: Pick<Storage, 'getItem'>): number | null {
  try {
    const n = Number(storage.getItem(KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// `null`: back to the default (a double click on the edge).
export function saveSidebarWidth(storage: Pick<Storage, 'setItem' | 'removeItem'>, width: number | null): void {
  try {
    if (width === null) storage.removeItem(KEY)
    else storage.setItem(KEY, String(Math.round(width)))
  } catch {
    // A browser with storage off: the width lasts until the page is closed.
  }
}

// The panel on the right (an image, a page, an agent's browser, a thread): the same, from its left
// edge. One width for all of them; without it each kind keeps its own (styles.css).
export const PANEL_MIN = 360
export const PANEL_ROOM = 320 // what's left for the conversation beside it, at least
const PANEL_KEY = 'tucano.panel-width'

export function clampPanelWidth(width: number, splitWidth: number): number {
  const max = Math.max(PANEL_MIN, splitWidth - PANEL_ROOM)
  return Math.round(Math.min(max, Math.max(PANEL_MIN, width)))
}

export function readPanelWidth(storage: Pick<Storage, 'getItem'>): number | null {
  try {
    const n = Number(storage.getItem(PANEL_KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function savePanelWidth(storage: Pick<Storage, 'setItem' | 'removeItem'>, width: number | null): void {
  try {
    if (width === null) storage.removeItem(PANEL_KEY)
    else storage.setItem(PANEL_KEY, String(Math.round(width)))
  } catch {
    // A browser with storage off: the width lasts until the page is closed.
  }
}
