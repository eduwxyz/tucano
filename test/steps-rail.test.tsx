// The line beside a run's steps is a handle: a double-click on it folds the steps, from wherever the
// run has scrolled to, instead of scrolling back up to the toggle at the top of it. linkedom has no
// layout, so what the line looks like and where it sits is measured in the built app; what is checked
// here is that the handle exists while the steps are open, that it folds them, and that one click on
// it does nothing.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message, Step } from '../src/shared/types'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })
const scrolled: string[] = []
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 100, right: 700, width: 600, height: 600, x: 100, y: 100, toJSON: () => ({}) })
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
  scrolled.push(this.className)
}
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id)
})

const { updateSettings } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { RunSteps } = await import('../src/renderer/src/components/Conversation')

const steps: Step[] = [
  { id: 's1', label: 'Read the skill', status: 'done', ms: 120 },
  { id: 's2', label: 'Ran the query', status: 'done', ms: 400 },
  { id: 's3', label: 'Wrote the file', status: 'done', ms: 90 }
]
const reply = (status: 'done' | 'working'): Message => ({
  id: 'm1',
  conversationId: 'dm',
  author: { kind: 'agent', id: 'a1' },
  text: 'feito',
  at: Date.now() - 5000,
  run: { status, steps }
})

let root: Root
beforeEach(() => {
  // Through the settings, not straight at the language: folding the steps writes the fold down, and
  // every settings write re-applies the app's language, so a language held only in the module falls
  // back to the app's own mid-test.
  updateSettings({ language: 'en', folded: [] }) // and nothing folded from the test before
  scrolled.length = 0
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const mount = async (message: Message): Promise<void> => {
  await act(async () => root.render(<RunSteps message={message} />))
}
const el = (sel: string): HTMLElement | null => document.querySelector(sel) as HTMLElement | null
const openSteps = async (message: Message = reply('done')): Promise<HTMLElement> => {
  await mount(message)
  await act(async () => el('.steps__toggle')!.click())
  return el('.steps__list')!
}
// A real mouse click carries a detail (1 for the first of a pair); `.click()` and a keyboard press carry 0.
// linkedom has no MouseEvent, so the detail is set on a plain event, which is what React reads it from.
const fire = async (node: HTMLElement, type: string, detail: number): Promise<void> => {
  await act(async () => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'detail', { value: detail })
    node.dispatchEvent(ev)
  })
}
const mouse = (node: HTMLElement, type: 'click' | 'dblclick'): Promise<void> => fire(node, type, type === 'dblclick' ? 2 : 1)
// What Chromium fires when a button is pressed with Enter or Space: a click whose detail is 0.
const keyboard = (node: HTMLElement): Promise<void> => fire(node, 'click', 0)

describe('the line beside the steps', () => {
  it('is there while the steps are open, and only then', async () => {
    await mount(reply('done'))
    expect(el('.steps__list')).toBeNull()
    expect(el('.steps__rail')).toBeNull() // closed: there is no line to grab
    await act(async () => el('.steps__toggle')!.click())
    expect(el('.steps__list')).not.toBeNull()
    const rail = el('.steps__rail')!
    expect(rail.tagName).toBe('BUTTON')
    expect(rail.getAttribute('aria-label')).toBe('Fold the steps')
    expect(rail.getAttribute('title')).toBe('Double-click to fold the steps')
    expect(el('.steps__body')!.contains(rail)).toBe(true)
    expect(el('.steps__body')!.contains(el('.steps__list'))).toBe(true)
  })

  it('folds the steps on a double-click, leaving the one line that says how many they were', async () => {
    await openSteps()
    await mouse(el('.steps__rail')!, 'dblclick')
    expect(el('.steps__list')).toBeNull()
    expect(el('.steps__rail')).toBeNull()
    expect(el('.steps')!.className).not.toContain('is-open')
    expect(el('.steps__summary')!.textContent).toBe('Done · 3 steps · 610 ms')
  })

  it('brings the line it folded to into view, or folding looks like the steps vanishing', async () => {
    await openSteps()
    await mouse(el('.steps__rail')!, 'dblclick')
    await act(async () => new Promise((ok) => setTimeout(ok, 5)))
    expect(scrolled).toContain('steps')
  })

  it('ignores one click: dragging past the line never folds a run', async () => {
    await openSteps()
    await mouse(el('.steps__rail')!, 'click')
    expect(el('.steps__list')).not.toBeNull()
    expect(el('.steps__rail')).not.toBeNull()
  })

  it('folds from the keyboard too, since a keyboard has no double-click', async () => {
    await openSteps()
    await keyboard(el('.steps__rail')!)
    expect(el('.steps__list')).toBeNull()
    expect(el('.steps__summary')!.textContent).toContain('3 steps')
  })

  it('folds a run that is still working, which opens by itself', async () => {
    await mount(reply('working'))
    expect(el('.steps__list')).not.toBeNull() // still working: the steps read as they go
    await mouse(el('.steps__rail')!, 'dblclick')
    expect(el('.steps__list')).toBeNull()
    expect(el('.steps')).not.toBeNull() // the line stays, with the step going by
  })
})
