// The feedback the Tuca writes (propor_feedback): a card under his reply that opens the "Enviar
// feedback" window with it, to review and send from there. He never sends it; once it went, the card says so.
import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Message } from '../src/shared/types'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
const store = new Map<string, string>()
const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
Object.assign(globalThis, { window, document, localStorage, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { localStorage })

const opened: unknown[] = []
const calls: { method: string; params: unknown }[] = []
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ platform: 'mac' }),
  amOwner: () => true,
  openDialog: (d: unknown) => void opened.push(d),
  toast: vi.fn(),
  windowless: () => true
}))
vi.mock('../src/renderer/src/rpc', () => ({ call: async (method: string, params: unknown) => void calls.push({ method, params }) }))
vi.mock('../src/renderer/src/components/Modal', () => ({ Modal: ({ title, children }: { title: string; children: ReactNode }) => <div data-title={title}>{children}</div> }))
vi.mock('../src/renderer/src/components/Update', () => ({ useUpdate: () => ({ version: '0.2.45' }) }))
vi.mock('../src/renderer/src/components/ui', () => ({ Icon: () => null }))
const { createRoot } = await import('react-dom/client')
const { FeedbackDialog, FeedbackDraftCard } = await import('../src/renderer/src/components/Feedback')
let root: ReturnType<typeof createRoot>

const reply = { id: 'm1', conversationId: 'd1', author: { kind: 'agent', id: 'tuca' }, text: 'Escrevi pra você revisar.', at: 1, run: { status: 'done', steps: [], feedbackDraft: { kind: 'idea', message: 'Um botão pra pausar uma rotina só por hoje.' } } } as unknown as Message
const html = (): string => document.getElementById('root')!.innerHTML
const button = (label: string): HTMLElement => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as unknown as HTMLElement

beforeEach(() => {
  store.clear()
  opened.length = 0
  calls.length = 0
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => act(async () => root.unmount()))

it('shows what he wrote, and opens the feedback window with it', async () => {
  await act(async () => root.render(<FeedbackDraftCard message={reply} />))
  expect(html()).toContain('Feedback pra quem faz o Tucano')
  expect(html()).toContain('Uma ideia')
  expect(html()).toContain('Um botão pra pausar uma rotina só por hoje.')
  await act(async () => button('Revisar e enviar').click())
  expect(opened).toEqual([{ kind: 'feedback', draft: { kind: 'idea', message: 'Um botão pra pausar uma rotina só por hoje.' }, from: 'm1' }])
})

it('opens the window filled in, sends what the person kept, and the card then says it went', async () => {
  await act(async () => root.render(<FeedbackDialog draft={{ kind: 'idea', message: 'Um botão pra pausar uma rotina só por hoje.' }} from="m1" onClose={() => {}} />))
  expect(document.querySelector('textarea')?.value).toBe('Um botão pra pausar uma rotina só por hoje.')
  expect(document.querySelector('[aria-checked="true"]')?.textContent).toBe('Uma ideia')
  await act(async () => button('Enviar').click())
  expect(calls).toEqual([{ method: 'sendFeedback', params: { kind: 'idea', message: 'Um botão pra pausar uma rotina só por hoje.', lang: 'pt' } }])
  await act(async () => root.render(<FeedbackDraftCard message={reply} />))
  expect(html()).toContain('enviado')
  expect(html()).not.toContain('Revisar e enviar')
})
