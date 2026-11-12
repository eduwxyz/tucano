// A row in the sidebar is a button that can also be picked up and moved: holding it and letting go
// where it was has to open it, and only a real drop may eat the click that follows.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// linkedom is the DOM these renderer tests run in (as in test/steer-pill.test.tsx).
const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const MouseEvent = window.MouseEvent as unknown as typeof globalThis.MouseEvent
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

const store = vi.hoisted(() => ({ clicks: [] as string[], drops: [] as string[] }))

vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: unknown) => T): T => select({}) }
})

const { createRoot } = await import('react-dom/client')
const { useHoldReorder } = await import('../src/renderer/src/reorder')

let container: HTMLDivElement
let root: Root

function Rows(): React.ReactNode {
  const sort = useHoldReorder({
    onDrop: (id, before) => store.drops.push(`${id}->${before}`),
    onNudge: () => {}
  })
  return (
    <div>
      {['a', 'b'].map((id) => (
        <div key={id} {...sort.rowProps(id)}>
          <button
            onClick={() => {
              store.clicks.push(id)
            }}
          >
            {id}
          </button>
        </div>
      ))}
    </div>
  )
}

// linkedom has no PointerEvent: a plain event carrying what React reads (the button, the pointer) is
// what these handlers see, which is the same shape a browser gives them.
const fire = (node: HTMLElement, type: string, extra: Record<string, unknown> = {}): Event => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true })
  for (const [k, v] of Object.entries({ button: 0, pointerId: 1, ...extra })) Object.defineProperty(ev, k, { value: v })
  act(() => {
    node.dispatchEvent(ev)
  })
  return ev
}

const rowOf = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-order-id="${id}"]`)!

const press = (id: string, type: 'pointerdown' | 'pointerup' | 'pointermove'): void => {
  const row = rowOf(id)
  fire(row.querySelector('button') ?? row, type)
}

const click = (id: string): Event => fire(container.querySelector<HTMLElement>(`[data-order-id="${id}"] button`)!, 'click', { detail: 1 })

beforeEach(async () => {
  store.clicks.length = 0
  store.drops.length = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Rows />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('picking a row up to move it', () => {
  it('opens a row held longer than the hold, when it was let go where it was', async () => {
    press('a', 'pointerdown')
    await act(async () => new Promise((ok) => setTimeout(ok, 420))) // past the hold
    press('a', 'pointerup')
    click('a')
    expect(store.clicks).toEqual(['a'])
    expect(store.drops).toEqual([])
  })

  it('opens the row on a quick click', async () => {
    press('b', 'pointerdown')
    press('b', 'pointerup')
    click('b')
    expect(store.clicks).toEqual(['b'])
  })

  it('captures the pointer only once the row is picked up, never on the press', async () => {
    const calls: string[] = []
    Object.assign(rowOf('a'), { setPointerCapture: () => calls.push('capture') })
    press('a', 'pointerdown')
    // A press that opens the row must leave the click where the browser sends it: on the button.
    expect(calls).toEqual([])
    press('a', 'pointerup')
    await act(async () => new Promise((ok) => setTimeout(ok, 20)))
    expect(calls).toEqual([])

    press('a', 'pointerdown')
    await act(async () => new Promise((ok) => setTimeout(ok, 420)))
    expect(calls).toEqual(['capture']) // carried from here on
    press('a', 'pointerup')
  })

  it('moves the row when it is let go over another one, and eats the click that follows', async () => {
    press('a', 'pointerdown')
    await act(async () => new Promise((ok) => setTimeout(ok, 420)))
    // The row under the pointer is found by geometry, and linkedom lays nothing out: the point is
    // stubbed to answer with the second row, which is what a real drop would hit.
    const before = document.elementFromPoint
    Object.assign(document, { elementFromPoint: () => container.querySelector('[data-order-id="b"] button') })
    press('a', 'pointermove')
    press('a', 'pointerup')
    Object.assign(document, { elementFromPoint: before })
    const after = click('a')
    expect(store.drops).toEqual(['a->b'])
    // The click that follows a drop is cancelled at the row, so it never reaches the button's own
    // handler. linkedom's dispatch still calls that handler afterwards, so the cancelled default is
    // what this asserts; in Chromium the click never happens at all.
    expect(after.defaultPrevented).toBe(true)
  })
})
