// Editing a prompt where it stands: the pencil in the rail on its left opens the words as a field, and
// sending posts the edited ask as a new prompt in the same place. The original stays in the room,
// because a prompt already sent is what the reply above answered.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Message } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })

const sent: { conversationId: string; text: string; threadId?: string }[] = []
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    sendMessage: (conversationId: string, text: string, _images?: unknown[], threadId?: string): void => void sent.push({ conversationId, text, ...(threadId ? { threadId } : {}) })
  }
})
const { getState } = await import('../src/renderer/src/store')
const { MessageList } = await import('../src/renderer/src/components/Conversation')
const { createRoot } = await import('react-dom/client')

const said = (id: string, text: string, at = 1): Message => ({ id, conversationId: 'dm', author: { kind: 'person', id: 'ana' }, text, at })
const reply = (id: string): Message => ({ id, conversationId: 'dm', author: { kind: 'agent', id: 'a1' }, text: 'corrigido', at: 2, run: { status: 'done', steps: [], replyTo: 'm1' } })

let root: Root
const paint = async (messages: Message[]): Promise<void> => {
  fake = {
    ...getState(),
    ready: true,
    you: 'ana',
    people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }],
    agents: [{ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, archived: false } as Agent],
    messages: { dm: messages }
  } as State
  await act(async () => root.render(<MessageList messages={messages} conversationId="dm" />))
}
const click = async (el: Element | null): Promise<void> => act(async () => { el!.dispatchEvent(new window.Event('click', { bubbles: true })) })
const pencil = (): HTMLElement | null => document.querySelector('.msg__edit')
const field = (): HTMLTextAreaElement | null => document.querySelector('.msg__edit-box textarea')
const button = (label: string): HTMLElement | null => [...document.querySelectorAll('.msg__edit-actions button')].find((b) => b.textContent === label) as HTMLElement | null

beforeEach(async () => {
  sent.length = 0
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root')!)
})

describe('a prompt of mine, edited where it stands', () => {
  it('carries a pencil in the rail on its left, and an agent reply does not', async () => {
    await paint([said('m1', 'corrige o login'), reply('r1')])
    expect(pencil()).toBeTruthy()
    expect(pencil()!.closest('.msg')!.getAttribute('data-id')).toBe('m1')
    expect(pencil()!.getAttribute('title')).toBe('Editar este pedido')
    // It wears the same box as the glyphs beside it — the thread button and the trash are 20 px icons —
    // so it stands in their column and fans out with them instead of reading as a smaller glyph out of
    // line (the geometry is pinned in test/prompt-glyphs-column.test.ts).
    expect(pencil()!.className).toContain('icon-btn')
    expect(pencil()!.className).toContain('icon-btn--sm')
    // One pencil for the one prompt in the room: the reply above has none, and nothing else offers one.
    expect(document.querySelectorAll('.msg__edit')).toHaveLength(1)
    // While the words stand as words, there is no field.
    expect(field()).toBeNull()
  })

  it('opens the words as a field, with the prompt in it, and sending posts the edited ask', async () => {
    await paint([said('m1', 'corrige o login')])
    await click(pencil())
    const box = field()!
    expect(box).toBeTruthy()
    expect(document.querySelector('.md')).toBeNull() // the words moved into the field
    // Nothing typed here: the field carries the prompt, so a send posts the prompt itself. Typing into
    // the field and the two keys are measured in the built app, where a real DOM owns the caret.
    await click(button('Enviar'))
    expect(sent).toEqual([{ conversationId: 'dm', text: 'corrige o login' }])
    expect(field()).toBeNull() // the field closed, and the prompt reads as it did
    expect(document.querySelector('.md')!.textContent).toContain('corrige o login')
  })

  it('cancel puts the words back without sending anything', async () => {
    await paint([said('m1', 'corrige o login')])
    await click(pencil())
    await click(button('Cancelar'))
    expect(sent).toEqual([])
    expect(field()).toBeNull()
    expect(document.querySelector('.md')!.textContent).toContain('corrige o login')
  })
})
