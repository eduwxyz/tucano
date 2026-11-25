// The proceed widget: one accent control on a finished reply, a stable approval word, and an
// inactive "Approved" button after the click. No prompt box appears in the conversation.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { proceedLabel } from '../src/shared/proceed'
import type { Message } from '../src/shared/types'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null })

const { answer, submit } = vi.hoisted(() => ({
  answer: vi.fn((_id: string, _index: number, _value: unknown) => {}),
  submit: vi.fn(async (_id: string) => {})
}))
const state = { you: 'p1', people: [{ id: 'p1', name: 'You' }] }
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(state),
  teamMode: () => false,
  amAdmin: () => false,
  personById: (s: { people: { id: string }[] }, id?: string) => s.people.find((p) => p.id === id),
  answerDecision: (...args: unknown[]) => answer(args[0] as string, args[1] as number, args[2]),
  submitDecisions: (...args: unknown[]) => submit(args[0] as string),
  cancelQuestion: async () => {}
}))

const { createRoot } = await import('react-dom/client')
const { ProceedCard } = await import('../src/renderer/src/components/Decisions')
let root: ReturnType<typeof createRoot>

const PROPOSAL = 'They’re still sitting there unstaged; say the word and I’ll restore all six, one branch each.'
const message = (id: string, open: boolean): Message => ({
  id,
  conversationId: 'c1',
  author: { kind: 'agent', id: 'a1' },
  text: PROPOSAL,
  at: 1,
  run: {
    status: 'done',
    steps: [],
    depth: 1,
    questions: [{ question: PROPOSAL, kind: 'text', proceed: true }],
    ...(open ? { proceedOpen: true as const } : { answers: [{ text: 'Aprovado' }] })
  }
})

const count = (html: string, needle: string): number => html.split(needle).length - 1
const click = async (el: Element): Promise<void> => act(async () => { el.dispatchEvent(new window.Event('click', { bubbles: true })) })

beforeEach(() => {
  answer.mockReset()
  submit.mockReset().mockResolvedValue(undefined)
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => { await act(async () => root.unmount()) })

describe('the proceed widget', () => {
  it('has exactly one control, an accent button with the mockup accessibility label', () => {
    const html = renderToStaticMarkup(<ProceedCard message={message('m-proceed', true)} />)
    expect(count(html, '<button')).toBe(1)
    expect(count(html, '<input')).toBe(0)
    expect(count(html, '<textarea')).toBe(0)
    expect(count(html, '<select')).toBe(0)
    expect(html).toContain('class="btn btn--primary proceed__button"')
    expect(html).toContain('aria-label="Approve the proposed next step"')
    expect(html).not.toContain('disabled')
  })

  it('keeps one label across two renders of the same message', () => {
    const first = renderToStaticMarkup(<ProceedCard message={message('m-proceed', true)} />)
    const again = renderToStaticMarkup(<ProceedCard message={message('m-proceed', true)} />)
    expect(first).toBe(again)
    expect(first).toContain(proceedLabel('m-proceed'))
    expect(renderToStaticMarkup(<ProceedCard message={message('m-other', true)} />)).not.toBe(first)
  })

  it('is dimmed, disabled and says Approved after the reply was accepted', () => {
    const html = renderToStaticMarkup(<ProceedCard message={message('m-proceed', false)} />)
    expect(count(html, '<button')).toBe(1)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/)
    expect(html).toContain('aria-label="Approved"')
    expect(html).toContain('>Aprovado<')
    expect(html).not.toContain('Approve the proposed next step')
  })

  it('sends the approval through the answer RPC and goes inactive without writing a prompt', async () => {
    await act(async () => root.render(<ProceedCard message={message('m-click', true)} />))
    const button = document.querySelector('button')!
    expect(button.hasAttribute('disabled')).toBe(false)
    await click(button)
    expect(answer).toHaveBeenCalledWith('m-click', 0, { text: 'Aprovado' })
    expect(submit).toHaveBeenCalledWith('m-click')
    expect(document.querySelector('button')!.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('button')!.getAttribute('aria-label')).toBe('Approved')
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelectorAll('button')).toHaveLength(1)
  })
})
