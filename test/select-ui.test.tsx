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

  // A panel field for "who else": every one chosen is named in the field, never folded into a count, and the
  // field grows to hold them.
  it('shows every value chosen when it is asked to, however many there are', async () => {
    const options = [{ value: 'a', label: 'Ana' }, { value: 'b', label: 'Bia' }, { value: 'c', label: 'Caio' }, { value: 'd', label: 'Dora' }, { value: 'e', label: 'Eva' }]
    await act(async () => root.render(<Select multiple values={['a', 'b', 'c', 'd']} options={options} onValuesChange={() => {}} />))
    // Four would be folded into "4 selecionados" by default.
    expect(document.querySelector('.select__trigger__value')?.textContent).toBe('4 selecionados')
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<Select multiple showAllValues values={['a', 'b', 'c', 'd']} options={options} onValuesChange={() => {}} />))
    const chips = [...document.querySelectorAll('.select__trigger__value .select__chip')].map((c) => c.textContent)
    expect(chips).toEqual(['Ana', 'Bia', 'Caio', 'Dora'])
    expect(document.querySelector('.select__trigger__value')?.textContent).not.toContain('selecionados')
    expect(document.querySelector('.select__trigger')?.className).toContain('is-wrapped')
    expect(document.querySelector('.select__trigger__value')?.className).toContain('is-wrap')
    // And the list still offers every one of them, the ones taken ticked.
    await act(async () => (document.querySelector('.select__trigger') as HTMLElement).click())
    const rows = [...document.querySelectorAll('[role=option]')]
    expect(rows.map((r) => r.textContent)).toEqual(['Ana', 'Bia', 'Caio', 'Dora', 'Eva'])
    expect(rows.filter((r) => r.className.includes('is-selected'))).toHaveLength(4)
  })

})
