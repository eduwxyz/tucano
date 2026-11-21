import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VaultKey } from '../src/shared/vault'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null })

const key = (name: string, extra: Partial<VaultKey> = {}): VaultKey => ({ id: name, name, agents: [], approve: false, hint: '••••abcd', createdAt: 1, updatedAt: 1, ...extra })
let fake: { you: string; people: { id: string }[]; agents: { id: string; name: string; archived: boolean; computer: boolean }[] }
let admin = true
let team = false
let keys: VaultKey[] = []
const saved = vi.fn(async (k: unknown) => k)
const imported = vi.fn(async (_lines: unknown, _replace: unknown, _mine?: boolean) => ({ saved: 1 }))
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(fake),
  amAdmin: () => admin,
  teamMode: () => team,
  isTeam: (a: { archived: boolean }) => !a.archived,
  agentById: (s: typeof fake, id: string) => s.agents.find((a) => a.id === id),
  personById: () => undefined,
  navigate: vi.fn(),
  vaultKeys: async () => keys,
  vaultUses: async () => [],
  saveVaultKey: (k: unknown) => saved(k),
  removeVaultKey: vi.fn(async () => {}),
  setVaultKeyAgent: vi.fn(),
  importVaultKeys: (l: unknown, r: unknown, m?: boolean) => imported(l, r, m)
}))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null, Icon: () => null }))
vi.mock('../src/renderer/src/components/Dialogs', () => ({ confirmDialog: async () => true }))
vi.mock('../src/renderer/src/components/Modal', () => ({ Modal: ({ title, children }: { title: string; children: ReactNode }) => <div role="dialog" aria-label={title}>{children}</div> }))
vi.mock('../src/renderer/src/components/Pages', () => ({
  Page: ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) => <section><h1>{title}</h1>{actions}{children}</section>,
  Field: ({ label, error, children }: { label: string; error?: string; children: ReactNode }) => <label>{label}{children}{error && <span className="field__error">{error}</span>}</label>,
  Toggle: ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => <input type="checkbox" aria-label="toggle" checked={on} onChange={(e) => onChange(e.target.checked)} />
}))
const { createRoot } = await import('react-dom/client')
const { VaultPage } = await import('../src/renderer/src/components/Vault')
let root: ReturnType<typeof createRoot>
const render = async (): Promise<void> => act(async () => root.render(<VaultPage />))
const click = async (el: Element) => act(async () => { el.dispatchEvent(new window.Event('click', { bubbles: true })) })
const type = async (input: Element, value: string): Promise<void> => {
  // linkedom has no default "text" type, and React only listens for typing on a text input.
  if (input.tagName === 'INPUT' && !input.getAttribute('type')) input.setAttribute('type', 'text')
  let proto: object | null = Object.getPrototypeOf(input)
  let set: ((v: string) => void) | undefined
  while (proto && !set) (set = Object.getOwnPropertyDescriptor(proto, 'value')?.set), (proto = Object.getPrototypeOf(proto))
  await act(async () => {
    set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!
const text = (): string => document.body.textContent ?? ''

beforeEach(() => {
  fake = { you: 'owner', people: [{ id: 'owner' }], agents: [{ id: 'fin', name: 'Fin', archived: false, computer: true }] }
  admin = true
  team = false
  keys = []
  saved.mockClear()
  imported.mockClear()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => { await act(async () => root.unmount()) })

it('alone: one list, a key as its name and last characters, never its value', async () => {
  keys = [key('STRIPE_KEY', { agents: ['fin'], approve: true })]
  await render()
  expect(text()).toContain('STRIPE_KEY')
  expect(text()).toContain('••••abcd')
  expect(text()).toContain('pede aprovação')
  expect(text()).not.toContain('Do time')
})

it('in a team: the team’s keys and mine, apart', async () => {
  team = true
  keys = [key('STRIPE_KEY'), key('GITHUB_TOKEN', { owner: 'owner' })]
  await render()
  expect(text()).toContain('Do time')
  expect(text()).toContain('Minhas')
})

it('a new key: a name that can’t be one says why, and the value is required', async () => {
  await render()
  await click(button('Nova chave'))
  const [name, value] = [...document.querySelectorAll('[role="dialog"] input')] as HTMLInputElement[]
  await type(name!, 'path')
  expect(text()).toContain('do próprio terminal')
  await type(name!, 'stripe key')
  expect(name!.value).toBe('STRIPE_KEY') // typed as an environment variable
  expect(button('Guardar no Cofre').disabled).toBe(true)
  await type(value!, 'sk_live_123')
  expect(button('Guardar no Cofre').disabled).toBe(false)
  await act(async () => { document.querySelector('[role="dialog"] form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: 'STRIPE_KEY', value: 'sk_live_123', agents: [], approve: false }))
})

it('an .env: new names go in, a name already saved only when its box is checked', async () => {
  keys = [key('DB_URL')]
  await render()
  await click(button('Importar .env'))
  await type(document.querySelector('[role="dialog"] textarea')!, 'STRIPE_KEY=sk_live_x\nDB_URL=postgres://new\nbad=1')
  expect(text()).toContain('nova')
  expect(text()).toContain('já existe')
  expect(text()).toContain('não entra')
  await click(button('Guardar 1 chave'))
  expect(imported).toHaveBeenCalledWith([{ name: 'STRIPE_KEY', value: 'sk_live_x' }], [], false)
})
