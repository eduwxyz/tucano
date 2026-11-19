// The agent replies card, back on the Agents pane: the two Enter modes, the cap on replies working
// in one channel, and the number of replies the agents may pass between themselves. The card is
// anchored where the settings rail expects it (`agents-replies`), both numbers stay within their caps,
// and steering and interrupting are only one-shot keys now.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_PARALLEL_SESSIONS, MAX_CHAIN_DEPTH, MAX_PARALLEL_SESSIONS, maxParallelSessionsCap, type Settings } from '../src/shared/types'
import { PERSONAL_SETTINGS } from '../src/core/policy-people'
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
const { SettingsPage, REPLY_MODES, chainDepthPatch, maxParallelSessionsPatch } = await import('../src/renderer/src/components/Pages')
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

  it('offers only the two Enter modes, and each one saves itself', async () => {
    const card = await draw()
    const shown = await optionsOf(card)
    expect(shown.map((o) => o.label)).toEqual(['Ao lado dela, em paralelo', 'Na fila, quando a resposta acabar'])
    expect(card.textContent).not.toContain('Entregue à resposta em curso')
    expect(card.textContent).not.toContain('Interrompe e começa com esta')
    // The hint still names the one-shot keys, but no longer offers them as Enter choices.
    expect(card.textContent).toContain('Alt+Enter entrega')
    expect(card.textContent).toContain('Shift+Alt+Enter interrompe')
    expect(card.textContent).toContain('Ctrl+Enter põe na fila')
    // In the order of REPLY_MODES, one row each: picking a row saves that mode.
    expect(shown).toHaveLength(REPLY_MODES.length)
    for (const [i, mode] of REPLY_MODES.entries()) {
      const rows = await optionsOf(card)
      await act(async () => rows[i]!.el.click())
      expect(patches.at(-1)).toEqual({ sendMode: mode })
    }
  })

  it('sets how many sessions may work in one channel, between one and the cap', async () => {
    const card = await draw()
    const input = [...document.querySelectorAll('input[type=number]')].find((i) => i.getAttribute('max') === String(MAX_PARALLEL_SESSIONS)) as unknown as HTMLInputElement
    expect(card.contains(input)).toBe(true)
    expect(input.getAttribute('min')).toBe('1')
    expect((input as unknown as HTMLInputElement).value).toBe(String(DEFAULT_MAX_PARALLEL_SESSIONS))
    expect(input.getAttribute('aria-label')).toBe('Sessões paralelas por canal')
    // Whatever reached the core, the saved value is a whole number inside the cap.
    expect(maxParallelSessionsPatch(50)).toEqual({ maxParallelSessions: MAX_PARALLEL_SESSIONS })
    expect(maxParallelSessionsPatch(0)).toEqual({ maxParallelSessions: 1 })
    expect(maxParallelSessionsPatch(3.6)).toEqual({ maxParallelSessions: 4 })
    expect(maxParallelSessionsCap(undefined)).toBe(DEFAULT_MAX_PARALLEL_SESSIONS)
  })

  it('caps the number of consecutive replies at both ends', async () => {
    const card = await draw()
    const input = [...card.querySelectorAll('input[type=number]')].find((i) => i.getAttribute('max') === String(MAX_CHAIN_DEPTH))!
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

describe('the settings the card travels by', () => {
  it('pass the patch rules, and bad values do not', () => {
    expect(settingsPatchError({ sendMode: 'steer', chainDepth: 4, maxParallelSessions: 2 })).toBeUndefined()
    expect(settingsPatchError({ sendMode: 'parallel' })).toBeUndefined()
    expect(settingsPatchError({ sendMode: 'sideways' })).toBeTruthy()
    expect(settingsPatchError({ chainDepth: 'four' })).toBeTruthy()
    expect(settingsPatchError({ maxParallelSessions: 'two' })).toBeTruthy()
  })

  it('goes to the right scope, with sendMode and chainDepth general', () => {
    expect(GENERAL_SETTINGS).toContain('sendMode')
    expect(GENERAL_SETTINGS).toContain('chainDepth')
    expect(PERSONAL_SETTINGS).toContain('maxParallelSessions')
  })
})
