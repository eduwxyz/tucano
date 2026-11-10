// The work drawer above the field: the replies running now with the prompt each answers, a way to
// stop one and to jump to it, and the prompts queued behind them. It opens by itself when it gains
// something to show, and isn't there when it has nothing.
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
const reply = (id: string, replyTo: string, text = ''): Message => ({
  id,
  conversationId: 'dm',
  author: { kind: 'agent', id: 'a1' },
  text,
  at: 2,
  run: { status: 'working', steps: [], replyTo }
})

let root: Root
const render = async (messages: Message[]): Promise<void> => {
  fake = { ...getState(), ready: true, you: 'ana', people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], messages: { dm: messages } } as State
  await act(async () => root.render(<WorkDrawer conversationId="dm" onJump={(id) => void stopped.push(`jump:${id}`)} />))
}
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
    await render([said('m1', 'oi')])
    expect(document.body.textContent).toBe('')
  })

  it('one reply at work: a handle, and the prompt it answers once opened', async () => {
    await render([said('m1', 'corrige o login', 1), reply('r1', 'm1')])
    expect(document.body.textContent).toContain('1 respondendo')
    expect(document.body.textContent).not.toContain('corrige o login') // closed: the head only
    await act(async () => button('1 respondendo').click())
    expect(document.body.textContent).toContain('corrige o login')
  })

  it('opens by itself for a second reply at work, which is the crowded case', async () => {
    await render([said('m1', 'primeiro pedido', 1), said('m2', 'segundo pedido', 3), reply('r1', 'm1'), reply('r2', 'm2')])
    expect(document.body.textContent).toContain('2 respondendo')
    expect(document.body.textContent).toContain('primeiro pedido')
    expect(document.body.textContent).toContain('segundo pedido')
  })

  it('opens by itself for a queued prompt, under its own heading', async () => {
    await render([said('m1', 'primeiro pedido', 1), { ...said('m2', 'isto pode esperar', 3), sendMode: 'queue' }, reply('r1', 'm1')])
    expect(document.body.textContent).toContain('1 na fila')
    expect(document.body.textContent).toContain('Na fila')
    expect(document.body.textContent).toContain('isto pode esperar')
  })

  it('stops one reply and jumps to another, without touching the rest', async () => {
    await render([said('m1', 'primeiro pedido', 1), said('m2', 'segundo pedido', 3), reply('r1', 'm1'), reply('r2', 'm2')])
    await act(async () => button('Parar esta resposta').click())
    expect(stopped).toEqual(['r1']) // the first stop glyph, for the first reply
    await act(async () => button('Ir para esta resposta').click())
    expect(stopped).toEqual(['r1', 'jump:r1'])
  })

  it('stays closed once a person closes it, until it has something new to show', async () => {
    await render([said('m1', 'primeiro pedido', 1), said('m2', 'segundo pedido', 3), reply('r1', 'm1'), reply('r2', 'm2')])
    await act(async () => button('2 respondendo').click())
    expect(document.body.textContent).not.toContain('primeiro pedido')
    // A third reply while it's closed doesn't reopen it: the person said no.
    await render([said('m1', 'primeiro pedido', 1), said('m2', 'segundo pedido', 3), said('m3', 'terceiro', 4), reply('r1', 'm1'), reply('r2', 'm2'), reply('r3', 'm3')])
    expect(document.body.textContent).toContain('3 respondendo')
  })
})
