// Settings › Agents: the browser card chooses who finds the element an agent asked to click — the
// page's text or a classifier. It writes the same `classifierJobs.browser` Classifier Uses shows,
// and it offers TypeSafe's Jev on an install with no classifier rows, because a fresh install has
// none to pick from.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JEV_CLASSIFIER, type ClassifierConfig } from '../src/shared/classifiers'
import { setLang } from '../src/shared/lang'
import type { Settings } from '../src/shared/types'
import { ENGINE_IDS } from '../src/shared/types'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
// What linkedom doesn't lay out: a size for the window and the trigger, frames and resizes that do nothing.
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })
window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 136, left: 100, right: 300, width: 200, height: 36, x: 100, y: 100, toJSON: () => ({}) })
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe(): void {}
    disconnect(): void {}
  }
})

let settings: Partial<Settings>
const save = vi.fn(async (_patch: Partial<Settings>) => {})
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: (select: (s: { settings: Partial<Settings> }) => unknown) => select({ settings }),
    updateSettings: save,
    setJevKey: async () => {}
  }
})

const luna: ClassifierConfig = { id: 'luna-01', name: 'Luna', provider: 'openai', model: 'gpt-6-luna' }
// Every harness ready; `gateway` decides whether the card says what leaves the gateway.
const engines = (gateway = false): Settings['engines'] =>
  Object.fromEntries(ENGINE_IDS.map((id) => [id, { installed: true, loggedIn: true, ...(gateway ? { route: 'gateway' } : {}) }])) as unknown as Settings['engines']

const { createRoot } = await import('react-dom/client')
const { BrowserClickCard } = await import('../src/renderer/src/components/Pages')
let root: Root

const render = async (): Promise<void> => {
  await act(async () => root.render(<BrowserClickCard />))
}
beforeEach(async () => {
  setLang('en')
  document.getElementById('root')!.innerHTML = ''
  settings = { classifiers: [JEV_CLASSIFIER], classifierJobs: {}, engines: engines(), language: 'en' }
  save.mockClear()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  settings = {}
})

const text = (): string => document.body.textContent ?? ''
const trigger = (): HTMLElement => document.querySelector<HTMLElement>('.select__trigger')!
const shown = (): string => trigger().querySelector('.select__value, .select__placeholder')?.textContent ?? ''
const options = (): string[] => [...document.querySelectorAll('[role="option"]')].map((o) => o.querySelector('.select__label')?.textContent ?? o.textContent ?? '')
const open = async (): Promise<void> => {
  if (trigger().getAttribute('aria-expanded') !== 'true') await act(async () => trigger().click())
}
const choose = async (label: string): Promise<void> => {
  await open()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => (o.querySelector('.select__label')?.textContent ?? '') === label)
  expect(option, label).toBeDefined()
  await act(async () => option!.dispatchEvent(new window.Event('click', { bubbles: true })))
}

describe('who finds the click, on the Agents’ browser card', () => {
  it('offers the page’s text and Jev when the install has no classifier rows', async () => {
    settings = { engines: engines(), language: 'en' }
    await render()
    expect(shown()).toBe('Only by the page’s text')
    await open()
    expect(options()).toEqual(['Only by the page’s text', 'Jev (TypeSafe)'])
  })

  it('writes a Jev row and the browser job when Jev is chosen on a fresh install', async () => {
    settings = { engines: engines(), language: 'en' }
    await render()
    await choose('Jev (TypeSafe)')
    // The job may only point at a row the list holds: the row is written with it.
    expect(save).toHaveBeenCalledWith({ classifiers: [JEV_CLASSIFIER], classifierJobs: { browser: 'jev' } })
  })

  it('clears the browser job when the page’s text is chosen back', async () => {
    settings = { classifiers: [JEV_CLASSIFIER], classifierJobs: { browser: 'jev' }, engines: engines(), language: 'en' }
    await render()
    expect(shown()).toBe('Jev (TypeSafe)')
    await choose('Only by the page’s text')
    expect(save).toHaveBeenCalledWith({ classifierJobs: {} })
  })

  it('shows a configured classifier as an option, and picks it without touching the list', async () => {
    settings = { classifiers: [JEV_CLASSIFIER, luna], classifierJobs: {}, engines: engines(), language: 'en' }
    await render()
    await open()
    expect(options()).toEqual(['Only by the page’s text', 'Jev (TypeSafe)', 'Luna · OpenAI'])
    await choose('Luna · OpenAI')
    expect(save).toHaveBeenCalledWith({ classifierJobs: { browser: 'luna-01' } })
  })

  it('says what leaves the gateway only while a classifier is chosen', async () => {
    settings = { classifiers: [JEV_CLASSIFIER], classifierJobs: {}, engines: engines(true), language: 'en' }
    await render()
    expect(text()).not.toContain('Outside the gateway')
    await act(async () => root.render(<div />))
    settings = { ...settings, classifierJobs: { browser: 'jev' } }
    await render()
    expect(text()).toContain('Outside the gateway')
    expect(text()).toContain('goes to TypeSafe')
  })

  it('shows the choice it inherited from the old browserJev switch', async () => {
    settings = { browserJev: true, engines: engines(), language: 'en' }
    await render()
    expect(shown()).toBe('Jev (TypeSafe)')
  })
})

describe('the settings page', () => {
  const pages = readFileSync(join(__dirname, '../src/renderer/src/components/Pages.tsx'), 'utf8')

  it('renders the card in the Agents pane, with no hint sending the choice elsewhere alone', () => {
    expect(pages).toContain("{pane('agentes') && <BrowserClickCard />}")
    const card = pages.slice(pages.indexOf('export function BrowserClickCard'), pages.indexOf('function VoiceCard'))
    expect(card).toContain('updateSettings({ classifierJobs: next })')
    expect(card).toContain('browser: id')
    expect(card).not.toContain('is chosen in Classifiers')
  })

  it('keeps Classifier Uses off the same job, so the two surfaces stay one choice', () => {
    expect(pages).toContain('<ClassifierUsesCard />')
    const uses = pages.slice(pages.indexOf('export function ClassifierUsesCard'), pages.indexOf('export function BrowserClickCard'))
    expect(uses).toContain('CLASSIFIER_JOBS.map((job) => (')
    expect(uses).toContain('updateSettings({ classifierJobs: next })')
  })
})
