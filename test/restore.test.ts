import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { Db, MIGRATIONS } from '../src/core/db'
import { applyRestore, finishRestore, markRestoreReady, stageRestore, staged, writeBackup } from '../src/core/restore'
import { initializeWorkspace } from '../src/core/seed'
import { zipFromFile } from '../src/core/zip'
import { ZipWriter } from '../src/core/zip-write'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tucano-restore-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const raw = (file: string): DatabaseSync => new DatabaseSync(file)
const one = <T = Record<string, unknown>>(d: DatabaseSync, sql: string, ...args: (string | number)[]): T => d.prepare(sql).get(...args) as T
const all = <T = Record<string, unknown>>(d: DatabaseSync, sql: string): T[] => d.prepare(sql).all() as T[]

it('writes a .zip that the reader takes back, stored and deflated, with UTF-8 names', () => {
  const d = tmp()
  const file = join(d, 'a.zip')
  const z = new ZipWriter(file)
  const text = Buffer.from('olá, tucano '.repeat(500))
  const noise = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7919) % 251))
  z.add('páginas/Decisões.md', text)
  z.add('bin', noise)
  z.add('vazio', Buffer.alloc(0))
  z.close()
  const zip = zipFromFile(file)
  expect([...zip.entries.keys()]).toEqual(['páginas/Decisões.md', 'bin', 'vazio'])
  expect(zip.entries.get('páginas/Decisões.md')!.method).toBe(8)
  expect(zip.read('páginas/Decisões.md', 1e6)!.equals(text)).toBe(true)
  expect(zip.read('bin', 1e6)!.equals(noise)).toBe(true)
  expect(zip.read('vazio', 1e6)!.length).toBe(0)
  zip.close()
})

// A computer's Tucano with what only works there, and a server's with its own logins.
function desktop(dir: string): Db {
  const db = new Db(join(dir, 'tucano.db'))
  initializeWorkspace(db, { TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '1' })
  db.setSettings({ wikiDir: '/Users/ana/Obsidian', telegram: { chatId: 1 } as never, accounts: [{ id: 'a1', engine: 'claude', label: 'Work' }] as never, harnesses: ['cursor'] as never })
  db.close()
  const d = raw(join(dir, 'tucano.db'))
  const agent = one<{ id: string }>(d, "SELECT id FROM agents WHERE kind IS NULL OR kind <> 'tuca' LIMIT 1").id
  const conv = one<{ id: string }>(d, "SELECT id FROM conversations WHERE kind = 'channel' LIMIT 1").id
  d.prepare("UPDATE agents SET computer = 1, computer_kind = 'mac', apps = '[{\"app\":\"Notes\"}]', folders = '[{\"path\":\"/Users/ana/x\"}]', account = 'a1' WHERE id = ?").run(agent)
  d.prepare("INSERT INTO routines (id, name, agent_id, conversation_id, prompt, days, time, enabled, created_at) VALUES ('r1', 'Resumo', ?, ?, 'resuma', '[1]', '09:00', 1, 1)").run(agent, conv)
  d.prepare("INSERT INTO secrets (key, value) VALUES ('connector:x:token', 'sealed-on-the-mac')").run()
  d.prepare("INSERT INTO person_keys (hash, person_id, label, created_at) VALUES ('mac-phone', (SELECT id FROM people WHERE role = 'owner'), 'iPhone', 1)").run()
  d.close()
  mkdirSync(join(dir, 'wiki', 'Projetos'), { recursive: true })
  writeFileSync(join(dir, 'wiki', 'Projetos', 'Checkout.md'), '# Checkout\n')
  mkdirSync(join(dir, 'wiki', '.git'), { recursive: true })
  writeFileSync(join(dir, 'wiki', '.git', 'HEAD'), 'ref')
  const w = raw(join(dir, 'wiki.db'))
  w.exec('CREATE TABLE pages (title TEXT); INSERT INTO pages VALUES (\'Checkout\')')
  w.close()
  mkdirSync(join(dir, 'artifacts', 'art1'), { recursive: true })
  writeFileSync(join(dir, 'artifacts', 'art1', 'grafico.png'), Buffer.from([1, 2, 3]))
  return new Db(join(dir, 'tucano.db'))
}

function server(dir: string): void {
  const db = new Db(join(dir, 'tucano.db'))
  db.setSettings({ harnesses: ['claude'] as never })
  db.close()
  const d = raw(join(dir, 'tucano.db'))
  d.prepare("INSERT INTO person_keys (hash, person_id, label, created_at) VALUES ('browser-key', (SELECT id FROM people WHERE role = 'owner'), 'Chrome', 2)").run()
  d.prepare("INSERT INTO secrets (key, value) VALUES ('push:keys', 'sealed-on-the-server')").run()
  d.close()
  mkdirSync(join(dir, 'wiki'), { recursive: true })
  writeFileSync(join(dir, 'wiki', 'Old.md'), 'old')
}

