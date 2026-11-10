// The work drawer above the field: the replies running now with the prompt each answers, a way to
// stop one and to jump to it, the prompts queued behind them, and the replies that already ended —
// kept, marked with how they ended, until their row is taken off. It opens by itself when it gains
// something to show, isn't there when it has nothing, and each conversation has its own.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })

const stopped: string[] = []
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    stopRun: (id: string): void => void stopped.push(id)
  }
})
const { getState } = await import('../src/renderer/src/store')
const { WorkDrawer } = await import('../src/renderer/src/components/Conversation')
const { createRoot } = await import('react-dom/client')

const said = (id: string, text: string, at = 1): Message => ({ id, conversationId: 'dm', author: { kind: 'person', id: 'ana' }, text, at })
const reply = (id: string, replyTo: string, status: 'working' | 'done' | 'waiting_input' = 'working'): Message => ({
  id,
  conversationId: 'dm',
  author: { kind: 'agent', id: 'a1' },
  text: status === 'working' ? '' : 'feito',
  at: 2,
  run: { status, steps: [], replyTo }
})

// Each test gets its own conversation: the drawer remembers what it watched per conversation, and
// that memory outlives a mount on purpose (coming back to a channel finds its list as it was left).
let n = 0
const nextConv = (): string => `conv${++n}`

let root: Root
const render = async (conversationId: string, messages: Message[]): Promise<void> => {
  fake = { ...getState(), ready: true, you: 'ana', people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], messages: { [conversationId]: messages } } as State
  await act(async () => root.render(<WorkDrawer key={conversationId} conversationId={conversationId} onJump={(id) => void stopped.push(`jump:${id}`)} />))
}
const text = (): string => document.body.textContent ?? ''
const button = (label: string): HTMLElement => {
  const hit = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === label || b.textContent?.trim() === label)
  if (!hit) throw new Error(`no button "${label}": ${[...document.querySelectorAll('button')].map((b) => b.getAttribute('title') ?? b.textContent).join(' | ')}`)
  return hit as HTMLElement
}

