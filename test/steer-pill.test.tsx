// The steer pill, under the box of a reply's steps while the agent works: it opens a field, what the
// person writes goes to the reply that's running (send mode `steer`) instead of becoming a message of
// its own, and the chain then says so in their words — as what it is, not as a tool call.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Step } from '../src/shared/types'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null })
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe(): void {}
    disconnect(): void {}
  }
})

// What the pill sends: the same call the composer makes, with the send mode that hands it to the run.
const sent = vi.hoisted(() => [] as { conversationId: string; text: string; mode?: string }[])
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: unknown) => T): T => select({}),
    sendMessage: (conversationId: string, text: string, _images?: unknown, _threadId?: string, _files?: unknown, mode?: string): void => {
      sent.push({ conversationId, text, mode })
    },
    stopRun: (): void => {}
  }
})

const { createRoot } = await import('react-dom/client')
const { RunBlock } = await import('../src/renderer/src/components/Conversation')

const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, label: `read ${id}.ts`, status: 'done', ms: 120, ...extra })

const reply = (status: Message['run'] extends undefined ? never : NonNullable<Message['run']>['status'], steps: Step[] = [step('a'), step('b')]): Message => ({
  id: 'm1',
  conversationId: 'c1',
  author: { kind: 'agent', id: 'a1' },
  text: 'pronto',
  at: Date.now(),
  run: { status, steps } as NonNullable<Message['run']>
})

let root: Root
beforeEach(() => {
  sent.length = 0
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const draw = async (message: Message): Promise<void> => {
  await act(async () => root.render(<RunBlock message={message} />))
}
const pill = (): HTMLElement | null => document.querySelector('.steps__steer-pill')
const field = (): HTMLTextAreaElement | null => document.querySelector('.steps__steer-note textarea')
const buttons = (): HTMLElement[] => [...document.querySelectorAll('.steps__steer-row button')] as HTMLElement[]
// Typing as React sees it: the value set past React's own tracker, then the input event.
const type = async (text: string): Promise<void> => {
  const ta = field()!
  let proto: object | null = Object.getPrototypeOf(ta)
  let set: ((v: string) => void) | undefined
  while (proto && !set) {
    set = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    proto = Object.getPrototypeOf(proto)
  }
  await act(async () => {
    set!.call(ta, text)
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
// linkedom has no KeyboardEvent: a keydown with the fields React reads, on the event itself.
const key = async (k: string, extra: { ctrlKey?: boolean } = {}): Promise<void> => {
  const ev = new window.Event('keydown', { bubbles: true }) as unknown as KeyboardEvent
  Object.defineProperty(ev, 'key', { value: k })
  Object.defineProperty(ev, 'ctrlKey', { value: !!extra.ctrlKey })
  await act(async () => void field()!.dispatchEvent(ev))
}

describe('the steer pill', () => {
  it('sits under the steps of a reply at work, and is gone once it is done', async () => {
    await draw(reply('working'))
    expect(pill()?.textContent?.trim()).toBe('Orientar')
    expect(document.querySelector('.steps__list')).not.toBeNull()
    // Under the box, not inside it: everything the run says about itself stays above the pill.
    const block = document.querySelector('.steps')!
    expect(block.querySelector('.steps__steer')).toBeNull()
    expect(block.nextElementSibling?.className).toBe('steps__steer')
    await draw(reply('done'))
    expect(pill()).toBeNull()
  })

  it('opens a field, and sends nothing until something is written', async () => {
    await draw(reply('working'))
    await act(async () => pill()!.click())
    expect(field()).not.toBeNull()
    expect(buttons()[0]!.hasAttribute('disabled')).toBe(true) // empty: nothing to send
    expect(sent).toHaveLength(0) // and opening it sent nothing
    await type('   ')
    expect(buttons()[0]!.hasAttribute('disabled')).toBe(true) // only spaces is still nothing
    expect(sent).toHaveLength(0)
  })

  it('sends what was written as a steer of the reply that is running, and closes the field', async () => {
    await draw(reply('working'))
    await act(async () => pill()!.click())
    await type('só as abertas, não mexa no resto')
    await act(async () => buttons()[0]!.click())
    expect(sent).toEqual([{ conversationId: 'c1', text: 'só as abertas, não mexa no resto', mode: 'steer' }])
    expect(field()).toBeNull() // closed on sending
  })

  it('Ctrl+Enter sends it too, and Escape closes it without sending', async () => {
    await draw(reply('working'))
    await act(async () => pill()!.click())
    await type('pelo caminho mais curto')
    await key('Enter', { ctrlKey: true })
    expect(sent).toEqual([{ conversationId: 'c1', text: 'pelo caminho mais curto', mode: 'steer' }])
    expect(field()).toBeNull()
    await act(async () => pill()!.click())
    await type('isto não vai')
    await key('Escape')
    expect(field()).toBeNull()
    expect(sent).toHaveLength(1) // the escape sent nothing
  })

  it("a steer in the chain is a row of its own, carrying the person's words whole", async () => {
    // What `steerIn` puts in the chain the moment the person sends it; the words are the row's content.
    const steer: Step = { id: 's1', kind: 'steer', label: 'Orientação', input: 'só as abertas, e o resto como está', status: 'running' }
    await draw(reply('working', [step('a'), steer])) // open while it works: the rows are there to read
    const rows = [...document.querySelectorAll('.step')]
    expect(rows).toHaveLength(2)
    const row = rows[1]!
    expect(row.className).toBe('step step--steer step--why step--running')
    expect(row.querySelector('.step__label')?.textContent).toBe('Orientação')
    // The row a call gets: its content sits in the call's own argument box, and the whole of it is a
    // click away, so what the person steered is readable in the chain without becoming a prompt.
    const said = row.querySelector('.step__input')
    expect(said?.textContent).toContain('só as abertas')
    expect(row.querySelector('.step__icon .spinner')).not.toBeNull() // still waiting for its next call
    await act(async () => said!.dispatchEvent(new window.Event('click', { bubbles: true })))
    expect(row.querySelector('.step__input')?.className).toContain('is-whole')
  })

  it('a steer the reply never read says so, in its own row', async () => {
    const steer: Step = { id: 's1', kind: 'steer', label: 'Orientação', input: 'só as abertas', error: 'A resposta terminou antes de ler isto', status: 'error' }
    await draw(reply('done', [step('a'), steer]))
    await act(async () => document.querySelector<HTMLElement>('.steps__toggle')!.click())
    const row = [...document.querySelectorAll('.step')][1]!
    expect(row.className).toContain('step--error')
    expect(row.textContent).toContain('só as abertas')
    expect(row.textContent).toContain('A resposta terminou antes de ler isto')
  })
})
