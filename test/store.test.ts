// The window's store, driven as the core drives it: a snapshot, then events over the port.
import { beforeAll, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Conversation, Message } from '../src/shared/types'

type Store = typeof import('../src/renderer/src/store')
let store: Store
let emit: (e: CoreEvent) => void
const asked: { method: string; params: unknown }[] = []

const conv = (id: string): Conversation => ({ id, kind: 'channel', name: id, members: [], threads: true }) as Conversation
const msg = (id: string, conversationId: string, at: number, extra: Partial<Message> = {}): Message => ({ id, conversationId, author: { kind: 'person', id: 'p1' }, text: id, at, ...extra })

// c1 opens with its last three messages (from t=10) and, from before that, a routine's run (t=2).
const opening = [msg('ask', 'c1', 2, { author: { kind: 'routine', id: 'r1' } }), msg('m10', 'c1', 10), msg('m11', 'c1', 11), msg('root', 'c1', 12), msg('r1', 'c1', 13, { threadId: 'root' }), msg('x1', 'c2', 5)]
const older = [msg('m8', 'c1', 8), msg('m9', 'c1', 9)]

beforeAll(async () => {
  let listener: ((e: unknown) => void) | null = null
  const port = {
    onmessage: null as ((m: { data: unknown }) => void) | null,
    postMessage(req: { id: number; method: string; params: unknown }) {
      asked.push({ method: req.method, params: req.params })
      const result =
        req.method === 'snapshot'
          ? { settings: { workspaceName: 'Edu', language: 'pt', engines: {} }, agents: [], conversations: [conv('c1'), conv('c2')], messages: opening, since: { c1: 10 }, connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'mac', packaged: false, isolatedComputers: true, people: [], you: '' }
          : req.method === 'olderMessages'
            ? { messages: [...older, opening[0]], since: 0 }
            : undefined
      queueMicrotask(() => port.onmessage!({ data: { id: req.id, result } }))
    }
  }
  const win: Record<string, unknown> = {
    addEventListener: (_: string, l: (e: unknown) => void) => (listener = l),
    removeEventListener: () => {},
    tucano: { onNavigate: () => {}, viewing: () => {}, connect: () => queueMicrotask(() => listener!({ source: win, data: 'core:port', ports: [port] })) }
  }
  ;(globalThis as Record<string, unknown>).window = win
  store = await import('../src/renderer/src/store')
  await store.start()
  emit = (event) => port.onmessage!({ data: { event } })
})

describe("the window's messages", () => {
  it('come per conversation; the timeline starts where they are whole, the older run kept aside', () => {
    const s = store.getState()
    expect(store.messagesIn(s, 'c1').map((m) => m.id)).toEqual(['ask', 'm10', 'm11', 'root', 'r1'])
    expect(store.timelineOf(s, 'c1').map((m) => m.id)).toEqual(['m10', 'm11', 'root'])
    expect(store.messageById(s, 'ask')?.author.kind).toBe('routine')
    expect(store.repliesOf(s, 'c1', 'root').map((m) => m.id)).toEqual(['r1'])
    expect(s.history).toEqual({ c1: 10 })
  })

  it('stream without waking the store: only the text of that message grows', () => {
    emit({ type: 'message', message: msg('reply', 'c1', 14, { author: { kind: 'agent', id: 'a1' }, text: '', threadId: 'root', run: { status: 'working', steps: [] } }) })
    const before = store.getState()
    expect(store.isWorking(before, 'c1')).toBe(true)
    expect(store.workingIds(before, 'c1', 'root')).toEqual(['reply'])
    expect(store.workingIds(before, 'c1')).toEqual([])
    emit({ type: 'delta', id: 'reply', text: 'Olá, ' })
    emit({ type: 'delta', id: 'reply', text: 'Edu' })
    expect(store.getState()).toBe(before)
    expect(store.liveText('reply')).toBe('Olá, Edu')
    // The full message carries the text so far: the streamed copy goes.
    emit({ type: 'message', message: msg('reply', 'c1', 14, { author: { kind: 'agent', id: 'a1' }, text: 'Olá, Edu!', threadId: 'root', run: { status: 'done', steps: [] } }) })
    expect(store.liveText('reply')).toBeUndefined()
    expect(store.messageById(store.getState(), 'reply')?.text).toBe('Olá, Edu!')
    expect(store.workingAgents(store.getState()).size).toBe(0)
  })

  it("keeps a thread's replies the same array while only another thread changes", () => {
    emit({ type: 'message', message: msg('other', 'c1', 15) })
    const replies = store.repliesOf(store.getState(), 'c1', 'root')
    emit({ type: 'message', message: msg('r-other', 'c1', 16, { threadId: 'other' }) })
    expect(store.repliesOf(store.getState(), 'c1', 'root')).toBe(replies)
    expect(store.repliesOf(store.getState(), 'c1', 'other').map((m) => m.id)).toEqual(['r-other'])
  })

  it("doesn't wake the store for a browser's frame", () => {
    const before = store.getState()
    emit({ type: 'browser_frame', agentId: 'a1', frame: 'data:image/jpeg;base64,AAAA' })
    expect(store.getState()).toBe(before)
  })

  it('load older ones in time order, once, and then the timeline is whole', async () => {
    await Promise.all([store.loadOlder('c1'), store.loadOlder('c1')])
    expect(asked.filter((a) => a.method === 'olderMessages')).toEqual([{ method: 'olderMessages', params: { conversationId: 'c1', before: 10 } }])
    const s = store.getState()
    expect(store.messagesIn(s, 'c1').map((m) => m.id)).toEqual(['ask', 'm8', 'm9', 'm10', 'm11', 'root', 'r1', 'reply', 'other', 'r-other'])
    expect(store.timelineOf(s, 'c1').map((m) => m.id)).toEqual(['ask', 'm8', 'm9', 'm10', 'm11', 'root', 'other'])
    expect(s.history).toEqual({})
    await store.loadOlder('c1') // nothing more to ask for
    expect(asked.filter((a) => a.method === 'olderMessages')).toHaveLength(1)
  })

  it('drop a conversation whole when it goes', () => {
    emit({ type: 'conversation_removed', id: 'c1' })
    expect(store.messagesIn(store.getState(), 'c1')).toEqual([])
    expect(store.messagesIn(store.getState(), 'c2').map((m) => m.id)).toEqual(['x1'])
  })
})
