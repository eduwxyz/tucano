// Settings › Models › Accounts: each signed-in account gets "Set as primary", the primary one is marked
// and gets "Unset as primary". The button only changes the setting; nothing else runs.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AccountEngine, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
const updateSettings = vi.fn()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    updateSettings: (patch: Partial<Settings>) => updateSettings(patch),
    addAccount: vi.fn(),
    loginAccount: vi.fn(async () => ({ opened: true, command: '' })),
    removeAccount: vi.fn(async () => {})
  }
})
const { getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { AccountsCard } = await import('../src/renderer/src/components/Harness')

const acc = (id: string, name: string, loggedIn: boolean, engine: AccountEngine = 'codex'): Account => ({ id, name, engine, loggedIn, detail: loggedIn ? 'Plus' : undefined })

let root: Root
const render = async (accounts: Account[], primaryAccounts: Settings['primaryAccounts'] = {}): Promise<void> => {
  const base = getState()
  fake = { ...base, ready: true, platform: 'linux', settings: { ...base.settings, accounts, primaryAccounts } } as State
  await act(async () => root.render(<AccountsCard />))
}
// The row of one account: the element whose text starts with its name, found by its strong label.
const row = (name: string): Element => {
  const strong = [...document.querySelectorAll('.accounts strong')].find((s) => s.textContent === name)
  return strong!.closest('.key-row') as Element
}
const button = (inRow: Element, label: string): HTMLButtonElement | undefined =>
  [...inRow.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined

beforeEach(() => {
  root = createRoot(document.getElementById('root')!)
  updateSettings.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe('the primary login of Codex, on the accounts card', () => {
  it('offers "Set as primary" on a signed-in account and saves it as the primary of that harness', async () => {
    await render([acc('acc-work', 'Trabalho', true), acc('acc-pessoal', 'Pessoal', true)])
    const btn = button(row('Pessoal'), 'Definir como principal')
    expect(btn).toBeDefined()
    expect(btn!.disabled).toBe(false)
    await act(async () => btn!.click())
    expect(updateSettings).toHaveBeenCalledWith({ primaryAccounts: { codex: 'acc-pessoal' } })
  })

  it('marks the primary account and offers "Unset as primary" there, with no "Set as primary" on it', async () => {
    await render([acc('acc-work', 'Trabalho', true), acc('acc-pessoal', 'Pessoal', true)], { codex: 'acc-pessoal' })
    expect(row('Pessoal').textContent).toContain('Principal')
    expect(button(row('Pessoal'), 'Tirar da principal')).toBeDefined()
    expect(button(row('Pessoal'), 'Definir como principal')).toBeUndefined()
    expect(button(row('Trabalho'), 'Definir como principal')).toBeDefined()
  })

  it('unsets the primary: the setting goes back to no primary for that harness', async () => {
    await render([acc('acc-work', 'Trabalho', true), acc('acc-pessoal', 'Pessoal', true)], { codex: 'acc-pessoal' })
    await act(async () => button(row('Pessoal'), 'Tirar da principal')!.click())
    expect(updateSettings).toHaveBeenCalledWith({ primaryAccounts: {} })
  })

  it('does not offer "Set as primary" for an account that is not signed in', async () => {
    await render([acc('acc-work', 'Trabalho', true), acc('acc-novo', 'Novo', false)])
    const btn = button(row('Novo'), 'Definir como principal')
    expect(btn).toBeDefined()
    expect(btn!.disabled).toBe(true)
  })

  it('keeps the other harnesses untouched: a primary of Codex does not change Claude Code', async () => {
    await render([acc('acc-work', 'Trabalho', true), acc('acc-claude', 'Claude do trabalho', true, 'claude')], { codex: 'acc-work' })
    expect(button(row('Claude do trabalho'), 'Definir como principal')).toBeDefined()
  })
})
