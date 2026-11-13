// The Accounts card, with a Grok login in it: offered beside Claude Code and Codex, and shown with
// the plan the CLI reports. (Its engine menu is a real Select, laid out by hand here, as in
// test/select-ui.test.tsx.)
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Account, EngineId, EngineStatus } from '../src/shared/types'
const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
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
const ready: EngineStatus = { installed: true, loggedIn: true, route: 'plan' }
const off: EngineStatus = { installed: false, loggedIn: false }
let fake: { settings: { accounts: Account[]; engines: Record<EngineId, EngineStatus> } }
vi.mock('../src/renderer/src/store', async () => {
  const types = await import('../src/shared/types')
  return { ACCOUNT_ENGINES: types.ACCOUNT_ENGINES, ENGINES: types.ENGINES, useStore: (select: (s: unknown) => unknown) => select(fake), addAccount: vi.fn(), loginAccount: vi.fn(), removeAccount: vi.fn() }
})
const { createRoot } = await import('react-dom/client')
const { AccountsCard } = await import('../src/renderer/src/components/Harness')
let root: ReturnType<typeof createRoot>
const render = async (): Promise<void> => {
  root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<AccountsCard />))
}
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new window.Event('click', { bubbles: true }))
  })
}
// The engine picker offers its options in a menu at document.body, opened by the trigger.
const engineOptions = async (): Promise<(string | null)[]> => {
  await click(document.querySelector('[role="combobox"]')!)
  return [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)
}
const engines = (extra: Partial<Record<EngineId, EngineStatus>> = {}): Record<EngineId, EngineStatus> => ({
  claude: ready,
  codex: ready,
  opencode: off,
  pi: off,
  antigravity: off,
  cursor: off,
  grok: ready,
  cline: off,
  hermes: off,
  ...extra
})
beforeEach(() => {
  fake = { settings: { accounts: [], engines: engines() } }
})
afterEach(async () => {
  await act(async () => root.unmount())
})

// A Grok login of its own is an account like a Claude Code or a Codex one: it is offered when Grok
// is installed, and its row says which plan the CLI reports.
it('offers Grok to add, beside Claude Code and Codex', async () => {
  await render()
  const options = await engineOptions()
  expect(options).toContain('Claude Code')
  expect(options).toContain('Codex')
  expect(options).toContain('Grok')
})

it('leaves out the harnesses that aren’t installed', async () => {
  fake = { settings: { accounts: [], engines: engines({ grok: off }) } }
  await render()
  const options = await engineOptions()
  expect(options).toContain('Claude Code')
  expect(options).not.toContain('Grok')
})

it('shows a Grok account on its plan', async () => {
  fake = { settings: { accounts: [{ id: 'g1', engine: 'grok', name: 'Pessoal', loggedIn: true, detail: 'Plano Grok' }], engines: engines() } }
  await render()
  expect(document.body.textContent).toContain('Grok · Plano Grok')
})
