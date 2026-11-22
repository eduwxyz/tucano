// An agent that runs on its own host: on the desktop that's the person's computer, but on a server
// it's the server. The agent's card says which, instead of calling the server "your computer".
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent } from '../src/shared/types'
const { window, document } = parseHTML('<html><body><div id="root"></div><button id="anchor">Lia</button></body></html>')
class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, ResizeObserver: ResizeObserverStub, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { ResizeObserver: ResizeObserverStub, innerWidth: 1200, innerHeight: 800 })

const lia = { id: 'lia', name: 'Lia', handle: 'lia', color: 'sky', modelId: 'sonnet', archived: false, kind: 'agent', role: '', computer: true, computerKind: 'mac' } as unknown as Agent
const fake: Record<string, unknown> = { view: { kind: 'conversation', id: 'dm' }, messages: {}, conversations: [], connectors: [], people: [], you: '' }
let onServer = false
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(fake),
  agentById: () => lia,
  modelById: () => undefined,
  canDecide: () => true,
  personName: () => '',
  navigate: vi.fn(),
  openDialog: vi.fn(),
  openDm: vi.fn(),
  windowless: () => onServer
}))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null, Icon: () => null, ago: () => '', ownColor: () => ({}) }))
const { createRoot } = await import('react-dom/client')
const { AgentCardLayer, openAgentCard, closeAgentCard } = await import('../src/renderer/src/components/AgentCard')
let root: ReturnType<typeof createRoot>

beforeEach(async () => {
  root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<AgentCardLayer />))
})
afterEach(async () => {
  await act(async () => closeAgentCard())
  await act(async () => root.unmount())
})
const card = async (): Promise<string> => {
  await act(async () => openAgentCard('lia', document.getElementById('anchor') as unknown as HTMLElement))
  return document.querySelector('.agent-card')?.textContent ?? ''
}

it("says the person's computer on the desktop", async () => {
  onServer = false
  expect(await card()).toContain('Roda no seu computador')
})

it('says the server on a server, never "your computer"', async () => {
  onServer = true
  const text = await card()
  expect(text).toContain('Roda direto no servidor')
  expect(text).not.toContain('seu computador')
})

it('says which lent computer it also uses, and whether it is on now', async () => {
  onServer = true
  Object.assign(lia, { grants: { mac: 'read_write' } })
  fake.connectors = [{ id: 'mac', name: 'MacBook do Edu', kind: 'remote', url: 'tucano-node://MacBook', auth: 'none', status: 'disconnected', tools: [] }]
  fake.people = [{ id: 'edu', role: 'owner' }]
  fake.you = 'edu'
  const text = await card()
  expect(text).toContain('Também usa')
  expect(text).toContain('MacBook do Edu')
  expect(text).toContain('desligado')
  fake.connectors = []
  Object.assign(lia, { grants: {} })
})

