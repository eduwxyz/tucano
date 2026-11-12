// The Memory page's tab for your own memories is one word, so it fits the tab strip at
// narrow widths: "You" / "Você". It used to read "About you", which wrapped to two lines
// once a few agents had notes of their own (see scripts/screens-memory-you.mjs).
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, Memory } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null })

const you = { id: 'p1', name: 'Apo' }
const liaison = { id: 'lia', name: 'Lia', handle: 'lia', archived: false } as Agent
const note = (id: string, scope: string, text: string): Memory => ({ id, scope, text, state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
const memories = [note('m1', 'person:p1', 'Prefers small pull requests.'), note('m2', 'lia', 'Works from the plan.')]
const fake = { memories, agents: [liaison], conversations: [], you, me: you } as unknown as State

vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: State) => unknown) => select(fake),
  addMemory: () => {},
  agentById: (s: State, id: string) => s.agents.find((a) => a.id === id),
  confirmMemory: () => {},
  decideMemory: () => {},
  editMemory: () => {},
  forgetMemory: () => {},
  isStale: () => false,
  navigate: () => {},
  purgeMemory: () => {},
  splitForPrompt: (m: Memory[]) => ({ prompt: m, searchable: [] }),
  isTeam: (a: Agent) => !a.archived,
  personScope: (person: { id: string }) => `person:${person.id}`,
  STALE_DAYS: 60
}))
vi.mock('../src/renderer/src/components/Pages', () => ({ Sheet: ({ title, children }: { title: string; children: unknown }) => <section data-title={title}>{children as never}</section> }))
vi.mock('../src/renderer/src/components/ui', () => ({
  AgentAvatar: () => null,
  Icon: () => null,
  ago: () => 'now'
}))

const { createRoot } = await import('react-dom/client')
const { MemoryPage } = await import('../src/renderer/src/components/Memory')
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = '<div id="root"></div>'
})

const tabs = () => [...document.querySelectorAll('.tabs-line > button')].map((b) => b.textContent?.trim())

const render = async (): Promise<void> => {
  await act(async () => root.render(<MemoryPage />))
}

it('names your own memories "You" in English, one word so the tab cannot wrap', async () => {
  setLang('en')
  await render()
  const label = tabs().find((t) => t === 'You' || t === 'About you')
  expect(label).toBe('You')
  expect(tabs()).not.toContain('About you')
  // The group heading inside the tab carries the same name.
  expect(document.querySelector('.read-group h2')?.textContent?.trim()).toBe('You')
})

it('and "Você" in Portuguese', async () => {
  setLang('pt')
  await render()
  expect(tabs()).toContain('Você')
  expect(tabs()).not.toContain('Sobre você')
  expect(document.querySelector('.read-group h2')?.textContent?.trim()).toBe('Você')
})
