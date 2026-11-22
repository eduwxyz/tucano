// The keys the message field answers to while a reply may be running somewhere: Enter does what the
// setting says, and a modifier picks one of the four ways, once, whatever the setting says. Shift+Enter
// is the line break it has always been, so the queue sits on Ctrl+Enter (Cmd+Enter on a Mac).
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: (q: string) => ({ matches: q.includes('pointer: coarse') }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })

let fake: State
const { sent } = vi.hoisted(() => ({ sent: [] as unknown[][] }))
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    voiceStatus: vi.fn(() => new Promise(() => {})),
    sendMessage: (...args: unknown[]): void => void sent.push(args)
  }
})
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/renderer/src/components/Conversation')
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()
const channel = { id: 'c1', kind: 'channel', name: 'geral', members: [] } as unknown as Conversation

let root: Root
beforeEach(() => {
  fake = { ...base, ready: true, people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], you: 'ana', agents: [], conversations: [channel], messages: {}, settings: {} } as unknown as State
  sent.length = 0
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
})

// The field has to be the one React is watching (a focusin first: without it the value tracker has no
// active element, and a keydown there throws inside React's own polyfill for linkedom's missing events).
const focusField = async (): Promise<void> => {
  const field = document.querySelector('textarea')!
  const proto = window.HTMLTextAreaElement.prototype as unknown as { attachEvent?: () => void; detachEvent?: () => void }
  proto.attachEvent ??= () => {}
  proto.detachEvent ??= () => {}
  await act(async () => {
    field.dispatchEvent(new window.Event('focusin', { bubbles: true }))
  })
}

// The text the person typed, as React sees it: the field's own setter, then the event it listens for.
const type = async (text: string): Promise<void> => {
  const field = document.querySelector('textarea') as unknown as { value: string; dispatchEvent: (e: unknown) => boolean }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype as object, 'value')?.set
  await focusField()
  await act(async () => {
    if (setter) setter.call(field, text)
    else field.value = text
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

// A keydown on that same field, with the modifiers a person would be holding.
const press = async (init: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): Promise<boolean> => {
  const field = document.querySelector('textarea')!
  const e = new window.Event('keydown', { bubbles: true, cancelable: true })
  Object.assign(e, { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...init })
  let prevented = false
  const preventDefault = (): void => {
    prevented = true
  }
  Object.assign(e, { preventDefault })
  await act(async () => {
    field.dispatchEvent(e)
  })
  return prevented
}

const modeOf = (): unknown => sent[0]?.[5]

describe('the keys that send from the message field', () => {
  it('Shift+Enter is a new line, never a queue, and nothing is sent', async () => {
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    await type('primeira')
    const prevented = await press({ key: 'Enter', shiftKey: true })
    expect(prevented).toBe(false) // the field's own line break, left alone
    expect(sent).toHaveLength(0)
  })

  it('Ctrl+Enter queues, whatever the setting says', async () => {
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    await type('isto depois')
    expect(await press({ key: 'Enter', ctrlKey: true })).toBe(true)
    expect(sent).toHaveLength(1)
    expect(modeOf()).toBe('queue')
  })

  it('Alt+Enter hands it to the reply, and Shift+Alt+Enter interrupts it', async () => {
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    await type('mude de plano')
    expect(await press({ key: 'Enter', altKey: true })).toBe(true)
    expect(modeOf()).toBe('steer')
    sent.length = 0
    await type('pare')
    expect(await press({ key: 'Enter', altKey: true, shiftKey: true })).toBe(true)
    expect(modeOf()).toBe('interrupt')
  })

  it('Enter alone follows the setting: parallel, until it says otherwise', async () => {
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    await type('mais uma')
    expect(await press({ key: 'Enter' })).toBe(true)
    expect(modeOf()).toBe('parallel')
  })

  it('Enter alone follows the setting: whatever it is set to, with no modifier held', async () => {
    fake = { ...fake, settings: { sendMode: 'steer' } } as unknown as State
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    await type('então')
    expect(await press({ key: 'Enter' })).toBe(true)
    expect(modeOf()).toBe('steer')
  })
})

