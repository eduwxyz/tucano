// Settings › Models: the Classifier Uses card has one selector per job, and each writes its own
// entry in `classifierJobs`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLASSIFIER_JOBS, JEV_CLASSIFIER, type ClassifierConfig } from '../src/shared/classifiers'
import { setLang } from '../src/shared/lang'
import type { Settings } from '../src/shared/types'
import { ENGINE_IDS } from '../src/shared/types'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
// What linkedom doesn't lay out: a size for the trigger, frames and resizes that do nothing.
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

const luna: ClassifierConfig = { id: 'luna-01', name: 'Luna', provider: 'openai', model: 'gpt-6-luna' }
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

const engines = (route?: 'gateway'): Settings['engines'] =>
  Object.fromEntries(ENGINE_IDS.map((id) => [id, { installed: true, loggedIn: true, ...(route ? { route } : {}) }])) as unknown as Settings['engines']

const { createRoot } = await import('react-dom/client')
const { ClassifierUsesCard } = await import('../src/renderer/src/components/Pages')
let root: ReturnType<typeof createRoot>

beforeEach(async () => {
  setLang('en')
  settings = { classifiers: [JEV_CLASSIFIER], classifierJobs: {}, engines: engines(), language: 'en' }
  save.mockClear()
  root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<ClassifierUsesCard />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  settings = {}
})

const text = (): string => document.body.textContent ?? ''
// The one selector whose Field label is `label`: the card draws one per job, in CLASSIFIER_JOBS order.
const selectOf = (label: string): Element | undefined =>
  [...document.querySelectorAll('label.field')].find((el) => el.querySelector('.field__label')?.textContent === label)?.querySelector('[role="combobox"]') ?? undefined
const options = (): Element[] => [...document.querySelectorAll('[role="option"]')]

describe('the classifier uses', () => {
  it('offers the two jobs, in order, and nothing else', () => {
    expect(CLASSIFIER_JOBS).toEqual(['routing', 'browser'])
    expect([...document.querySelectorAll('label.field .field__label')].map((el) => el.textContent)).toEqual(['Who replies in a channel', 'What an agent clicks in a page'])
    expect(document.querySelectorAll('[role="switch"]').length).toBe(0)
  })

  it('offers Off and the classifiers in the list', async () => {
    await act(async () => {
      selectOf('Who replies in a channel')!.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(options().map((o) => o.querySelector('.select__label')?.textContent)).toEqual(['Off', 'Jev · TypeSafe'])
  })

  it('writes that job, and only that job, when a classifier is chosen', async () => {
    await act(async () => {
      selectOf('What an agent clicks in a page')!.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    const jev = options().find((o) => o.querySelector('.select__label')?.textContent?.startsWith('Jev'))!
    await act(async () => {
      jev.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(save).toHaveBeenCalledWith({ classifierJobs: { browser: 'jev' } })
  })

  it('has no key field of its own: the Classifiers card keeps the keys', () => {
    expect(text()).not.toContain('TypeSafe key')
    expect(document.body.innerHTML).not.toContain('key-row')
  })

  it('says what a chosen job sends, without a gateway too, and when its key is missing', async () => {
    expect(text()).not.toContain('recent messages')
    await act(async () => root.render(<div />))
    settings = { ...settings, classifiers: [luna], classifierJobs: { routing: 'luna-01' }, classifierKeys: {} }
    await act(async () => root.render(<ClassifierUsesCard />))
    expect(text()).toContain('Every message without an @mention sends the channel’s recent messages to OpenAI')
    expect(text()).not.toContain('Outside the gateway')
    expect(text()).toContain('Luna has no key yet')
    await act(async () => root.render(<div />))
    settings = { ...settings, classifierKeys: { 'luna-01': true }, engines: engines('gateway') }
    await act(async () => root.render(<ClassifierUsesCard />))
    expect(text()).toContain('Outside the gateway')
    expect(text()).not.toContain('has no key yet')
  })
})

describe('the settings page', () => {
  const pages = readFileSync(join(__dirname, '../src/renderer/src/components/Pages.tsx'), 'utf8')

  it('renders the uses inside the Classifiers subject, through one loop', () => {
    const at = pages.indexOf('<SectionAnchor id="models-classifiers"')
    expect(at).toBeGreaterThan(-1)
    expect(pages.slice(at, pages.indexOf('</SectionAnchor>', at))).toContain('<ClassifierUsesCard />')
    const body = pages.slice(pages.indexOf('export function ClassifierUsesCard'), pages.indexOf('export function BrowserClickCard'))
    expect(body).toContain('CLASSIFIER_JOBS.map((job) =>')
    expect(body).not.toContain('<Toggle')
    expect(body).not.toContain('<JevKey')
  })
})
