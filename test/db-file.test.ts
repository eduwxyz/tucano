import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'

const MB = 1024 * 1024

function fresh(): { db: Db; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'tucano-db-')), 'tucano.db')
  return { db: new Db(file), file }
}

// Forty messages of 60 KB, then the conversation deleted: the pages they held are free, and nothing
// the file does on its own gives them back.
function bloat(db: Db): { before: number; free: number } {
  const id = 'loaded'
  db.createConversation({ id, kind: 'channel', name: 'loaded', members: [] })
  for (let i = 0; i < 40; i++) db.saveMessage({ id: `m${i}`, conversationId: id, author: { kind: 'person', id: db.ownerId() }, text: `${i} `.padEnd(60_000, 'x'), at: Date.now() - i })
  const loaded = db.size()
  db.deleteConversation(id)
  return { before: loaded.bytes, free: db.size().free }
}

describe('the file behind everything', () => {
  it('counts what it takes and what of that is free', () => {
    const { db, file } = fresh()
    const s = db.size()
    expect(s.bytes).toBeGreaterThan(0)
    // A migration can rebuild an empty table and leave reusable pages even in a new file.
    // Compare against an independent connection, including any such free pages.
    const probe = new DatabaseSync(file, { readOnly: true })
    try {
      const page = Number(probe.prepare('PRAGMA page_size').get()!['page_size'])
      expect(s.free).toBe(Number(probe.prepare('PRAGMA freelist_count').get()!['freelist_count']) * page)
      expect(s.bytes).toBe(Number(probe.prepare('PRAGMA page_count').get()!['page_count']) * page)
    } finally { probe.close() }
    // The page count is the file's own arithmetic, not a second opinion about the size.
    expect(Math.abs(s.bytes - statSync(file).size)).toBeLessThan(1024 * 1024)
    db.close()
  })

  it('says a sound file is sound', () => {
    const { db } = fresh()
    expect(db.check()).toEqual({ sound: true, said: 'ok' })
    db.close()
  })

  it('keeps the pages a delete freed, and only gives them back when the file is rebuilt', () => {
    const { db } = fresh()
    const { free } = bloat(db)
    // Deleting 2.4 MB of messages leaves those pages in the file: the size is unchanged and the
    // freelist is where they went.
    expect(free).toBeGreaterThan(1 * MB)
    const before = db.size()
    db.rebuild()
    const after = db.size()
    expect(after.free).toBe(0)
    expect(after.bytes).toBeLessThan(before.bytes)
    db.close()
  })

  it('switches the file to incremental auto-vacuum, so a slice of the freed pages goes back each day', () => {
    const { db } = fresh()
    // Before the rebuild the file has no page map, so there is nothing to trim with.
    bloat(db)
    expect(db.trim()).toBe(0)
    db.rebuild()
    // After it, the pages that a delete frees can be handed back a slice at a time.
    const { free } = bloat(db)
    expect(free).toBeGreaterThan(1 * MB)
    expect(db.trim()).toBeGreaterThan(0)
    expect(db.size().free).toBeLessThan(free)
    db.close()
  })

  it('takes a slice at a time, and says how many pages went', () => {
    const { db } = fresh()
    bloat(db)
    db.rebuild()
    const { free } = bloat(db)
    const pages = Math.round(free / 4096)
    expect(db.trim(10)).toBe(10)
    expect(Math.round(db.size().free / 4096)).toBe(Math.max(0, pages - 10))
    db.close()
  })

  it('reports a file that does not read back consistent', () => {
    const { db, file } = fresh()
    const text = `${'damaged '.padEnd(40_000, 'y')}`
    db.createConversation({ id: 'c', kind: 'channel', name: 'c', members: [] })
    for (let i = 0; i < 8; i++) db.saveMessage({ id: `d${i}`, conversationId: 'c', author: { kind: 'person', id: db.ownerId() }, text, at: Date.now() - i })
    db.close()
    // An index of the file's own, then its first page overwritten the way a half-written page leaves
    // one: the schema still opens, and the check is the only thing that notices.
    const raw = new DatabaseSync(file)
    raw.exec('CREATE INDEX damaged_idx ON messages (at)')
    const page = Number((raw.prepare('PRAGMA page_size').get() as Record<string, number>)['page_size'])
    const root = Number((raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'damaged_idx'").get() as Record<string, number>)['rootpage'])
    raw.close()
    const bytes = readFileSync(file)
    expect(root).toBeGreaterThan(1)
    bytes.fill(0xff, (root - 1) * page, root * page)
    writeFileSync(file, bytes)
    const reopened = new Db(file)
    const check = reopened.check()
    expect(check.sound).toBe(false)
    expect(check.said).not.toBe('ok')
    reopened.close()
  })
})
