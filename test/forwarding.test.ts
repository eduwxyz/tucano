import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { Db } from '../src/core/db'

it('migrates saved channel forwards without losing their source name', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tucano-forward-')), 'test.db')
  const db = new Db(path)
  db.createConversation({ id: 'destination', kind: 'channel', name: 'launch', members: [] })
  db.saveMessage({ id: 'copy', conversationId: 'destination', author: { kind: 'me' }, text: 'Deployment ready.', at: 123 })
  db.close()

  const old = new DatabaseSync(path)
  const version = (old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  old.prepare('UPDATE messages SET forwarded = ? WHERE id = ?').run(JSON.stringify({ messageId: 'original', conversationId: 'source', channel: 'engineering', author: 'Iris', at: 100 }), 'copy')
  old.exec('ALTER TABLE messages DROP COLUMN reply')
  old.exec(`PRAGMA user_version = ${version - 2}`)
  old.close()

  const upgraded = new Db(path)
  try {
    expect(upgraded.message('copy')?.forwarded).toEqual({ messageId: 'original', conversationId: 'source', conversationName: 'engineering', conversationKind: 'channel', author: 'Iris', at: 100 })
  } finally {
    upgraded.close()
  }
})
