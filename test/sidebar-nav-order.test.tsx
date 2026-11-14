// The sidebar's own screens (Approvals, Memory, Wiki…) sit in the order the person gave them: the
// same hold, drop and Alt+arrow the lists under them have, kept as `navOrder` in the settings.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
const saved: Record<string, unknown>[] = []
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    updateSettings: (patch: Record<string, unknown>): void => void saved.push(patch)
  }
})
const { getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { Sidebar } = await import('../src/renderer/src/components/Sidebar')

// The labels below are the English ones: a person reading the app in Portuguese gets the same text
// from the first argument of L().
setLang('en')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const agent = (p: Partial<Agent>): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: 'Pesquisadora', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...p })

type Setup = Partial<Omit<State, 'settings'>> & { settings?: Partial<State['settings']> }

let root: Root
const render = async (s: Setup = {}): Promise<void> => {
  const base = getState()
  fake = { ...base, ready: true, people: [ana], you: 'ana', ...s, settings: { ...base.settings, ...s.settings } } as State
  await act(async () => root.render(<Sidebar />))
}

// The screens above the lists, in the order the sidebar draws them, and one of their buttons.
const navOrder = (): string[] => [...document.querySelectorAll('.sidebar__scroll > .nav-row[data-order-group="nav"]')].map((x) => x.getAttribute('data-order-id')!)
const navRow = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-order-group="nav"][data-order-id="${id}"]`)!
const line = (): HTMLElement | null => document.querySelector<HTMLElement>('.nav-hide')

// linkedom cannot lay anything out: the row under the pointer is what the stub answers with.
const fire = (node: Element | null, type: string): void => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true })
  for (const [k, v] of Object.entries({ button: 0, pointerId: 1 })) Object.defineProperty(ev, k, { value: v })
  act(() => {
    node?.dispatchEvent(ev)
  })
}
const carry = async (id: string): Promise<void> => {
  fire(navRow(id).querySelector('.nav-item'), 'pointerdown')
  await act(async () => new Promise((ok) => setTimeout(ok, 420)))
}
const over = (el: Element | null): (() => void) => {
  const was = document.elementFromPoint
  Object.assign(document, { elementFromPoint: () => el })
  return () => Object.assign(document, { elementFromPoint: was })
}
const dropOn = (id: string, el: Element | null): void => {
  const restore = over(el)
  fire(navRow(id).querySelector('.nav-item'), 'pointermove')
  fire(navRow(id).querySelector('.nav-item'), 'pointerup')
  restore()
}
const navButton = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-order-group="nav"][data-order-id="${id}"] .nav-item`)!

// linkedom has no KeyboardEvent: a plain event carrying what React reads is the same shape a browser gives.
const key = (node: HTMLElement, k: string, alt = true): void => {
  const ev = new window.Event('keydown', { bubbles: true, cancelable: true })
  for (const [name, value] of Object.entries({ key: k, altKey: alt })) Object.defineProperty(ev, name, { value })
  act(() => {
    node.dispatchEvent(ev)
  })
}

// Two agents (so "Team" shows) and an owner (so "Report" does): every screen in the list.
const team = { agents: [agent({}), agent({ id: 'a2', name: 'Rui', handle: 'rui' })] }

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  saved.length = 0
  vi.clearAllMocks()
})

