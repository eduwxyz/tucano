// Smart routing is one more classifier feature, not a card of its own: its switch is the last line of
// Settings › Classifiers, right under the job it serves, and the tab it opens is a button offered
// only while it is on.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
const setTab = vi.fn()
const navigate = vi.fn()
const updateSettings = vi.fn()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    setTab,
    navigate,
    updateSettings,
    useVoice: () => undefined
  }
})
const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ClassifiersCard } = await import('../src/renderer/src/components/Pages')

let root: Root | undefined
beforeEach(() => {
  setLang('en')
  setTab.mockClear()
  navigate.mockClear()
  updateSettings.mockClear()
  const mount = document.getElementById('root')!
  mount.innerHTML = ''
  root = undefined
  fake = {
    ...real.getState(),
    ready: true,
    people: [],
    you: '',
    agents: [],
    conversations: [],
    messages: {},
    inbox: { approvals: [], questions: [] },
    settings: { ...real.getState().settings, classifiers: [], classifierJobs: {}, routerModel: 'haiku' } as Settings
  } as State
})
const render = async (node: ReactNode): Promise<void> => {
  if (root) await act(async () => root!.unmount())
  const host = document.createElement('div')
  document.getElementById('root')!.append(host)
  root = createRoot(host)
  const mounted = root
  await act(async () => mounted.render(node))
}
const text = (): string => document.body.textContent ?? ''
const button = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label)) as HTMLElement | undefined

describe('smart routing inside Classifiers', () => {
  it('is a row of the card, under the jobs, with its switch and no button while it is off', async () => {
    await render(<ClassifiersCard />)
    expect(text()).toContain('Smart model routing')
    // The router model the who-replies job falls back to is here too, now that its card is gone.
    expect(text()).toContain('Router model')
    expect(button('Configure routing')).toBeUndefined()
  })

  it('offers the routing tab as a button to the left of the switch once it is on', async () => {
    fake = { ...fake, settings: { ...fake.settings, routing: { enabled: true, pools: {} } } as Settings }
    await render(<ClassifiersCard />)
    const open = button('Configure routing')
    expect(open).toBeDefined()
    const row = open!.parentElement!
    const controls = [...row.children]
    // A real button, not a link: accent styling is what the person clicks to go on.
    expect(open!.tagName).toBe('BUTTON')
    expect(open!.className).toContain('btn--primary')
    // The button comes first in the row; the switch is the control after it.
    expect(controls.indexOf(open!)).toBe(0)
    expect(controls.length).toBe(2)
    await act(async () => open!.click())
    expect(navigate).toHaveBeenCalledWith({ kind: 'settings' })
    expect(setTab).toHaveBeenCalledWith('settings', 'roteamento')
  })

  it('has no card of its own left in Settings', () => {
    const pages = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'components', 'Pages.tsx'), 'utf8')
    expect(pages).not.toContain("title={L('Roteador', 'Router')}")
    expect(pages).not.toContain('SmartRoutingSwitch')
  })
})
