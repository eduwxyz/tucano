// The two settings that keep the sidebar clean: Asks and Approvals leave it while nothing waits in
// them, and come back on their own. Off (unset), both are always there, which is what every install
// already had.
import { parseHTML } from 'linkedom'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, Person, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, matchMedia: () => ({ matches: false }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
Object.assign(document, { oninput: null })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))
// The update note reads an external store, which has no server render: it isn't what's under test.
vi.mock('../src/renderer/src/components/Update', () => ({ UpdateNote: () => null }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    updateSettings: vi.fn(),
    navigate: vi.fn(),
    openDialog: vi.fn(),
    setTab: vi.fn()
  }
})
const store = await import('../src/renderer/src/store')
const { Sidebar } = await import('../src/renderer/src/components/Sidebar')

const me: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }

const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()

const sidebar = (o: { settings?: Partial<Settings>; questions?: number; approvals?: number; view?: State['view']; people?: Person[] } = {}): string => {
  const questions = Array.from({ length: o.questions ?? 0 }, (_, i) => ({
    id: `q${i}`,
    agentId: 'a1',
    text: `Pergunta ${i}`,
    askedTo: 'ana',
    requestedBy: 'ana',
    state: 'open',
    deadlineAt: Date.now() + 3_600_000,
    createdAt: 1
  }))
  const approvals = Array.from({ length: o.approvals ?? 0 }, (_, i) => ({ id: `ap${i}`, agentId: 'a1', state: 'pending' }))
  fake = {
    ...base,
    ...fake,
    ready: true,
    people: o.people ?? [me],
    agents: [lia],
    approvals: approvals as State['approvals'],
    you: 'ana',
    platform: 'windows',
    conversations: [],
    inbox: { approvals: approvals as State['inbox']['approvals'], questions: questions as State['inbox']['questions'] },
    view: o.view ?? { kind: 'conversation', id: 'none' },
    settings: { ...base.settings, theme: 'light', ...o.settings }
  } as State
  return renderToStaticMarkup(<Sidebar />)
}

// The nav items, by their label: the channel and agent sections have their own headings.
const has = (html: string, label: string): boolean => html.includes(`nav-item__label">${label}<`)

beforeEach(() => {
  setLang('en')
  fake = base
})

describe('the Asks and Approvals entries', () => {
  it('are both there with nothing waiting, when neither setting is on', () => {
    const html = sidebar()
    expect(has(html, 'Asks')).toBe(true)
    expect(has(html, 'Approvals')).toBe(true)
  })

  it('Asks leaves the sidebar while no agent asks anything', () => {
    const html = sidebar({ settings: { hideEmptyAsks: true } })
    expect(has(html, 'Asks')).toBe(false)
    expect(has(html, 'Approvals')).toBe(true)
  })

  it('Asks comes back with the first question', () => {
    expect(has(sidebar({ settings: { hideEmptyAsks: true }, questions: 1 }), 'Asks')).toBe(true)
  })

  it('Approvals leaves the sidebar while nothing waits on you', () => {
    const html = sidebar({ settings: { hideEmptyApprovals: true } })
    expect(has(html, 'Approvals')).toBe(false)
    expect(has(html, 'Asks')).toBe(true)
  })

  it('Approvals comes back with the first approval', () => {
    expect(has(sidebar({ settings: { hideEmptyApprovals: true }, approvals: 1 }), 'Approvals')).toBe(true)
  })

  it('both can be hidden at once, and only the section headings are left', () => {
    const html = sidebar({ settings: { hideEmptyAsks: true, hideEmptyApprovals: true } })
    expect(has(html, 'Asks')).toBe(false)
    expect(has(html, 'Approvals')).toBe(false)
  })

  it('the page you are looking at keeps its entry, off is only for the empty case', () => {
    const html = sidebar({ settings: { hideEmptyAsks: true, hideEmptyApprovals: true }, view: { kind: 'asks' } })
    expect(has(html, 'Asks')).toBe(true)
    expect(has(html, 'Approvals')).toBe(false)
  })

  it('says For you instead of Approvals with a team, and hiding it waits for the whole inbox', () => {
    const people: Person[] = [me, { ...me, id: 'bob', name: 'Bob', role: 'member' }]
    // A question alone keeps it: For you is the whole inbox, not approvals only.
    const html = sidebar({ settings: { hideEmptyApprovals: true, hideEmptyAsks: true }, questions: 1, people })
    expect(has(html, 'For you')).toBe(true)
    expect(has(sidebar({ settings: { hideEmptyApprovals: true, hideEmptyAsks: true }, people }), 'For you')).toBe(false)
  })
})
