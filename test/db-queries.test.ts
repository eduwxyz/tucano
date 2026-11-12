import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { wikiAccess, type Agent, type Approval, type Message, type Run, type WikiAccess } from '../src/shared/types'

const agent = (id: string): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
const run = (status: Run['status']): Run => ({ status, steps: [{ id: 's1', label: 'lendo', status: 'running' }] })
const msg = (id: string, conversationId: string, at: number, extra: Partial<Message> = {}): Message => ({ id, conversationId, author: { kind: 'agent', id: 'a1' }, text: id, at, ...extra })
const approval = (id: string, state: Approval['state']): Approval => ({ id, hash: id, agentId: 'a1', conversationId: 'c1', messageId: 'm1', connectorId: 'k', connectorName: 'K', tool: 't', args: {}, why: '', highRisk: false, state, createdAt: 1, expiresAt: Date.now() + 60_000 })

function seeded(): Db {
  const db = new Db(':memory:')
  for (const id of ['a1', 'a2', 'a3']) db.saveAgent(agent(id))
  db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a3', 'a1'] })
  db.createConversation({ id: 'c2', kind: 'dm', name: 'a2', members: ['a2'], threads: true })
  db.saveMessage(msg('m1', 'c1', 1, { run: run('working') }))
  db.saveMessage(msg('m2', 'c1', 2, { run: run('done') }))
  db.saveMessage(msg('m3', 'c2', 3, { run: run('waiting_approval') }))
  db.saveMessage(msg('m4', 'c2', 4))
  for (const id of ['m1', 'm2', 'm3']) db.recordActivity(db.message(id)!, null)
  return db
}

describe('reading just what is asked', () => {
  it('one conversation, the same as in the full list', () => {
    const db = seeded()
    for (const c of db.conversations()) expect(db.conversation(c.id)).toEqual(c)
    expect(db.conversation('c1')).toMatchObject({ members: ['a3', 'a1'], unread: 1 }) // members in the order they joined
    expect(db.conversation('c2')).toMatchObject({ threads: true, unread: 1 })
    expect(db.conversation('nope')).toBeUndefined()
    db.markRead('c1')
    expect(db.conversation('c1')?.unread).toBe(0)
  })

  it('the replies by the state of their run', () => {
    const db = seeded()
    expect(db.messagesWithRun(['working']).map((m) => m.id)).toEqual(['m1'])
    expect(db.messagesWithRun(['working', 'waiting_approval']).map((m) => m.id)).toEqual(['m1', 'm3'])
    expect(db.messagesWithRun([])).toEqual([])
  })

  it('a start marks only the working replies as interrupted', () => {
    const db = seeded()
    expect(db.interruptStaleRuns()).toBe(1)
    expect(db.message('m1')?.run).toMatchObject({ status: 'interrupted', steps: [{ status: 'error' }] })
    expect(db.message('m2')?.run?.status).toBe('done')
    expect(db.message('m3')?.run?.status).toBe('waiting_approval')
    expect(db.interruptStaleRuns()).toBe(0)
  })

  it('the pending approvals, counted', () => {
    const db = seeded()
    db.createApproval(approval('p1', 'pending'))
    db.createApproval(approval('p2', 'pending'))
    db.createApproval(approval('d1', 'refused'))
    expect(db.pendingApprovals()).toBe(2)
    db.decideApproval('p1', 'approved')
    expect(db.pendingApprovals()).toBe(db.approvals().filter((a) => a.state === 'pending').length)
  })

  it('one artifact by its id', () => {
    const db = seeded()
    const a = { id: 'f1', agentId: 'a1', conversationId: 'c1', messageId: 'm1', kind: 'file' as const, name: 'notas.md', title: 'Notas', source: 'x', size: 3, createdAt: 5 }
    db.saveArtifact(a)
    db.saveArtifact({ ...a, id: 'f2', name: 'outro.md' })
    expect(db.artifact('f1')).toEqual(a)
    expect(db.artifact('f1')).toEqual(db.artifacts().find((x) => x.id === 'f1'))
    expect(db.artifact('nope')).toBeUndefined()
  })
})

