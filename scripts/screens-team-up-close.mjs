// Team-ups close: one is closed by right-click in the sidebar, and one nobody came back to closes
// itself the next time the app opens. Fresh data, fake engines.
// Run after `npm run build`: node scripts/screens-team-up-close.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens/team-up-close'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-teamup-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'en-US' }
const day = 86_400_000

async function open() {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.setViewportSize({ width: 1280, height: 820 })
  await win.waitForSelector('.sidebar')
  return { app, win, errors }
}
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle(win) {
  const deadline = Date.now() + 25_000
  let quiet = 0
  while (Date.now() < deadline && quiet < 3) {
    await win.waitForTimeout(500)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(win, text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
}
const teamUps = (win) => win.locator('.nav-item', { hasText: /team-up-/ })
const shot = (win, name) => win.screenshot({ path: `${out}/${name}.png` })

// ---------- run 1: a team-up opens, and the person closes it with the right-click menu ----------
let { app, win, errors } = await open()
// #data has only Theo in it, so his reply calling Lia opens a team-up.
await win.locator('.nav-item', { hasText: /^#?\s*data$/i }).first().click()
await send(win, 'peça pra lia ajudar aqui')
await settle(win)
await teamUps(win).first().waitFor({ timeout: 20_000 })
console.log('team-up opened:', (await teamUps(win).first().innerText()).replace(/\s+/g, ' ').trim())
await shot(win, '01-team-up-in-the-sidebar')

await teamUps(win).first().click({ button: 'right' })
await win.waitForSelector('.menu')
console.log('menu:', (await win.locator('.menu [role=menuitem]').allInnerTexts()).join(' | '))
await shot(win, '02-right-click-close-team-up')
await win.locator('.menu [role=menuitem]', { hasText: 'Close team-up' }).click()
await win.waitForSelector('.modal')
await shot(win, '03-confirm')
await win.locator('.modal .btn--danger').click()
await win.waitForTimeout(800)
console.log('team-ups left after closing:', await teamUps(win).count())

// ---------- the setting: how many quiet days, and it saves ----------
await win.locator('.nav-item', { hasText: /^Settings$/ }).first().click()
await win.locator('.tabs button, .settings-nav button, [role=tab]', { hasText: /^Agents$/ }).first().click().catch(() => {})
await win.locator('.field', { hasText: 'Close on its own after' }).first().scrollIntoViewIfNeeded()
const days = win.locator('.field', { hasText: 'Close on its own after' }).first().locator('input')
console.log('days field, as it opens:', await days.inputValue())
await shot(win, '04-setting-team-ups')
await days.fill('3')
await days.blur()
await win.waitForTimeout(400)

// A second team-up, left alone: it's the one the next run finds gone.
await win.locator('.nav-item', { hasText: /^#?\s*data$/i }).first().click()
await send(win, 'peça pra lia montar o painel')
await settle(win)
await teamUps(win).first().waitFor({ timeout: 20_000 })
const second = (await teamUps(win).first().innerText()).replace(/\s+/g, ' ').trim()
console.log('second team-up:', second)
console.log('errors in run 1:', errors.length ? errors : 'none')
await app.close()

// ---------- the days go by: backdate that team-up, as a week of quiet would ----------
const db = new DatabaseSync(join(data, 'tucano.db'))
const rows = db.prepare('SELECT id, name FROM conversations WHERE team_up IS NOT NULL').all()
for (const r of rows) {
  db.prepare("UPDATE conversations SET team_up = json_set(team_up, '$.at', json_extract(team_up, '$.at') - ?) WHERE id = ?").run(5 * day, r.id)
  db.prepare('UPDATE messages SET at = at - ? WHERE conversation_id = ?').run(5 * day, r.id)
}
const quiet = db.prepare("SELECT json_extract(team_up, '$.at') AS at, id FROM conversations WHERE team_up IS NOT NULL").all()
console.log('backdated by 5 days:', quiet.map((r) => r.id).join(', ') || 'none')
db.close()

// ---------- run 2: it closes itself on startup, and everything else stays ----------
;({ app, win, errors } = await open())
await win.waitForTimeout(2500)
console.log('team-ups after reopening, 5 quiet days and 3 allowed:', await teamUps(win).count())
console.log('channels still there:', await win.locator('.nav-item', { hasText: /^#?\s*(data|content|engineering)$/i }).count())
await shot(win, '05-after-reopening')
console.log('errors in run 2:', errors.length ? errors : 'none')
await app.close()
console.log('data dir:', data)
