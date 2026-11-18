// Settings › Models: the recommended option is one of the classifier uses, a dropdown like the rest
// in the Classifier Uses card, and it writes `classifierJobs.recommend`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLASSIFIER_JOBS, JEV_CLASSIFIER } from '../src/shared/classifiers'
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

describe('the recommended option, as a classifier use', () => {
  it('is a dropdown in Classifier Uses, last of the uses, and no longer a switch', () => {
    expect(text()).toContain('Mark the recommended option')
    const trigger = selectOf('Mark the recommended option')
    expect(trigger).toBeDefined()
    expect(trigger!.textContent).toContain('Off')
    expect(document.querySelectorAll('[role="switch"]').length).toBe(0)
    // The last selector in the card is this one.
    const triggers = [...document.querySelectorAll('[role="combobox"]')]
    expect(triggers.length).toBe(CLASSIFIER_JOBS.length)
    expect(triggers[triggers.length - 1]).toBe(trigger)
    expect(CLASSIFIER_JOBS[CLASSIFIER_JOBS.length - 1]).toBe('recommend')
  })

  it('offers Off and the classifiers in the list, like the other uses', async () => {
    await act(async () => {
      selectOf('Mark the recommended option')!.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(options().map((o) => o.querySelector('.select__label')?.textContent)).toEqual(['Off', 'Jev · TypeSafe'])
  })

  it('keeps its hint to one line', () => {
    expect(text()).toContain('Suggests an option on an agent question; you still choose.')
    expect(text()).not.toContain('Off by default')
    expect(text()).not.toContain('"Something else" is never suggested')
  })

  it('writes the recommend job, and only that job, when a classifier is chosen', async () => {
    await act(async () => {
      selectOf('Mark the recommended option')!.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    const jev = options().find((o) => o.querySelector('.select__label')?.textContent?.startsWith('Jev'))!
    await act(async () => {
      jev.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(save).toHaveBeenCalledWith({ classifierJobs: { recommend: 'jev' } })
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ jevRecommend: expect.anything() }))
  })

  it('has no key field of its own: the Classifiers card keeps the keys', () => {
    expect(text()).not.toContain('TypeSafe key')
    expect(text()).not.toContain('Without the key')
    expect(document.body.innerHTML).not.toContain('key-row')
  })

  it('names what it sends once it is assigned', async () => {
    expect(text()).not.toContain('Outside the gateway')
    await act(async () => root.render(<div />))
    settings = { ...settings, classifierJobs: { recommend: 'jev' }, engines: engines('gateway') }
    await act(async () => root.render(<ClassifierUsesCard />))
    expect(text()).toContain('Outside the gateway')
    expect(text()).toContain("the question's text and options go to TypeSafe to suggest one of them")
  })
})

describe('the settings page', () => {
  const pages = readFileSync(join(__dirname, '../src/renderer/src/components/Pages.tsx'), 'utf8')

  it('has no card of its own for Jev as a classifier', () => {
    expect(pages).not.toContain('Jev as a classifier')
    expect(pages).not.toContain('Jev como classificador')
  })

  it('renders the use inside the Classifier Uses card, through the same loop as the others', () => {
    const at = pages.indexOf('section="models-classifier-uses"')
    expect(at).toBeGreaterThan(-1)
    const card = pages.slice(at, pages.indexOf('</Card>', at))
    expect(card).toContain('<ClassifierUsesCard />')
    const body = pages.slice(pages.indexOf('export function ClassifierUsesCard'), pages.indexOf('export function BrowserClickCard'))
    expect(body).toContain('CLASSIFIER_JOBS.map((job) =>')
    expect(body).toContain("job === 'recommend'")
    expect(body).not.toContain('jevRecommend')
    expect(body).not.toContain('<Toggle')
    expect(body).not.toContain('<JevKey')
  })
})
