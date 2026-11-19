// Deleting a session from the room: the reply goes, and with it the thread it started (the answers
// it got there) and any approval asked under it. The prompt it answered stays, and what it spent
// stays in the receipts: the tokens went out either way. A reply still at work is stopped first and
// deleted whole: nothing it had written comes back.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import type { CoreEvent } from '../src/shared/rpc'
import type { Approval, Message } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'

const freshDb = (): Db => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-del-')), 'tucano.db'))
  db.saveAgent({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
  db.renamePerson(db.ownerId(), 'Ana')
  db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'], owner: db.ownerId() })
  return db
}

const said = (id: string, text: string, at: number, threadId?: string): Message => ({ id, conversationId: 'dm', ...(threadId ? { threadId } : {}), author: { kind: 'person', id: 'ana' }, text, at })
const reply = (id: string, text: string, at: number, status: 'done' | 'working' = 'done', threadId?: string): Message => ({
  id,
  conversationId: 'dm',
  ...(threadId ? { threadId } : {}),
  author: { kind: 'agent', id: 'a1' },
  text,
  at,
  run: { status, steps: [], replyTo: 'p1' }
})

describe('a session deleted', () => {
  it('the reply goes with its thread, and the prompt that started it stays', () => {
    const db = freshDb()
    db.saveMessage(said('p1', 'corrige o login', 1))
    db.saveMessage(reply('r1', 'corrigido', 2))
    db.saveMessage(said('t1', 'e o cadastro?', 3, 'r1'))
    db.saveMessage(reply('t2', 'também', 4, 'done', 'r1'))

    expect(db.deleteMessage('r1').sort()).toEqual(['r1', 't1', 't2'])
    expect(db.message('r1')).toBeUndefined()
    expect(db.message('t1')).toBeUndefined() // the thread went with the reply that started it
    expect(db.message('t2')).toBeUndefined()
    expect(db.message('p1')).toBeTruthy() // what was asked is still the conversation's
  })

  it('what the session spent stays in the receipts: the tokens went out anyway', () => {
    const db = freshDb()
    db.saveMessage(said('p1', 'corrige o login', 1))
    db.saveMessage(reply('r1', 'corrigido', 2))
    db.addReceipt({ messageId: 'r1', agentId: 'a1', engine: 'claude', at: 2, model: 'sonnet', inputTokens: 900, cacheReadTokens: 0, outputTokens: 100, ms: 4000 })

    db.deleteMessage('r1')
    expect(db.receiptTotals('r1').tokens).toBe(1000)
  })

  it('an approval asked under that reply goes with it', () => {
    const db = freshDb()
    db.saveMessage(said('p1', 'manda o e-mail', 1))
    db.saveMessage(reply('r1', 'preciso de aprovação', 2))
    const approval: Approval = { id: 'ap1', hash: 'h', agentId: 'a1', conversationId: 'dm', messageId: 'r1', connectorId: 'c', connectorName: 'Gmail', tool: 'send', args: {}, why: '', highRisk: false, state: 'pending', createdAt: 2, expiresAt: Date.now() + 60_000, requestedBy: 'ana' }
    db.createApproval(approval)

    db.deleteMessage('r1')
    expect(db.approval('ap1')).toBeUndefined()
  })
})

describe('deleting a session over the API', () => {
  let core: Awaited<ReturnType<typeof bootCore>>
  let ana: Client
  let dm: string
  type Snap = { conversations: { id: string; kind: string; members: string[] }[]; messages: Message[] }
  const until = async (ok: () => Promise<boolean>, ms = 20_000): Promise<void> => {
    const end = Date.now() + ms
    while (!(await ok())) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('an ended reply leaves the conversation, and every screen hears of it', async () => {
    core = await bootCore()
    ana = core.connect()
    const agent = (await ana.call<{ agents: { id: string }[] }>('snapshot')).agents[0]!
    dm = await ana.call<string>('openDm', { agentId: agent.id })
    await ana.call('sendMessage', { conversationId: dm, text: 'diz oi' })
    const ended = async (): Promise<Message | undefined> => (await ana.call<Snap>('snapshot')).messages.find((m) => m.conversationId === dm && m.run?.status === 'done')
    await until(async () => !!(await ended()))
    const mine = (await ana.call<Snap>('snapshot')).messages.find((m) => m.conversationId === dm && m.author.kind === 'person')!
    const session = (await ended())!

    const gone = await ana.call<string[]>('deleteMessage', { messageId: session.id })
    expect(gone).toEqual([session.id])
    const after = (await ana.call<Snap>('snapshot')).messages
    expect(after.some((m) => m.id === session.id)).toBe(false)
    expect(after.some((m) => m.id === mine.id)).toBe(true) // the prompt it answered stayed
    expect(ana.events.some((e: CoreEvent) => e.type === 'message_removed' && e.id === session.id)).toBe(true)
    // Nothing of it says anything any more: what the drawer and the message list have left is nothing.
    expect((await ana.call<Snap>('snapshot')).messages.some((m) => m.id === session.id)).toBe(false)
  })

  it("a routine's post goes too: nothing ran under it, and the routine itself stays", async () => {
    // A routine posts as an ask in the room, without a run of its own, so it is put here the way the
    // scheduler writes it. Deleting it takes the post out; the routine keeps its slot and posts again.
    const db = new DatabaseSync(join(core.dataDir, 'tucano.db'))
    try {
      db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, ?, ?, ?, ?)').run('rot-post-1', dm, 'routine', 'rot1', 'Relatório diário', Date.now())
    } finally {
      db.close()
    }
    expect(await ana.call<string[]>('deleteMessage', { messageId: 'rot-post-1' })).toEqual(['rot-post-1'])
    const after = new DatabaseSync(join(core.dataDir, 'tucano.db'))
    try {
      expect(after.prepare('SELECT id FROM messages WHERE id = ?').get('rot-post-1')).toBeUndefined()
    } finally {
      after.close()
    }
    expect(ana.events.some((e: CoreEvent) => e.type === 'message_removed' && e.id === 'rot-post-1')).toBe(true)
  })

  it("a prompt goes on its own: the reply it earned is a message of its own and stays", async () => {
    // The ask is not a session. Deleting it takes the words out of the room; the answer keeps its own
    // row, because it is what was said, and its replyTo naming a message no longer there is a state the
    // room already lives with (a prompt that paged out of the window looks the same).
    const before = await ana.call<Snap>('snapshot')
    const prompt = before.messages.find((m) => m.conversationId === dm && m.author.kind === 'person')!
    const others = before.messages.filter((m) => m.id !== prompt.id).map((m) => m.id)
    expect(await ana.call<string[]>('deleteMessage', { messageId: prompt.id })).toEqual([prompt.id])
    const after = await ana.call<Snap>('snapshot')
    expect(after.messages.some((m) => m.id === prompt.id)).toBe(false)
    // Nothing else in the room moved: the replies are still there, and so are the other asks.
    expect(others.every((id) => after.messages.some((m) => m.id === id))).toBe(true)
    expect(ana.events.some((e: CoreEvent) => e.type === 'message_removed' && e.id === prompt.id)).toBe(true)
  })

  it('a reply still at work goes too: it is stopped first, and what it had written goes with it', async () => {
    // The core writes a reply as it runs, so one at work is put here directly (as team-round6 does
    // with its artifacts). The door takes it: the run is dropped, so nothing of it lands afterwards.
    const agent = (await ana.call<{ agents: { id: string }[] }>('snapshot')).agents[0]!.id
    const db = new DatabaseSync(join(core.dataDir, 'tucano.db'))
    try {
      db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)').run('w1', dm, 'agent', agent, 'estou olhando', Date.now(), JSON.stringify({ status: 'working', steps: [] }))
    } finally {
      db.close()
    }
    expect(await ana.call<string[]>('deleteMessage', { messageId: 'w1' })).toEqual(['w1'])
    const after = new DatabaseSync(join(core.dataDir, 'tucano.db'))
    try {
      expect(after.prepare('SELECT id FROM messages WHERE id = ?').get('w1')).toBeUndefined()
    } finally {
      after.close()
    }
    expect(ana.events.some((e: CoreEvent) => e.type === 'message_removed' && e.id === 'w1')).toBe(true)
  })
})
