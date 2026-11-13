import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Settings } from '../src/shared/types'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null })
let fake: { settings: Partial<Settings> }
let admin = true
const update = vi.fn()
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(fake),
  amAdmin: () => admin,
  updateSettings: (p: unknown) => update(p),
  ACCOUNT_ENGINES: ['claude', 'codex'],
  ENGINE_IDS: ['claude', 'codex'],
  addAccount: vi.fn(), loginAccount: vi.fn(), removeAccount: vi.fn(),
  ENGINES: { claude: { label: 'Claude Code' }, codex: { label: 'Codex' } }
}))
vi.mock('../src/renderer/src/components/Usage', () => ({
  Ring: ({ label, w }: { label: string; w: { utilization: number } }) => <div className="ring">{label} {Math.round(w.utilization * 100)}%</div>,
  windowLabel: (m: number) => `w${m}`
}))
vi.mock('../src/renderer/src/components/ui', () => ({ Icon: () => null }))
vi.mock('../src/renderer/src/components/Select', () => ({ Select: () => null }))
vi.mock('../src/renderer/src/components/EngineProblem', () => ({ EngineProblem: () => null }))
const { createRoot } = await import('react-dom/client')
const { AccountsQuota } = await import('../src/renderer/src/components/UsageAccounts')
const { AccountsCard } = await import('../src/renderer/src/components/Harness')
let root: ReturnType<typeof createRoot>
const future = Date.now() + 3_600_000
const win = (utilization: number) => ({ utilization, resetsAt: future })
const account = (id: string, name: string) => ({ id, name, engine: 'claude', loggedIn: true })
const base = (over: Partial<Settings>): { settings: Partial<Settings> } => ({
  settings: { engines: { claude: { loggedIn: true }, codex: { loggedIn: false } }, accounts: [account('a1', 'Trabalho'), account('a2', 'Reserva')], quota: { fiveHour: win(0.5), at: Date.now() }, accountQuota: { a1: { fiveHour: win(1), at: Date.now() } }, ...over } as Partial<Settings>
})
const mount = async (el: React.ReactNode) => { await act(async () => root.render(el)) }
beforeEach(() => {
  fake = base({})
  admin = true
  update.mockReset()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => { await act(async () => root.unmount()) })
const click = async (el: Element) => act(async () => { el.dispatchEvent(new window.Event('click', { bubbles: true })) })
const text = () => document.body.textContent ?? ''

it('lists the usual login first, then each account, with rings or the empty line', async () => {
  await mount(<AccountsQuota engine="claude" />)
  const rows = [...document.querySelectorAll('.usage-account')]
  expect(rows).toHaveLength(3)
  expect(rows[0]!.textContent).toContain('A de sempre')
  expect(rows[0]!.querySelectorAll('.ring')).toHaveLength(1)
  expect(rows[1]!.textContent).toContain('Trabalho')
  expect(rows[2]!.textContent).toContain('Reserva')
  expect(rows[2]!.textContent).toContain('Ainda sem dados')
  expect(rows[2]!.querySelectorAll('.ring')).toHaveLength(0)
  expect(text()).toContain('cada agente na conta dele')
})
it('marks a login at 100% as out for now', async () => {
  await mount(<AccountsQuota engine="claude" />)
  const row = document.querySelector('[data-login="a1"]')!
  expect(row.querySelector('.is-out')?.textContent).toBe('Acabou por agora')
  expect(document.querySelectorAll('.is-out')).toHaveLength(1)
})
it('when balancing, flags the login with the most left as next in line', async () => {
  fake = base({ accountUse: 'balance' })
  await mount(<AccountsQuota engine="claude" />)
  expect(text()).toContain('equilibrando entre as contas')
  const next = document.querySelectorAll('.is-next')
  expect(next).toHaveLength(1)
  expect(next[0]!.closest('.usage-account')?.getAttribute('data-login')).toBe('a2')
})
it('renders nothing with a single login', async () => {
  fake = base({ accounts: [] })
  await mount(<AccountsQuota engine="claude" />)
  expect(document.querySelector('section')).toBeNull()
})
it('lets the person pick how to use the accounts', async () => {
  await mount(<AccountsCard />)
  const radios = [...document.querySelectorAll('[role="radio"]')]
  expect(radios.map((r) => r.textContent)).toEqual(['Cada agente na conta dele', 'Equilibrar entre as contas'])
  expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
  expect(text()).toContain('entra o Modelo reserva dele')
  await click(radios[1]!)
  expect(update).toHaveBeenCalledWith({ accountUse: 'balance' })
})
it('reflects balance as active and hides the choice with no accounts', async () => {
  fake = base({ accountUse: 'balance' })
  await mount(<AccountsCard />)
  expect(document.querySelectorAll('[role="radio"]')[1]!.getAttribute('aria-checked')).toBe('true')
  expect(text()).toContain('mais sobrando')
  fake = base({ accounts: [] })
  await mount(<AccountsCard />)
  expect(document.querySelector('[role="radiogroup"]')).toBeNull()
})
