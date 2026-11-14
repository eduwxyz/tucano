import { parseHTML } from 'linkedom'
import { act, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Root } from 'react-dom/client'
import { setLang } from '../src/shared/lang'
import { SettingsLayout } from '../src/renderer/src/components/SettingsLayout'
import { settingsStructure, type SettingsAccess, type SettingsSectionId } from '../src/renderer/src/settings-structure'

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
  const height = element.classList.contains('settings-navigation') ? 88 : index >= 0 ? 500 : 500
  return { top, bottom: top + height, left: 0, right: 720, width: 720, height, x: 0, y: top, toJSON: () => ({}) }
}
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 500 } })
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 5000 } })
const { createRoot } = await import('react-dom/client')
let root: Root
let access: SettingsAccess
let requested: string
const navigated: string[] = []
function Harness(): ReactNode {
  const [route, setRoute] = useState(requested)
  const sections = settingsStructure(access)
  const content = Object.fromEntries(sections.map(section => [section.id,
    <div className="card"><h2>{section.id}</h2><button>{`Control ${section.id}`}</button></div>
  ])) as Record<SettingsSectionId, ReactNode>
  return <div className="page__scroll"><SettingsLayout requested={route} sections={sections} content={content} onNavigate={id => { navigated.push(id); setRoute(id) }} /></div>
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
  requested = 'app'
  reduced = false
  frames.clear()
  navigated.length = 0
  focus = null
})
afterEach(async () => { await act(async () => root.unmount()); frames.clear() })

describe('settings section navigation', () => {
  it('keeps sections together with links, and uses tabs only for different page panels', async () => {
    await render()
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1)
    expect(document.querySelectorAll('nav a')).toHaveLength(6)
    expect(document.querySelectorAll('[data-settings-section]')).toHaveLength(6)
    expect(document.querySelector('[role="tabpanel"]:not([hidden])')?.id).toBe('settings-panel-app')
    expect(document.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
  })

  it('animates pointer navigation with ease-in-out and focuses the target without a second scroll', async () => {
    await render()
    await click('a[href="#settings-app-notifications"]')
    expect(navigated).toEqual(['app-notifications'])
    expect(focus?.id).toBe('settings-app-notifications')
    await tick(0)
    expect(scroller().scrollTop).toBe(0)
    await tick(140)
    expect(scroller().scrollTop).toBeCloseTo(608)
    await tick(280)
    expect(scroller().scrollTop).toBeCloseTo(1216)
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Notifications')
  })

  it('moves immediately for keyboard activation and for reduced motion', async () => {
    await render()
    await click('a[href="#settings-app-notifications"]', 0)
    expect(scroller().scrollTop).toBeCloseTo(1216)
    expect(frames.size).toBe(0)
    reduced = true
    await click('a[href="#settings-app-dictation"]')
    expect(scroller().scrollTop).toBeCloseTo(1816)
    expect(frames.size).toBe(0)
  })

  it('cancels an old animation on another selection or wheel input', async () => {
    await render()
    await click('a[href="#settings-app-notifications"]')
    await tick(0)
    await tick(140)
    await click('a[href="#settings-app-dictation"]')
    await tick(200)
    await tick(480)
    expect(scroller().scrollTop).toBeCloseTo(1816)
    await click('a[href="#settings-app-appearance"]')
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
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Conversation')
    expect(focus).toBe(control)
    expect(navigated).toEqual([])
  })

  it('supports main-tab arrows, Home and End while preserving focus on the tab', async () => {
    await render()
    const press = async (key: string): Promise<void> => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'key', { value: key })
      await act(async () => document.querySelector('[role="tab"][aria-selected="true"]')!.dispatchEvent(event))
    }
    await press('ArrowRight')
    expect(focus?.id).toBe('settings-tab-workspace')
    expect(document.querySelector('[role="tabpanel"]:not([hidden])')?.id).toBe('settings-panel-workspace')
    await press('End')
    expect(focus?.id).toBe('settings-tab-connections')
    await press('Home')
    expect(focus?.id).toBe('settings-tab-app')
  })

  it('maps legacy destinations to available sections and rejects inaccessible remembered pages', async () => {
    requested = 'integracoes'
    await render()
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Connections')
    expect(document.querySelector('[aria-current="location"]')?.textContent).toBe('Phone and Telegram')
    expect(focus?.id).toBe('settings-connections-phone')
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    access = { admin: false, owner: false, team: true, servers: false }
    requested = 'models-routing'
    await render()
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('App')
    expect([...document.querySelectorAll('[role="tab"]')].map(el => el.textContent)).toEqual(['App', 'Workspace'])
    expect(document.querySelector('[data-settings-section="app-dictation"]')).toBeNull()
  })

  it('preserves normal modified-link behavior and cancels pending frames on unmount', async () => {
    await render()
    const event = await click('a[href="#settings-app-notifications"]', 1, { ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(navigated).toEqual([])
    await click('a[href="#settings-app-notifications"]')
    expect(frames.size).toBeGreaterThan(0)
    await act(async () => root.unmount())
    expect(frames.size).toBe(0)
  })
})
