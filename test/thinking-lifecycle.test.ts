import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Settings } from '../src/shared/types'

let store: typeof import('../src/renderer/src/store')
let emit: (event: CoreEvent) => void

beforeEach(async () => {
  vi.resetModules()
  let listener: ((event: unknown) => void) | undefined
  const settings = { workspaceName: 'Review user', language: 'en', engines: {}, theme: 'system', showThinking: true } as Settings
  const message = { id: 'private-reply', conversationId: 'private-room', author: { kind: 'agent', id: 'a1' }, text: '', at: 1 }
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(request: { id: number; method: string }) {
      const result = request.method === 'snapshot'
        ? { settings, agents: [], conversations: [{ id: 'private-room', kind: 'channel', name: 'Private room' }], messages: [message], since: {}, connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'windows', packaged: false, isolatedComputers: true, people: [], you: '' }
        : undefined
      queueMicrotask(() => port.onmessage!({ data: { id: request.id, result } }))
    }
  }
  const win = {
    addEventListener: (_name: string, next: (event: unknown) => void) => { listener = next },
    removeEventListener: () => {},
    tucano: { onNavigate: () => {}, viewing: () => {}, connect: () => queueMicrotask(() => listener!({ source: win, data: 'core:port', ports: [port] })) }
  }
  Object.assign(globalThis, { window: win })
  store = await import('../src/renderer/src/store')
  await store.start()
  emit = event => port.onmessage!({ data: { event } })
  emit({ type: 'thinking', id: message.id, text: 'Private reasoning retained before the transition.' })
  expect(store.liveThought(message.id)).toContain('Private reasoning')
})

describe('reasoning retention after access and preference transitions', () => {
  it('forgets retained reasoning when the settings event turns it off', () => {
    emit({ type: 'settings', settings: { ...store.getState().settings, showThinking: false } })
    expect(store.liveThought('private-reply')).toBeUndefined()
    emit({ type: 'thinking', id: 'private-reply', text: 'This arrived while off.' })
    emit({ type: 'settings', settings: { ...store.getState().settings, showThinking: true } })
    expect(store.liveThought('private-reply')).toBeUndefined()
  })

  it('forgets retained reasoning when the local preference turns it off', async () => {
    await store.updateSettings({ showThinking: false })
    expect(store.liveThought('private-reply')).toBeUndefined()
  })

  it('forgets the removed conversation alongside its messages', () => {
    emit({ type: 'conversation_removed', id: 'private-room' })
    expect(store.getState().messages['private-room']).toBeUndefined()
    expect(store.liveThought('private-reply')).toBeUndefined()
  })

  it('drops cached reasoning when a replacement snapshot is installed', async () => {
    await store.start()
    expect(store.liveThought('private-reply')).toBeUndefined()
  })

  it('preserves reasoning for unrelated settings and conversations', () => {
    emit({ type: 'settings', settings: { ...store.getState().settings, theme: 'dark' } })
    emit({ type: 'conversation_removed', id: 'other-room' })
    expect(store.liveThought('private-reply')).toContain('Private reasoning')
  })
})
