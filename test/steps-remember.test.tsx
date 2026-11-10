// The steps of a conversation remember being folded: leaving it, or restarting the app, and coming
// back finds them as they were left, and a run that starts there opens folded too. What the folding
// itself looks like (the handle, the line it leaves) is test/steps-rail.test.tsx, next door.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Step } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

// What the app wrote down, in order: the settings patch each fold or unfold produced.
const written: { folded?: string[] }[] = []
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: (): State => fake,
    updateSettings: (patch: { folded?: string[] }): void => {
      written.push(patch)
      if (patch.folded) fake = { ...fake, settings: { ...fake.settings, folded: patch.folded } }
    }
  }
})

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 100, right: 700, width: 600, height: 600, x: 100, y: 100, toJSON: () => ({}) })
window.HTMLElement.prototype.scrollIntoView = (): void => {}
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id)
})

const actual = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const defaults = actual.getState() // the store as the app starts it, before a test says otherwise
const { setLang } = await import('../src/shared/lang')
const { createRoot } = await import('react-dom/client')
const { RunSteps } = await import('../src/renderer/src/components/Conversation')

const steps: Step[] = [
  { id: 's1', label: 'Read the skill', status: 'done', ms: 120 },
  { id: 's2', label: 'Ran the query', status: 'done', ms: 400 },
  { id: 's3', label: 'Wrote the file', status: 'done', ms: 90 }
]
// A reply as it comes back from the database: a new object every time, as it is after a relaunch.
const reply = (status: 'done' | 'working', conversationId = 'dm-lia', id = 'm1'): Message => ({
  id,
  conversationId,
  author: { kind: 'agent', id: 'a1' },
  text: 'feito',
  at: Date.now() - 5_000,
  run: { status, steps }
})

let root: Root
beforeAll(() => setLang('en'))
beforeEach(() => {
  written.length = 0
  fake = { ...defaults, ready: true, settings: { ...defaults.settings, folded: [] } }
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const mount = async (message: Message): Promise<void> => {
  await act(async () => root.render(<RunSteps message={message} />))
}
const el = (sel: string): HTMLElement | null => document.querySelector(sel) as HTMLElement | null
// A real mouse click carries a detail (1 for the first of a pair); `.click()` and a keyboard press carry 0.
const fire = async (node: HTMLElement, type: string, detail: number): Promise<void> => {
  await act(async () => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'detail', { value: detail })
    node.dispatchEvent(ev)
  })
}
const doubleClick = (node: HTMLElement): Promise<void> => fire(node, 'dblclick', 2)

describe('the steps a conversation was left with', () => {
  it('a run still working opens its steps, and folds them from the line, which is written down', async () => {
    await mount(reply('working'))
    expect(el('.steps__list')).not.toBeNull() // working: the steps read as they go
    await doubleClick(el('.steps__rail')!)
    expect(el('.steps__list')).toBeNull()
    expect(written.at(-1)).toEqual({ folded: ['steps:dm-lia'] }) // remembered under the conversation
    expect(el('.steps__toggle')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('coming back to the conversation, the reply is still folded: a fresh message, the same conversation', async () => {
    await mount(reply('done'))
    await act(async () => el('.steps__toggle')!.click()) // opened to read it
    expect(el('.steps__list')).not.toBeNull()
    await doubleClick(el('.steps__rail')!) // folded from the line
    expect(written.at(-1)).toEqual({ folded: ['steps:dm-lia'] })

    // What the app does on coming back: the same reply, drawn again from the database.
    await mount(reply('done'))
    expect(el('.steps__list')).toBeNull()
    expect(el('.steps__summary')!.textContent).toContain('3 steps')
  })

  it('a run that starts while the conversation is folded opens folded, not open', async () => {
    fake = { ...fake, settings: { ...fake.settings, folded: ['steps:dm-lia'] } }
    await mount(reply('working', 'dm-lia', 'm2'))
    expect(el('.steps__list')).toBeNull()
    expect(el('.steps__toggle')!.getAttribute('aria-expanded')).toBe('false')
    expect(written).toHaveLength(0) // read, not written: nothing changed here
  })

  it('is remembered per conversation: another one keeps opening its own steps', async () => {
    fake = { ...fake, settings: { ...fake.settings, folded: ['steps:dm-lia'] } }
    await mount(reply('working', 'ch-eng', 'm3'))
    expect(el('.steps__list')).not.toBeNull()
  })

  it('unfolding from the toggle clears it, so the next run in that conversation opens again', async () => {
    fake = { ...fake, settings: { ...fake.settings, folded: ['steps:dm-lia'] } }
    await mount(reply('done'))
    expect(el('.steps__list')).toBeNull()
    await act(async () => el('.steps__toggle')!.click())
    expect(el('.steps__list')).not.toBeNull()
    expect(written.at(-1)).toEqual({ folded: [] })

    await mount(reply('working', 'dm-lia', 'm4')) // a run that starts now, in the same conversation
    expect(el('.steps__list')).not.toBeNull()
  })

  it('the toggle folds it too, and says so as loudly as the line does', async () => {
    await mount(reply('done'))
    await act(async () => el('.steps__toggle')!.click()) // open
    await act(async () => el('.steps__toggle')!.click()) // and folded again, from the top
    expect(el('.steps__list')).toBeNull()
    expect(written.at(-1)).toEqual({ folded: ['steps:dm-lia'] })
  })

  it('writes nothing when there is nothing to change: opening a reply that was never folded', async () => {
    await mount(reply('done'))
    await act(async () => el('.steps__toggle')!.click())
    expect(el('.steps__list')).not.toBeNull()
    expect(written).toHaveLength(0)
  })
})
