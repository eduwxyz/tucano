// A harness saved as picked and later found not installed must lose its pick: its checkbox is
// disabled, so leaving the pick would strand a selected row nobody can turn off.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import { setLang } from '../src/shared/lang'
import { ENGINE_IDS, type EngineId, type EngineStatus, type Settings } from '../src/shared/types'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener(): void {}, removeEventListener(): void {} }) })

type FakeState = { settings: Pick<Settings, 'engines' | 'harnesses' | 'endpoint'>; platform: string }
let state: FakeState
let saved: { harnesses?: EngineId[] }[] = []
const listeners = new Set<() => void>()
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
const notify = (): void => { for (const fn of listeners) fn() }

vi.mock('../src/renderer/src/store', async () => {
  const { useSyncExternalStore } = await import('react')
  const { ENGINES, MODELS, startsPicked } = await import('../src/shared/types')
  return {
    useStore: (select: (s: FakeState) => unknown) => useSyncExternalStore(subscribe, () => select(state)),
    updateSettings: (patch: { harnesses?: EngineId[] }) => {
      saved.push(patch)
      state = { ...state, settings: { ...state.settings, ...patch } }
      notify()
    },
    ACCOUNT_ENGINES: [],
    accountsOn: () => [],
    EFFORTS: [],
    addAccount: vi.fn(),
    ENGINES,
    ENGINE_IDS,
    loginAccount: vi.fn(),
    removeAccount: vi.fn(),
    MODELS,
    startsPicked,
    codexValue: (value: string) => value,
    customModel: (engine: EngineId, value: string) => `${engine}:${value}`,
    engineModels: async () => ({ models: [] }),
    harnessMcps: async () => [],
    importHarnessMcp: vi.fn(),
    installEngine: vi.fn(),
    loginEngine: vi.fn(),
    modelInfo: () => undefined,
    navigate: vi.fn(),
    openExternal: vi.fn(),
    probeEndpoint: async () => ({ models: [] }),
    rememberModels: vi.fn(),
    setEndpoint: vi.fn(),
    setTab: vi.fn(),
    testEngine: async () => ({ ok: true, message: '' })
  }
})
vi.mock('../src/renderer/src/components/ui', () => ({ Icon: () => null }))
vi.mock('../src/renderer/src/components/EngineProblem', () => ({ EngineProblem: () => null }))
vi.mock('../src/renderer/src/components/Select', () => ({ Select: () => <select /> }))

const { createRoot } = await import('react-dom/client')
const { HarnessList } = await import('../src/renderer/src/components/Harness')
let root: Root
const ready: EngineStatus = { installed: true, loggedIn: true, route: 'plan' }
const statuses = (overrides: Partial<Record<EngineId, EngineStatus>> = {}): Record<EngineId, EngineStatus> =>
  ({ ...Object.fromEntries(ENGINE_IDS.map((e) => [e, ready])), ...overrides }) as Record<EngineId, EngineStatus>
const render = async (): Promise<void> => { await act(async () => root.render(<HarnessList />)) }
const check = (label: string): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>(`.harness__check[aria-label="Use ${label}"]`)
  if (!button) throw new Error(`no check for ${label}`)
  return button
}

beforeEach(() => {
  setLang('en')
  document.getElementById('root')!.innerHTML = ''
  saved = []
  listeners.clear()
  state = { settings: { engines: statuses(), harnesses: ['claude'], endpoint: undefined }, platform: 'windows' }
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => { await act(async () => root.unmount()) })

describe('picked harnesses that cannot run', () => {
  it('drops the pick of a harness found not installed, including the endpoint row', async () => {
    state.settings.engines = statuses({
      pi: { installed: false, loggedIn: false },
      endpoint: { installed: false, loggedIn: false }
    })
    state.settings.harnesses = ['claude', 'pi', 'endpoint']
    await render()
    expect(saved).toEqual([{ harnesses: ['claude'] }])
    expect(state.settings.harnesses).toEqual(['claude'])
    expect(check('Pi').disabled).toBe(true)
    expect(check('Pi').classList.contains('is-on')).toBe(false)
    expect(check('the endpoint').disabled).toBe(true)
    expect(check('the endpoint').classList.contains('is-on')).toBe(false)
    expect(check('Claude Code').disabled).toBe(false)
    expect(check('Claude Code').classList.contains('is-on')).toBe(true)
  })

  it('keeps an installed harness picked and writes nothing', async () => {
    await render()
    expect(saved).toEqual([])
    expect(check('Claude Code').classList.contains('is-on')).toBe(true)
  })

  it('waits for a status that has finished checking before it drops a pick', async () => {
    state.settings.engines = statuses({ pi: { installed: false, loggedIn: false, checking: true } })
    state.settings.harnesses = ['pi']
    await render()
    expect(saved).toEqual([])
    expect(check('Pi').classList.contains('is-on')).toBe(true)
    await act(async () => {
      state = { ...state, settings: { ...state.settings, engines: statuses({ pi: { installed: false, loggedIn: false } }) } }
      notify()
    })
    expect(saved).toEqual([{ harnesses: [] }])
    expect(check('Pi').classList.contains('is-on')).toBe(false)
  })
})
