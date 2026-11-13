// Screenshots of Settings › History and a bot's own, on the built app: the period, the two wipes, and what
// the confirm window says before anything goes. Run after `npm run build`:
//   node scripts/screens-history.mjs [out-dir]
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright'

const out = process.argv[2] ?? 'frames/history'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-history-'))
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

// 1. A first run, only to create the database and the starter team.
let app1 = await open()
await app1.win.waitForTimeout(900)
await app1.app.close()

// 2. Three weeks of history in a channel and in a bot's DM, and one bot that keeps everything.
let lia = ''
{
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const now = Date.now()
  const me = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get().id
  const agents = db.prepare('SELECT id, name FROM agents ORDER BY created_at').all()
  lia = agents[0].id
  const channel = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' ORDER BY created_at LIMIT 1").get()
  const dm = db.prepare("SELECT id FROM conversations WHERE kind = 'dm' ORDER BY created_at LIMIT 1").get()
  db.prepare('UPDATE agents SET retention_days = 0 WHERE id = ?').run(lia)
  const say = db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, ?, ?, ?, ?)')
  const day = 86_400_000
  for (let i = 0; i < 24; i++) {
    const at = now - (40 - i) * day
    say.run(`h-${i}`, channel.id, i % 3 === 0 ? 'agent' : 'person', i % 3 === 0 ? agents[i % agents.length].id : me, `Message ${i} of the channel's old history.`, at)
    if (dm) say.run(`d-${i}`, dm.id, i % 2 === 0 ? 'agent' : 'person', i % 2 === 0 ? lia : me, `Message ${i} of the private history.`, at)
  }
  db.close()
}

// 3. Settings › General, at the danger area: Backups, the history, and the workspace delete.
const { app, win } = await open()
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

await win.locator('.nav-item', { has: win.locator('.nav-item__label') }).filter({ hasText: /^Settings$/ }).first().click()
await win.waitForSelector('.tabs')
const area = win.locator('.workspace-danger').first()
const card = area.locator('.workspace-danger__section', { hasText: 'History' }).first()
await area.scrollIntoViewIfNeeded()
await win.waitForTimeout(200)
await shot('01-settings-history')

// The first press asks; nothing has gone yet.
await card.locator('button.btn--danger').click()
await win.waitForSelector('.modal')
await win.waitForTimeout(150)
await shot('02-global-wipe-asks')
await win.locator('.modal .btn--danger').click()
await win.waitForTimeout(700)
await shot('03-settings-after-wipe')
const note = await card.locator('[role="status"]').textContent()
assert.ok(/\d+ message/.test(note ?? ''), `the note says how many went, got ${note}`)
assert.ok(errors.length === 0, `no page errors: ${errors.join(' | ')}`)

// 4. The bot's own: its period, its wipe.
await win.locator('.nav-item', { has: win.locator('[class*="avatar"]') }).nth(1).click()
await win.waitForSelector('.agent-form')
const own = win.locator('.card--danger', { hasText: 'history' }).first()
await own.scrollIntoViewIfNeeded()
await own.locator('button[role="radio"]', { hasText: 'Only this bot' }).click()
await win.waitForTimeout(150)
await own.locator('input[type="number"]').fill('0')
await win.waitForTimeout(150)
await shot('04-bot-history')
await own.locator('button.btn--danger').click()
await win.waitForSelector('.modal')
await win.waitForTimeout(150)
await shot('05-bot-wipe-asks')
const title = await win.locator('.modal [role="dialog"]').first().getAttribute('aria-label')
assert.ok(/history/i.test(title ?? ''), `the bot's window names its history, got ${title}`)
await win.locator('.modal .btn--ghost').click()
await app.close()

console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'ok, no page errors')
