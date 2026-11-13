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
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    continueRun,
    retryRun,
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