describe("the sidebar's own screens", () => {
  it('stay in the core order until the person moves one', async () => {
    await render(team)
    expect(navOrder()).toEqual(['approvals', 'memory', 'wiki', 'routines', 'skills', 'org', 'report'])
  })

  it('follow in the saved order, and show a screen it does not name last', async () => {
    await render({ ...team, settings: { navOrder: ['wiki', 'approvals'] } })
    expect(navOrder()).toEqual(['wiki', 'approvals', 'memory', 'routines', 'skills', 'org', 'report'])
  })

  it('forget a screen the order names that is not there', async () => {
    await render({ ...team, settings: { navOrder: ['wiki', 'gone', 'approvals'] } })
    expect(navOrder()).toEqual(['wiki', 'approvals', 'memory', 'routines', 'skills', 'org', 'report'])
  })

  it('move one place down with Alt+ArrowDown, saving the list as it is shown', async () => {
    await render(team)
    key(navButton('wiki'), 'ArrowDown')
    expect(saved).toEqual([{ navOrder: ['approvals', 'memory', 'routines', 'wiki', 'skills', 'org', 'report'], navHidden: [] }])
  })

  it('move one place up with Alt+ArrowUp, from the saved order, not the core one', async () => {
    await render({ ...team, settings: { navOrder: ['wiki', 'approvals'] } })
    key(navButton('approvals'), 'ArrowUp')
    expect(saved).toEqual([{ navOrder: ['approvals', 'wiki', 'memory', 'routines', 'skills', 'org', 'report'], navHidden: [] }])
  })

  it('stay put at the ends of the list', async () => {
    await render(team)
    key(navButton('approvals'), 'ArrowUp')
    key(navButton('report'), 'ArrowDown')
    expect(saved).toEqual([
      { navOrder: ['approvals', 'memory', 'wiki', 'routines', 'skills', 'org', 'report'], navHidden: [] },
      { navOrder: ['approvals', 'memory', 'wiki', 'routines', 'skills', 'org', 'report'], navHidden: [] }
    ])
  })

  it('leave the row where it is on an arrow without Alt', async () => {
    await render(team)
    key(navButton('wiki'), 'ArrowDown', false)
    expect(saved).toEqual([])
  })

  it('keep the Tuca and the foot where they are: only the screens between them move', async () => {
    await render({ ...team, settings: { navOrder: ['report', 'org'] } })
    const scroll = document.querySelector('.sidebar__scroll')!
    expect(scroll.firstElementChild!.textContent).toContain('Tuca')
    expect(navOrder()).toEqual(['report', 'org', 'approvals', 'memory', 'wiki', 'routines', 'skills'])
    expect(document.querySelector('.sidebar__foot .nav-item')).not.toBeNull()
  })
})

// Under the line a screen leaves the sidebar but keeps its place in the order, so the line is both
// the way out and the way back.
describe('the line under the screens', () => {
  const all = ['memory', 'wiki', 'routines', 'skills', 'org', 'report']

  it('is absent until a screen is carried, and says what it does while it is', async () => {
    await render(team)
    expect(line()).toBeNull()
    await carry('wiki')
    expect(line()!.textContent).toBe('Hide sections below')
  })

  it('hides the screen let go on it', async () => {
    await render(team)
    await carry('wiki')
    dropOn('wiki', line())
    expect(saved).toEqual([{ navHidden: ['wiki'] }])
  })

  it('hides a screen let go on one already under it', async () => {
    await render({ ...team, settings: { navHidden: ['routines'] } })
    await carry('wiki')
    dropOn('wiki', navRow('routines'))
    expect(saved).toEqual([{ navHidden: ['routines', 'wiki'] }])
  })

  it('never takes the last screen still shown: that would leave no way back', async () => {
    await render({ ...team, settings: { navHidden: all } })
    expect(navOrder()).toEqual(['approvals'])
    await carry('approvals')
    dropOn('approvals', line())
    expect(saved).toEqual([])
  })

  it('keeps the count of what is under it, and opens on a press', async () => {
    await render({ ...team, settings: { navHidden: ['wiki'] } })
    expect(line()!.textContent).toContain('1 hidden')
    expect(navOrder()).not.toContain('wiki')
    fire(line(), 'pointerdown')
    fire(line(), 'click')
    expect(navOrder()).toContain('wiki')
    expect(navRow('wiki').className).toContain('is-parked')
  })

  it('shows a screen again when it is pulled back above it', async () => {
    await render({ ...team, settings: { navHidden: ['wiki'] } })
    fire(line(), 'pointerdown')
    fire(line(), 'click')
    key(navButton('wiki'), 'ArrowUp')
    expect(saved).toEqual([{ navOrder: ['approvals', 'wiki', 'memory', 'routines', 'skills', 'org', 'report'], navHidden: [] }])
  })

  it('does not open on a press that began on a row: that press was a drop', async () => {
    await render({ ...team, settings: { navHidden: ['wiki'] } })
    fire(line(), 'click')
    expect(navOrder()).not.toContain('wiki')
  })
})
