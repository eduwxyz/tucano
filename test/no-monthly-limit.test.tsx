// An agent's month has a limit, or it hasn't: 0 is no limit, never "already spent". The runner always
// read it that way (#243); three screens didn't, so a workspace where every bot sits at 0 showed a red
// "Hit the monthly limit" dot on all of them, offered "Raise the limit" instead of "Try again", and
// printed "of 0 tokens" / "0% of the month's limit" as if the month were gone. One rule now
// (shared/limits.ts), read by the runner and by every place that draws it.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, Proposal, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { hasMonthlyLimit, monthlyCeiling, overMonthlyLimit, usedShare } from '../src/shared/limits'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    retryRun: vi.fn(async () => {}),
    continueRun: vi.fn(async () => {}),
    setTab: vi.fn(),
    navigate: vi.fn(),
    voiceStatus: vi.fn(() => new Promise(() => {}))
  }
})
const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { Sidebar } = await import('../src/renderer/src/components/Sidebar')
const { ConversationView } = await import('../src/renderer/src/components/Conversation')
const { Proposals } = await import('../src/renderer/src/components/Tuca')
const { workspaceState } = await import('../src/core/tuca-help')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const agent = (p: Partial<Agent> = {}): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: 'Pesquisadora', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 5_000_000, grants: {}, memory: 'auto', computer: false, archived: false, ...p })
const dm: Conversation = { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }
const reply = (status: 'limit_reached' | 'failed'): Message => ({ id: 'm1', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'Parei.', at: 2, run: { status, steps: [] } })

// A fresh root per render: the sidebar's rows are memoized, so sharing one container between two
// renders would keep the first state's dot on screen.
let root: Root | undefined
beforeEach(() => {
  setLang('en')
  const mount = document.getElementById('root')!
  mount.innerHTML = ''
  root = undefined
  fake = {
    ...real.getState(),
    ready: true,
    people: [ana],
    you: 'ana',
    agents: [],
    conversations: [dm],
    messages: {},
    inbox: { approvals: [], questions: [] },
    settings: { ...real.getState().settings, sidebarParts: undefined } as Settings
  } as State
})
const render = async (node: ReactNode): Promise<void> => {
  if (root) await act(async () => root!.unmount())
  const host = document.createElement('div')
  document.getElementById('root')!.append(host)
  root = createRoot(host)
  const mounted = root
  await act(async () => mounted.render(node))
}

describe('the rule itself', () => {
  it('reads 0 — and anything that is not a positive number — as no ceiling', () => {
    expect(monthlyCeiling(0)).toBe(Infinity)
    expect(monthlyCeiling(-5)).toBe(Infinity)
    expect(hasMonthlyLimit(0)).toBe(false)
    expect(overMonthlyLimit(50_000_000, 0)).toBe(false)
    expect(usedShare(5_000_000, 0)).toBeUndefined()
  })

  it('keeps a real ceiling', () => {
    expect(hasMonthlyLimit(1_000_000)).toBe(true)
    expect(overMonthlyLimit(1_000_000, 1_000_000)).toBe(true)
    expect(overMonthlyLimit(999_999, 1_000_000)).toBe(false)
    expect(usedShare(900_000, 1_000_000)).toBeCloseTo(0.9, 6)
  })
})

describe('the sidebar', () => {
  it('draws no limit dot for an agent with no monthly limit, however much it spent', async () => {
    fake = { ...fake, agents: [agent({ used: 50_000_000 })] }
    await render(<Sidebar />)
    expect(document.body.textContent).toContain('Lia') // the row is there
    expect(document.querySelector('.dot')).toBeNull()
    expect(document.body.textContent).not.toContain('Hit the monthly limit')
  })

  it('still warns past 80% and reddens at 100% when there is a limit', async () => {
    fake = { ...fake, agents: [agent({ limit: 1_000_000, used: 900_000 })] }
    await render(<Sidebar />)
    expect(document.querySelector('.dot--warn')).not.toBeNull()
    expect(document.querySelector('.dot--danger')).toBeNull()
    fake = { ...fake, agents: [agent({ limit: 1_000_000, used: 1_000_000 })] }
    await render(<Sidebar />)
    expect(document.querySelector('.dot--danger')?.getAttribute('title')).toContain('Hit the monthly limit')
  })
})

describe('a reply that stopped at the limit', () => {
  const buttons = (): string[] => [...document.querySelectorAll('button.retry')].map((b) => b.textContent ?? '')

  it('offers Try again, not Raise the limit, when there is no limit to raise', async () => {
    fake = { ...fake, agents: [agent()], messages: { d1: [reply('limit_reached')] } }
    await render(<ConversationView id="d1" />)
    expect(buttons()).toContain('Try again')
    expect(buttons().join(' ')).not.toContain('Raise')
  })

  it('offers Raise the limit instead when the month really is spent', async () => {
    fake = { ...fake, agents: [agent({ limit: 1_000_000, used: 1_000_000 })], messages: { d1: [reply('limit_reached')] } }
    await render(<ConversationView id="d1" />)
    expect(buttons().join(' ')).toContain('Raise Lia’s limit')
    expect(buttons()).not.toContain('Try again')
  })

  it('keeps Try again for any other kind of failure either way', async () => {
    fake = { ...fake, agents: [agent({ limit: 1_000_000, used: 1_000_000 })], messages: { d1: [reply('failed')] } }
    await render(<ConversationView id="d1" />)
    expect(buttons()).toContain('Try again')
  })
})

describe("the Tuca's card for changing an agent", () => {
  it('says "no limit" instead of a 0 that reads as a cap', async () => {
    const proposal: Proposal = { kind: 'agent', agentId: 'a1', changes: { limit: 0 }, before: { limit: 2_000_000 } }
    const carded: Message = { id: 't1', conversationId: 't1', author: { kind: 'agent', id: 'tuca' }, text: 'Posso tirar o limite?', at: 1, run: { status: 'done', steps: [], proposals: [proposal] } }
    fake = { ...fake, agents: [agent({ limit: 2_000_000, used: 0 })], messages: { t1: [carded] } }
    await render(<Proposals message={carded} />)
    const text = document.body.textContent ?? ''
    expect(text).toContain("Month's limit")
    expect(text).toContain('no limit')
    expect(text).toContain('2M') // and what it was
  })
})

describe('what the Tuca reads about an agent', () => {
  const state = (a: Agent): string =>
    workspaceState('agentes', {
      settings: fake.settings,
      connectors: [],
      agents: [a],
      conversations: [],
      routines: [],
      approvals: [],
      failures: [],
      lastRun: () => undefined,
      now: Date.now()
    })

  it('says there is no monthly limit instead of "0% of the month"', () => {
    expect(state(agent())).toContain('no monthly limit')
    expect(state(agent({ limit: 4_000_000, used: 1_000_000 }))).toContain('25% of the month')
  })
})
