// What comes back from handed work arrives where it was asked as a line: an answer folded, one click
// away, and a question open by itself. The question is the one thing in that conversation waiting on
// the person, and its own text says what it wrote before asking — folding it means clicking to read
// the only thing that needs them. (#376)
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
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
    navigate: vi.fn(),
    retryRun: vi.fn(async () => {}),
    continueRun: vi.fn(async () => {}),
    setTab: vi.fn(),
    voiceStatus: vi.fn(() => new Promise(() => {}))
  }
})
const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ConversationView } = await import('../src/renderer/src/components/Conversation')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: 'Researcher', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const dm: Conversation = { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }
// Her own channel, where the work was handed to her: the line points at it, and it isn't this one.
const hers: Conversation = { id: 'x1', kind: 'channel', name: 'clientes', members: ['a1'] }

// What Theo (here Lia) sent back, in the conversation where the work was asked for: an answer, or a
// question — which goes up without `back`, exactly as the runner writes it.
const handed = (what: 'answer' | 'question'): Message => ({
  id: what,
  conversationId: 'd1',
  author: { kind: 'agent', id: 'a1' },
  text:
    what === 'answer'
      ? 'About the request in #clientes:\n\nTwo decisions went your way.'
      : 'A question about the request in #clientes:\n\nPagination in the menu? (Remote search | Infinite scroll)',
  at: 3,
  run: { status: 'done', steps: [], delegation: { id: 'dl1', to: 'a1', conversationId: 'x1', rootId: 'r1', ...(what === 'answer' ? { back: 'result' as const } : {}) } }
})

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
    agents: [lia],
    conversations: [dm, hers],
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
const fold = (): HTMLElement | null => document.querySelector('.returned-line button.link')

describe('what comes back from handed work', () => {
  it('keeps an answer folded, and says so', async () => {
    fake = { ...fake, messages: { d1: [handed('answer')] } }
    await render(<ConversationView id="d1" />)
    expect(document.querySelector('.returned-line')?.textContent).toContain('Lia answered')
    expect(fold()?.getAttribute('aria-expanded')).toBe('false')
    expect(fold()?.textContent).toBe('See the answer')
    expect(document.querySelector('.returned-line__body')).toBeNull()
  })

  it('opens a question by itself, with what it asked in full', async () => {
    fake = { ...fake, messages: { d1: [handed('question')] } }
    await render(<ConversationView id="d1" />)
    expect(document.querySelector('.returned-line')?.textContent).toContain('Lia has a question')
    expect(fold()?.getAttribute('aria-expanded')).toBe('true')
    expect(fold()?.textContent).toBe('Fold')
    expect(document.querySelector('.returned-line__body')?.textContent).toContain('Pagination in the menu?')
  })

  it('still folds it when the person presses Fold', async () => {
    fake = { ...fake, messages: { d1: [handed('question')] } }
    await render(<ConversationView id="d1" />)
    await act(async () => fold()!.click())
    expect(fold()?.getAttribute('aria-expanded')).toBe('false')
    expect(fold()?.textContent).toBe('See the question')
  })
})
