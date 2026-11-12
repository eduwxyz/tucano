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
  // A row that can be picked up and that a drop lands on (or before).
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
  // A place that only receives a drop: a section's end, a group's name. Nothing to pick up there.
  zoneProps: (id: string) => { 'data-order-id': string }
}

export function useHoldReorder({ onDrop, onNudge }: { onDrop: (id: string, before: string) => void; onNudge: (id: string, by: -1 | 1) => void }): HoldReorder {
  const [picked, setPicked] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swallow = useRef(false) // the click that follows a drop must not navigate
  const target = useRef<string | null>(null) // the row under the pointer, without waiting for a render
  const carrying = useRef<string | null>(null) // the same, for the handlers that run before a render
  const pressedOn = useRef<HTMLElement | null>(null) // the row the pointer went down on
  const pressedWith = useRef<number | null>(null) // and its pointer

  const cancel = useCallback((): void => {
    if (pressedOn.current && pressedWith.current !== null) {
      // Capture is only ever taken once a row is carried; letting go of it here keeps a later press
      // from arriving at an element that is no longer listening.
      try {
        pressedOn.current.releasePointerCapture?.(pressedWith.current)
      } catch {
        /* the pointer was already released */
      }
    }
    pressedOn.current = null
    pressedWith.current = null
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
        // No capture yet. Taking it on every press retargets the click that follows to this row, so
        // the button inside it never opens — and a row that never opens reads as a dead sidebar.
        // It is taken once the row is actually being carried, below.
        pressedOn.current = e.currentTarget as HTMLElement
        pressedWith.current = e.pointerId
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          swallow.current = true
          carrying.current = id
          setPicked(id)
          // Now that the row is picked up, keep the gesture even if it leaves the row or the row
          // re-renders under the pointer.
          try {
            pressedOn.current?.setPointerCapture?.(pressedWith.current ?? 0)
          } catch {
            /* the pointer is gone: nothing to carry */
          }
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
        const dropped = !!(id2 && to && to !== id2)
        if (dropped) onDrop(id2!, to!)
        // A row held long enough to be picked up and then let go where it was is still a click: it
        // opens, exactly like a quick one. Only a drop eats the click that follows it.
        swallow.current = dropped
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
    }),
    zoneProps: (id) => ({ 'data-order-id': id })
  }
}
