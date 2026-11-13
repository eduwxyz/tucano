// Where the cards go: the screen dimmed, the rectangle on it to drag whole and to pull by its
// corners, and the two buttons. It saves through the core like any other setting, so the cards move
// to it as soon as it's kept (src/main/notice.ts follows what the core says).
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { NOTICE_MIN_H, NOTICE_MIN_W, type NoticeArea } from '../../../shared/notice'
import { call } from '../rpc'
import { link } from './feed'

type Rect = { x: number; y: number; w: number; h: number }
type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Drag = { corner: Corner | 'move'; startX: number; startY: number; from: Rect }
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

const kept = (r: Rect): Rect => {
  const W = window.innerWidth
  const H = window.innerHeight
  const w = Math.min(W, Math.max(Math.min(NOTICE_MIN_W, W), r.w))
  const h = Math.min(H, Math.max(Math.min(NOTICE_MIN_H, H), r.h))
  return { x: Math.min(Math.max(0, r.x), W - w), y: Math.min(Math.max(0, r.y), H - h), w, h }
}

// The rectangle as the drag has it: moved whole, or with the corner under the pointer pulled, and
// never smaller than a card or past the screen.
function dragged(d: Drag, x: number, y: number): Rect {
  const dx = x - d.startX
  const dy = y - d.startY
  const r = d.from
  if (d.corner === 'move') return kept({ ...r, x: r.x + dx, y: r.y + dy })
  const minW = Math.min(NOTICE_MIN_W, window.innerWidth)
  const minH = Math.min(NOTICE_MIN_H, window.innerHeight)
  const left = d.corner === 'nw' || d.corner === 'sw' ? Math.min(r.x + dx, r.x + r.w - minW) : r.x
  const top = d.corner === 'nw' || d.corner === 'ne' ? Math.min(r.y + dy, r.y + r.h - minH) : r.y
  const right = d.corner === 'ne' || d.corner === 'se' ? Math.max(r.x + r.w + dx, left + minW) : left + (r.x + r.w - left)
  const bottom = d.corner === 'sw' || d.corner === 'se' ? Math.max(r.y + r.h + dy, top + minH) : top + (r.y + r.h - top)
  return kept({ x: left, y: top, w: right - left, h: bottom - top })
}

export function AreaPicker(): ReactNode {
  const [rect, setRect] = useState<Rect | null>(null)
  const [saving, setSaving] = useState(false)
  const drag = useRef<Drag | null>(null)

  useEffect(() => {
    window.tucano.notice.onPick((r) => setRect((was) => was ?? kept({ x: r.x, y: r.y, w: r.w, h: r.h })))
  }, [])
  // The port to the core, so saving the rectangle is the same call every other setting makes.
  useEffect(() => void link().catch(() => undefined), [])

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const d = drag.current
      if (d) setRect(dragged(d, e.clientX, e.clientY))
    }
    const up = (): void => {
      drag.current = null
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.tucano.notice.areaCancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key)
    }
  }, [])

  const hold = (corner: Corner | 'move') => (e: ReactPointerEvent): void => {
    if (!rect) return
    e.preventDefault()
    e.stopPropagation()
    drag.current = { corner, startX: e.clientX, startY: e.clientY, from: rect }
  }

  // Which way the stack grows: up from the rectangle's bottom edge when it sits in the lower half of
  // the screen, down from its top when it sits in the upper one.
  const up = (r: Rect): boolean => r.y + r.h / 2 >= window.innerHeight / 2

  const save = async (): Promise<void> => {
    if (!rect || saving) return
    setSaving(true)
    const area: NoticeArea = { x: rect.x / window.innerWidth, y: rect.y / window.innerHeight, w: rect.w / window.innerWidth, h: rect.h / window.innerHeight, up: up(rect) }
    try {
      await link()
      const feed = await call('noticeFeed')
      await call('updateSettings', { patch: { notice: { ...feed.rules, area } } })
    } finally {
      window.tucano.notice.areaDone()
    }
  }

  return (
    <div className="pick" onPointerDown={() => (drag.current = null)}>
      {rect && (
        <div className="pick__box" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onPointerDown={hold('move')}>
          <span className="pick__label" data-at={up(rect) ? 'bottom' : 'top'}>
            {up(rect) ? L('Os avisos chegam aqui, de baixo pra cima', 'Notifications arrive here, from the bottom up') : L('Os avisos chegam aqui, de cima pra baixo', 'Notifications arrive here, from the top down')}
          </span>
          {CORNERS.map((c) => (
            <span key={c} className={`pick__corner pick__corner--${c}`} onPointerDown={hold(c)} />
          ))}
        </div>
      )}
      <div className="pick__bar" onPointerDown={(e) => e.stopPropagation()}>
        <p>{L('Arraste o retângulo, e os cantos pra mudar o tamanho. Os avisos aparecem aí.', 'Drag the rectangle, and its corners to resize it. Notifications appear there.')}</p>
        <div className="row">
          <button className="btn btn--sm" onClick={() => window.tucano.notice.areaCancel()}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button className="btn btn--sm btn--primary" disabled={!rect || saving} onClick={() => void save()}>
            {L('Salvar', 'Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
