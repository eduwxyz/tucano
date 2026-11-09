// Sorting the sidebar's own rows (the DMs, the agents) by hand: press and hold a row to pick it
// up, then release it over the row it should come before. Not a drag from the first pixel, because
// these rows are buttons — a slightly short drag would open the conversation instead of moving it.
//
// Two things learned the hard way on this project: take the pointer capture on press (a control that
// resizes or re-renders under a held pointer loses the gesture to a boundary event), and treat the
// gesture as one unit — a click that lands after a drop must not also navigate.
import { useCallback, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

const HOLD_MS = 350

export interface HoldReorder {
  picked: string | null // the row the pointer picked up
  over: string | null // the row it would land before
  rowProps: (id: string) => {
    'data-order-id': string
    onPointerDown: (e: ReactPointerEvent) => void
    onPointerMove: (e: ReactPointerEvent) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onKeyDown: (e: ReactKeyboardEvent) => void
    onClickCapture: (e: ReactMouseEvent) => void
    style?: { touchAction: 'none' }
  }
}

export function useHoldReorder({ onDrop, onNudge }: { onDrop: (id: string, before: string) => void; onNudge: (id: string, by: -1 | 1) => void }): HoldReorder {
  const [picked, setPicked] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swallow = useRef(false) // the click that follows a drop must not navigate
  const target = useRef<string | null>(null) // the row under the pointer, without waiting for a render
  const carrying = useRef<string | null>(null) // the same, for the handlers that run before a render

  const cancel = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    carrying.current = null
    target.current = null
    setPicked(null)
    setOver(null)
  }, [])

  // The row under the pointer, by its own id: geometry, so it still works with the capture taken.
  const rowAt = (x: number, y: number): string | null => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-order-id]')?.dataset.orderId ?? null

  return {
    picked,
    over,
    rowProps: (id) => ({
      'data-order-id': id,
      // Only while a row is being carried: a permanent touch-action would stop the list scrolling.
      ...(picked ? { style: { touchAction: 'none' as const } } : {}),
      onPointerDown: (e) => {
        if (e.button !== 0) return
        // The press can't be lost to a boundary event while the row re-renders under it.
        e.currentTarget.setPointerCapture?.(e.pointerId)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          swallow.current = true
          carrying.current = id
          setPicked(id)
        }, HOLD_MS)
      },
      onPointerMove: (e) => {
        if (!carrying.current) return
        const at = rowAt(e.clientX, e.clientY)
        if (at === target.current) return
        target.current = at
        setOver(at)
      },
      onPointerUp: () => {
        const to = target.current
        const id2 = carrying.current
        if (id2 && to && to !== id2) onDrop(id2, to)
        cancel()
      },
      onPointerCancel: () => cancel(),
      // A row the keyboard is on moves with Alt+arrows: the same step the context menu offers.
      onKeyDown: (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        onNudge(id, e.key === 'ArrowUp' ? -1 : 1)
      },
      onClickCapture: (e) => {
        if (!swallow.current) return
        swallow.current = false
        e.preventDefault()
        e.stopPropagation()
      }
    })
  }
}
