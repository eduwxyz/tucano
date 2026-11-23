// The jump row under the settings groups: it names the subjects of the open group in the order they
// read, takes the page to one over an interruptible 280 ms ease-in-out, and moves at once for a
// keyboard activation or a reduced-motion preference. A subject the page did not draw gets no link,
// so the row never offers a dead anchor. The search's answer opens a group at a subject.
import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Root } from 'react-dom/client'
import { setLang } from '../src/shared/lang'
import { SettingsJumps, SettingsResults } from '../src/renderer/src/components/SettingsLayout'
import { inStrip, searchSettings, settingsGroups, settingsStructure } from '../src/renderer/src/settings-structure'

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
// The groups bar measures 40 px; every subject stands 600 px below the one above it. The scroller is
// 500 px tall over 5000 px of content.
const CARD_TOP = 120
const CARD_STRIDE = 600
const ROW = 40
const INSET = ROW + 16
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

const access = { admin: true, owner: true, team: false, servers: false, extensions: true }
const ALL = settingsStructure(access)
const SECTIONS = ALL.filter(section => section.visible)
let root: Root
let skipped: string | null = null

function Harness(): ReactNode {
  return (
    <div className="page__scroll">
      <div className="settings-groups" />
      <SettingsJumps sections={SECTIONS} />
      {SECTIONS.filter(section => section.id !== skipped).map(section => (
        <div key={section.id} className="card" id={`settings-${section.id}`} data-settings-section={section.id} tabIndex={-1} />
      ))}
    </div>
  )
}
const render = async (node: ReactNode = <Harness />): Promise<void> => {
  await act(async () => root.render(node))
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
const scroller = (): HTMLElement => document.querySelector('.page__scroll')!
const links = (): HTMLAnchorElement[] => [...document.querySelectorAll<HTMLAnchorElement>('.settings-jumps a')]
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

describe('settings jump row', () => {
  it('names the subjects in the order they read, as links and not tabs', async () => {
    await render()
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(0)
    // Every subject the page draws, minus the ones the structure keeps out of the row on purpose.
    expect(links()).toHaveLength(SECTIONS.filter(inStrip).length)
    expect(links().map(link => link.textContent)).toEqual(SECTIONS.filter(inStrip).map(section => section.label))
  })

  it('leaves out a subject that reads inside the one above it, and still draws its card', async () => {
    // The extensions are a card of their own under Browser, with no link of its own in the row
    // (Apo, 22 Nov 2026): the subject above already says where you are.
    const quiet = SECTIONS.filter(section => !inStrip(section))
    expect(quiet.map(section => section.id)).toEqual(['agents-addons'])
    await render()
    expect(links().map(link => link.textContent)).not.toContain('Ads and consent notices')
    expect(document.querySelector('[data-settings-section="agents-addons"]')).not.toBeNull()
  })

  it('drops a subject the page did not draw', async () => {
    skipped = SECTIONS[1]!.id
    await render()
    expect(links()).toHaveLength(SECTIONS.filter(inStrip).length - 1)
    expect(links().map(link => link.getAttribute('href'))).not.toContain(`#settings-${SECTIONS[1]!.id}`)
  })

  it('animates a pointer selection with ease-in-out, parks the subject under the groups and focuses it without a second scroll', async () => {
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
    expect(frames.size).toBe(0)
  })

  it('moves immediately for a keyboard activation, and for a reduced-motion preference', async () => {
    await render()
    await click(`a[href="#settings-${SECTIONS[2]!.id}"]`, 0)
    expect(scroller().scrollTop).toBeCloseTo(reached(2), 0)
    expect(frames.size).toBe(0)
    reduced = true
    await click(`a[href="#settings-${SECTIONS[4]!.id}"]`)
    expect(scroller().scrollTop).toBeCloseTo(reached(4), 0)
    expect(frames.size).toBe(0)
  })

  it('cancels a running glide when another subject is chosen, and on wheel input', async () => {
    await render()
    await click(`a[href="#settings-${SECTIONS[4]!.id}"]`)
    await tick(0)
    await tick(140)
    expect(scroller().scrollTop).toBeGreaterThan(0)
    // A second selection replaces the first: the page never reaches the abandoned target.
    await click(`a[href="#settings-${SECTIONS[2]!.id}"]`)
    await tick(200)
    await tick(340)
    expect(scroller().scrollTop).toBeLessThan(reached(4))
    await tick(480)
    expect(scroller().scrollTop).toBeCloseTo(reached(2), 0)
    // Wheel input stops a glide where it is, without jumping to its target.
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
})

describe('settings search and groups', () => {
  it('finds a control by what a person calls it, ignoring accents and case, and names where it is', async () => {
    setLang('pt')
    const pt = settingsStructure(access)
    const hits = searchSettings(pt, 'HORARIO de silencio')
    expect(hits.map(hit => [hit.term, hit.section.id])).toEqual([['Horário de silêncio', 'agents-routines']])
    let picked: string | null = null
    await render(<SettingsResults hits={hits} query="horario de silencio" onPick={section => { picked = section.id }} />)
    const row = document.querySelector<HTMLButtonElement>('.settings-results__row')!
    expect(row.textContent).toContain('Agentes › Rotinas')
    await act(async () => row.click())
    expect(picked).toBe('agents-routines')
  })

  it('finds a subject by its name first, at most three places per subject, and says so when nothing matches', async () => {
    const hits = searchSettings(settingsStructure(access), 'limit')
    expect(hits[0]).toMatchObject({ term: 'Limits', section: { id: 'agents-limits' } })
    expect(hits.filter(hit => hit.section.id === 'agents-limits').length).toBeLessThanOrEqual(3)
    await render(<SettingsResults hits={[]} query="zzz" onPick={() => {}} />)
    expect(document.querySelector('.settings-results__none')?.textContent).toContain('No results for “zzz”')
  })

  it('searches only what this person sees, and shows only the groups they have something in', () => {
    const member = settingsStructure({ admin: false, owner: false, team: true, servers: true })
    expect(searchSettings(member, 'autonomy')).toEqual([])
    expect(searchSettings(member, 'sounds').map(hit => hit.section.id)).toEqual(['app-notifications'])
    expect(settingsGroups(member)).toEqual(['geral', 'conexoes', 'workspace'])
    expect(settingsGroups(ALL)).toEqual(['geral', 'agentes', 'modelos', 'conexoes', 'workspace'])
  })
})
