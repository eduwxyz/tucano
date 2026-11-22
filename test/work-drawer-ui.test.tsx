// The work drawer above the field: the replies running now with the prompt each answers, a way to
// stop one and to jump to it, and the replies that already ended — kept, marked with how they ended,
// until their row is taken off. It opens by itself when it gains something to show, isn't there when
// it has nothing, and each conversation has its own. A prompt waiting its turn has no reply yet, so
// it is never a row here: it says so on its own message in the conversation.
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
const { WorkDrawer } = await import('../src/renderer/src/components/WorkDrawer')
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
  await act(async () =>
    root.render(
      <WorkDrawer
        key={conversationId}
        conversationId={conversationId}
        onJump={(id, threadId) => void stopped.push(`jump:${id}${threadId ? `@${threadId}` : ''}`)}
        onThread={(rootId) => void stopped.push(`thread:${rootId}`)}
      />
    )
  )
}
// A message inside a thread: `threadId` is the id of the message that started it.
const inThread = (m: Message, threadId: string): Message => ({ ...m, threadId })
const text = (): string => document.body.textContent ?? ''
const button = (label: string): HTMLElement => {
  const hit = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('title') === label || b.textContent?.trim() === label || (b.classList.contains('work-drawer__head') && !!b.textContent?.includes(label))
  )
  if (!hit) throw new Error(`no button "${label}": ${[...document.querySelectorAll('button')].map((b) => b.getAttribute('title') ?? b.textContent).join(' | ')}`)
  return hit as HTMLElement
}
// The thread button of the first row whose prompt is `said`, pressed: it opens the thread that reply
// lives in, or the one its own reply starts.
const threadOf = async (said: string): Promise<void> => {
  const row = [...document.querySelectorAll('.work-row')].find((r) => r.textContent?.includes(said)) as HTMLElement
  const btn = row.querySelector('.work-row__thread-btn') as HTMLElement
  await act(async () => btn.click())
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

  it('a reply that ends while you are in another conversation is a finished row when you come back', async () => {
    const here = nextConv()
    const there = nextConv()
    await render(here, [said('m1', 'o pedido daqui', 1), reply('r1', 'm1')])
    await render(there, [said('m2', 'outro assunto', 1)])
    await render(here, [said('m1', 'o pedido daqui', 1), reply('r1', 'm1', 'done')])
    expect(text()).toContain('1 terminada')
  })

  it('a reply with no prompt of its own still has a row that reads', async () => {
    const conv = nextConv()
    await render(conv, [{ ...reply('r1', 'gone'), run: { status: 'working', steps: [] } }])
    await act(async () => button('1 respondendo').click())
    expect(text()).toContain('Uma resposta')
  })

  it('a reply at work inside a thread is work here too: its row opens that thread, and one outside opens its own', async () => {
    const conv = nextConv()
    await render(conv, [
      said('m1', 'primeiro pedido', 1),
      said('t1', 'a thread do orçamento', 2),
      inThread(said('t2', 'segue o anexo', 3), 't1'),
      reply('r1', 'm1'),
      inThread(reply('r2', 't2'), 't1')
    ])
    expect(text()).toContain('2 respondendo') // the one outside, and the one in the thread
    expect(text()).toContain('primeiro pedido')
    expect(text()).toContain('segue o anexo')
    // One thread button per row, the glyph alone: the row says which thread only in its tooltip, so
    // a long thread title can't push the row onto a second line.
    expect(document.querySelectorAll('.work-row__thread-btn').length).toBe(2)
    expect(document.body.textContent).not.toContain('a thread do orçamento')
    const inThreadBtn = [...document.querySelectorAll('.work-row')].find((r) => r.textContent?.includes('segue o anexo'))!.querySelector('.work-row__thread-btn') as HTMLElement
    expect(inThreadBtn.getAttribute('title')).toContain('a thread do orçamento') // named in the tooltip, in its own words
    await threadOf('segue o anexo')
    expect(stopped).toEqual(['thread:t1']) // the thread it lives in, not its own id
    await threadOf('primeiro pedido')
    expect(stopped).toEqual(['thread:t1', 'thread:r1']) // a reply outside a thread opens the one it starts
    // Pressing the row itself still jumps into the thread, not to a message in the room.
    const go = [...document.querySelectorAll('.work-row__go')].find((b) => b.textContent?.includes('segue o anexo')) as HTMLElement
    await act(async () => go.click())
    expect(stopped).toEqual(['thread:t1', 'thread:r1', 'jump:r2@t1'])
  })

  it('stops a reply that lives in a thread like any other, without touching the rest', async () => {
    const conv = nextConv()
    await render(conv, [said('t1', 'a thread do orçamento', 1), inThread(reply('r2', 't1'), 't1')])
    expect(text()).toContain('1 respondendo')
    await act(async () => button('1 respondendo').click())
    await act(async () => button('Parar esta resposta').click())
    expect(stopped).toEqual(['r2'])
  })

  it('a reply that ended inside a thread stays as a finished row, with its thread button, and still jumps', async () => {
    const conv = nextConv()
    const messages = (status: 'working' | 'done'): Message[] => [said('t1', 'a thread do orçamento', 1), inThread(reply('r2', 't1', status), 't1')]
    await render(conv, messages('working'))
    await render(conv, messages('done'))
    expect(text()).toContain('1 terminada')
    await act(async () => button('1 terminada').click())
    expect(document.querySelectorAll('.work-row--done .work-row__thread-btn').length).toBe(1)
    await threadOf('a thread do orçamento')
    expect(stopped).toEqual(['thread:t1'])
    await act(async () => button('Ir para esta resposta').click())
    expect(stopped).toEqual(['thread:t1', 'jump:r2@t1'])
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
