import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Db, MIGRATIONS } from '../src/core/db'

const file = (): string => join(mkdtempSync(join(tmpdir(), 'tucano-ahead-')), 'tucano.db')

// A migration runs only while its index is past the file's counter, so a list that once got shorter —
// a merge that dropped a migration, a rollback — leaves the file counted as done with migrations it
// never ran, and every migration added afterwards is skipped as well. These are the tables 0.2.44's
// migrations make; `questions` is one written with a plain CREATE TABLE, which proves the weaker
// spelling is put back too.
const late = ['jobs', 'harness_keys', 'mcp_creations', 'vault_keys', 'vault_uses', 'vault_logins', 'questions']

describe('a database counted past its migrations', () => {
  const behind = (): string => {
    const f = file()
    new Db(f).close()
    const raw = new DatabaseSync(f)
    for (const t of late) raw.exec(`DROP TABLE ${t}`)
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
    raw.close()
    return f
  }

  it('gets back every table a skipped migration would have made', () => {
    const f = behind()
    const db = new Db(f)
    expect(db.vaultKeys()).toEqual([])
    expect(db.job('missing')).toBeUndefined()
    const raw = new DatabaseSync(f, { readOnly: true })
    try {
      const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
      for (const t of late) expect(names).toContain(t)
      // Including what the dropped table carried: an index written with a plain CREATE INDEX.
      const indexes = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name)
      expect(indexes).toContain('questions_open')
      // The count it came with is left alone: the next migration is still the one after the list.
      expect(Number(raw.prepare('PRAGMA user_version').get()!['user_version'])).toBe(MIGRATIONS.length)
    } finally { raw.close() }
    db.close()
  })

  it('puts back an index whose migration was skipped, without touching the table', () => {
    const f = file()
    new Db(f).close()
    const raw = new DatabaseSync(f)
    raw.exec('DROP INDEX messages_retry')
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
    raw.close()
    const db = new Db(f)
    expect(db.vaultKeys()).toEqual([])
    const probe = new DatabaseSync(f, { readOnly: true })
    try {
      expect(probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'messages_retry'").get()).toBeDefined()
    } finally { probe.close() }
    db.close()
  })

  it('leaves a fresh file with every one of them', () => {
    const db = new Db(file())
    expect(db.vaultKeys()).toEqual([])
    expect(db.vaultLogins()).toEqual([])
    db.close()
  })
})
