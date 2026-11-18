import { parseHTML } from 'linkedom'
import { act, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Root } from 'react-dom/client'
import { setLang } from '../src/shared/lang'
import { SettingsLayout } from '../src/renderer/src/components/SettingsLayout'
import { settingsStructure, type SettingsAccess, type SettingsPageId, type SettingsSectionId } from '../src/renderer/src/settings-structure'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
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
window.HTMLElement.prototype.focus = function () { focus = this as unknown as HTMLElement }
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const element = this as unknown as HTMLElement
  const scroller = document.querySelector<HTMLElement>('.page__scroll')
  const targets = [...document.querySelectorAll('[data-settings-section]')]
  const index = targets.indexOf(element)
  const top = index >= 0 ? 40 + 120 + index * 600 - (scroller?.scrollTop || 0) : 40
  const height = element.classList.contains('settings-navigation') ? 88 : 500
  return { top, bottom: top + height, left: 0, right: 720, width: 720, height, x: 0, y: top, toJSON: () => ({}) }
}
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 500 } })
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 5000 } })
const { createRoot } = await import('react-dom/client')
let root: Root
let access: SettingsAccess
let requested: string | undefined
let page: SettingsPageId
const navigated: string[] = []
function Harness(): ReactNode {
  const [route, setRoute] = useState(requested)
  const sections = settingsStructure(access)
  const content = Object.fromEntries(sections.map(section => [section.id,
    <div className="card"><h2>{section.id}</h2><button>{`Control ${section.id}`}</button></div>
  ])) as Record<SettingsSectionId, ReactNode>
  return <div className="page__scroll"><SettingsLayout page={page} requested={route} sections={sections} content={content} onNavigate={id => { navigated.push(id); setRoute(id) }} /></div>
}
const render = async (): Promise<void> => { await act(async () => root.render(<Harness />)) }
const tick = async (at: number): Promise<void> => {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(at)) })
}
const click = async (selector: string, detail = 1, extra: Record<string, unknown> = {}): Promise<Event> => {
  const event = new window.Event('click', { bubbles: true, cancelable: true })
  Object.entries({ button: 0, detail, ...extra }).forEach(([key, value]) => Object.defineProperty(event, key, { value }))
  await act(async () => document.querySelector(selector)!.dispatchEvent(event))
  return event
}
const scroller = (): HTMLElement => document.querySelector('.page__scroll')!
beforeEach(() => {
  setLang('en')
  document.getElementById('root')!.innerHTML = ''
  root = createRoot(document.getElementById('root')!)
  access = { admin: true, owner: true, team: false, servers: false }
  requested = undefined
  page = 'geral'
  reduced = false
  frames.clear()
  navigated.length = 0
  focus = null
})
afterEach(async () => { await act(async () => root.unmount()); frames.clear() })

describe('settings section navigation', () => {
  it('names the pane’s own sections in one rail, without repeating the page’s tabs', async () => {
    await render()
    const sections = settingsStructure(access).filter(section => section.visible && section.page === 'geral')
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(0)
    expect(document.querySelectorAll('nav a')).toHaveLength(sections.length)
    expect(document.querySelectorAll('[data-settings-section]')).toHaveLength(sections.length)
    expect([...document.querySelectorAll('nav a')].map(link => link.textContent)).toEqual(sections.map(section => section.label))
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Appearance')
  })

  it('animates pointer navigation with ease-in-out and focuses the target without a second scroll', async () => {
    await render()
    await click('a[href="#settings-geral-notifications"]')
    expect(navigated).toEqual(['geral-notifications'])
    expect(focus?.id).toBe('settings-geral-notifications')
    await tick(0)
    expect(scroller().scrollTop).toBe(0)
    await tick(140)
    expect(scroller().scrollTop).toBeCloseTo(908)
    await tick(280)
    expect(scroller().scrollTop).toBeCloseTo(1816)
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Notifications')
  })

  it('moves immediately for keyboard activation and for reduced motion', async () => {
    await render()
    await click('a[href="#settings-geral-notifications"]', 0)
    expect(scroller().scrollTop).toBeCloseTo(1816)
    expect(frames.size).toBe(0)
    reduced = true
    await click('a[href="#settings-geral-voice"]')
    expect(scroller().scrollTop).toBeCloseTo(1216)
    expect(frames.size).toBe(0)
  })

  it('cancels an old animation on another selection or wheel input', async () => {
    await render()
    await click('a[href="#settings-geral-notifications"]')
    await tick(0)
    await tick(140)
    await click('a[href="#settings-geral-voice"]')
    await tick(200)
    await tick(480)
    expect(scroller().scrollTop).toBeCloseTo(1216)
    await click('a[href="#settings-geral-appearance"]')
    await tick(500)
    await tick(600)
    const stopped = scroller().scrollTop
    await act(async () => scroller().dispatchEvent(new window.Event('wheel', { bubbles: true })))
    await tick(900)
    expect(scroller().scrollTop).toBe(stopped)
  })

  it('tracks manual scrolling without moving focus or writing navigation state', async () => {
    await render()
    const control = document.querySelector<HTMLElement>('button')!
    control.focus()
    scroller().scrollTop = 900
    await act(async () => scroller().dispatchEvent(new window.Event('scroll')))
    await tick(0)
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Workspace context')
    expect(focus).toBe(control)
    expect(navigated).toEqual([])
  })

  it('shows only the pane it is given, so a tab change swaps the rail and its sections', async () => {
    await render()
    expect(document.querySelector('[data-settings-section="modelos-router"]')).toBeNull()
    page = 'modelos'
    await render()
    const models = settingsStructure(access).filter(section => section.visible && section.page === 'modelos')
    expect([...document.querySelectorAll('nav a')].map(link => link.textContent)).toEqual(models.map(section => section.label))
    expect(document.querySelector('[data-settings-section="modelos-router"]')).not.toBeNull()
    expect(document.querySelector('[data-settings-section="geral-appearance"]')).toBeNull()
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Agent models')
  })

  it('lands on a remembered section of its own pane, and on the first one for a destination elsewhere', async () => {
    page = 'integracoes'
    requested = 'integracoes'
    await render()
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Phone and Telegram')
    expect(focus?.id).toBe('settings-integracoes-phone')
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    access = { admin: false, owner: false, team: true, servers: false }
    page = 'geral'
    requested = 'modelos-router'
    await render()
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Appearance')
    expect(document.querySelector('[data-settings-section="geral-voice"]')).toBeNull()
    expect(document.querySelector('[data-settings-section="modelos-router"]')).toBeNull()
  })

  it('preserves normal modified-link behavior and cancels pending frames on unmount', async () => {
    await render()
    const event = await click('a[href="#settings-geral-notifications"]', 1, { ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(navigated).toEqual([])
    await click('a[href="#settings-geral-notifications"]')
    expect(frames.size).toBeGreaterThan(0)
    await act(async () => root.unmount())
    expect(frames.size).toBe(0)
  })
})
