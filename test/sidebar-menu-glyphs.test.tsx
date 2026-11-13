// A row's right-click menu offers the same two steps the keyboard has, and each one wears the arrow
// it means: the label says what happens, the glyph says which way the row goes (#250).
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { Sidebar } = await import('../src/renderer/src/components/Sidebar')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const agent = (p: Partial<Agent>): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: 'Pesquisadora', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...p })
const dm = (p: Partial<Conversation>): Conversation => ({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'], ...p })

let root: Root
const render = async (s: Partial<State> = {}): Promise<void> => {
  const base = getState()
  fake = { ...base, ready: true, people: [ana], you: 'ana', ...s, settings: { ...base.settings, sidebarParts: undefined } } as State
  await act(async () => root.render(<Sidebar />))
}

// linkedom has no mouse event carrying coordinates: a plain event with what the menu reads is the
// same shape React gets from a browser.
const rightClick = (node: Element): void => {
  const ev = new window.Event('contextmenu', { bubbles: true, cancelable: true })
  for (const [name, value] of Object.entries({ clientX: 40, clientY: 60 })) Object.defineProperty(ev, name, { value })
  act(() => {
    node.dispatchEvent(ev)
  })
}

// The bot's DM row, and an item of the menu it just opened.
const dmRow = (): Element => [...document.querySelectorAll('.section')].find((x) => /mensagens diretas/i.test(x.textContent ?? ''))!.querySelector('.nav-item')!
const menuItem = (re: RegExp): HTMLElement => [...document.querySelectorAll<HTMLElement>('.menu__item')].find((b) => re.test(b.textContent ?? ''))!
const arrow = (item: HTMLElement): string | null | undefined => item.querySelector('svg path')?.getAttribute('d')

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe("a bot DM's right-click menu", () => {
  it('draws an arrow beside Move up and Move down, each pointing the way the row goes', async () => {
    await render({ agents: [agent({})], conversations: [dm({})] })
    rightClick(dmRow())
    const up = menuItem(/Mover para cima|Move up/)
    const down = menuItem(/Mover para baixo|Move down/)
    expect(arrow(up)).toBeTruthy()
    expect(arrow(down)).toBeTruthy()
    expect(arrow(up)).not.toBe(arrow(down))
  })
})