describe('indexes for what runs often', () => {
  const plan = (raw: DatabaseSync, sql: string): string => (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ')

  it('an existing database gains them, keeps its data, and the hot queries use them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tucano-idx-')), 'tucano.db')
    // A database from before the indexes: those migrations undone (and the two after them: cls_auto, and the Antigravity rename, which has nothing to undo), with messages in it.
    const db0 = new Db(file)
    db0.saveAgent(agent('a1'))
    db0.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a1'] })
    db0.saveMessage(msg('root', 'c1', 1))
    db0.saveMessage(msg('reply', 'c1', 2, { threadId: 'root' }))
    db0.close()
    const raw = new DatabaseSync(file)
    const { user_version } = raw.prepare('PRAGMA user_version').get() as { user_version: number }
    raw.exec(`DROP INDEX messages_by_thread_id; DROP INDEX messages_by_author; DROP INDEX receipts_by_message; ALTER TABLE connector_tools DROP COLUMN cls_auto; PRAGMA user_version = ${user_version - 3}`)
    expect(plan(raw, "SELECT conversation_id FROM messages WHERE author_kind = 'agent' AND author_id = 'a1' ORDER BY at DESC LIMIT 1")).toContain('SCAN messages')
    raw.close()

    const db = new Db(file)
    expect(db.message('reply')?.threadId).toBe('root')
    expect(db.lastConversationOf('a1')).toBe('c1')
    expect(db.quietThreads(10, 0).map((t) => t.id)).toEqual(['root'])
    db.close()

    const after = new DatabaseSync(file)
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(user_version)
    expect(plan(after, "SELECT conversation_id FROM messages WHERE author_kind = 'agent' AND author_id = 'a1' ORDER BY at DESC LIMIT 1")).toContain('messages_by_author')
    expect(plan(after, "SELECT COALESCE(ROUND(SUM(output_tokens)), 0) FROM receipts WHERE message_id = 'm1'")).toContain('receipts_by_message')
    expect(
      plan(
        after,
        `SELECT r.id, t.last FROM (SELECT thread_id, MAX(at) AS last FROM messages WHERE thread_id IS NOT NULL AND author_kind != 'system' GROUP BY thread_id) t
         CROSS JOIN messages r ON r.id = t.thread_id WHERE r.thread_id IS NULL AND t.last < 10 ORDER BY t.last`
      )
    ).toMatch(/SEARCH messages USING INDEX messages_by_thread_id.*SEARCH r USING INDEX sqlite_autoindex_messages_1/)
    after.close()
  })

  it('a query asked again reuses its compiled statement, which holds nothing between uses', () => {
    const db = seeded()
    const inner = (db as unknown as { db: DatabaseSync }).db
    expect(inner.prepare('SELECT * FROM messages WHERE id = ?')).toBe(inner.prepare('SELECT * FROM messages WHERE id = ?'))
    expect(db.message('m1')?.id).toBe('m1')
    expect(db.message('m2')?.id).toBe('m2')
    expect(inner.isTransaction).toBe(false)
    db.tx(() => db.saveMessage(msg('m5', 'c1', 5))) // a write right after a get still goes through
    expect(db.message('m5')?.text).toBe('m5')
  })
})

describe('an agent kept and read back', () => {
  // The wiki's third access, 'read_write', was in the save but not in the read: it came back as 'read' on
  // the next launch, so the card fell to "no agent writes" and the picker emptied itself.
  it('gives back the wiki access it was saved with, write included, across a reopen', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tucano-wiki-access-')), 'tucano.db')
    const db = new Db(file)
    for (const [id, wiki] of [['a1', 'read_write'], ['a2', 'read'], ['a3', 'none'], ['a4', undefined]] as [string, WikiAccess | undefined][]) db.saveAgent({ ...agent(id), ...(wiki ? { wiki } : {}) })
    expect(db.agent('a1')?.wiki).toBe('read_write')
    db.close()

    const again = new Db(file)
    expect(again.agent('a1')?.wiki).toBe('read_write')
    expect(again.agent('a2')?.wiki).toBe('read')
    expect(again.agent('a3')?.wiki).toBe('none')
    expect(again.agent('a4')?.wiki).toBeUndefined() // unset stays unset: it reads as 'read'
    expect(wikiAccess(again.agent('a1')!)).toBe('read_write')
    expect(wikiAccess(again.agent('a4')!)).toBe('read')
    again.close()
  })
})
