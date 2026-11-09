// Clearing a conversation's history: the rows stay (receipts, costs and approvals point at message
// ids), the screen and what the next reply reads start after the cut, and the conversation itself is
// untouched — same DM, same channel, same place in the list.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Conversation, Message } from '../src/shared/types'
import { Db } from '../src/core/db'
import { contextWindow } from '../src/core/memory'

const msg = (id: string, conversationId: string, at: number, extra: Partial<Message> = {}): Message => ({
  id,
  conversationId,
  author: { kind: 'person', id: 'p1' },
  text: id,
  at,
  ...extra
})

// Everything within this month, so the costs stay where the receipts put them.
const base = Date.now() - 10 * 60_000
const cut = base + 3_000

function made(): { db: Db; id: string } {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'clear-')), 'test.db'))
  db.saveAgent({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'], owner: 'p1' })
  for (const m of [msg('m1', 'dm', base + 1_000), msg('m2', 'dm', base + 2_000), msg('m3', 'dm', base + 2_500, { author: { kind: 'agent', id: 'a1' }, run: { status: 'done', steps: [] } })]) db.saveMessage(m)
  db.addReceipt({ messageId: 'm3', agentId: 'a1', engine: 'claude', model: 'sonnet', inputTokens: 900, cacheReadTokens: 0, outputTokens: 100, ms: 1, at: base + 2_500 })
  return { db, id: 'dm' }
}

describe('clearing a history', () => {
  it('keeps the rows and hides them from every read that builds a reply', () => {
    const { db, id } = made()
    db.clearConversation(id, cut)
    expect(db.recentMessages(id, 10)).toEqual([])
    expect(db.messagesBefore(id, base + 60_000, 10).messages).toEqual([])
    // The rows are still there: the screen's own full list and the receipts that point at them.
    expect(db.messages().map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(db.usedThisMonth('a1')).toBe(1_000)
  })

  it('keeps the conversation, and the cut is on it', () => {
    const { db, id } = made()
    db.clearConversation(id, cut)
    const c = db.conversation(id)!
    expect(c.kind).toBe('dm')
    expect(c.clearedAt).toBe(cut)
  })

  it('starts again from the next message, and reads only that', () => {
    const { db, id } = made()
    db.clearConversation(id, cut)
    db.saveMessage(msg('m5', id, cut + 1_000))
    expect(db.recentMessages(id, 10).map((m) => m.id)).toEqual(['m5'])
    const window = contextWindow(db, msg('m6', id, cut + 2_000), 30)
    expect(window.messages.map((m) => m.id)).toEqual(['m5'])
  })

  it('drops the summary that was written about what went', () => {
    const { db, id } = made()
    db.setSummary(id, 'Falaram de tudo.', base + 2_500)
    db.clearConversation(id, cut)
    expect(db.conversation(id)!.summary).toBeUndefined()
    expect(contextWindow(db, msg('m7', id, cut + 1_000), 30).summary).toBeUndefined()
  })

  it('leaves a conversation that was never cleared alone', () => {
    const { db, id } = made()
    expect(db.conversation(id)!.clearedAt).toBeUndefined()
    expect(db.recentMessages(id, 10).map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })
})

describe("the window's view of a cleared conversation", () => {
  let store: typeof import('../src/renderer/src/store')

  beforeAll(async () => {
    let listener: ((e: unknown) => void) | null = null
    const conversations: Conversation[] = [
      { id: 'dm', kind: 'dm', name: 'a1', members: ['a1'], clearedAt: 2_500 } as Conversation,
      { id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] } as Conversation
    ]
    const messages = [msg('m1', 'dm', 1_000), msg('m2', 'dm', 2_000), msg('m3', 'dm', 3_000), msg('c1', 'ch', 1_000)]
    const port = {
      onmessage: null as ((m: { data: unknown }) => void) | null,
      postMessage(req: { id: number; method: string; params: unknown }) {
        const result =
          req.method === 'snapshot'
            ? { settings: { workspaceName: 'Edu', language: 'pt', engines: {} }, agents: [], conversations, messages, since: {}, connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'mac', packaged: false, isolatedComputers: true, people: [], you: 'p1' }
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
  })

  it('draws only what came after the cut', () => {
    const s = store.getState()
    expect(store.clearedAt(s, 'dm')).toBe(2_500)
    expect(store.messagesIn(s, 'dm').map((m) => m.id)).toEqual(['m3'])
  })

  it('leaves a conversation that was never cleared whole', () => {
    const s = store.getState()
    expect(store.clearedAt(s, 'ch')).toBe(0)
    expect(store.messagesIn(s, 'ch').map((m) => m.id)).toEqual(['c1'])
  })
})
