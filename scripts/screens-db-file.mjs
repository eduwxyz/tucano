// Screenshots of the file's card in Settings › General: what it takes, what is free, and a rebuild in
// progress and done. Run after `npm run build`: node scripts/screens-db-file.mjs [out-dir]
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright'

const out = process.argv[2] ?? 'frames/db-file'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-dbfile-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en' }
const errors = []

async function open() {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'electron')}`], env })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// A first run, to create the file and the starter team.
const first = await open()
await first.win.waitForTimeout(900)
await first.app.close()

// Six megabytes that were said once and are gone: the pages stay in the file until it is rebuilt.
{
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const now = Date.now()
  const me = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get().id
  const conv = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' ORDER BY created_at LIMIT 1").get().id
  const say = db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, ?, ?, ?, ?)')
  for (let i = 0; i < 120; i++) say.run(`bulk-${i}`, conv, 'person', me, `${i} `.padEnd(50_000, 'w'), now - i)
  db.prepare("DELETE FROM messages WHERE id LIKE 'bulk-%'").run()
  db.close()
}

const { app, win } = await open()
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

await win.locator('.nav-item', { has: win.locator('.nav-item__label') }).filter({ hasText: /^Settings$/ }).first().click()
await win.waitForSelector('.tabs')
const card = win.locator('.workspace-danger').first()
await card.scrollIntoViewIfNeeded()
await win.waitForTimeout(400)
const said = await card.textContent()
assert.ok(/MB/.test(said ?? ''), `the card says the size, got ${said}`)
assert.ok(/sound/i.test(said ?? ''), `the card says the check, got ${said}`)
await shot('db-file-1-card')

// The press: the button says it is working while the core rebuilds.
await card.locator('button.btn', { hasText: 'Optimize' }).click()
await win.waitForTimeout(250)
await shot('db-file-2-optimizing')
await win.waitForFunction(() => /→|compact|sound/.test(document.querySelector('.card [role="status"]')?.textContent ?? ''), null, { timeout: 60_000 })
await win.waitForTimeout(300)
await shot('db-file-3-after')
const done = await card.locator('[role="status"]').textContent()
assert.ok(/→|compact|Still/.test(done ?? ''), `the note says what went, got ${done}`)
await app.close()

console.log(errors.length ? `page errors: ${errors.join(' | ')}` : `ok, no page errors; note: ${done}`)
