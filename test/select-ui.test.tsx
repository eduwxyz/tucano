// The reusable Select: each one its own ids, so two on a page don't share a list or its options.
// (Esc inside a modal needs a browser's capture order, which linkedom doesn't have: checked in the app.)
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
// What linkedom doesn't lay out: a size for the trigger, frames and resizes that do nothing.
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 136, left: 100, right: 300, width: 200, height: 36, x: 100, y: 100, toJSON: () => ({}) })
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe(): void {}
    disconnect(): void {}
  }
})

const { createRoot } = await import('react-dom/client')
const { Select } = await import('../src/renderer/src/components/Select')

let root: Root
beforeEach(() => {
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

describe('the Select', () => {
  it('gives each select its own ids', async () => {
    await act(async () => root.render(<><Select options={['a', 'b']} value="a" /><Select options={['c', 'd']} value="c" /></>))
    const triggers = [...document.querySelectorAll('.select__trigger')]
    for (const t of triggers) await act(async () => (t as HTMLElement).click())
    const lists = [...document.querySelectorAll('[role=listbox]')].map((l) => l.getAttribute('id'))
    expect(lists).toHaveLength(2)
    expect(new Set(lists).size).toBe(2)
  })

})
