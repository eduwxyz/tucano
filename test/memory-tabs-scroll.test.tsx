// The Memory page's tab strip holds a tab per bot, and bots have no limit, so the strip scrolls
// inside the bar: the tab you pick comes to the middle of it, and two borderless arrows page it a
// screenful at a time, each only while there is strip in that direction (#396).
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, Memory } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null })

const you = { id: 'p1', name: 'Apo' }
const bots: Agent[] = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: `Bot ${i}`, handle: `bot${i}`, archived: false }) as Agent)
const note = (id: string, scope: string, text: string): Memory => ({ id, scope, text, state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
const memories = [note('m0', 'person:p1', 'Prefers small pull requests.'), ...bots.map((a) => note(`m-${a.id}`, a.id, `${a.name} keeps a note.`))]
const fake = { memories, agents: bots, conversations: [], you, me: you } as unknown as State

vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: State) => unknown) => select(fake),
  addMemory: () => {},
  agentById: (s: State, id: string) => s.agents.find((a) => a.id === id),
  confirmMemory: () => {},
  decideMemory: () => {},
  editMemory: () => {},
  forgetMemory: () => {},
  isStale: () => false,
  navigate: () => {},
  purgeMemory: () => {},
  splitForPrompt: (m: Memory[]) => ({ prompt: m, searchable: [] }),
  isTeam: (a: Agent) => !a.archived,
  personScope: (person: { id: string }) => `person:${person.id}`,
  STALE_DAYS: 60
}))
vi.mock('../src/renderer/src/components/Pages', () => ({ Sheet: ({ title, children }: { title: string; children: unknown }) => <section data-title={title}>{children as never}</section> }))
vi.mock('../src/renderer/src/components/ui', () => ({
  AgentAvatar: () => null,
  Icon: () => null,
  ago: () => 'now'
}))

const { createRoot } = await import('react-dom/client')
const { MemoryPage } = await import('../src/renderer/src/components/Memory')
let root: ReturnType<typeof createRoot>

beforeEach(async () => {
  setLang('en')
  root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<MemoryPage />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = '<div id="root"></div>'
})

const strip = (): HTMLElement => document.querySelector('.tabs-line__strip') as unknown as HTMLElement
const back = (): HTMLElement | null => document.querySelector('.tabs-line__page--back') as unknown as HTMLElement | null
const more = (): HTMLElement | null => document.querySelector('.tabs-line__page:not(.tabs-line__page--back)') as unknown as HTMLElement | null
const tab = (id: string): HTMLElement => document.querySelector(`[data-tab="${id}"]`) as unknown as HTMLElement

const rect = (left: number, width: number): DOMRect => ({ left, width, right: left + width, top: 0, bottom: 0, height: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect

// linkedom has no layout: give the strip a width, a scroll width and a scroll position the way a
// browser would after the bots were added.
const layout = async (opts: { width?: number; scroll: number; left: number }): Promise<void> => {
  const el = strip()
  Object.defineProperty(el, 'clientWidth', { value: opts.width ?? 600, configurable: true })
  Object.defineProperty(el, 'scrollWidth', { value: opts.scroll, configurable: true })
  Object.defineProperty(el, 'scrollLeft', { value: opts.left, configurable: true, writable: true })
  await act(async () => el.dispatchEvent(new window.Event('scroll')))
}

const spyOn = (el: HTMLElement): { to: ReturnType<typeof vi.fn>; by: ReturnType<typeof vi.fn> } => {
  const to = vi.fn()
  const by = vi.fn()
  Object.assign(el, { scrollTo: to, scrollBy: by })
  return { to, by }
}

it('puts the bots inside a strip that scrolls, rather than past the edge of the page', async () => {
  const ids = [...document.querySelectorAll('.tabs-line__strip > button')].map((b) => b.getAttribute('data-tab'))
  expect(ids).toEqual(['all', 'me', ...bots.map((b) => b.id)])
  // Nothing overflows yet, so there is nothing to page to and no arrow to offer.
  expect(back()).toBeNull()
  expect(more()).toBeNull()
})

it('offers the arrow in a direction only while there is strip there, and pages by a screenful', async () => {
  const { by } = spyOn(strip())
  await layout({ scroll: 1800, left: 0 })
  expect(back()).toBeNull()
  expect(more()).not.toBeNull()
  await act(async () => more()!.click())
  expect(by).toHaveBeenCalledWith({ left: 600 - 48, behavior: 'smooth' })

  // Scrolled along, the strip has somewhere to go back to and nowhere new on the right.
  await layout({ scroll: 1800, left: 1200 })
  expect(back()).not.toBeNull()
  expect(more()).toBeNull()
  await act(async () => back()!.click())
  expect(by).toHaveBeenLastCalledWith({ left: -(600 - 48), behavior: 'smooth' })

  // At the right edge neither arrow is offered.
  await layout({ scroll: 1800, left: 1200 })
  expect(more()).toBeNull()
})

it('slides the tab you pick to the middle of the strip', async () => {
  const el = strip()
  const { to } = spyOn(el)
  await layout({ scroll: 1800, left: 100 })
  el.getBoundingClientRect = () => rect(0, 600)
  tab('a5').getBoundingClientRect = () => rect(900, 80)
  await act(async () => tab('a5').click())
  // 900 px into the view at a scroll of 100, less half of what is left either side of the tab.
  expect(to).toHaveBeenCalledWith({ left: 100 + 900 - (600 - 80) / 2, behavior: 'smooth' })
  expect(tab('a5').className).toBe('is-on')
})
