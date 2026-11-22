// The extensions' card in Settings › Agents: three rows, one switch each, so the person can carry an ad
// blocker without the two consent removers — or take one away without the other two. The rows read their
// state from the settings snapshot, which the core fills while each download is in flight.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Settings } from '../src/shared/types'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let settings: Settings
const updateSettings = vi.fn()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: { settings: Settings }) => T): T => select({ settings }), updateSettings: (patch: Partial<Settings>) => updateSettings(patch) }
})
const { createRoot } = await import('react-dom/client')
const { AgentAddOns } = await import('../src/renderer/src/components/AgentAddOns')

const base = { language: 'en' } as Settings
let root: Root

beforeEach(() => {
  setLang('en')
  settings = { ...base }
  updateSettings.mockClear()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

const rows = (): HTMLElement[] => [...document.querySelectorAll('.key-row')] as HTMLElement[]
const rowOf = (name: string): HTMLElement => {
  const found = rows().find((row) => (row.textContent ?? '').includes(name))
  if (!found) throw new Error(`no row for ${name}: ${rows().map((r) => r.textContent).join(' | ')}`)
  return found
}
const toggleOf = (name: string): HTMLButtonElement => rowOf(name).querySelector('button.toggle') as HTMLButtonElement
const render = async (): Promise<void> => {
  await act(async () => root.render(<AgentAddOns />))
}
const click = async (el: Element): Promise<void> => {
  await act(async () => void el.dispatchEvent(new window.Event('click', { bubbles: true })))
  await act(async () => new Promise((r) => setTimeout(r, 5)))
}

describe('the extensions an agent’s browser can carry', () => {
  it('draws one row for each, with what it fixes and its own switch off', async () => {
    await render()
    expect(rows().map((r) => r.querySelector('strong')?.textContent)).toEqual(['uBlock Origin Lite', "I still don't care about cookies", 'Consent-O-Matic'])
    expect(rowOf('uBlock Origin Lite').textContent).toContain('Takes the ads off the page')
    expect(rowOf("I still don't care about cookies").textContent).toContain('Closes the cookie notice by itself')
    expect(rowOf('Consent-O-Matic').textContent).toContain('Answers the consent dialog')
    for (const row of rows()) expect(row.querySelector('button.toggle')?.getAttribute('aria-checked')).toBe('false')
    // Nothing is downloading, so nothing says it is.
    expect(document.body.textContent).not.toContain('Downloading')
  })

  it('turns one on without touching the others, and sends the whole set', async () => {
    settings = { ...base, browserAddOns: { ads: true } }
    await render()
    expect(toggleOf('uBlock Origin Lite').getAttribute('aria-checked')).toBe('true')
    expect(toggleOf('Consent-O-Matic').getAttribute('aria-checked')).toBe('false')
    await click(toggleOf('Consent-O-Matic'))
    expect(updateSettings).toHaveBeenCalledWith({ browserAddOns: { ads: true, consent: true } })
    // The store saves what was sent and hands the rows the new snapshot, which is what a click sees next.
    settings = { ...base, browserAddOns: { ads: true, consent: true } }
    await render()
    await click(toggleOf('uBlock Origin Lite'))
    expect(updateSettings).toHaveBeenLastCalledWith({ browserAddOns: { ads: false, consent: true } })
  })

  it('reads an older build’s single switch as all three', async () => {
    // What 0.2.44 saved when the three arrived on one switch.
    settings = { ...base, browserAddOns: true as unknown as Settings['browserAddOns'] }
    await render()
    for (const row of rows()) expect(row.querySelector('button.toggle')?.getAttribute('aria-checked')).toBe('true')
  })

  it('says which one failed, under that row only', async () => {
    settings = {
      ...base,
      browserAddOns: { ads: true, cookies: true },
      addOns: { browser: { state: 'ready' }, extensions: { ads: { state: 'ready' }, cookies: { state: 'failed', error: 'The Chrome Web Store answered 404 for I still don’t care about cookies.' } } }
    }
    await render()
    expect(rowOf("I still don't care about cookies").querySelector('.field__error')?.textContent).toContain('404')
    expect(rowOf('uBlock Origin Lite').querySelector('.field__error')).toBeNull()
  })

  it('tells the shared browser apart from the three switches: its download and its failure sit above them', async () => {
    settings = { ...base, browserAddOns: { ads: true }, addOns: { browser: { state: 'preparing', progress: { received: 50, total: 200 } }, extensions: { ads: { state: 'preparing' } } } }
    await render()
    expect(document.body.textContent).toContain('Downloading Chrome for Testing · 25%')
    expect(rowOf('uBlock Origin Lite').textContent).toContain('Downloading — it joins the next session’s browser.')

    settings = { ...base, browserAddOns: { ads: true }, addOns: { browser: { state: 'failed', error: 'The Chrome for Testing list answered 500.' }, extensions: { ads: { state: 'ready' } } } }
    await render()
    expect(document.body.textContent).toContain('Chrome for Testing didn’t download: The Chrome for Testing list answered 500.')
    expect(rowOf('uBlock Origin Lite').textContent).not.toContain('didn’t download')
  })
})
