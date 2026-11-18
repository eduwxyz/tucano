// The agent replies card, back on the Agents pane: the 0.2.36 send mode with its four ways, and the
// number of replies the agents may pass between themselves. The card is anchored where the settings
// rail expects it (`agents-replies`), the four modes each save, and the number stays within the cap.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CHAIN_DEPTH, type Settings } from '../src/shared/types'
import { GENERAL_SETTINGS } from '../src/shared/workspaces'
import { settingsPatchError } from '../src/core/settings-patch'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, {
  window,
  document,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})
Object.assign(window, { innerWidth: 1280, innerHeight: 800, tucano: {} })
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id)
})
// React's input polyfill asks the focused element for attachEvent, which linkedom doesn't have.
Object.assign(window.HTMLInputElement.prototype, { attachEvent: () => {}, detachEvent: () => {} })

let fake: State
const { patches } = vi.hoisted(() => ({ patches: [] as Record<string, unknown>[] }))
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    updateSettings: (patch: Record<string, unknown>): void => void patches.push(patch),
    amAdmin: () => true,
    amOwner: () => true,
    teamMode: () => false
  }
})

const { createRoot } = await import('react-dom/client')
const { SettingsPage, REPLY_MODES, chainDepthPatch } = await import('../src/renderer/src/components/Pages')
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()

const ready = { installed: true, loggedIn: true, route: 'local' }
const settings = {
  workspaceName: 'Edu',
  context: '',
  engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: { ...ready, route: 'endpoint' } },
  routerModel: 'haiku',
  memoryModel: 'haiku',
  memory: 'auto',
  defaultLimit: 20_000_000,
  approvalTtlHours: 24,
  sendMode: 'parallel',
  chainDepth: 3
} as unknown as Settings

let root: Root
beforeEach(() => {
  patches.length = 0
  // The Agents pane of Settings, as the rail opens it.
  fake = { ...base, settings, tabs: { ...base.tabs, settings: 'agentes' } } as unknown as State
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
})

const draw = async (): Promise<HTMLElement> => {
  await act(async () => root.render(<SettingsPage />))
  return document.getElementById('agents-replies')!
}

// The select inside the card, opened the way a person opens it, and the options it shows, in order.
const optionsOf = async (card: HTMLElement): Promise<{ label: string; el: HTMLElement }[]> => {
  if (!document.querySelector('[role=listbox]')) {
    const trigger = card.querySelector('.select__trigger') as unknown as HTMLElement
    await act(async () => trigger.click())
  }
  return [...document.querySelectorAll('[role=option]')].map((o) => ({ label: o.textContent ?? '', el: o as unknown as HTMLElement }))
}

describe('the agent replies card on the Agents pane', () => {
  it('renders there, at the anchor the settings rail links to', async () => {
    const card = await draw()
    expect(card).not.toBeNull()
    expect(card.getAttribute('data-section')).toBe('agents-replies')
    expect(card.querySelector('h2')?.textContent).toBe('Respostas dos agentes')
    // One card, not a second copy elsewhere on the pane.
    expect(document.querySelectorAll('[data-section="agents-replies"]')).toHaveLength(1)
    expect(document.querySelectorAll('h2').length).toBeGreaterThan(1) // the pane's other cards are there too
  })

  it('keeps the chain number in that card, and only there', async () => {
    const card = await draw()
    const capped = [...document.querySelectorAll('input[type=number]')].filter((i) => i.getAttribute('max') === String(MAX_CHAIN_DEPTH))
    expect(capped).toHaveLength(1)
    expect(card.contains(capped[0]!)).toBe(true)
  })

  it('offers the four modes, and each one saves itself', async () => {
    const card = await draw()
    const shown = await optionsOf(card)
    expect(shown.map((o) => o.label)).toEqual([
      'Ao lado dela, em paralelo',
      'Na fila, quando a resposta acabar',
      'Entregue à resposta em curso',
      'Interrompe e começa com esta'
    ])
    // In the order of REPLY_MODES, one row each: picking a row saves that mode.
    expect(shown).toHaveLength(REPLY_MODES.length)
    for (const [i, mode] of REPLY_MODES.entries()) {
      const rows = await optionsOf(card)
      await act(async () => rows[i]!.el.click())
      expect(patches.at(-1)).toEqual({ sendMode: mode })
    }
  })

  it('caps the number of consecutive replies at both ends', async () => {
    const card = await draw()
    const input = card.querySelector('input[type=number]')!
    // The control itself stops at the cap…
    expect(input.getAttribute('min')).toBe('1')
    expect(input.getAttribute('max')).toBe(String(MAX_CHAIN_DEPTH))
    expect((input as unknown as HTMLInputElement).value).toBe('3')
    // …and what it saves is that same cap, whatever number reached it.
    expect(chainDepthPatch(50)).toEqual({ chainDepth: MAX_CHAIN_DEPTH })
    expect(chainDepthPatch(0)).toEqual({ chainDepth: 1 })
    expect(chainDepthPatch(-4)).toEqual({ chainDepth: 1 })
    expect(chainDepthPatch(7.6)).toEqual({ chainDepth: 8 })
    expect(chainDepthPatch(4)).toEqual({ chainDepth: 4 })
  })
})

describe('the settings these two keys travel by', () => {
  it('both pass the patch rules, and a mode that is not one of the four does not', () => {
    expect(settingsPatchError({ sendMode: 'steer', chainDepth: 4 })).toBeUndefined()
    expect(settingsPatchError({ sendMode: 'parallel' })).toBeUndefined()
    expect(settingsPatchError({ sendMode: 'sideways' })).toBeTruthy()
    expect(settingsPatchError({ chainDepth: 'four' })).toBeTruthy()
  })

  it('both are general settings, so a new workspace takes them', () => {
    expect(GENERAL_SETTINGS).toContain('sendMode')
    expect(GENERAL_SETTINGS).toContain('chainDepth')
  })
})
