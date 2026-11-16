// Typing @ in a conversation lists the agents who are not in it, one row each with its own Open DM.
// In a channel the header says they are outside it; in a DM it says only the DM's agent replies,
// since a mention there calls no one.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, Conversation } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false }) })
Object.assign(window, { tucano: {} })
// React only listens for typing when the document has an oninput, which linkedom lacks.
Object.assign(document, { oninput: null })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
const openDm = vi.fn()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, openDm: (id: string) => openDm(id), useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, voiceStatus: vi.fn(() => new Promise(() => {})) }
})
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/renderer/src/components/Conversation')
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()

const agent = (id: string, name: string): Agent => ({ id, name, handle: name.toLowerCase(), role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'low', limit: 2_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }) as Agent
const lia = agent('lia', 'Lia')
const leo = agent('leo', 'Leo')
const mastercard = agent('mc', 'Mastercard')
const theo = agent('theo', 'Theo')

let root: Root
const type = async (conversation: Conversation, typed: string): Promise<void> => {
  fake = { ...base, ready: true, people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], you: 'ana', agents: [lia, leo, mastercard, theo], conversations: [conversation], messages: {} } as unknown as State
  await act(async () => root.render(<Composer conversationId={conversation.id} members={[lia]} placeholder="" />))
  const field = document.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, typed)
    Object.defineProperty(field, 'selectionStart', { configurable: true, value: typed.length })
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const header = (): string | undefined => document.querySelector('.mention-menu__hint')?.textContent?.trim()
const rows = (): string[] => [...document.querySelectorAll('.mention-menu__outsider')].map((r) => r.querySelector('strong')!.textContent!)

beforeEach(() => {
  root = createRoot(document.getElementById('root')!)
  openDm.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  setLang('pt')
})

const dm = { id: 'd1', kind: 'dm', name: 'lia', members: ['lia'] } as unknown as Conversation
const channel = { id: 'c1', kind: 'channel', name: 'geral', members: ['lia'] } as unknown as Conversation

describe('the agents outside the conversation', () => {
  it('lists one row for each, with its own Open DM', async () => {
    await type(dm, '@')
    expect(rows()).toEqual(['Leo', 'Mastercard', 'Theo'])
    expect(document.querySelectorAll('.mention-menu__outsider button')).toHaveLength(3)
  })
  it('opens the DM of the row that was clicked', async () => {
    await type(dm, '@')
    const button = document.querySelectorAll('.mention-menu__outsider button')[1]!
    await act(async () => void button.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })))
    expect(openDm).toHaveBeenCalledExactlyOnceWith('mc')
  })
  it('does not open a DM on a mouse press, which only keeps the focus in the composer', async () => {
    await type(dm, '@')
    const press = new window.Event('mousedown', { bubbles: true, cancelable: true })
    await act(async () => void document.querySelector('.mention-menu__outsider button')!.dispatchEvent(press))
    expect(press.defaultPrevented).toBe(true)
    expect(openDm).not.toHaveBeenCalled()
  })
  it('is a real button, so Enter and Space activate it as a click', async () => {
    await type(dm, '@')
    const button = document.querySelector('.mention-menu__outsider button')!
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type') ?? 'button').toBe('button')
    expect(button.hasAttribute('tabindex')).toBe(false)
  })
  it('narrows the list to the typed name', async () => {
    await type(dm, '@th')
    expect(rows()).toEqual(['Theo'])
  })
  it('says who replies in a DM, in English', async () => {
    setLang('en')
    await type(dm, '@th')
    expect(header()).toBe('Only Lia replies here; mentioning these won’t call them.')
  })
  it('says who replies in a DM, in Portuguese', async () => {
    await type(dm, '@th')
    expect(header()).toBe('Só Lia responde aqui; mencioná-los não chama ninguém.')
  })
  it('says they are outside a channel, in English', async () => {
    setLang('en')
    await type(channel, '@th')
    expect(header()).toBe('Not in this channel')
  })
  it('says they are outside a channel, in Portuguese', async () => {
    await type(channel, '@th')
    expect(header()).toBe('Fora deste canal')
  })
  it('starts with no divider when no member is listed above', async () => {
    await type(dm, '@th')
    expect(document.querySelector('.mention-menu__item')).toBeNull()
    expect(document.querySelector('.mention-menu__hint')!.classList.contains('has-divider')).toBe(false)
  })
  it('draws the divider when members are listed above', async () => {
    await type(dm, '@l')
    expect(document.querySelector('.mention-menu__item')).not.toBeNull()
    expect(rows()).toEqual(['Leo'])
    expect(document.querySelector('.mention-menu__hint')!.classList.contains('has-divider')).toBe(true)
  })
})
