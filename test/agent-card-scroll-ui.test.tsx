import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
const { window, document } = parseHTML('<html><body><div id="root"></div><header><button id="dm-header">Lia</button></header><div id="messages"><button id="message-avatar">Lia</button></div></body></html>')
class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, ResizeObserver: ResizeObserverStub, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { ResizeObserver: ResizeObserverStub, innerWidth: 1200, innerHeight: 800 })

const lia = { id: 'lia', name: 'Lia', handle: 'lia', color: 'sky', modelId: 'sonnet', archived: false, kind: 'agent', role: '' } as unknown as Agent
let fake: Pick<State, 'view' | 'messages' | 'conversations'>
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(fake),
  agentById: () => lia,
  modelById: () => undefined,
  canDecide: () => true,
  personName: () => '',
  navigate: vi.fn(),
  openDialog: vi.fn(),
  openDm: vi.fn()
}))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null, Icon: () => null, ago: () => '', ownColor: () => ({}) }))
const { createRoot } = await import('react-dom/client')
const { AgentCardLayer, openAgentCard, closeAgentCard } = await import('../src/renderer/src/components/AgentCard')
let root: ReturnType<typeof createRoot>
type ScrollListener = (e: { target: EventTarget | null }) => void
const scrollListeners = new Set<ScrollListener>()
const addListener = window.addEventListener.bind(window)
const removeListener = window.removeEventListener.bind(window)
Object.assign(window, {
  addEventListener: (type: string, listener: ScrollListener, capture?: boolean) => (type === 'scroll' ? scrollListeners.add(listener) : addListener(type, listener, capture)),
  removeEventListener: (type: string, listener: ScrollListener, capture?: boolean) => (type === 'scroll' ? scrollListeners.delete(listener) : removeListener(type, listener, capture))
})

beforeEach(async () => {
  fake = { view: { kind: 'conversation', id: 'dm' }, messages: {}, conversations: [] } as unknown as typeof fake
  root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<AgentCardLayer />))
})
afterEach(async () => {
  await act(async () => closeAgentCard())
  await act(async () => root.unmount())
})

const anchor = (id: string): HTMLElement => document.getElementById(id) as unknown as HTMLElement
const openFrom = async (id: string): Promise<void> => act(async () => openAgentCard('lia', anchor(id)))
const cardShown = (): boolean => !!document.querySelector('.agent-card')
// linkedom neither carries scroll events from an element up to the window's capture listeners
// nor keeps a `target` set on an event, so the window's `scroll` listeners (the ones the app
// registers with capture) are recorded above and called directly with the scrolled element as target.
const scroll = async (scrolled: HTMLElement): Promise<void> => act(async () => [...scrollListeners].forEach((listener) => listener({ target: scrolled as unknown as EventTarget })))

it('keeps a card opened from the DM header while the message list auto-scrolls during a run', async () => {
  await openFrom('dm-header')
  expect(cardShown()).toBe(true)
  await act(async () => {
    fake = { ...fake, messages: { dm: [] } }
    root.render(<AgentCardLayer />)
  })
  await scroll(anchor('messages'))
  expect(cardShown()).toBe(true)
})

it('closes a card whose anchor sits inside the scrolled message list', async () => {
  await openFrom('message-avatar')
  expect(cardShown()).toBe(true)
  await scroll(anchor('messages'))
  expect(cardShown()).toBe(false)
})
