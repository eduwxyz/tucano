// The strip in the field it belongs to: with a team it shows only a question this person may answer,
// and pressing it goes to that card, in the room or in the thread it was asked in.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Message } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, voiceStatus: vi.fn(() => new Promise(() => {})) }
})
const { createRoot } = await import('react-dom/client')
const { Composer } = await import('../src/renderer/src/components/Conversation')
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()

const channel = { id: 'c1', kind: 'channel', name: 'geral', members: ['a1'] } as unknown as Conversation
const lia = { id: 'a1', name: 'Lia', handle: 'lia', role: 'PM' }
const question = (over: Partial<Message> = {}, askedTo?: string): Message => ({
  id: 'q1',
  conversationId: 'c1',
  author: { kind: 'agent', id: 'a1' },
  text: '',
  at: 1,
  run: { status: 'waiting_input', steps: [], depth: 1, question: 'Pra quando?', ...(askedTo ? { askedTo } : {}) },
  ...over
})
const team = [
  { id: 'ana', name: 'Ana', role: 'owner', about: '' },
  { id: 'bia', name: 'Bia', role: 'member', about: '' }
]

let root: Root
const jumps: [string, string | undefined][] = []
const show = async (m: Message, inbox: { id: string; confirm?: string }[], threadId?: string, people = team, jumpable = true): Promise<void> => {
  fake = { ...base, ready: true, people, you: 'ana', agents: [lia], conversations: [channel], messages: { c1: [m] }, inbox: { ...base.inbox, questions: inbox } } as unknown as State
  await act(async () =>
    root.render(
      <Composer
        conversationId="c1"
        members={[]}
        placeholder="Mensagem"
        {...(threadId ? { threadId } : {})}
        {...(jumpable ? { onJump: (id: string, thread?: string) => void jumps.push([id, thread]) } : {})}
      />
    )
  )
}
const strip = (): HTMLElement | null => document.querySelector('.ask-strip')

beforeEach(() => {
  jumps.length = 0
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
})

describe('the strip above the field', () => {
  it('shows a question asked to me, and goes to its card', async () => {
    await show(question({}, 'ana'), [{ id: 'q1' }])
    expect(strip()?.textContent).toContain('Lia')
    await act(async () => strip()!.click())
    expect(jumps).toEqual([['q1', undefined]])
  })

  it('stays away from a question asked to someone else', async () => {
    await show(question({}, 'bia'), [])
    expect(strip()).toBeNull()
  })

  it('shows one asked to someone else when it is mine to answer (I cover for them)', async () => {
    await show(question({}, 'bia'), [{ id: 'q1' }])
    expect(strip()).not.toBeNull()
  })

  it('stays away while the question still waits for a yes to be asked', async () => {
    await show(question({}, 'bia'), [{ id: 'q1', confirm: 'pending' }])
    expect(strip()).toBeNull()
  })

  it('goes away once it is answered', async () => {
    await show(question({}, 'ana'), [{ id: 'q1' }])
    expect(strip()).not.toBeNull()
    const answered = question({}, 'ana')
    await show({ ...answered, run: { ...answered.run!, status: 'done' } }, [])
    expect(strip()).toBeNull()
  })

  it('in a thread, goes to the card in that thread', async () => {
    await show(question({ threadId: 't1' }, 'ana'), [{ id: 'q1' }], 't1')
    await act(async () => strip()!.click())
    expect(jumps).toEqual([['q1', 't1']])
  })

  it('is not drawn where there is no list to go to (the intro chats)', async () => {
    await show(question(), [], undefined, [team[0]!], false)
    expect(strip()).toBeNull()
  })
})
