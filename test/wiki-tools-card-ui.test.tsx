// The wiki's card lives on the Tools tab, with the level an agent may have of it: no access, read
// only, or read and write. Picking one saves right away, as the other cards on that tab do.
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
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), patchAgent: vi.fn(), ensureTuca: vi.fn(() => new Promise(() => {})) }
})
const { getState, patchAgent } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { AgentPage } = await import('../src/renderer/src/components/Pages')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia = (p: Partial<Agent>): Agent => ({
  id: 'a1',
  name: 'Lia',
  handle: 'lia',
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false,
  ...p
})

let root: Root
const render = async (agent: Agent, tab: string): Promise<void> => {
  fake = { ...getState(), ready: true, people: [ana], you: 'ana', agents: [agent], connectors: [], tabs: { agent: tab } }
  await act(async () => root.render(<AgentPage id="a1" />))
}
const wikiCard = (): Element | undefined => [...document.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent === 'Wiki')
const labels = (): string => [...(wikiCard()?.querySelectorAll('[role="radio"]') ?? [])].map((b) => b.textContent).join(' · ')
const picked = (): string => [...(wikiCard()?.querySelectorAll('[role="radio"]') ?? [])].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent).join()
const hint = (): string => wikiCard()?.querySelector('.hint')?.textContent ?? ''
const click = async (name: string): Promise<void> => {
  const b = [...(wikiCard()?.querySelectorAll('button') ?? [])].find((x) => x.textContent === name)!
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
}

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe('the wiki card, on the Tools tab', () => {
  it('is there, with the three levels and the current one picked', async () => {
    await render(lia({ wiki: 'read' }), 'ferramentas')
    expect(wikiCard()).toBeTruthy()
    expect(labels()).toBe('Sem acesso · Só lê · Lê e escreve')
    expect(picked()).toBe('Só lê')
    expect(hint()).toContain('o curador da wiki continua sendo quem escreve')
  })

  it('is not on the Memory tab any more', async () => {
    await render(lia({ wiki: 'read' }), 'memoria')
    expect(wikiCard()).toBeUndefined()
  })

  it('picks read and write, and saves it right away', async () => {
    await render(lia({ wiki: 'read' }), 'ferramentas')
    await click('Lê e escreve')
    expect(picked()).toBe('Lê e escreve')
    expect(hint()).toContain('wiki_escrever')
    expect(patchAgent).toHaveBeenCalledWith('a1', { wiki: 'read_write' })
  })

  it('turns it off again, and an unset agent reads', async () => {
    await render(lia({ wiki: 'none' }), 'ferramentas')
    expect(picked()).toBe('Sem acesso')
    await click('Só lê')
    expect(patchAgent).toHaveBeenCalledWith('a1', { wiki: 'read' })
    await render(lia({}), 'ferramentas')
    expect(picked()).toBe('Só lê') // unset means it reads
  })
})