it("takes a computer's Tucano to a server whole, keeping the server's logins", () => {
  const mac = tmp()
  const srv = tmp()
  const db = desktop(mac)
  const out = join(mac, 'Tucano-backup.zip')
  const made = writeBackup({ db, dataDir: mac, wikiDir: join(mac, 'wiki'), wikiIndex: join(mac, 'wiki.db'), out, app: '0.2.26' })
  db.close()
  expect(made).toMatchObject({ version: 1, app: '0.2.26', wikiPages: 1, files: 1, filesLeftOut: 0, schema: MIGRATIONS.length })
  expect(made.agents).toBeGreaterThan(0)
  const names = [...zipFromFile(out).entries.keys()]
  expect(names).toContain('wiki/Projetos/Checkout.md')
  expect(names).toContain('artifacts/art1/grafico.png')
  expect(names).toContain('wiki.db')
  expect(names.some((n) => n.includes('.git'))).toBe(false)

  server(srv)
  mkdirSync(join(srv, 'uploads'))
  const up = join(srv, 'uploads', 'x-Tucano-backup.zip')
  writeFileSync(up, readFileSync(out))
  const found = stageRestore({ file: up, dataDir: srv, schemaMax: MIGRATIONS.length, app: '0.2.26' })
  expect(found).toMatchObject({ agents: made.agents, messages: made.messages, wikiPages: 1, files: 1, app: '0.2.26' })
  expect(existsSync(up)).toBe(false) // the upload goes once read
  expect(staged(srv)).toBe(true)
  // Checked but not confirmed: a start changes nothing.
  expect(applyRestore(srv)).toBe(false)
  markRestoreReady(srv)
  expect(applyRestore(srv)).toBe(true)
  expect(existsSync(join(srv, 'wiki', 'Projetos', 'Checkout.md'))).toBe(true)
  expect(existsSync(join(srv, 'wiki', 'Old.md'))).toBe(false)
  expect(existsSync(join(srv, 'artifacts', 'art1', 'grafico.png'))).toBe(true)
  const before = readdirSync(join(srv, 'restore')).filter((f) => f.startsWith('before-'))
  expect(before).toHaveLength(1)
  expect(existsSync(join(srv, 'restore', before[0]!, 'wiki', 'Old.md'))).toBe(true)

  const restored = new Db(join(srv, 'tucano.db'))
  expect(finishRestore(restored, srv)).toBe(1)
  expect(finishRestore(restored, srv)).toBeUndefined() // once
  const owner = restored.ownerId()
  restored.close()
  const d = raw(join(srv, 'tucano.db'))
  // Whoever restored stays signed in; the computer's phone key doesn't come.
  expect(all(d, 'SELECT hash, person_id FROM person_keys')).toEqual([{ hash: 'browser-key', person_id: owner }])
  expect(all(d, 'SELECT key, value FROM secrets')).toEqual([{ key: 'push:keys', value: 'sealed-on-the-server' }])
  const settings = Object.fromEntries(all<{ key: string; value: string }>(d, 'SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]))
  expect(settings['harnesses']).toEqual(['claude'])
  expect(settings['wikiDir']).toBeUndefined()
  expect(settings['accounts']).toBeUndefined()
  expect(settings['telegram']).toBeUndefined()
  expect(all(d, 'SELECT enabled FROM routines')).toEqual([{ enabled: 0 }])
  const a = one<Record<string, unknown>>(d, "SELECT computer, apps, folders, account FROM agents WHERE computer_kind = 'mac'")
  expect(a).toEqual({ computer: 0, apps: '[]', folders: '[]', account: null })
  expect(one<{ n: number }>(d, 'SELECT count(*) AS n FROM messages').n).toBe(made.messages)
  expect(one<{ value: string }>(d, "SELECT value FROM meta WHERE key = 'restoredRoutines'").value).toBe('1')
  d.close()
})

it("refuses a backup from a newer Tucano than the server's, and a file that isn't one", () => {
  const srv = tmp()
  mkdirSync(join(srv, 'uploads'))
  const newer = join(srv, 'uploads', 'newer.db')
  const d = raw(newer)
  d.exec(`CREATE TABLE t (x); PRAGMA user_version = ${MIGRATIONS.length + 1}`)
  d.close()
  expect(() => stageRestore({ file: newer, dataDir: srv, schemaMax: MIGRATIONS.length, app: '0.2.21' })).toThrow(/mais nova|newer/)
  expect(staged(srv)).toBe(false)

  const other = join(srv, 'uploads', 'fotos.zip')
  const z = new ZipWriter(other)
  z.add('foto.jpg', Buffer.from([1]))
  z.close()
  expect(() => stageRestore({ file: other, dataDir: srv, schemaMax: MIGRATIONS.length, app: '' })).toThrow(/backup/)
  expect(staged(srv)).toBe(false)
})

it("takes a daily backup's .db alone", () => {
  const mac = tmp()
  const srv = tmp()
  const db = desktop(mac)
  mkdirSync(join(srv, 'uploads'))
  const up = join(srv, 'uploads', 'tucano-2026-11-10-08-00.db')
  db.backupTo(up)
  db.close()
  const found = stageRestore({ file: up, dataDir: srv, schemaMax: MIGRATIONS.length, app: '' })
  expect(found.agents).toBeGreaterThan(0)
  expect(found.wikiPages).toBe(0)
  markRestoreReady(srv)
  expect(applyRestore(srv)).toBe(true)
  const restored = new Db(join(srv, 'tucano.db'))
  expect(finishRestore(restored, srv)).toBe(1)
  expect(restored.agents().length).toBeGreaterThan(0)
  restored.close()
})
