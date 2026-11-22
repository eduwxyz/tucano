// The extensions' card in Settings › Agents: five rows, one switch each, so the person can carry an ad
// blocker without the two consent removers — or take one away without the others. The rows read their
// state from the settings snapshot, which the core fills while each download is in flight. Under them,
// one row for how that browser behaves (Additional accessibility), which is a switch and not an extension.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import { ADD_ONS } from '../src/shared/addons'
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
// The five extension rows, apart from the behaviour switch that sits under them.
const extensionRows = (): HTMLElement[] => rows().filter((row) => ADD_ONS.some((e) => (row.textContent ?? '').includes(e.name)))
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
    expect(extensionRows().map((r) => r.querySelector('strong')?.textContent)).toEqual([
      'uBlock Origin Lite',
      "I still don't care about cookies",
      'Consent-O-Matic',
      'PopUpOFF',
      'Unclutter',
      'Defuddle Clip'
    ])
    expect(rowOf('uBlock Origin Lite').textContent).toContain('Takes the ads off the page')
    expect(rowOf("I still don't care about cookies").textContent).toContain('Closes the cookie notice by itself')
    expect(rowOf('Consent-O-Matic').textContent).toContain('Answers the consent dialog')
    expect(rowOf('PopUpOFF').textContent).toContain('Clears what sits on top of the page')
    // The one that restyles pages says so where it is chosen, not after someone wonders why a page changed.
    expect(rowOf('Unclutter').textContent).toContain('a screenshot stops being the site’s')
    // The one that hands over the article says what an agent gets, not what the extension is called.
    expect(rowOf('Defuddle Clip').textContent).toContain('Pulls the article out of the page as clean text')
    for (const row of extensionRows()) expect(row.querySelector('button.toggle')?.getAttribute('aria-checked')).toBe('false')
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

  it('reads an older build’s single switch as the three it meant, and leaves the two new ones off', async () => {
    // What 0.2.44 saved when the three arrived on one switch: Unclutter and PopUpOFF did not exist yet, and
    // one of them changes how a page looks, so it is never turned on by a value from an older build.
    settings = { ...base, browserAddOns: true as unknown as Settings['browserAddOns'] }
    await render()
    const on = extensionRows().map((row) => [row.querySelector('strong')?.textContent, row.querySelector('button.toggle')?.getAttribute('aria-checked')])
    expect(on).toEqual([
      ['uBlock Origin Lite', 'true'],
      ["I still don't care about cookies", 'true'],
      ['Consent-O-Matic', 'true'],
      ['PopUpOFF', 'false'],
      ['Unclutter', 'false'],
      ['Defuddle Clip', 'false']
    ])
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

  it('says when one arrived as its vendor ships it, because the store moved the line it sets up', async () => {
    // The core edits each extension after unpacking it (shared/addons.ts): a build that moved the line is
    // left alone, and its row carries the reason rather than pretending it is set up.
    settings = {
      ...base,
      browserAddOns: { ads: true },
      addOns: { browser: { state: 'ready' }, extensions: { ads: { state: 'ready', note: 'Left as the store ships it: the line in js/mode-manager.js has moved (0 matches).' } } }
    }
    await render()
    expect(rowOf('uBlock Origin Lite').textContent).toContain('the line in js/mode-manager.js has moved')
    expect(rowOf('uBlock Origin Lite').querySelector('.field__error')).toBeNull()
  })

  it('tells the shared browser apart from the switches: its download and its failure sit above them', async () => {
    settings = { ...base, browserAddOns: { ads: true }, addOns: { browser: { state: 'preparing', progress: { received: 50, total: 200 } }, extensions: { ads: { state: 'preparing' } } } }
    await render()
    expect(document.body.textContent).toContain('Downloading Chrome for Testing · 25%')
    expect(rowOf('uBlock Origin Lite').textContent).toContain('Downloading — it joins the next session’s browser.')

    settings = { ...base, browserAddOns: { ads: true }, addOns: { browser: { state: 'failed', error: 'The Chrome for Testing list answered 500.' }, extensions: { ads: { state: 'ready' } } } }
    await render()
    expect(document.body.textContent).toContain('Chrome for Testing isn’t available: The Chrome for Testing list answered 500.')
    expect(rowOf('uBlock Origin Lite').textContent).not.toContain('didn’t download')
  })

  it('draws how that browser behaves as one row of its own, under the extensions', async () => {
    await render()
    const row = rowOf('Additional accessibility')
    // Last, not among them: it is not an extension and nothing downloads for it.
    expect(rows()[rows().length - 1]).toBe(row)
    expect(row.textContent).toContain('Pages ask for less motion')
    expect(row.textContent).toContain('no video starts on its own')
    expect(row.querySelector('button.toggle')?.getAttribute('aria-checked')).toBe('false')
    await click(row.querySelector('button.toggle') as Element)
    expect(updateSettings).toHaveBeenCalledWith({ browserAccessibility: true })

    settings = { ...base, browserAccessibility: true }
    await render()
    expect(rowOf('Additional accessibility').querySelector('button.toggle')?.getAttribute('aria-checked')).toBe('true')
  })
})
