// Opening a conversation puts the cursor in the message field, except on a touch screen: on a
// phone that raised the keyboard over the messages the person came to read.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
let touch = false
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: (q: string) => ({ matches: q.includes('pointer: coarse') && touch }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, voiceStatus: vi.fn(() => new Promise(() => {})) }
})
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/renderer/src/components/Conversation')
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()
const channel = { id: 'c1', kind: 'channel', name: 'geral', members: [] } as unknown as Conversation

let root: Root
let focused: number
beforeEach(() => {
  fake = { ...base, ready: true, people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], you: 'ana', agents: [], conversations: [channel], messages: {} } as unknown as State
  focused = 0
  window.HTMLTextAreaElement.prototype.focus = () => void focused++
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
})

describe('the message field when a conversation opens', () => {
  it('takes the focus with a mouse and keyboard (the desktop app)', async () => {
    touch = false
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    expect(focused).toBe(1)
  })
  it('leaves it on a touch screen, so the keyboard stays down', async () => {
    touch = true
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    expect(document.querySelector('textarea')).not.toBeNull()
    expect(focused).toBe(0)
  })
})
