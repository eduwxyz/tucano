// A follow up, at the bottom of a reply that has ended: the same pill a steer is, for the reply that
// isn't running anymore. What the person writes stays in that reply — it goes on in the same row,
// resuming the session it ended with, instead of becoming another message in the conversation.
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

// What the pill sends: the reply it goes on from, and the instruction, and nothing else.
const sent = vi.hoisted(() => [] as { messageId: string; text: string }[])
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: unknown) => T): T => select({}),
    followUpRun: (messageId: string, text: string): void => {
      sent.push({ messageId, text })
    },
    sendMessage: (): void => {},
    stopRun: (): void => {}
  }
})

const { createRoot } = await import('react-dom/client')
const { RunSteps } = await import('../src/renderer/src/components/Conversation')

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
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const draw = async (message: Message): Promise<void> => {
  await act(async () => root.render(<RunSteps message={message} />))
}
const pill = (): HTMLElement | null => document.querySelector('.steps__ask-pill')
const field = (): HTMLTextAreaElement | null => document.querySelector('.steps__ask-note textarea')
const buttons = (): HTMLElement[] => [...document.querySelectorAll('.steps__ask-row button')] as HTMLElement[]
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

describe('the follow up pill', () => {
  it('is what the bottom of a finished reply shows, and a running reply shows a steer instead', async () => {
    await draw(reply('done'))
    expect(pill()?.textContent?.trim()).toBe('Seguir')
    expect(document.querySelector('.steps__list')).toBeNull() // done: the steps are folded, it is still there
    const block = document.querySelector('.steps')!
    expect(block.lastElementChild?.className).toBe('steps__ask steps__ask--down') // under the chain, last
    // A reply that's working has nothing to follow up yet: that pill says Steer.
    await draw(reply('working'))
    expect(pill()?.textContent?.trim()).toBe('Orientar')
  })

  it('is not offered for a reply that failed or was stopped: that one is tried again', async () => {
    for (const status of ['failed', 'stopped', 'interrupted', 'waiting_input'] as const) {
      await draw(reply(status))
      expect(pill()).toBeNull()
    }
  })

  it('opens a field, and sends nothing until something is written', async () => {
    await draw(reply('done'))
    expect(field()).toBeNull()
    await act(async () => pill()!.click())
    expect(field()).not.toBeNull()
    expect(field()?.getAttribute('placeholder')).toBe('O que mais?')
    expect(buttons()[0]!.hasAttribute('disabled')).toBe(true) // empty: nothing to send
    expect(sent).toHaveLength(0) // and opening it sent nothing
    await type('   ')
    expect(buttons()[0]!.hasAttribute('disabled')).toBe(true) // only spaces is still nothing
    expect(sent).toHaveLength(0)
  })

  it('hands the instruction to the reply it goes on from, and closes the field', async () => {
    await draw(reply('done'))
    await act(async () => pill()!.click())
    await type('agora escreva o resumo da última seção')
    await act(async () => buttons()[0]!.click())
    expect(sent).toEqual([{ messageId: 'm1', text: 'agora escreva o resumo da última seção' }])
    expect(field()).toBeNull() // closed on sending
  })

  it('Ctrl+Enter sends it too, and Escape closes it without sending', async () => {
    await draw(reply('done'))
    await act(async () => pill()!.click())
    await type('pelo mesmo caminho, mais um passo')
    await key('Enter', { ctrlKey: true })
    expect(sent).toEqual([{ messageId: 'm1', text: 'pelo mesmo caminho, mais um passo' }])
    expect(field()).toBeNull()
    await act(async () => pill()!.click())
    await type('isto não vai')
    await key('Escape')
    expect(field()).toBeNull()
    expect(sent).toHaveLength(1) // the escape sent nothing
  })

  it('the instruction it went on with is a row of its own in the chain, in the person’s words', async () => {
    const followup: Step = { id: 'f1', kind: 'followup', label: 'Você pediu para seguir', detail: 'agora escreva o resumo', status: 'done' }
    await draw(reply('done', [step('a'), followup, step('b')]))
    await act(async () => document.querySelector<HTMLElement>('.steps__toggle')!.click())
    const rows = [...document.querySelectorAll('.step')]
    expect(rows).toHaveLength(3)
    expect(rows[1]!.className).toBe('step step--followup') // not a tool call: it doesn't wear a call's clothes
    expect(rows[1]!.textContent).toContain('Você pediu para seguir')
    expect(rows[1]!.textContent).toContain('agora escreva o resumo')
    expect(rows[1]!.querySelector('.step__icon')).not.toBeNull()
    expect(rows[1]!.querySelector('.step__ms')).toBeNull() // it didn't run, so it has no time
  })
})
