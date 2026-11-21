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

// The sidebar's screens and the lists under them each keep their own order: a row carried in one
// list must not be dropped onto a row of another, or a stray drop sends it to the end of a list it
// never belonged to.
function Lists(): React.ReactNode {
  const nav = useHoldReorder({ group: 'nav', onDrop: (id, before) => store.drops.push(`nav:${id}->${before}`), onNudge: () => {} })
  const channels = useHoldReorder({ group: 'channels', onDrop: (id, before) => store.drops.push(`ch:${id}->${before}`), onNudge: () => {} })
  return (
    <div>
      {['wiki', 'approvals'].map((id) => (
        <div key={id} {...nav.rowProps(id)}>
          <button>{id}</button>
        </div>
      ))}
      <div {...channels.rowProps('geral')}>
        <button>geral</button>
      </div>
    </div>
  )
}

describe('a list of its own', () => {
  // The row the pointer is over, as linkedom cannot lay anything out.
  const over = (selector: string): (() => void) => {
    const before = document.elementFromPoint
    Object.assign(document, { elementFromPoint: () => container.querySelector(selector) })
    return () => Object.assign(document, { elementFromPoint: before })
  }
  const carry = async (id: string): Promise<void> => {
    press(id, 'pointerdown')
    await act(async () => new Promise((ok) => setTimeout(ok, 420)))
  }

  beforeEach(async () => {
    await act(async () => root.render(<Lists />))
  })

  it('moves a row onto another row of the same list', async () => {
    await carry('wiki')
    const restore = over('[data-order-id="approvals"] button')
    press('wiki', 'pointermove')
    press('wiki', 'pointerup')
    restore()
    expect(store.drops).toEqual(['nav:wiki->approvals'])
  })

  it('does nothing when the row is let go over a row of another list', async () => {
    await carry('wiki')
    const restore = over('[data-order-id="geral"] button')
    press('wiki', 'pointermove')
    press('wiki', 'pointerup')
    restore()
    expect(store.drops).toEqual([])
  })
})

// One hook can sort several lists (the agents of each sector): each row says which, and a row only
// lands in its own. A press that wanders off before the hold is a scroll, not a pick-up.
const nudges = vi.hoisted(() => [] as string[])
function Sectors(): React.ReactNode {
  const sort = useHoldReorder({ group: 'agents', onDrop: (id, before) => store.drops.push(`${id}->${before}`), onNudge: (id, by) => nudges.push(`${id}${by}`) })
  return (
    <div>
      {[['a1', 'sector:a'], ['a2', 'sector:a'], ['b1', 'sector:b']].map(([id, g]) => (
        <div key={id} {...sort.rowProps(id!, g)} data-picked={sort.picked === id ? 'yes' : undefined}>
          <button>{id}</button>
        </div>
      ))}
      <div {...sort.zoneProps('end:a', 'sector:a')} data-live={sort.carrying('sector:a') ? 'yes' : undefined} />
    </div>
  )
}

describe('several lists under one hook', () => {
  const over = (selector: string): (() => void) => {
    const before = document.elementFromPoint
    Object.assign(document, { elementFromPoint: () => container.querySelector(selector) })
    return () => Object.assign(document, { elementFromPoint: before })
  }
  const hold = async (): Promise<void> => act(async () => new Promise((ok) => setTimeout(ok, 420)))

  beforeEach(async () => {
    nudges.length = 0
    await act(async () => root.render(<Sectors />))
  })

  it('drops a row on a row or the end of its own list, never on another list', async () => {
    press('a2', 'pointerdown')
    await hold()
    expect(container.querySelector('[data-live]')).not.toBeNull() // its list's end wakes up
    let restore = over('[data-order-id="b1"] button')
    press('a2', 'pointermove')
    press('a2', 'pointerup')
    restore()
    expect(store.drops).toEqual([])

    press('a1', 'pointerdown')
    await hold()
    restore = over('[data-order-id="end:a"]')
    press('a1', 'pointermove')
    press('a1', 'pointerup')
    restore()
    expect(store.drops).toEqual(['a1->end:a'])
    expect(container.querySelector('[data-live]')).toBeNull()
  })

  it('picks nothing up when the press wanders off before the hold', async () => {
    fire(rowOf('a1').querySelector('button')!, 'pointerdown', { clientX: 10, clientY: 10 })
    fire(rowOf('a1').querySelector('button')!, 'pointermove', { clientX: 10, clientY: 40 })
    await hold()
    expect(container.querySelector('[data-picked]')).toBeNull()
  })

  it('steps the row the keyboard is on with Alt+arrows, and lets plain arrows be', () => {
    fire(rowOf('a2').querySelector('button')!, 'keydown', { key: 'ArrowUp', altKey: true })
    fire(rowOf('a1').querySelector('button')!, 'keydown', { key: 'ArrowDown', altKey: true })
    fire(rowOf('a1').querySelector('button')!, 'keydown', { key: 'ArrowDown', altKey: false })
    expect(nudges).toEqual(['a2-1', 'a11'])
  })

  it('puts a carried row back with Escape', async () => {
    press('a1', 'pointerdown')
    await hold()
    expect(container.querySelector('[data-picked]')).not.toBeNull()
    fire(rowOf('a1').querySelector('button')!, 'keydown', { key: 'Escape' })
    expect(container.querySelector('[data-picked]')).toBeNull()
    press('a1', 'pointerup')
    expect(store.drops).toEqual([])
  })
})
