// An agent's page saves by itself: a switch at once, what's typed after a pause, each time over the
// stored agent (so a rule an approval added meanwhile isn't undone), with "Salvando…" then "✓ Salvo"
// in its head. A new agent still waits for "Criar agente".
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), saveAgent: vi.fn(async () => {}), navigate: vi.fn(), ensureTuca: vi.fn(() => new Promise(() => {})) }
})
const { getState, saveAgent } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { AgentPage } = await import('../src/renderer/src/components/Pages')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, owner: 'ana' }

let root: Root
const show = async (node: React.ReactNode, agents = [lia], tab = 'ferramentas'): Promise<void> => {
  const base = getState()
  fake = { ...base, ready: true, people: [ana], you: 'ana', agents, connectors: [], tabs: { agent: tab }, settings: { ...base.settings, engines: { ...base.settings.engines, claude: { installed: true, loggedIn: true } } } }
  await act(async () => root.render(node))
}
const wait = (ms: number): Promise<void> => act(async () => new Promise((r) => setTimeout(r, ms)))
const flip = async (label: string): Promise<void> => {
  const sw = document.querySelector(`[role="switch"][aria-label="${label}"]`)!
  await act(async () => void sw.dispatchEvent(new window.Event('click', { bubbles: true })))
}
const head = (): string => document.querySelector('.phead__actions')?.textContent ?? ''

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe("an agent's page saves by itself", () => {
  it('has no Save button', async () => {
    await show(<AgentPage id="a1" />)
    expect([...document.querySelectorAll('button')].some((b) => /^Salvar$/.test(b.textContent ?? ''))).toBe(false)
  })

  it('a switch saves at once, over the stored agent, and the head says so', async () => {
    await show(<AgentPage id="a1" />)
    // Meanwhile an approval's "always allow" added a rule to the stored agent.
    await show(<AgentPage id="a1" />, [{ ...lia, autoApprove: ['gh:create_pull_request'] }])
    let done = (): void => {}
    vi.mocked(saveAgent).mockImplementationOnce(() => new Promise<void>((r) => (done = r)))
    await flip('Busca na web')
    await wait(10)
    expect(saveAgent).toHaveBeenCalledTimes(1)
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', web: false, autoApprove: ['gh:create_pull_request'] }), [])
    expect(head()).toContain('Salvando…')
    await act(async () => done())
    expect(head()).toContain('✓ Salvo')
  })

  it('what is typed waits for a pause, then goes in one save', async () => {
    await show(<AgentPage id="a1" />, [lia], 'perfil')
    const role = document.querySelector('input[placeholder="Ex.: Engenharia"]')!
    // Typing, as the field's handler gets it, with the field focused (that's what makes the page wait).
    const props = Object.entries(role).find(([k]) => k.startsWith('__reactProps'))![1] as { onChange: (e: unknown) => void }
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => role })
    for (const value of ['E', 'En', 'Eng']) await act(async () => props.onChange({ target: { value } }))
    delete (document as { activeElement?: unknown }).activeElement
    await wait(50)
    expect(head()).toContain('Salvando…')
    expect(saveAgent).not.toHaveBeenCalled()
    await wait(1000)
    expect(saveAgent).toHaveBeenCalledTimes(1)
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ role: 'Eng' }), [])
  })

  it('a new agent is created only with "Criar agente"', async () => {
    await show(<AgentPage draft={{ ...lia, id: 'new1', name: 'Bia', handle: 'bia' }} />, [lia])
    await flip('Busca na web')
    await wait(10)
    expect(saveAgent).not.toHaveBeenCalled()
    const create = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Criar agente')!
    await act(async () => void create.dispatchEvent(new window.Event('click', { bubbles: true })))
    await wait(10)
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'new1', web: false }), [])
  })
})
