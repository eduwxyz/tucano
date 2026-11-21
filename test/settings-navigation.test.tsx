// The strip under a settings tab: it names the sections of the open tab in the order their cards
// read, follows the reading position, takes the pane to a section over an interruptible 280 ms
// ease-in-out, and moves at once for a keyboard activation or a reduced-motion preference. A section
// whose card the page did not draw gets no link, so the strip never offers a dead anchor.
import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Root } from 'react-dom/client'
import { setLang } from '../src/shared/lang'
import { SettingsLayout } from '../src/renderer/src/components/SettingsLayout'
import { settingsStructure, settingsTabStructure } from '../src/renderer/src/settings-structure'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
let focus: HTMLElement | null = null
let reduced = false
let sequence = 0
const frames = new Map<number, FrameRequestCallback>()
Object.assign(window, { matchMedia: () => ({ matches: reduced }) })
Object.assign(globalThis, {
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence },
  cancelAnimationFrame: (id: number) => { frames.delete(id) },
  ResizeObserver: class { observe(): void {} disconnect(): void {} }
})
// The page's own tab bar and the strip measure 40 px; every card stands 600 px below the one above
// it, starting under both rows. The scroller is 500 px tall over 5000 px of content.
const CARD_TOP = 120
const CARD_STRIDE = 600
const ROW = 40
const INSET = ROW + ROW + 16
window.HTMLElement.prototype.focus = function () { focus = this as unknown as HTMLElement }
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const element = this as unknown as HTMLElement
  const scroller = document.querySelector<HTMLElement>('.page__scroll')
  const top = scroller && element === scroller ? 0 : CARD_TOP + [...document.querySelectorAll('[data-settings-section]')].indexOf(element) * CARD_STRIDE - (scroller?.scrollTop || 0)
  const height = element.classList.contains('card') ? 500 : ROW
  return { top, bottom: top + height, left: 0, right: 720, width: 720, height, x: 0, y: top, toJSON: () => ({}) }
}
// linkedom has no scroll boxes: a plain property that starts at 0 is what the code reads and writes.
const offsets = new WeakMap<HTMLElement, number>()
Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', {
  configurable: true,
  get() { return offsets.get(this as unknown as HTMLElement) ?? 0 },
  set(value: number) { offsets.set(this as unknown as HTMLElement, value) }
})
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 500 } })
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 5000 } })
const { createRoot } = await import('react-dom/client')

const access = { admin: true, owner: true, team: false, servers: false }
const ALL = settingsStructure(access)
const SECTIONS = settingsTabStructure('geral', ALL)
let root: Root
let skipped: string | null = null

function Harness(): ReactNode {
  return (
    <div className="page__scroll">
      <div className="tabs"><button>General</button></div>
      <SettingsLayout sections={SECTIONS} />
      {SECTIONS.filter(section => section.id !== skipped).map(section => (
        <div key={section.id} className="card" id={`settings-${section.id}`} data-settings-section={section.id} tabIndex={-1} />
      ))}
    </div>
  )
}
const render = async (): Promise<void> => {
  await act(async () => root.render(<Harness />))
  // The reading-position check the strip schedules as it mounts, so the frames left are animations.
  await tick(0)
}
const tick = async (at: number): Promise<void> => {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(at)) })
}
const click = async (selector: string, detail = 1): Promise<Event> => {
  const event = new window.Event('click', { bubbles: true, cancelable: true })
  Object.entries({ button: 0, detail }).forEach(([key, value]) => Object.defineProperty(event, key, { value }))
  await act(async () => document.querySelector(selector)!.dispatchEvent(event))
  return event
}
const scroll = async (): Promise<void> => {
  await act(async () => document.querySelector('.page__scroll')!.dispatchEvent(new window.Event('scroll')))
  await tick(0)
}
const scroller = (): HTMLElement => document.querySelector('.page__scroll')!
const links = (): HTMLAnchorElement[] => [...document.querySelectorAll<HTMLAnchorElement>('.settings-sections a')]
const reached = (index: number): number => CARD_TOP + index * CARD_STRIDE - INSET

beforeEach(() => {
  setLang('en')
  document.getElementById('root')!.innerHTML = ''
  root = createRoot(document.getElementById('root')!)
  reduced = false
  skipped = null
  frames.clear()
  focus = null
})
afterEach(async () => { await act(async () => root.unmount()); frames.clear() })

