// A finished session's last word, as it was written: the glyph in its footer puts the reply's own
// Markdown on the clipboard, not what the screen drew from it. A stopped reply qualifies when its
// words came after work had come back; a stopped shell still thinking does not.
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, RunStatus, Settings, Step } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { setLang } from '../src/shared/lang'

setLang('en')

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { innerWidth: 1280, innerHeight: 800, tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

const written: string[] = []
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: (t: string) => { written.push(t); return Promise.resolve() } }
})

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, toast: vi.fn(), voiceStatus: vi.fn(() => new Promise(() => {})) }
})
const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')

const { createRoot } = await import('react-dom/client')
const { ConversationView, CopyMarkdown } = await import('../src/renderer/src/components/Conversation')
const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/renderer/src/components/Conversation.tsx', import.meta.url), 'utf8')

let root: Root
beforeEach(() => {
  written.length = 0
  setLang('en')
  const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
  const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: 'Researcher', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
  const dm: Conversation = { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }
  fake = {
    ...real.getState(),
    ready: true,
    people: [ana],
    you: 'ana',
    agents: [lia],
    conversations: [dm],
    messages: {},
    inbox: { approvals: [], questions: [] },
    settings: { ...real.getState().settings } as Settings
  } as State
  document.getElementById('root')!.innerHTML = ''
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const step = (label: string, status: Step['status']): Step => ({ id: label, label, status })
const worked = [step('Thinking', 'done'), step('Read the report', 'done'), step('Stopped', 'error')]
const reply = (id: string, status: RunStatus, text: string, steps: Step[] = worked): Message => ({
  id, conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text, at: 2,
  run: { status, steps, receipt: { model: 'sonnet', inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, ms: 100 } }
})
const render = async (messages: Message[]): Promise<void> => {
  fake = { ...fake, messages: { d1: messages } }
  await act(async () => root.render(<ConversationView id="d1" />))
}
const glyphs = (): HTMLElement[] => [...document.querySelectorAll('.msg__meta .msg__copy')] as HTMLElement[]
const footer = (id: string): Element | null => document.querySelector(`[data-id="${id}"] .msg__meta`)

it('copies the answer’s own Markdown, and says so on the glyph for a moment', async () => {
  const md = '## Hoje\n\n- um item\n- outro, com **negrito**\n\n```ts\nconst a = 1\n```'
  await act(async () => root.render(<CopyMarkdown text={md} />))
  const button = document.querySelector('.msg__copy') as HTMLElement
  expect(button).toBeTruthy()
  expect(button.getAttribute('title')).toBe('Copy as Markdown')
  expect(button.getAttribute('aria-label')).toBe('Copy as Markdown')
  expect(button.querySelector('svg')).toBeTruthy()
  expect(button.textContent).toBe('') // a glyph, no label beside it
  await act(async () => button.click())
  expect(written).toEqual([md]) // the source, unmangled by the page
  expect(document.querySelector('.msg__copy')!.className).toContain('is-copied')
})

it('belongs to the footer of a finished reply, and to nothing else', async () => {
  // In the footer row, ahead of the numbers that footer already carries.
  const footerAt = source.indexOf('<div className="msg__meta">')
  const copy = source.indexOf('<CopyMarkdown text={message.text} />')
  const receipt = source.indexOf('<ReceiptLine receipt={message.run.receipt} />')
  expect(footerAt).toBeGreaterThan(0)
  expect(copy).toBeGreaterThan(footerAt) // inside the footer…
  expect(copy).toBeLessThan(receipt) // …at its head
  expect(source.match(/<CopyMarkdown text=/g)!.length).toBe(1) // once, on the reply row
  // A done reply, and a stopped one whose words came after a step came back. Nothing else.
  expect(source).toMatch(/message\.author\.kind === 'agent' && !!message\.text\.trim\(\) && \(message\.run\?\.status === 'done' \|\| \(message\.run\?\.status === 'stopped' && answered\(message\.run\)\)\)/)
  // Borderless and dim, like the answer glyph beside it; it only lights up under the pointer.
  expect(css).toMatch(/\.msg__copy\s*\{[^}]*color:\s*var\(--text-3\)/)
  expect(css).toMatch(/\.msg__copy\s*\{[^}]*border:\s*0/)
  expect(css).toMatch(/\.msg__copy:hover,[\s\S]{0,80}\.msg__copy\.is-copied\s*\{[^}]*color:\s*var\(--text\)/)
  // It rides the footer's own height instead of standing a button tall inside it.
  expect(css).toMatch(/\.msg__meta \.msg__copy\s*\{[^}]*min-height:\s*0/)
})

it('puts the glyph in the footer of a stopped reply that ended with an answer', async () => {
  const md = '## Result\n\n- the check passed\n- the branch is clean'
  await render([reply('m1', 'stopped', md)])
  expect(footer('m1')).toBeTruthy()
  expect(glyphs()).toHaveLength(1)
  expect(glyphs()[0]!.getAttribute('title')).toBe('Copy as Markdown')
  await act(async () => glyphs()[0]!.click())
  expect(written).toEqual([md])
})

it('leaves the stopped shell without a glyph and gives it to the continued reply that answered', async () => {
  const shell = reply('m1', 'stopped', 'Vou olhar o relatório.', [step('Thinking', 'done'), step('Stopped', 'error')])
  const continued = { ...reply('m2', 'stopped', 'The report is ready: 12 rows.', [step('Thinking', 'done'), step('Went on by itself', 'done'), step('Stopped', 'error')]), run: { ...reply('m2', 'stopped', '').run!, autoContinued: 1 } }
  await render([shell, continued])
  expect(footer('m1')).toBeTruthy() // the receipt still draws a footer
  expect(document.querySelector('[data-id="m1"] .msg__copy')).toBeNull()
  expect(document.querySelector('[data-id="m2"] .msg__copy')?.getAttribute('aria-label')).toBe('Copy as Markdown')
})

for (const status of ['working', 'waiting_input', 'waiting_approval', 'paused', 'failed', 'interrupted', 'limit_reached'] as const) {
  it(`keeps the glyph out of a ${status} reply's footer`, async () => {
    await render([reply('m1', status, '## An answer that is not finished')])
    expect(footer('m1')).toBeTruthy() // a footer, with its numbers, stays
    expect(glyphs()).toHaveLength(0)
  })
}

it('keeps the glyph out of a person’s message and an empty reply', async () => {
  const person: Message = { id: 'p1', conversationId: 'd1', author: { kind: 'person', id: 'ana' }, text: '## My own Markdown', at: 1 }
  await render([person, reply('m1', 'stopped', '   ')])
  expect(glyphs()).toHaveLength(0)
})
