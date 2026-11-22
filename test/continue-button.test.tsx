// A reply the app cut with work behind it is worth more than a restart of the same work, so it offers
// "Continue" before "Try again"; one that never got a tool call back offers "Try again" alone (#390).
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, Settings, Step } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
const continueRun = vi.fn(async () => {})
const retryRun = vi.fn(async () => {})
const continueJob = vi.fn(async () => {})
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    continueRun,
    retryRun,
    continueJob,
    setTab: vi.fn(),
    navigate: vi.fn(),
    voiceStatus: vi.fn(() => new Promise(() => {}))
  }
})
const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ConversationView } = await import('../src/renderer/src/components/Conversation')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const agent = (): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: 'Pesquisadora', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
const dm: Conversation = { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }
const step = (label: string, status: Step['status'], detail?: string): Step => ({ id: label, label, status, ...(detail ? { detail } : {}) })
const cut = (steps: Step[]): Message => ({
  id: 'm1', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'Comecei.', at: 2,
  run: { status: 'interrupted', task: 'conserte o teste', steps }
})

let root: Root | undefined
beforeEach(() => {
  setLang('en')
  continueRun.mockClear()
  retryRun.mockClear()
  continueJob.mockClear()
  const mount = document.getElementById('root')!
  mount.innerHTML = ''
  root = undefined
  fake = {
    ...real.getState(),
    ready: true,
    people: [ana],
    you: 'ana',
    agents: [agent()],
    conversations: [dm],
    messages: {},
    inbox: { approvals: [], questions: [] },
    settings: { ...real.getState().settings } as Settings
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
const buttons = (): string[] => [...document.querySelectorAll('button.retry')].map((b) => b.textContent?.trim() ?? '')

describe('a reply the app cut', () => {
  it('offers Continue before Try again once a tool call came back', async () => {
    fake = { ...fake, messages: { d1: [cut([step('Thought', 'done'), step('Read src/core/runs.ts', 'done', 'src/core/runs.ts')])] } }
    await render(<ConversationView id="d1" />)
    expect(buttons()[0]).toBe('Continue')
    expect(buttons()).toContain('Try again')
  })

  it('offers only Try again when all it did was think', async () => {
    fake = { ...fake, messages: { d1: [cut([step('Thought', 'done')])] } }
    await render(<ConversationView id="d1" />)
    expect(buttons()).not.toContain('Continue')
    expect(buttons()).toContain('Try again')
  })

  it('goes on with the reply that was cut when Continue is pressed', async () => {
    fake = { ...fake, messages: { d1: [cut([step('Thought', 'done'), step('Ran npx vitest run', 'error', 'exit 1')])] } }
    await render(<ConversationView id="d1" />)
    const button = [...document.querySelectorAll('button.retry')].find((b) => b.textContent?.trim() === 'Continue')
    await act(async () => (button as unknown as { click: () => void }).click())
    expect(continueRun).toHaveBeenCalledWith('m1')
    // And it is not the same thing as trying again from the beginning.
    expect(retryRun).not.toHaveBeenCalled()
  })
})

describe('a piece of work stopped on its brakes', () => {
  const note = (stop?: { job: string }): Message => ({ id: 'n1', conversationId: 'd1', author: { kind: 'system' }, text: '**I stopped this work**: 3 replies in a row brought nothing new.\n\n**Done so far**\n- Lia: Ran the tests\n\nTo go on, click Continue, or write here what to change.', at: 3, ...(stop ? { stop } : {}) })

  it('shows the whole note with Continue, which goes on with the work', async () => {
    fake = { ...fake, messages: { d1: [note({ job: 'j1' })] } }
    await render(<ConversationView id="d1" />)
    expect(document.querySelector('.system-line--stop')?.textContent).toContain('Done so far')
    const button = [...document.querySelectorAll('button.retry')].find((b) => b.textContent?.trim() === 'Continue')
    await act(async () => (button as unknown as { click: () => void }).click())
    expect(continueJob).toHaveBeenCalledWith('n1')
  })

  it('once someone went on, the note stays without the button', async () => {
    fake = { ...fake, messages: { d1: [note()] } }
    await render(<ConversationView id="d1" />)
    expect(buttons()).not.toContain('Continue')
  })
})

describe("a request's line", () => {
  it("says what the one doing it is on right now, while it works", async () => {
    const rev: Agent = { ...agent(), id: 'a2', name: 'Rev', handle: 'rev' }
    const ch: Conversation = { id: 'c1', kind: 'channel', name: 'eng', members: ['a1', 'a2'] }
    const asked: Message = { id: 'm1', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at: 2, run: { status: 'done', steps: [], delegations: [{ id: 'dl1', to: 'a2', conversationId: 'c1', rootId: 'm1' }] } }
    const doing: Message = { id: 'm2', conversationId: 'c1', threadId: 'm1', author: { kind: 'agent', id: 'a2' }, text: '', at: 3, run: { status: 'working', steps: [step('Read the diff', 'done'), step('Running the tests', 'running')] } }
    const open = { id: 'dl1', from: 'a1', to: 'a2', conversationId: 'c1', rootId: 'm1', originConversationId: 'c1', originMessageId: 'm1', requestedBy: 'ana', text: 'review it', state: 'open' as const, createdAt: 2 }
    fake = { ...fake, agents: [agent(), rev], conversations: [ch], messages: { c1: [asked, doing] }, delegations: [open] }
    await render(<ConversationView id="c1" />)
    expect(document.querySelector('.delegation-chip .request-note__state')?.textContent).toBe('working · Running the tests')
    fake = { ...fake, messages: { c1: [asked, { ...doing, run: { ...doing.run!, status: 'done' } }] } }
    await render(<ConversationView id="c1" />)
    expect(document.querySelector('.delegation-chip .request-note__state')?.textContent).toBe('working')
  })
})
