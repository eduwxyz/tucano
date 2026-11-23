// The keys the message field answers to: Enter sends a prompt, which starts its own reply (or waits its
// turn past the conversation's limit, in the core), and Shift+Enter is the line break it has always been.
// The field writes to the conversation, never into a running reply: no key there steers or interrupts one
// (a reply is steered from its own pill, and stopped with Parar).
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

// What the field sent: the text, and whether it asked for anything beyond a plain prompt.
const modeOf = (): unknown => sent[0]?.[5]

describe('the keys that send from the message field', () => {
  it('Shift+Enter is a new line, and nothing is sent', async () => {
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    await type('primeira')
    const prevented = await press({ key: 'Enter', shiftKey: true })
    expect(prevented).toBe(false) // the field's own line break, left alone
    expect(sent).toHaveLength(0)
  })

  it('Enter sends a plain prompt', async () => {
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    await type('mais uma')
    expect(await press({ key: 'Enter' })).toBe(true)
    expect(sent).toHaveLength(1)
    expect(modeOf()).toBeUndefined()
  })

  it('no modifier steers, queues or interrupts: Ctrl, Alt and Shift+Alt with Enter send the same plain prompt', async () => {
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    for (const held of [{ ctrlKey: true }, { altKey: true }, { altKey: true, shiftKey: true }]) {
      sent.length = 0
      await type('isto')
      await press({ key: 'Enter', ...held })
      expect(modeOf()).toBeUndefined()
    }
  })

  it('an old setting from before is ignored: Enter is still a plain prompt', async () => {
    fake = { ...fake, settings: { sendMode: 'steer' } } as unknown as State
    await act(async () => root.render(<Composer conversationId="c1" members={[]} placeholder="Mensagem" />))
    await type('então')
    expect(await press({ key: 'Enter' })).toBe(true)
    expect(modeOf()).toBeUndefined()
  })
})
