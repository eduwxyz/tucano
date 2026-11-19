import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { clampPanelWidth, clampSidebarWidth, PANEL_MIN, readPanelWidth, readSidebarWidth, savePanelWidth, saveSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from '../sidebar-size'

// A drag that listens on the window, so it goes on if the edge itself is redrawn in the middle (a
// panel is, while a reply streams in), and over a page inside a panel (styles.css turns the
// pointer off on iframes while body.is-resizing).
function drag(e: PointerEvent<HTMLDivElement>, at: (x: number) => number, show: (w: number) => void, done: (w: number) => void): void {
  if (e.button !== 0) return
  e.preventDefault()
  const id = e.pointerId
  document.body.classList.add('is-resizing')
  const move = (ev: globalThis.PointerEvent): void => {
    if (ev.pointerId === id) show(at(ev.clientX))
  }
  const end = (ev: globalThis.PointerEvent): void => {
    if (ev.pointerId !== id) return
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    document.body.classList.remove('is-resizing')
    done(at(ev.clientX))
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
}

// The edge between the sidebar and the page: drag it to make the sidebar wider or narrower, double
// click to go back to the default, or use the arrow keys with it focused. The width goes on the
// app as --sidebar-w (styles.css), so the grid follows while it's dragged.
export function SidebarResize(): ReactNode {
  const [width, setWidth] = useState<number | null>(() => readSidebarWidth(localStorage))
  const [dragging, setDragging] = useState(false)
  const shown = clampSidebarWidth(width ?? SIDEBAR_DEFAULT, window.innerWidth)

  useEffect(() => {
    const root = document.documentElement
    if (width === null) root.style.removeProperty('--sidebar-w')
    else root.style.setProperty('--sidebar-w', `${clampSidebarWidth(width, window.innerWidth)}px`)
  }, [width])
  // A smaller window can't keep a sidebar that takes most of it.
  useEffect(() => {
    const fit = (): void => setWidth((w) => (w === null ? w : clampSidebarWidth(w, window.innerWidth)))
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const keep = (w: number | null): void => {
    setWidth(w)
    saveSidebarWidth(localStorage, w)
  }
  const down = (e: PointerEvent<HTMLDivElement>): void => {
    setDragging(true)
    drag(e, (x) => clampSidebarWidth(x, window.innerWidth), setWidth, (w) => (setDragging(false), keep(w)))
  }
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft') keep(clampSidebarWidth(shown - step, window.innerWidth))
    else if (e.key === 'ArrowRight') keep(clampSidebarWidth(shown + step, window.innerWidth))
    else if (e.key === 'Home') keep(null)
    else return
    e.preventDefault()
  }

  return (
    <div
      className={`sidebar-resize ${dragging ? 'is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={L('Largura da barra lateral', 'Sidebar width')}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={shown}
      tabIndex={0}
      title={L('Arraste pra ajustar a largura. Dois cliques voltam ao padrão.', 'Drag to change the width. Double-click for the default.')}
      onPointerDown={down}
      onDoubleClick={() => keep(null)}
      onKeyDown={key}
    />
  )
}

// The same for the panel on the right, from its left edge: the first thing inside a .side-panel.
// The width is one for every kind of panel, on the app as --panel-w.
export function PanelResize(): ReactNode {
  const [width, setWidth] = useState<number | null>(() => readPanelWidth(localStorage))
  const [dragging, setDragging] = useState(false)
  const self = useRef<HTMLDivElement>(null)
  // The room the panel and the conversation share, and where it ends on the right.
  const room = (): { width: number; right: number } => {
    const r = (self.current?.closest('.split') ?? document.body).getBoundingClientRect()
    return { width: r.width, right: r.right }
  }
  const now = (): number => Math.round(self.current?.parentElement?.getBoundingClientRect().width ?? PANEL_MIN)

  useEffect(() => {
    const root = document.documentElement
    if (width === null) root.style.removeProperty('--panel-w')
    else root.style.setProperty('--panel-w', `${clampPanelWidth(width, room().width)}px`)
  }, [width])
  useEffect(() => {
    const fit = (): void => setWidth((w) => (w === null ? w : clampPanelWidth(w, room().width)))
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  const keep = (w: number | null): void => {
    setWidth(w)
    savePanelWidth(localStorage, w)
  }
  // While it's dragged the width goes straight on the app too: the panel may be redrawn in between.
  const show = (w: number): void => {
    document.documentElement.style.setProperty('--panel-w', `${w}px`)
    setWidth(w)
  }
  const down = (e: PointerEvent<HTMLDivElement>): void => {
    const r = room() // the room as the drag starts: the edge may not be there at the end
    setDragging(true)
    drag(e, (x) => clampPanelWidth(r.right - x, r.width), show, (w) => (setDragging(false), show(w), savePanelWidth(localStorage, w)))
  }
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 48 : 16
    if (e.key === 'ArrowLeft') keep(clampPanelWidth(now() + step, room().width))
    else if (e.key === 'ArrowRight') keep(clampPanelWidth(now() - step, room().width))
    else if (e.key === 'Home') keep(null)
    else return
    e.preventDefault()
  }

  return (
    <div
      ref={self}
      className={`panel-resize ${dragging ? 'is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={L('Largura do painel', 'Panel width')}
      aria-valuemin={PANEL_MIN}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      title={L('Arraste pra ajustar a largura. Dois cliques voltam ao padrão.', 'Drag to change the width. Double-click for the default.')}
      onPointerDown={down}
      onDoubleClick={() => keep(null)}
      onKeyDown={key}
    />
  )
}
