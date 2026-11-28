// Frames of a routine with nothing to report: the request in the channel, the empty reply as one
// quiet line, what it did behind it, and the sidebar without a badge. Fake engines, a temp
// workspace, and two routines made due a moment ago so the app runs them on its first tick.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2]
if (!out) throw new Error('usage: node scripts/screens-silent.mjs <out folder>')
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-silent-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '1' }

// 1. A first launch, to seed the demo team and its channels.
const first = await electron.launch({ args: ['.'], env })
const firstWin = await first.firstWindow()
await firstWin.waitForSelector('.sidebar')
await firstWin.waitForTimeout(1500)
await first.close()

// 2. Two routines, due thirty seconds ago: one with nothing to report, one that reports.
const db = new DatabaseSync(join(data, 'tucano.db'))
const agent = (handle) => db.prepare('SELECT id FROM agents WHERE handle = ?').get(handle).id
const channel = (name) => db.prepare('SELECT id FROM conversations WHERE kind = ? AND name = ?').get('channel', name).id
const add = (name, handle, where, prompt) =>
  db
    .prepare(
      `INSERT INTO routines (id, name, agent_id, conversation_id, prompt, days, time, once, date, month_day, enabled, next_at, last_at, last_message_id, created_by, created_at, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 1, ?, NULL, NULL, NULL, ?, NULL)`
    )
    .run(randomUUID(), name, agent(handle), channel(where), prompt, JSON.stringify([1, 2, 3, 4, 5]), '09:00', Date.now() - 30_000, Date.now())
add('Morning check', 'lia', 'engineering', "Remember that yesterday's build went through with no errors. If there is nothing I need to know, answer just [SILENT].")
add('Day wrap-up', 'theo', 'data', 'Sum up what is open in Linear.')
db.close()

// 3. The app again: it runs both on the first tick.
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
await win.setViewportSize({ width: 1360, height: 880 })
await win.waitForSelector('.sidebar')
const quiet = win.locator('.msg', { has: win.locator('.steps__summary', { hasText: /Nada a informar|Nothing to report/ }) })
await quiet.first().waitFor({ timeout: 90_000 })
await win.waitForTimeout(800)

// 4. The frames.
await win.locator('.conversation').screenshot({ path: `${out}/01-the-channel.png` })
await quiet.first().scrollIntoViewIfNeeded()
await quiet.first().screenshot({ path: `${out}/02-the-reply.png` })
const closed = await win.evaluate(() => {
  const reply = [...document.querySelectorAll('.msg')].find((m) => /Nada a informar|Nothing to report/.test(m.querySelector('.steps__summary')?.textContent ?? ''))
  const box = reply?.getBoundingClientRect()
  return { height: Math.round(box?.height ?? 0), width: Math.round(box?.width ?? 0), open: reply?.querySelector('.steps')?.classList.contains('is-open') ?? null, steps: reply?.querySelectorAll('.step').length ?? 0, words: (reply?.textContent ?? '').trim() }
})
await quiet.first().locator('.steps__toggle').click()
await win.waitForTimeout(400)
await quiet.first().screenshot({ path: `${out}/03-what-it-did.png` })
await win.locator('.sidebar').screenshot({ path: `${out}/04-no-badge.png` })

// 5. What the screen actually says, for the body.
const measured = await win.evaluate(() => {
  const reply = [...document.querySelectorAll('.msg')].find((m) => /Nada a informar|Nothing to report/.test(m.querySelector('.steps__summary')?.textContent ?? ''))
  const row = reply?.closest('.msg') ?? reply
  const badges = [...document.querySelectorAll('.sidebar [class*="nav-item"], .sidebar .nav-item')]
    .map((el) => ({ name: el.textContent?.trim() ?? '', badge: el.querySelector('.badge')?.textContent ?? null }))
    .filter((x) => x.badge)
  return {
    text: reply?.querySelector('.md')?.textContent ?? null,
    line: row?.querySelector('.steps__summary')?.textContent ?? null,
    open: row?.querySelector('.steps')?.classList.contains('is-open') ?? null,
    steps: row?.querySelectorAll('.step').length ?? 0,
    width: Math.round(row?.getBoundingClientRect().width ?? 0),
    badges,
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})
console.log('closed, as first drawn:', JSON.stringify(closed, null, 1))
console.log('the reply, as drawn:', JSON.stringify(measured, null, 1))
console.log('page errors:', errors)
await app.close()
