// Typing @ and the start of an agent who is not in the conversation: in a channel the hint says the
// agent isn't there, in a DM it says only the DM's agent replies, since a mention there calls no one.
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
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, voiceStatus: vi.fn(() => new Promise(() => {})) }
})
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/renderer/src/components/Conversation')
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()

const agent = (id: string, name: string): Agent => ({ id, name, handle: name.toLowerCase(), role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'low', limit: 2_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }) as Agent
const lia = agent('lia', 'Lia')
const mastercard = agent('mc', 'Mastercard')

let root: Root
const hintWhenTyping = async (conversation: Conversation, typed: string): Promise<string | undefined> => {
  fake = { ...base, ready: true, people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], you: 'ana', agents: [lia, mastercard], conversations: [conversation], messages: {} } as unknown as State
  await act(async () => root.render(<Composer conversationId={conversation.id} members={[lia]} placeholder="" />))
  const field = document.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, typed)
    Object.defineProperty(field, 'selectionStart', { configurable: true, value: typed.length })
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  return document.querySelector('.mention-menu__hint')?.textContent?.trim()
}

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  setLang('pt')
})

describe('the hint for an agent outside the conversation', () => {
  const dm = { id: 'd1', kind: 'dm', name: 'lia', members: ['lia'] } as unknown as Conversation
  const channel = { id: 'c1', kind: 'channel', name: 'geral', members: ['lia'] } as unknown as Conversation

  it('says who replies in a DM, in English', async () => {
    setLang('en')
    expect(await hintWhenTyping(dm, '@maste')).toBe('Only Lia replies here; Mastercard won’t be called. Open DM')
  })
  it('says who replies in a DM, in Portuguese', async () => {
    expect(await hintWhenTyping(dm, '@maste')).toBe('Só Lia responde aqui; mencionar Mastercard não chama ninguém. Abrir DM')
  })
  it('keeps saying the agent is not in the channel', async () => {
    setLang('en')
    expect(await hintWhenTyping(channel, '@maste')).toBe('Mastercard isn’t in this channel. Open DM')
  })
  it('keeps the Portuguese channel text', async () => {
    expect(await hintWhenTyping(channel, '@maste')).toBe('Mastercard não está neste canal. Abrir DM')
  })
})
