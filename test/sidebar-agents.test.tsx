// One list of agents in the sidebar ("Agentes"): the DMs and the agents were two lists, now each agent
// is one row that opens its DM. The role sits after the name (grey, cut with an ellipsis, in full on
// hover; with a team, whose agent it is) and shows on hover; on the right only what changed: unread,
// working, waiting on me. With sectors (src/shared/org.ts) the list is grouped, each group foldable.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, RunStatus } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), navigate: vi.fn(), openDm: vi.fn(async () => {}), updateSettings: vi.fn() }
})
const store = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { Sidebar } = await import('../src/renderer/src/components/Sidebar')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
const agent = (p: Partial<Agent>): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: 'Pesquisadora', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...p })
const dm = (p: Partial<Conversation>): Conversation => ({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'], ...p })
const msg = (id: string, conversationId: string, agentId: string, status: RunStatus): Message => ({ id, conversationId, author: { kind: 'agent', id: agentId }, text: '', at: 0, run: { status, steps: [] } })

let root: Root
const render = async (s: Partial<State>): Promise<void> => {
  const base = store.getState()
  fake = { ...base, ready: true, people: [ana], you: 'ana', ...s, settings: { ...base.settings, sidebarParts: undefined, ...s.settings } } as State
  await act(async () => root.render(<Sidebar />))
}
const section = (label: string): Element => [...document.querySelectorAll('.section')].find((x) => x.querySelector('.section__head')?.textContent?.includes(label))!
const agentRows = (): Element[] => [...section('Agentes').querySelectorAll('.agent-row > .nav-item')]
const row = (name: string): Element => agentRows().find((r) => r.querySelector('.nav-item__label')?.textContent === name)!
const click = (el: Element): Promise<void> => act(async () => void el.dispatchEvent(new window.Event('click', { bubbles: true })))

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe("an agent's row in the sidebar", () => {
  it('is one list: no "Mensagens diretas", one row per agent whether or not it has a DM', async () => {
    await render({ agents: [agent({}), agent({ id: 'a2', name: 'Theo', handle: 'theo' })], conversations: [dm({}), { id: 'c1', kind: 'channel', name: 'geral', members: ['a1'] }] })
    expect(document.body.textContent).not.toContain('ensagens diretas')
    expect(agentRows().map((r) => r.querySelector('.nav-item__label')!.textContent)).toEqual(['Lia', 'Theo'])
    expect(section('Canais').querySelector('.nav-item__role')).toBeNull()
  })

  it("shows the agent's role after its name, with its full text on hover", async () => {
    await render({ agents: [agent({})], conversations: [dm({})] })
    const role = row('Lia').querySelector('.nav-item__label + .nav-item__meta.nav-item__role')!
    expect(role.textContent).toBe('Pesquisadora')
    expect(role.getAttribute('title')).toBe('Pesquisadora')
  })

  it('opens its DM, or makes one the first time; the gear opens its page', async () => {
    await render({ agents: [agent({}), agent({ id: 'a2', name: 'Theo', handle: 'theo' })], conversations: [dm({})] })
    await click(row('Lia'))
    expect(store.navigate).toHaveBeenCalledWith({ kind: 'conversation', id: 'd1' })
    await click(row('Theo'))
    expect(store.openDm).toHaveBeenCalledWith('a2')
    await click(row('Lia').parentElement!.querySelector('.agent-row__gear')!)
    expect(store.navigate).toHaveBeenCalledWith({ kind: 'agent', id: 'a1' })
  })

  it('is lit on its DM and on its page', async () => {
    await render({ agents: [agent({})], conversations: [dm({})], view: { kind: 'conversation', id: 'd1' } })
    expect(row('Lia').className).toContain('is-active')
    await render({ agents: [agent({})], conversations: [dm({})], view: { kind: 'agent', id: 'a1' } })
    expect(row('Lia').className).toContain('is-active')
  })

  it('keeps the unread count after the role, with the name in bold', async () => {
    await render({ agents: [agent({})], conversations: [dm({ unread: 3 })] })
    const parts = [...row('Lia').children].map((x) => x.className)
    expect(parts.indexOf('nav-item__meta nav-item__role')).toBeLessThan(parts.findIndex((c) => c.includes('badge')))
    expect(row('Lia').querySelector('.badge')!.textContent).toBe('3')
    expect(row('Lia').className).toContain('is-unread')
  })

  it('says how many things wait on me in its DM, with a shield', async () => {
    const messages = { d1: [msg('m1', 'd1', 'a1', 'waiting_approval'), msg('m2', 'd1', 'a1', 'waiting_input'), msg('m3', 'd1', 'a1', 'done')] }
    await render({ agents: [agent({})], conversations: [dm({})], messages })
    const pill = row('Lia').querySelector('.waiting-pill')!
    expect(pill.textContent).toBe('2')
    expect(pill.getAttribute('title')).toContain('Lia')
  })

  it('shows three dots while the agent works in its DM', async () => {
    await render({ agents: [agent({})], conversations: [dm({})], messages: { d1: [msg('m1', 'd1', 'a1', 'working')] } })
    expect(row('Lia').querySelectorAll('.working-dots i')).toHaveLength(3)
  })

  it('an agent with no role shows just its name', async () => {
    await render({ agents: [agent({ role: '' })], conversations: [dm({})] })
    expect(row('Lia').querySelector('.nav-item__role')!.textContent).toBe('')
    expect(row('Lia').querySelector('.nav-item__label')!.textContent).toBe('Lia')
  })

  it("with a team, someone else's agent says whose it is on hover; mine doesn't", async () => {
    const team = { people: [ana, bia], you: 'bia' }
    await render({ ...team, agents: [agent({ owner: 'ana' })], conversations: [dm({ owner: 'bia' })] })
    expect(row('Lia').querySelector('.nav-item__role')!.getAttribute('title')).toBe('Pesquisadora · de Ana')
    await render({ ...team, agents: [agent({ owner: 'bia' })], conversations: [dm({ owner: 'bia' })] })
    expect(row('Lia').querySelector('.nav-item__role')!.getAttribute('title')).toBe('Pesquisadora')
  })

  it('keeps a DM with an archived agent reachable, and the archived entry', async () => {
    await render({ agents: [agent({}), agent({ id: 'a2', name: 'Duda', handle: 'duda', archived: true })], conversations: [dm({}), dm({ id: 'd2', name: 'a2', members: ['a2'] })] })
    expect(row('Duda').parentElement!.className).toContain('is-archived')
    expect(section('Agentes').textContent).toContain('Arquivados')
  })

  it('has the org chart behind an icon in the header, where "Time" was', async () => {
    await render({ agents: [agent({}), agent({ id: 'a2', name: 'Theo', handle: 'theo' })], conversations: [] })
    expect([...document.querySelectorAll('.nav-item__label')].map((x) => x.textContent)).not.toContain('Time')
    await click(section('Agentes').querySelector('.section__head [aria-label="Organograma"]')!)
    expect(store.navigate).toHaveBeenCalledWith({ kind: 'org' })
  })
})

describe('the agents grouped by sector', () => {
  // Lia heads a sector (Theo answers to her); Duda answers to no one: in no sector.
  const team = [agent({ sectorName: 'Pesquisa' }), agent({ id: 'a2', name: 'Theo', handle: 'theo', reportsTo: 'a1' }), agent({ id: 'a3', name: 'Duda', handle: 'duda' })]
  const heads = (): string[] => [...document.querySelectorAll('.agent-sector__head .fold-toggle')].map((x) => x.textContent ?? '')

  it('groups them, each head first, those in no sector last', async () => {
    await render({ agents: team, conversations: [] })
    expect(heads()).toEqual(['Pesquisa', 'Sem setor'])
    const groups = [...document.querySelectorAll('.agent-sector')].map((g) => [...g.querySelectorAll('.nav-item__label')].map((x) => x.textContent))
    expect(groups).toEqual([['Lia', 'Theo'], ['Duda']])
  })

  it('folded, a sector still says how many agents, how many unread and what waits on me', async () => {
    const conversations = [dm({ unread: 2 }), dm({ id: 'd2', name: 'a2', members: ['a2'], unread: 1 })]
    await render({ agents: team, conversations, messages: { d2: [msg('m1', 'd2', 'a2', 'waiting_approval')] }, settings: { folded: ['sector:a1'] } as State['settings'] })
    const head = document.querySelector('.agent-sector.is-folded .agent-sector__head')!
    expect(head.querySelector('.agent-sector__count')!.textContent).toBe('2')
    expect(head.querySelector('.badge')!.textContent).toBe('3')
    expect(head.querySelector('.waiting-pill')!.textContent).toBe('1')
  })

  it('without sectors, a flat list', async () => {
    await render({ agents: [agent({}), agent({ id: 'a2', name: 'Theo', handle: 'theo' })], conversations: [] })
    expect(document.querySelector('.agent-sector')).toBeNull()
    expect(agentRows()).toHaveLength(2)
  })
})
