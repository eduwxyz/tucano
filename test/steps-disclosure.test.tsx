// A compact reply stays useful without hiding the work: follow its current action, inspect its
// steps, and stop it independently. Finishing must not interrupt a manual inspection.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Step, StepsMode } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window.HTMLElement.prototype, { scrollTo: () => {} })

let fake: State
const stop = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), useLiveThought: () => undefined, stopRun: stop }
})

const { createRoot } = await import('react-dom/client')
const { getState } = await import('../src/renderer/src/store')
const { RunSteps } = await import('../src/renderer/src/components/Conversation')
const { setLang } = await import('../src/shared/lang')

const step = (extra: Partial<Step> = {}): Step => ({ id: 's1', label: 'Reading', detail: 'orders.csv', status: 'running', ...extra })
const reply = (status: NonNullable<Message['run']>['status'] = 'working', steps: Step[] = [step()]): Message => ({
  id: 'm1', conversationId: 'dm', author: { kind: 'agent', id: 'a1' }, text: '', at: Date.now(), run: { status, steps }
})

let root: Root
beforeEach(() => {
  setLang('en')
  stop.mockClear()
  fake = { ...getState(), settings: { ...getState().settings, steps: 'one-line' }, agents: [] }
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const draw = async (message: Message): Promise<void> => { await act(async () => root.render(<RunSteps message={message} />)) }
const toggle = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.steps__toggle')!
const click = async (element: HTMLElement): Promise<void> => { await act(async () => void element.dispatchEvent(new window.Event('click', { bubbles: true }))) }
const list = (): Element | null => document.querySelector('.steps__list')

describe('the one-line disclosure', () => {
  it('follows the running action and target, keeping only the first line', async () => {
    await draw(reply())
    expect(list()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().textContent).toContain('Reading…')
    expect(document.querySelector('.steps__now')?.textContent).toBe('orders.csv')

    await draw(reply('working', [step({ status: 'done' }), step({ id: 's2', label: 'Running', detail: 'npm test\r\necho later' })]))
    expect(toggle().textContent).toContain('Running…')
    expect(document.querySelector('.steps__now')?.textContent).toBe('npm test')
    expect(toggle().textContent).not.toContain('echo later')
  })

  it('falls back to input, bounds long targets, and keeps a status without a running step', async () => {
    await draw(reply('working', [step({ detail: '', input: 'x'.repeat(300) + '\nsecond line' })]))
    expect(document.querySelector('.steps__now')?.textContent).toBe('x'.repeat(200))
    await draw(reply('working', []))
    expect(toggle().textContent).toContain('Reading the request…')
    expect(document.querySelector('.steps__now')).toBeNull()
    await draw(reply('working', [step({ label: 'Thinking', detail: 'Claude Code · Sonnet', kind: 'thinking' })]))
    expect(toggle().textContent).toContain('Thinking…')
    expect(document.querySelector('.steps__now')).toBeNull()
    await draw(reply('working', [step({ status: 'done' })]))
    expect(toggle().textContent).toContain('Thinking…')
    expect(document.querySelector('.steps__now')).toBeNull()
  })

  it.each(['done', 'failed'] as const)('keeps manually opened details through %s, and lets them close again', async (status) => {
    await draw(reply())
    await click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(list()).not.toBeNull()
    expect(document.querySelector('.steps__now')).toBeNull()
    await draw(reply(status, [step({ status: status === 'failed' ? 'error' : 'done', error: status === 'failed' ? 'File missing' : undefined })]))
    expect(list()).not.toBeNull()
    if (status === 'failed') expect(list()?.textContent).toContain('File missing')
    await click(toggle())
    expect(list()).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('starts finished replies folded and lets their full history open', async () => {
    await draw(reply('done', [step({ status: 'done' }), step({ id: 's2', status: 'done' })]))
    expect(list()).toBeNull()
    expect(toggle().textContent).toContain('Done · 2 steps')
    await click(toggle())
    expect(document.querySelectorAll('.step')).toHaveLength(2)
  })

  it('offers Stop as a separate native button without toggling the details', async () => {
    await draw(reply('working', [step({ status: 'error' }), step({ id: 's2' })]))
    const button = document.querySelector<HTMLButtonElement>('button.steps__stop')!
    expect(button).not.toBeNull()
    expect(button.type).toBe('button')
    expect(toggle().contains(button)).toBe(false)
    expect(document.querySelector('.steps__failed')?.textContent).toContain('1 failed')
    expect(document.querySelector('.steps__elapsed')).not.toBeNull()
    await click(button)
    expect(stop).toHaveBeenCalledExactlyOnceWith('m1')
    expect(list()).toBeNull()
    await click(toggle())
    await click(button)
    expect(list()).not.toBeNull()
    expect(stop).toHaveBeenCalledTimes(2)
  })
})

describe('the existing list modes', () => {
  it.each(['all', 'latest'] as StepsMode[])('%s keeps current activity visible when manually folded', async (mode) => {
    fake.settings.steps = mode
    await draw(reply())
    await click(toggle())
    expect(list()).toBeNull()
    expect(document.querySelector('.steps__now')?.textContent).toBe('orders.csv')
    await draw(reply('working', [step({ detail: 'customers.csv' })]))
    expect(list()).toBeNull()
    expect(document.querySelector('.steps__now')?.textContent).toBe('customers.csv')
    await draw(reply('done', [step({ status: 'done' })]))
    expect(list()).toBeNull()
  })

  it.each(['all', 'latest'] as StepsMode[])('%s folds on completion only when it was not manually opened', async (mode) => {
    fake.settings.steps = mode
    await draw(reply())
    expect(list()).not.toBeNull()
    await draw(reply('done', [step({ status: 'done' })]))
    expect(list()).toBeNull()
    await click(toggle())
    await draw(reply('working'))
    await draw(reply('done', [step({ status: 'done' })]))
    expect(list()).not.toBeNull()
  })
})
