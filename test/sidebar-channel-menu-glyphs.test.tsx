// A channel's context menu moves the row with "Move up" and "Move down", and those two were the only
// items in it without a glyph: they sat under a separator between a gear and a trash, so they read as
// plain text beside icons. Each now wears the icon set's own arrow, and up points up.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div><div id="scratch"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), navigate: vi.fn(), openDm: vi.fn(async () => {}), updateSettings: vi.fn() }
})
const store = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { Sidebar } = await import('../src/renderer/src/components/Sidebar')
const { Icon } = await import('../src/renderer/src/components/ui')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const channel = (id: string, name: string): Conversation => ({ id, kind: 'channel', name, members: ['a1'] })

let root: Root
const render = async (s: Partial<State> = {}): Promise<void> => {
  const base = store.getState()
  fake = { ...base, ready: true, people: [ana], you: 'ana', conversations: [channel('c1', 'geral'), channel('c2', 'obras')], ...s, settings: { ...base.settings, sidebarParts: undefined, ...s.settings } } as State
  await act(async () => root.render(<Sidebar />))
}
const rows = (): Element[] => [...[...document.querySelectorAll('.section')].find((x) => x.querySelector('.section__head')?.textContent?.includes('Canais'))!.querySelectorAll('.nav-item')]
const row = (name: string): Element => rows().find((r) => r.querySelector('.nav-item__label')?.textContent === name)!
const right = async (name: string): Promise<void> => {
  const e = new window.Event('contextmenu', { bubbles: true, cancelable: true })
  Object.assign(e, { clientX: 20, clientY: 20 })
  await act(async () => void row(name).parentElement!.dispatchEvent(e))
}
const menu = (): Element[] => [...document.querySelectorAll('.menu__item')]
const item = (label: string): Element => menu().find((x) => x.textContent?.includes(label))!
// What the icon set draws for that name, so the assertion survives the arrow being redrawn.
const drawn = async (name: 'up' | 'down'): Promise<string> => {
  const host = document.getElementById('scratch')!
  const scratch = createRoot(host as unknown as Element)
  await act(async () => scratch.render(<Icon name={name} size={14} />))
  const html = host.innerHTML
  await act(async () => scratch.unmount())
  return html
}

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe("a channel's right-click menu", () => {
  it('wears an arrow on Move up and on Move down, each pointing the way the row goes', async () => {
    await render()
    await right('obras')
    expect(menu().length).toBeGreaterThan(0)
    expect(item('Mover para cima').querySelector('svg')).not.toBeNull()
    expect(item('Mover para baixo').querySelector('svg')).not.toBeNull()
    expect(item('Mover para cima').querySelector('svg')!.outerHTML).toBe(await drawn('up'))
    expect(item('Mover para baixo').querySelector('svg')!.outerHTML).toBe(await drawn('down'))
  })

  it('keeps the two steps in order, up before down, and still moves the row', async () => {
    await render()
    await right('obras')
    const labels = menu().map((x) => x.textContent)
    expect(labels.indexOf('Mover para cima')).toBe(labels.indexOf('Mover para baixo') - 1)
    await act(async () => void (item('Mover para cima') as HTMLElement).click())
    expect(store.updateSettings).toHaveBeenCalledTimes(1)
    expect((store.updateSettings as unknown as { mock: { calls: [{ channelLayout: { loose: string[] } }][] } }).mock.calls[0]![0].channelLayout.loose).toEqual(['c2', 'c1'])
  })
})
