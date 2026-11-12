// The block that shows the model's thinking follows the reply it belongs to: open and scrolling
// while it thinks, folded to the last line it thought once the reply is over, and the whole of it
// one click away. It stays out of the way of what the reply offers at its bottom.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
window.Element.prototype.scrollTo = () => {} // the block keeps itself at the last line; linkedom has no scrolling
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

let fake: Pick<State, 'settings'>
let thought: string | undefined
vi.mock('../src/renderer/src/store', () => ({ useStore: (select: (s: unknown) => unknown) => select(fake), useLiveThought: () => thought }))

const { createRoot } = await import('react-dom/client')
const { Thought } = await import('../src/renderer/src/components/Conversation')

const message: Message = { id: 'm1', conversationId: 'dm', author: { kind: 'agent', id: 'a1' }, text: '', at: 1 }
let root: ReturnType<typeof createRoot>

const draw = async (working: boolean): Promise<void> => {
  await act(async () => root.render(<Thought message={message} working={working} />))
}
const block = (): Element | null => document.querySelector('.thought')
const head = (): Element => document.querySelector('.thought__head')!
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new window.Event('click', { bubbles: true }))
  })
}

beforeEach(() => {
  fake = { settings: { showThinking: true } as Settings }
  thought = 'o pedido tem duas partes.\nprimeiro a conta.'
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
})

describe('the thinking block', () => {
  it('is open and arriving while the reply works: the whole text, and a cursor on the line it is writing', async () => {
    await draw(true)
    expect(block()!.className).toContain('is-open')
    expect(block()!.className).toContain('is-working')
    expect(document.querySelector('.thought__text')!.textContent).toContain('primeiro a conta.')
    expect(document.querySelector('.thought__caret')).not.toBeNull()
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(head().textContent).toContain('Pensando')
  })

  it('folds itself once the reply is over, saying only the line it ended on', async () => {
    await draw(false)
    expect(block()!.className).not.toContain('is-open')
    expect(head().getAttribute('aria-expanded')).toBe('false')
    expect(head().textContent).toContain('Pensou')
    expect(document.querySelector('.thought__last')!.textContent).toBe('primeiro a conta.')
    expect(document.querySelector('.thought__text')).toBeNull()
    expect(document.querySelector('.thought__caret')).toBeNull()
  })

  it('opens again on a click, the whole of it, and folds back on the next', async () => {
    await draw(false)
    await click(head())
    expect(document.querySelector('.thought__text')!.textContent).toContain('o pedido tem duas partes.')
    expect(head().getAttribute('aria-expanded')).toBe('true')
    await click(head())
    expect(document.querySelector('.thought__text')).toBeNull()
  })

  it('keeps a person’s choice while the reply is still working', async () => {
    await draw(true)
    await click(head())
    expect(document.querySelector('.thought__text')).toBeNull()
  })

  it('is nothing at all while it has thought nothing, or with the switch off', async () => {
    await draw(true)
    thought = undefined
    await draw(true)
    expect(block()).toBeNull()
    thought = 'algo'
    fake = { settings: { showThinking: false } as Settings }
    await draw(true)
    expect(block()).toBeNull()
  })
})
