import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { Db } from '../src/core/db'
import type { Message } from '../src/shared/types'

it('adds reply to the main schema and persists quotes without changing existing messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-replies-'))
  const path = join(dir, 'test.db')
  const original: Message = { id: 'original', conversationId: 'channel', author: { kind: 'me' }, text: 'Original message.', at: 100 }
  const reply: Message = { id: 'reply', conversationId: 'channel', author: { kind: 'me' }, text: 'Explain this part.', at: 101, reply: { messageId: original.id, author: 'Edu', text: 'Original', at: original.at, excerpt: true } }
  try {
    const initial = new Db(path)
    initial.createConversation({ id: 'channel', kind: 'channel', name: 'engineering', members: [] })
    initial.saveMessage(original)
    initial.close()

    // Recreate the schema immediately before the single Reply migration.
    const before = new DatabaseSync(path)
    const version = (before.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    before.exec('ALTER TABLE messages DROP COLUMN reply')
    before.exec(`PRAGMA user_version = ${version - 1}`)
    before.close()

    const migrated = new Db(path)
    try {
      expect(migrated.message(original.id)).toMatchObject(original)
      expect(migrated.message(original.id)?.reply).toBeUndefined()
      migrated.saveMessage(reply)
    } finally {
      migrated.close()
    }

    const reopened = new Db(path)
    try {
      expect(reopened.message(reply.id)).toMatchObject(reply)
      expect(reopened.message(original.id)).toMatchObject(original)
    } finally {
      reopened.close()
    }
    const schema = new DatabaseSync(path)
    try {
      expect(schema.prepare('PRAGMA user_version').get()).toEqual({ user_version: version })
      const columns = schema.prepare('PRAGMA table_info(messages)').all().map((c) => c['name'])
      expect(columns).toContain('reply')
      expect(columns).not.toContain('forwarded')
    } finally {
      schema.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
