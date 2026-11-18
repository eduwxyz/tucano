// A message from an agent that runs on the person's own computer carries the laptop icon after the
// time, the same mark as the sidebar, in place of a "on your computer" pill.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, navigate: vi.fn(), voiceStatus: vi.fn(() => new Promise(() => {})) }
})
const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ConversationView } = await import('../src/renderer/src/components/Conversation')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: 'Researcher', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: true, computerKind: 'mac', archived: false }
const dm: Conversation = { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }
const said = (id: string, at: number, run = true): Message => ({ id, conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'Done.', at, ...(run ? { run: { status: 'done' as const, steps: [] } } : {}) })

let root: Root | undefined
const show = async (agent: Agent, messages: Message[]): Promise<void> => {
  fake = { ...real.getState(), ready: true, people: [ana], you: 'ana', agents: [agent], conversations: [dm], messages: { d1: messages }, inbox: { approvals: [], questions: [] }, settings: { ...real.getState().settings, sidebarParts: undefined } as Settings } as State
  if (root) await act(async () => root!.unmount())
  const host = document.createElement('div')
  document.getElementById('root')!.append(host)
  root = createRoot(host)
  const mounted = root
  await act(async () => mounted.render(<ConversationView id="d1" />))
}
beforeEach(() => {
  setLang('en')
  document.getElementById('root')!.innerHTML = ''
  root = undefined
})

describe('the message header of an agent on your computer', () => {
  it('shows the laptop icon after the time, with its name for assistive tech and on hover', async () => {
    await show(lia, [said('m1', 1)])
    const head = document.querySelector('.msg__head')!
    const mark = head.querySelector('.mac-mark')!
    expect(mark.getAttribute('aria-label')).toBe('On your computer')
    expect(mark.getAttribute('title')).toBe('On your computer')
    const kids = [...head.children]
    expect(kids.indexOf(mark)).toBe(kids.indexOf(head.querySelector('.msg__time')!) + 1)
    expect(head.querySelector('.tag')).toBeNull()
    expect(head.textContent?.toLowerCase()).not.toContain('on your computer')
  })

  it('speaks Portuguese when the app does', async () => {
    setLang('pt')
    await show(lia, [said('m1', 1)])
    expect(document.querySelector('.mac-mark')?.getAttribute('aria-label')).toBe('No seu computador')
  })

  it('marks only the first of grouped messages, where the header is', async () => {
    await show(lia, [said('m1', 1, false), said('m2', 2, false)])
    expect(document.querySelectorAll('.msg__head').length).toBe(1)
    expect(document.querySelectorAll('.mac-mark').length).toBe(1)
  })

  it('leaves an agent with its own isolated computer unmarked', async () => {
    await show({ ...lia, computerKind: 'linux' }, [said('m1', 1)])
    expect(document.querySelector('.mac-mark')).toBeNull()
  })
})