beforeEach(() => {
  stopped.length = 0
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

describe('the work drawer', () => {
  it('is not there when nothing is running', async () => {
    await render(nextConv(), [said('m1', 'oi')])
    expect(text()).toBe('')
  })

  it('one reply at work: a handle, and the prompt it answers once opened', async () => {
    const conv = nextConv()
    await render(conv, [said('m1', 'corrige o login', 1), reply('r1', 'm1')])
    expect(text()).toContain('1 respondendo')
    expect(text()).not.toContain('corrige o login') // closed: the head only
    await act(async () => button('1 respondendo').click())
    expect(text()).toContain('corrige o login')
  })

  it('opens by itself for a second reply at work, which is the crowded case', async () => {
    await render(nextConv(), [said('m1', 'primeiro pedido', 1), said('m2', 'segundo pedido', 3), reply('r1', 'm1'), reply('r2', 'm2')])
    expect(text()).toContain('2 respondendo')
    expect(text()).toContain('primeiro pedido')
    expect(text()).toContain('segundo pedido')
  })

  it('opens by itself for a queued prompt, under its own heading', async () => {
    await render(nextConv(), [said('m1', 'primeiro pedido', 1), { ...said('m2', 'isto pode esperar', 3), sendMode: 'queue' }, reply('r1', 'm1')])
    expect(text()).toContain('1 na fila')
    expect(text()).toContain('Na fila')
    expect(text()).toContain('isto pode esperar')
  })

  it('stops one reply and jumps to another, without touching the rest', async () => {
    await render(nextConv(), [said('m1', 'primeiro pedido', 1), said('m2', 'segundo pedido', 3), reply('r1', 'm1'), reply('r2', 'm2')])
    await act(async () => button('Parar esta resposta').click())
    expect(stopped).toEqual(['r1']) // the first stop glyph, for the first reply
    await act(async () => button('Ir para esta resposta').click())
    expect(stopped).toEqual(['r1', 'jump:r1'])
  })

  it('the stop glyph is an x, not a square nobody reads', async () => {
    await render(nextConv(), [said('m1', 'primeiro pedido', 1), reply('r1', 'm1')])
    await act(async () => button('1 respondendo').click())
    const stop = button('Parar esta resposta')
    expect(stop.querySelector('svg rect')).toBeNull() // the old square
    expect(stop.querySelector('svg path')?.getAttribute('d')).toBe('M6 6l12 12M18 6 6 18')
  })

  it('keeps a reply that ended as a finished row, which still jumps to it', async () => {
    const conv = nextConv()
    await render(conv, [said('m1', 'corrige o login', 1), reply('r1', 'm1')])
    expect(text()).toContain('1 respondendo')
    await render(conv, [said('m1', 'corrige o login', 1), reply('r1', 'm1', 'done')])
    expect(text()).toContain('1 terminada')
    expect(text()).not.toContain('1 respondendo')
    await act(async () => button('1 terminada').click())
    expect(text()).toContain('Terminadas')
    expect(text()).toContain('corrige o login')
    await act(async () => button('Ir para esta resposta').click())
    expect(stopped).toEqual(['jump:r1'])
  })

  it('marks a failure apart from a reply that went through', async () => {
    const conv = nextConv()
    await render(conv, [said('m1', 'manda o relatório', 1), reply('r1', 'm1')])
    await render(conv, [said('m1', 'manda o relatório', 1), { ...reply('r1', 'm1', 'done'), run: { status: 'failed', steps: [], replyTo: 'm1' } }])
    await act(async () => button('1 terminada').click())
    expect(document.querySelector('.work-row__state--bad')).not.toBeNull()
    expect(document.querySelector('.work-row__state--ok')).toBeNull()
  })

  it('a finished row carries a trash that takes it off, and the drawer goes with it', async () => {
    const conv = nextConv()
    await render(conv, [said('m1', 'corrige o login', 1), reply('r1', 'm1')])
    await render(conv, [said('m1', 'corrige o login', 1), reply('r1', 'm1', 'done')])
    await act(async () => button('1 terminada').click())
    const trash = button('Tirar da lista')
    expect(trash.querySelector('svg path')?.getAttribute('d')).toContain('M4 7h16')
    await act(async () => trash.click())
    expect(text()).toBe('')
    expect(document.querySelector('.work-drawer')).toBeNull()
  })

  it('a reply waiting on a person is not finished: it never becomes a row', async () => {
    const conv = nextConv()
    await render(conv, [said('m1', 'faz o resumo', 1), reply('r1', 'm1')])
    await render(conv, [said('m1', 'faz o resumo', 1), reply('r1', 'm1', 'waiting_input')])
    expect(text()).toBe('') // the question is asked above the field, not in the drawer
  })

  it('one drawer per conversation: finished rows do not follow you to another', async () => {
    const dm = nextConv()
    const canal = nextConv()
    await render(dm, [said('m1', 'pedido do dm', 1), reply('r1', 'm1')])
    await render(dm, [said('m1', 'pedido do dm', 1), reply('r1', 'm1', 'done')])
    expect(text()).toContain('1 terminada')
    // Another channel with its own work: only its own, and its own open state.
    await render(canal, [said('x1', 'no canal', 1), reply('x2', 'x1'), reply('x3', 'x1')])
    expect(text()).toContain('2 respondendo')
    expect(text()).not.toContain('terminada')
    expect(text()).not.toContain('pedido do dm')
    // Back in the DM: what it remembered, as it was left.
    await render(dm, [said('m1', 'pedido do dm', 1), reply('r1', 'm1', 'done')])
    expect(text()).toContain('1 terminada')
  })

  it('stays closed once a person closes it, until it has something new to show', async () => {
    const conv = nextConv()
    await render(conv, [said('m1', 'primeiro pedido', 1), said('m2', 'segundo pedido', 3), reply('r1', 'm1'), reply('r2', 'm2')])
    await act(async () => button('2 respondendo').click())
    expect(text()).not.toContain('primeiro pedido')
    // A third reply while it's closed doesn't reopen it: the person said no.
    await render(conv, [said('m1', 'primeiro pedido', 1), said('m2', 'segundo pedido', 3), said('m3', 'terceiro', 4), reply('r1', 'm1'), reply('r2', 'm2'), reply('r3', 'm3')])
    expect(text()).toContain('3 respondendo')
  })
})
