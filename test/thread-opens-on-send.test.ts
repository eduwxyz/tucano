import { beforeEach, expect, it, vi } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Message } from '../src/shared/types'

// The store against a fake core: what it asks for, and the events it gets back.
let emit: (e: CoreEvent) => void = () => {}
const sent: unknown[] = []
vi.mock('../src/renderer/src/rpc', () => ({
  connect: async (apply: (e: CoreEvent) => void) => void (emit = apply),
  disconnect: () => {},
  call: async (method: string, params?: unknown) => {
    if (method === 'sendMessage') sent.push(params)
    if (method !== 'snapshot') return undefined
    return {
      you: 'me', people: [], settings: { language: 'en', theme: 'system', onboarding: { done: true } }, agents: [], messages: [], connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [],
      conversations: [
        { id: 'threads', kind: 'channel', name: 'ops', members: [], threads: true },
        { id: 'chat', kind: 'channel', name: 'chat', members: [] }
      ]
    }
  }
}))
Object.assign(globalThis, { window: { tucano: { onNavigate: () => {}, viewing: () => {} }, addEventListener: () => {} } })
const store = await import('../src/renderer/src/store')
await store.start()

const back = (m: Partial<Message> & { id: string; conversationId: string }): void =>
  emit({ type: 'message', message: { author: { kind: 'person', id: 'me' }, text: 'hi', at: Date.now(), ...m } as Message })

beforeEach(() => {
  store.openPanel(null)
  sent.length = 0
})

it('opens the thread of what I wrote in a conversation that answers in threads', () => {
  store.navigate({ kind: 'conversation', id: 'threads' })
  store.sendMessage('threads', 'deploy the site')
  expect(sent).toHaveLength(1)
  back({ id: 'm1', conversationId: 'threads' })
  expect(store.getState().panel).toEqual({ kind: 'thread', id: 'm1' })
  // Only that one: the next message from elsewhere (another device) doesn't open anything.
  store.openPanel(null)
  back({ id: 'm2', conversationId: 'threads' })
  expect(store.getState().panel).toBeNull()
})

it("leaves the panel alone in a chat, in a thread's own reply, and for someone else's message", () => {
  store.navigate({ kind: 'conversation', id: 'chat' })
  store.sendMessage('chat', 'hello')
  back({ id: 'c1', conversationId: 'chat' })
  expect(store.getState().panel).toBeNull()

  store.navigate({ kind: 'conversation', id: 'threads' })
  store.sendMessage('threads', 'more', [], 'm1')
  back({ id: 'r1', conversationId: 'threads', threadId: 'm1' })
  expect(store.getState().panel).toBeNull()

  store.sendMessage('threads', 'again')
  back({ id: 'a1', conversationId: 'threads', author: { kind: 'agent', id: 'bot' } })
  expect(store.getState().panel).toBeNull()
  back({ id: 'm3', conversationId: 'threads' })
  expect(store.getState().panel).toEqual({ kind: 'thread', id: 'm3' })
})

it("doesn't pull me back if I moved to another conversation before it came back", () => {
  store.navigate({ kind: 'conversation', id: 'threads' })
  store.sendMessage('threads', 'go')
  store.navigate({ kind: 'conversation', id: 'chat' })
  back({ id: 'm4', conversationId: 'threads' })
  expect(store.getState().panel).toBeNull()
  expect(store.getState().view).toEqual({ kind: 'conversation', id: 'chat' })
})
