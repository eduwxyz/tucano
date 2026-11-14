// Dismissing an ask on the Asks page: two steps, and the question is closed for good — the only
// place it was visible was this list, so it has to be a deliberate press.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })

const dropped: string[] = []
let fake: State
let past: State['inbox']['questions'] = []
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    dismissQuestion: (id: string): void => void dropped.push(id),
    questionsHistory: async (): Promise<State['inbox']['questions']> => past
  }
})
const { getState } = await import('../src/renderer/src/store')
const { AsksPage } = await import('../src/renderer/src/components/Pages')
const { createRoot } = await import('react-dom/client')

const me: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }

let root: Root
beforeEach(() => {
  dropped.length = 0
  past = []
  fake = {
    ...getState(),
    ready: true,
    people: [me],
    agents: [lia],
    you: 'ana',
    conversations: [{ id: 'dm1', kind: 'dm', name: 'Lia', members: ['a1'] }] as State['conversations'],
    inbox: {
      approvals: [],
      questions: [{ id: 'q1', conversationId: 'dm1', agentId: 'a1', text: 'Publico o post hoje?', askedTo: 'ana', requestedBy: 'ana', state: 'open', deadlineAt: Date.now() + 3_600_000, createdAt: 1 }]
    }
  } as State
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const button = (label: string): HTMLElement => {
  const hit = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!hit) throw new Error(`no button "${label}": ${[...document.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
  return hit as HTMLElement
}

describe('dismissing an ask', () => {
  it('asks first, and Keep it sends nothing', async () => {
    await act(async () => root.render(<AsksPage />))
    await act(async () => button('Dispensar').click())
    expect(document.body.textContent).toContain('Deixar sem resposta?')
    await act(async () => button('Manter').click())
    expect(dropped).toEqual([])
    expect(document.body.textContent).not.toContain('Deixar sem resposta?')
  })

  it('closes it once confirmed', async () => {
    await act(async () => root.render(<AsksPage />))
    await act(async () => button('Dispensar').click())
    await act(async () => button('Sim, dispensar').click())
    expect(dropped).toEqual(['q1'])
  })

  it('keeps the answered and closed ones under them, not in the waiting list', async () => {
    past = [
      { id: 'q0', conversationId: 'dm1', agentId: 'a1', text: 'Publico o post hoje?', askedTo: 'ana', requestedBy: 'ana', state: 'answered', answeredBy: 'ana', answeredAt: 2, deadlineAt: 0, createdAt: 1 },
      { id: 'q-1', conversationId: 'dm1', agentId: 'a1', text: 'Fecho o mês assim?', askedTo: 'ana', requestedBy: 'ana', state: 'closed', deadlineAt: 0, createdAt: 1 }
    ]
    await act(async () => root.render(<AsksPage />))
    await act(async () => {})
    const text = document.body.textContent ?? ''
    expect(text).toContain('Histórico')
    // The history is a table now: a short tag per row, the wording that fits a column.
    expect(text).toContain('por você')
    expect(text).toContain('sem resposta')
    expect(text).toContain('Publico o post hoje?')
    expect(text).toContain('Fecho o mês assim?')
  })

  it('still answers the ask from the page instead', async () => {
    await act(async () => root.render(<AsksPage />))
    const field = document.querySelector('input.grow') as HTMLInputElement | null
    expect(field?.getAttribute('placeholder')).toBe('Sua resposta')
    expect(button('Responder').hasAttribute('disabled')).toBe(true) // nothing typed yet
  })
})
