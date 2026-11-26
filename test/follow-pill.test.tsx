// The same pill on a reply that has ended: there is nothing left to steer, so it reads Follow, and what
// the person writes makes that reply go on from where it stopped (send mode `steer`, the reply's id).
// It is one pill in one place, not a second control: the label and the icon are all that change.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Step } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

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

// What the pill sends: the composer's call, with the mode and the reply it was written for.
const sent = vi.hoisted(() => [] as { conversationId: string; text: string; mode?: string; replyId?: string }[])
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    sendMessage: (conversationId: string, text: string, _images?: unknown, _threadId?: string, _files?: unknown, mode?: string, replyId?: string): void => {
      sent.push({ conversationId, text, mode, replyId })
    },
    stopRun: (): void => {}
  }
})

const { createRoot } = await import('react-dom/client')
const { getState } = await import('../src/renderer/src/store')
const { RunBlock } = await import('../src/renderer/src/components/Conversation')

const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, label: `read ${id}.ts`, status: 'done', ms: 120, ...extra })

const reply = (status: NonNullable<Message['run']>['status'], steps: Step[] = [step('a'), step('b')]): Message => ({
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
  fake = { ...getState() }
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
const key = async (k: string, extra: { ctrlKey?: boolean } = {}): Promise<void> => {
  const ev = new window.Event('keydown', { bubbles: true }) as unknown as KeyboardEvent
  Object.defineProperty(ev, 'key', { value: k })
  Object.defineProperty(ev, 'ctrlKey', { value: !!extra.ctrlKey })
  await act(async () => void field()!.dispatchEvent(ev))
}

describe('the pill on a reply that has ended', () => {
  it('is the same pill, reading Follow, in the row under the chain', async () => {
    await draw(reply('done'))
    const pills = document.querySelector('.steps__pills')!
    const follow = pills.querySelector<HTMLElement>('.steps__steer-pill')!
    expect(follow.textContent?.trim()).toMatch(/^(Seguir|Follow)$/)
    expect(follow.getAttribute('title')).toMatch(/seguir daqui|go on from here/)
    expect(document.querySelectorAll('.steps__pills')).toHaveLength(1) // one row, not a second control
    expect(document.querySelectorAll('.steps__steer-pill')).toHaveLength(1)
    expect(document.querySelector('.steps__steer')).toBeNull() // no field until it is opened
    // Where the steer sits: inside the box, in the row under the summary line. A finished reply's
    // chain is folded, so that row is the last thing the box draws.
    expect(pills.parentElement!.className).toContain('steps')
    expect(pills.parentElement!.lastElementChild).toBe(pills)
  })

  it('still reads Steer while the reply is at work', async () => {
    await draw(reply('working'))
    expect(pill()!.textContent?.trim()).toMatch(/^(Orientar|Steer)$/)
    expect(pill()!.getAttribute('title')).toMatch(/sem parar|without stopping/)
  })

  it('opens a field, sends nothing until something is written, and sends it to that same reply', async () => {
    await draw(reply('done'))
    await act(async () => pill()!.click())
    expect(field()).not.toBeNull()
    expect(field()!.getAttribute('placeholder')).toMatch(/O que mais\?|What next\?/)
    expect(buttons()[0]!.hasAttribute('disabled')).toBe(true)
    expect(sent).toHaveLength(0)
    await type('   ')
    expect(buttons()[0]!.hasAttribute('disabled')).toBe(true)
    await type('acrescente as duas correções de hoje')
    expect(buttons()[0]!.hasAttribute('disabled')).toBe(false)
    expect(sent).toHaveLength(0) // typing sends nothing
    await act(async () => buttons()[0]!.click())
    // The same call the steer makes: the mode and the reply it was written for, and no message of its own.
    expect(sent).toEqual([{ conversationId: 'c1', text: 'acrescente as duas correções de hoje', mode: 'steer', replyId: 'm1' }])
    expect(field()).toBeNull()
  })

  it('Ctrl+Enter sends it, and Escape closes it without sending', async () => {
    await draw(reply('done'))
    await act(async () => pill()!.click())
    await type('pelo caminho mais curto')
    await key('Enter', { ctrlKey: true })
    expect(sent).toEqual([{ conversationId: 'c1', text: 'pelo caminho mais curto', mode: 'steer', replyId: 'm1' }])
    expect(field()).toBeNull()
    await act(async () => pill()!.click())
    await type('isto não vai')
    await key('Escape')
    expect(field()).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('carries no pill on a reply that stopped, failed or waits for an answer', async () => {
    for (const status of ['stopped', 'failed', 'waiting_input', 'waiting_approval'] as const) {
      await draw(reply(status))
      expect(pill()).toBeNull()
    }
  })

  it('an instruction in the chain is the person’s own row, not a call of its own', async () => {
    const row: Step = { id: 'f1', kind: 'steer', label: 'Você pediu para seguir', input: 'acrescente as duas correções', status: 'done' }
    await draw(reply('done', [step('a'), row]))
    await act(async () => document.querySelector<HTMLElement>('.steps__toggle')!.click())
    const rows = [...document.querySelectorAll('.step')]
    expect(rows[1]!.className).toContain('step--steer')
    expect(rows[1]!.textContent).toContain('acrescente as duas correções')
  })
})
