import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Message } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
Object.assign(globalThis, { requestAnimationFrame: (cb: () => void): number => (cb(), 0), cancelAnimationFrame: () => {} })
const actions = vi.hoisted(() => ({ navigate: vi.fn(), openThread: vi.fn(), loadThread: vi.fn(), toast: vi.fn(), setReplyTo: vi.fn() }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, ...actions, getState: () => fake, useStore: <T,>(select: (s: State) => T): T => select(fake), voiceStatus: vi.fn(() => new Promise(() => {})) }
})
const { createRoot } = await import('react-dom/client')
const { Composer, MessageList } = await import('../src/renderer/src/components/Conversation')
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()
const original: Message = { id: 'original', conversationId: 'c1', author: { kind: 'person', id: 'bea' }, text: 'Check this part.', at: 1 }

let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  fake = {
    ...base, ready: true, you: 'ana', me: { ...base.me, name: 'Ana' },
    people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }, { id: 'bea', name: 'Bea', role: 'member', about: '' }],
    agents: [], conversations: [{ id: 'c1', kind: 'channel', name: 'general', members: [] }], messages: { c1: [original] }, replyTo: {}
  } as State
  window.HTMLTextAreaElement.prototype.focus = () => {}
  window.getSelection = () => ({ removeAllRanges: () => {} }) as unknown as Selection
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => { await act(async () => root.unmount()) })

const renderComposers = async (): Promise<void> => {
  await act(async () => root.render(<>
    <section id="channel"><Composer conversationId="c1" members={[]} placeholder="Message" /></section>
    <section id="thread"><Composer conversationId="c1" threadId="root" members={[]} placeholder="Thread" /></section>
  </>))
}

it('keeps a channel quote out of the thread composer', async () => {
  fake.replyTo = { c1: { messageId: original.id } }
  await renderComposers()
  expect(document.querySelector('#channel .composer__reply')).not.toBeNull()
  expect(document.querySelector('#thread .composer__reply')).toBeNull()
})

it('keeps a thread quote with its own draft', async () => {
  fake.replyTo = { root: { messageId: original.id, quote: 'this part' } }
  await renderComposers()
  expect(document.querySelector('#channel .composer__reply')).toBeNull()
  expect(document.querySelector('#thread .composer__reply')?.textContent).toContain('this part')
})

it('names the person being quoted, including someone who has left', async () => {
  fake.replyTo = { c1: { messageId: original.id } }
  await renderComposers()
  expect(document.querySelector('#channel .composer__reply strong')?.textContent).toContain('Bea')
  fake = { ...fake, people: fake.people.filter((p) => p.id !== 'bea'), former: [{ id: 'bea', name: 'Bea' }] }
  await renderComposers()
  expect(document.querySelector('#channel .composer__reply strong')?.textContent).toContain('Bea')
})

it('opens the original quote in its thread', async () => {
  const quoted = { ...original, threadId: 'root' }
  const reply: Message = { id: 'reply', conversationId: 'c1', author: { kind: 'person', id: 'ana' }, text: 'Please explain.', at: 2, reply: { messageId: quoted.id, author: 'Bea', text: quoted.text, at: quoted.at } }
  fake.messages = { c1: [quoted, reply] }
  await act(async () => root.render(<MessageList messages={[reply]} conversationId="c1" />))
  await act(async () => (document.querySelector('.reply-quote') as HTMLButtonElement).click())
  expect(actions.navigate).toHaveBeenCalledWith({ kind: 'conversation', id: 'c1', message: 'root' })
  expect(actions.openThread).toHaveBeenCalledWith('root', quoted.id)
})

it('loads an older original before navigating to its quote', async () => {
  const reply: Message = { id: 'reply', conversationId: 'c1', author: { kind: 'person', id: 'ana' }, text: 'Please explain.', at: 2, reply: { messageId: original.id, author: 'Bea', text: original.text, at: original.at } }
  fake.messages = { c1: [reply] }
  actions.loadThread.mockImplementationOnce(async () => { fake = { ...fake, messages: { c1: [original, reply] } } })
  await act(async () => root.render(<MessageList messages={[reply]} conversationId="c1" />))
  const quote = document.querySelector('.reply-quote') as HTMLButtonElement
  expect(quote.disabled).toBe(false)
  await act(async () => quote.click())
  expect(actions.loadThread).toHaveBeenCalledWith(original.id)
  expect(actions.navigate).toHaveBeenCalledWith({ kind: 'conversation', id: 'c1', message: original.id })
})

it('replies to the thread heading through its button and the selection shortcut', async () => {
  fake.platform = 'mac'
  await act(async () => root.render(<MessageList messages={[]} conversationId="c1" threadId="root" lead={original} />))
  await act(async () => (document.querySelector('.msg__replyto') as HTMLButtonElement).click())
  expect(actions.setReplyTo).toHaveBeenLastCalledWith('root', { messageId: original.id, quote: undefined })

  const text = document.querySelector('.msg__text')!.firstChild!
  window.getSelection = () => ({ anchorNode: text, focusNode: text, isCollapsed: false, toString: () => 'this part', removeAllRanges: () => {} }) as unknown as Selection
  await act(async () => document.dispatchEvent(new window.Event('selectionchange')))
  expect(document.querySelector('.msg__replyto')?.textContent).toContain('trecho')
  const event = new window.Event('keydown', { cancelable: true })
  Object.assign(event, { key: 'l', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })
  await act(async () => window.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
  expect(actions.setReplyTo).toHaveBeenLastCalledWith('root', { messageId: original.id, quote: 'this part' })
})
