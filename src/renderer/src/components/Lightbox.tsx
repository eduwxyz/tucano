// An image or video the size of the window: the wheel zooms where the pointer is, dragging moves it
// and the arrows go through the others.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { closeLightbox, moveLightbox, useStore } from '../store'
import { imageMenuState, openImageMenu } from '../image-menu'
import { Icon } from './ui'

const MAX = 8
type View = { scale: number; x: number; y: number }
const FIT: View = { scale: 1, x: 0, y: 0 }

export function Lightbox(): ReactNode {
  const box = useStore((s) => s.lightbox)
  const item = box?.items[box.index]
  const [view, setView] = useState<View>(FIT)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const video = useRef(false) // its controls keep the arrows and the wheel, and zoom doesn't apply
  video.current = !!item?.video

  useEffect(() => setView(FIT), [item?.url])
  const zoomBy = (factor: number, at?: { x: number; y: number }): void =>
    setView((v) => {
      const scale = Math.min(MAX, Math.max(1, v.scale * factor))
      if (scale === 1) return FIT
      // The point under the pointer stays under it.
      const rect = stage.current!.getBoundingClientRect()
      const px = (at?.x ?? rect.left + rect.width / 2) - rect.left - rect.width / 2
      const py = (at?.y ?? rect.top + rect.height / 2) - rect.top - rect.height / 2
      const k = scale / v.scale
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })

  useEffect(() => {
    if (!box) return
    const onKey = (e: KeyboardEvent): void => {
      if (imageMenuState()) return // the picture's right-click menu is open: Esc is for that
      const keys: Record<string, () => void> = {
        Escape: closeLightbox,
        ArrowLeft: () => moveLightbox(-1),
        ArrowRight: () => moveLightbox(1),
        '+': () => zoomBy(1.4),
        '=': () => zoomBy(1.4),
        '-': () => zoomBy(1 / 1.4),
        '0': () => setView(FIT)
      }
      const act = keys[e.key]
      if (!act || (video.current && e.key !== 'Escape')) return
      e.preventDefault()
      e.stopPropagation() // Esc here is for this, not for what's behind it
      act()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [!box])

  // React's wheel handler is passive, and this one has to stop the page from scrolling.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (video.current) return
      e.preventDefault()
      zoomBy(Math.exp(-e.deltaY * 0.002), { x: e.clientX, y: e.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [!box])

  if (!box || !item) return null
  const many = box.items.length > 1
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={item.title}>
      <header className="lightbox__bar">
        <strong className="lightbox__title">{item.title}</strong>
        {many && <span className="small">{box.index + 1} / {box.items.length}</span>}
        <span className="grow" />
        {!item.video && (
          <>
            <button className="icon-btn" title={L('Afastar (−)', 'Zoom out (−)')} aria-label={L('Afastar', 'Zoom out')} onClick={() => zoomBy(1 / 1.4)}>−</button>
            <span className="small lightbox__zoom">{Math.round(view.scale * 100)}%</span>
            <button className="icon-btn" title={L('Aproximar (+)', 'Zoom in (+)')} aria-label={L('Aproximar', 'Zoom in')} onClick={() => zoomBy(1.4)}>+</button>
          </>
        )}
        <button className="icon-btn" title={L('Fechar (Esc)', 'Close (Esc)')} aria-label={L('Fechar', 'Close')} onClick={closeLightbox}>
          <Icon name="x" size={16} />
        </button>
      </header>
      <div
        className={`lightbox__stage ${view.scale > 1 ? 'is-zoomed' : ''}`}
        ref={stage}
        onClick={(e) => {
          if (e.target === e.currentTarget && !dragged.current) closeLightbox()
          dragged.current = false
        }}
        onPointerDown={(e) => {
          if (view.scale === 1 || item.video) return
          drag.current = { x: e.clientX - view.x, y: e.clientY - view.y, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          // Captured only now: from the press, a click on the image would count as a click on the stage.
          if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId)
          d.moved = true
          setView((v) => ({ ...v, x: e.clientX - d.x, y: e.clientY - d.y }))
        }}
        onPointerUp={() => {
          dragged.current = !!drag.current?.moved
          drag.current = null
        }}
      >
        {item.video ? (
          <video src={item.url} controls autoPlay />
        ) : (
          <img
            src={item.url}
            alt={item.title}
            draggable={false}
            // Right-click here: the two ways out of the app. (In a reply there is a third, the prompt.)
            onContextMenu={(e) => {
              e.preventDefault()
              openImageMenu({ url: item.url, title: item.title, surface: 'gallery' }, { x: e.clientX, y: e.clientY })
            }}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            onDoubleClick={(e) => {
              if (view.scale > 1) return setView(FIT)
              const img = e.currentTarget
              zoomBy(Math.max(1.5, img.naturalWidth / img.clientWidth), { x: e.clientX, y: e.clientY })
            }}
          />
        )}
      </div>
      {many && (
        <>
          <button className="lightbox__nav lightbox__nav--prev" aria-label={L('Anterior', 'Previous')} onClick={() => moveLightbox(-1)}>‹</button>
          <button className="lightbox__nav lightbox__nav--next" aria-label={L('Próxima', 'Next')} onClick={() => moveLightbox(1)}>›</button>
        </>
      )}
    </div>
  )
}
