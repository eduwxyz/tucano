// The drawer above the message field: the replies running here now, and the prompts waiting their
// turn. A row is where that reply is, or stops that one reply; the queued ones say so.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, State } from '../src/renderer/src/store'

// The rows are real buttons: they are clicked here, in a DOM that has them.
const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe(): void {}
    disconnect(): void {}
  }
})

const stopped: string[] = []
const jumped: string[] = []
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    stopRun: (id: string): void => void stopped.push(id),
    jumpToMessage: (id: string): void => void jumped.push(id)
  }
})
const { getState } = await import('../src/renderer/src/store')
const { SessionDrawer, drawerOpen, oneLine } = await import('../src/renderer/src/components/Sessions')
const { createRoot } = await import('react-dom/client')

const agent = { id: 'a1', handle: 'lia', name: 'Lia', role: 'Writer', color: 'sky', kind: 'team', limit: 0, used: 0, instructions: '', effort: 'medium', model: 'haiku', web: false, connectors: [], skills: [], routines: [], archived: false } as unknown as State['agents'][number]
const other = { ...agent, id: 'a2', handle: 'theo', name: 'Theo', color: 'green' } as State['agents'][number]

const said = (id: string, text: string, at: number, extra: Partial<Message> = {}): Message =>
  ({ id, conversationId: 'c1', author: { kind: 'person', id: 'me' }, text, at, ...extra }) as Message
const reply = (id: string, who: string, at: number, replyTo?: string): Message =>
  ({ id, conversationId: 'c1', author: { kind: 'agent', id: who }, text: '', at, run: { status: 'working', steps: [], replyTo } }) as Message

const NOW = Date.now()
const prompt1 = said('p1', 'Publica o post de **hoje**?\n\nObrigado!', NOW - 70_000)
const run1 = reply('r1', 'a1', NOW - 65_000, 'p1')
const prompt2 = said('p2', 'Agora o resumo semanal', NOW - 30_000)
const run2 = reply('r2', 'a2', NOW - 29_000, 'p2')
const queued = said('q1', 'depois: revisa o [texto](http://x)', NOW - 10_000, { sendMode: 'queue' })

const withMessages = (list: Message[]): void => {
  fake = { ...getState(), ready: true, messages: { c1: list }, agents: [agent, other], history: {} }
}
const html = (): string => renderToStaticMarkup(<SessionDrawer conversationId="c1" />)

beforeEach(() => {
  stopped.length = 0
  jumped.length = 0
  withMessages([])
})

describe('a row of the drawer', () => {
  it('is one line: Markdown marks out, a link keeps its words, the breaks collapsed', () => {
    expect(oneLine('Publica o post de **hoje**?\n\nObrigado!')).toBe('Publica o post de hoje? Obrigado!')
    expect(oneLine('revisa o [texto](http://x) e `isto`')).toBe('revisa o texto e isto')
    expect(oneLine('![a](b.png) olha só')).toBe('olha só')
    expect(oneLine('  # Título  ')).toBe('Título')
  })
})

describe('whether the drawer is open', () => {
  it('opens by itself when something is queued or two replies run at once', () => {
    expect(drawerOpen(true, true, null, '2/0')).toBe(true)
    expect(drawerOpen(true, false, null, '1/0')).toBe(false)
  })

  it('keeps a person’s choice for what it was made about, and gives it up when that changes', () => {
    const choice = { key: '2/0', open: false }
    expect(drawerOpen(true, true, choice, '2/0')).toBe(false) // closed by hand, stays closed
    expect(drawerOpen(true, true, choice, '2/1')).toBe(true) // a prompt queued: back open
  })

  it('has nothing to show when nothing runs and nothing waits', () => {
    expect(drawerOpen(false, false, { key: '0/0', open: true }, '0/0')).toBe(false)
  })
})

describe('the drawer itself', () => {
  it('renders nothing at all when there is nothing to say', () => {
    withMessages([prompt1])
    expect(html()).toBe('')
  })

  it('lists each reply with the prompt it answers, and says how long it has been at it', () => {
    withMessages([prompt1, run1, prompt2, run2])
    const out = html()
    expect(out).toContain('2 respostas ao vivo')
    expect(out).toContain('Lia')
    expect(out).toContain('Publica o post de hoje? Obrigado!')
    expect(out).toContain('Agora o resumo semanal')
    expect(out).toMatch(/drawer__meta">1 min 5s/)
    expect(out).not.toContain('Na fila')
    expect(out.match(/drawer__stop/g)).toHaveLength(2)
  })

  it('groups the prompts still waiting their turn, with the one after it', () => {
    withMessages([prompt1, run1, queued])
    const out = html()
    expect(out).toContain('1 resposta ao vivo · 1 na fila')
    expect(out).toContain('Na fila')
    expect(out).toContain('depois: revisa o texto')
    expect(out).toContain('esperando a vez')
    expect(out).toContain('drawer__stop')
  })

  it('shows one reply and nothing queued as a single closed line, to open if wanted', () => {
    withMessages([prompt1, run1])
    const out = html()
    expect(out).toContain('1 resposta ao vivo')
    expect(out).toContain('Ver')
    expect(out).not.toContain('drawer__body')
  })
})

describe('clicking in the drawer', () => {
  let root: Root
  const mount = (): HTMLElement => {
    root = createRoot(document.getElementById('root')!)
    act(() => root.render(<SessionDrawer conversationId="c1" />))
    return document.getElementById('root')!
  }
  afterEach(() => act(() => root.unmount()))

  it('goes where the reply is when its row is clicked', () => {
    withMessages([prompt1, run1, prompt2, run2])
    const el = mount()
    const row = el.querySelectorAll('.drawer__row .drawer__go')[1] as HTMLElement
    act(() => row.click())
    expect(jumped).toEqual(['r2'])
    expect(stopped).toEqual([])
  })

  it('stops that one reply, and only that one, from the glyph on its row', () => {
    withMessages([prompt1, run1, prompt2, run2])
    const el = mount()
    act(() => (el.querySelectorAll('.drawer__stop')[0] as HTMLElement).click())
    expect(stopped).toEqual(['r1'])
    expect(jumped).toEqual([])
  })

  it('a queued row goes to the prompt that is waiting', () => {
    withMessages([prompt1, run1, queued])
    const el = mount()
    act(() => (el.querySelector('.drawer__go--queued') as HTMLElement).click())
    expect(jumped).toEqual(['q1'])
  })

  it('opens and closes from its head', () => {
    withMessages([prompt1, run1])
    const el = mount()
    expect(el.querySelector('.drawer__body')).toBeNull()
    act(() => (el.querySelector('.drawer__head') as HTMLElement).click())
    expect(el.querySelector('.drawer__body')).not.toBeNull()
    act(() => (el.querySelector('.drawer__head') as HTMLElement).click())
    expect(el.querySelector('.drawer__body')).toBeNull()
  })
})
