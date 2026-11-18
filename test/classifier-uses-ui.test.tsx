// Settings › Models: the recommended-option switch is one of the classifier uses, in the Classifier
// Uses card, not a card of its own — and it still writes `jevRecommend`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JEV_CLASSIFIER } from '../src/shared/classifiers'
import { setLang } from '../src/shared/lang'
import type { Settings } from '../src/shared/types'
import { ENGINE_IDS } from '../src/shared/types'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

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

const engines = (): Settings['engines'] =>
  Object.fromEntries(ENGINE_IDS.map((id) => [id, { installed: true, loggedIn: true }])) as unknown as Settings['engines']

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
const switchOf = (label: string): Element | undefined => [...document.querySelectorAll('[role="switch"]')].find((el) => (el.getAttribute('aria-label') ?? '') === label)

describe('the recommended option, as a classifier use', () => {
  it('is a switch in Classifier Uses, with its explanation', () => {
    expect(text()).toContain('Mark the recommended option')
    expect(text()).toContain('It is only a suggestion: you still choose')
    const toggle = switchOf('Mark the recommended option')
    expect(toggle).toBeDefined()
    expect(toggle!.getAttribute('aria-checked')).toBe('false')
    expect(document.querySelectorAll('[role="switch"]').length).toBe(1)
  })

  it('writes the jevRecommend setting when it is switched on', async () => {
    const toggle = switchOf('Mark the recommended option')!
    await act(async () => {
      toggle.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(save).toHaveBeenCalledWith({ jevRecommend: true })
  })

  it('offers the TypeSafe key, and says what it sends, once it is on', async () => {
    expect(text()).not.toContain('Without the key')
    await act(async () => root.render(<div />))
    settings = { ...settings, jevRecommend: true }
    await act(async () => root.render(<ClassifierUsesCard />))
    expect(text()).toContain('Without the key, the pill never shows')
    expect(text()).toContain('TypeSafe key')
  })
})

describe('the settings page', () => {
  const pages = readFileSync(join(__dirname, '../src/renderer/src/components/Pages.tsx'), 'utf8')

  it('has no card of its own for Jev as a classifier', () => {
    expect(pages).not.toContain('Jev as a classifier')
    expect(pages).not.toContain('Jev como classificador')
  })

  it('renders the switch inside the Classifier Uses card', () => {
    const at = pages.indexOf('section="models-classifier-uses"')
    expect(at).toBeGreaterThan(-1)
    const card = pages.slice(at, pages.indexOf('</Card>', at))
    expect(card).toContain('<ClassifierUsesCard />')
    expect(pages).toContain("updateSettings({ jevRecommend: v })")
  })
})