describe('settings section strip', () => {
  it('names the pane’s own sections in the order their cards read, as links and not tabs', async () => {
    await render()
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(0)
    expect(links()).toHaveLength(SECTIONS.length)
    expect(links().map(link => link.textContent)).toEqual(SECTIONS.map(section => section.label))
    expect(links()[0]!.getAttribute('aria-current')).toBe('location')
    expect(document.querySelectorAll('[aria-current="location"]')).toHaveLength(1)
  })

  it('drops a section whose card the page did not draw', async () => {
    skipped = SECTIONS[1]!.id
    await render()
    expect(links()).toHaveLength(SECTIONS.length - 1)
    expect(links().map(link => link.getAttribute('href'))).not.toContain(`#settings-${SECTIONS[1]!.id}`)
  })

  it('animates a pointer selection with ease-in-out and focuses the target without a second scroll', async () => {
    await render()
    const index = 3
    const event = await click(`a[href="#settings-${SECTIONS[index]!.id}"]`)
    expect(event.defaultPrevented).toBe(true)
    expect(focus?.id).toBe(`settings-${SECTIONS[index]!.id}`)
    await tick(0)
    expect(scroller().scrollTop).toBe(0)
    await tick(140)
    expect(scroller().scrollTop).toBeCloseTo(reached(index) / 2, 0)
    await tick(280)
    expect(scroller().scrollTop).toBeCloseTo(reached(index), 0)
    expect(links()[index]!.getAttribute('aria-current')).toBe('location')
  })

  it('moves immediately for a keyboard activation, and for a reduced-motion preference', async () => {
    await render()
    await click(`a[href="#settings-${SECTIONS[2]!.id}"]`, 0)
    expect(scroller().scrollTop).toBeCloseTo(reached(2), 0)
    // Only the reading-position check it schedules on landing: no animation frame is left.
    await tick(0)
    expect(scroller().scrollTop).toBeCloseTo(reached(2), 0)
    expect(frames.size).toBe(0)
    reduced = true
    await click(`a[href="#settings-${SECTIONS[4]!.id}"]`)
    expect(scroller().scrollTop).toBeCloseTo(reached(4), 0)
    await tick(0)
    expect(scroller().scrollTop).toBeCloseTo(reached(4), 0)
    expect(frames.size).toBe(0)
  })

  it('cancels a running animation when another section is chosen, and on wheel input', async () => {
    await render()
    await click(`a[href="#settings-${SECTIONS[4]!.id}"]`)
    await tick(0)
    await tick(140)
    const midway = scroller().scrollTop
    expect(midway).toBeGreaterThan(0)
    // A second selection replaces the first: what is on screen never reaches the abandoned target,
    // and the pane settles on the new one.
    await click(`a[href="#settings-${SECTIONS[2]!.id}"]`)
    await tick(200)
    await tick(340)
    expect(scroller().scrollTop).toBeLessThan(reached(4))
    await tick(480)
    expect(scroller().scrollTop).toBeCloseTo(reached(2), 0)
    // Wheel input stops an animation where it is, without jumping to its target.
    await click(`a[href="#settings-${SECTIONS[5]!.id}"]`)
    await tick(0)
    await tick(140)
    await act(async () => scroller().dispatchEvent(new window.Event('wheel')))
    const stopped = scroller().scrollTop
    expect(stopped).toBeGreaterThan(reached(2))
    expect(stopped).toBeLessThan(reached(5))
    await tick(700)
    expect(scroller().scrollTop).toBeCloseTo(stopped, 5)
  })

  it('follows the reading position as the pane scrolls, and leaves the last card room to arrive', async () => {
    await render()
    scroller().scrollTop = reached(2) + 10
    await scroll()
    expect(links()[2]!.getAttribute('aria-current')).toBe('location')
    scroller().scrollTop = reached(5) + 10
    await scroll()
    expect(links()[5]!.getAttribute('aria-current')).toBe('location')
    // The page keeps a tail under its last card: the strip's height and the tab bar taken out of the
    // viewport, so that card can reach the line like the ones above it.
    expect(scroller().style.getPropertyValue('--settings-tail')).toBe(`${500 - ROW - ROW - 32}px`)
  })
})
