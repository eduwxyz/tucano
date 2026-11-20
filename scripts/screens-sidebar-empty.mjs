// The two settings that keep the sidebar clean, in the built app: Asks and Approvals out of the
// sidebar while nothing waits in them (both off by default), back on their own as soon as one
// question or one approval exists — and still on after a restart, because it's saved.
// Run after `npm run build`: node scripts/screens-sidebar-empty.mjs [out dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens/sidebar-empty'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-sidebar-'))
const errors = []

async function open() {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' } })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 820 })
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForSelector('.sidebar')
  await win.waitForTimeout(800)
  return { app, win }
}

// The nav entry, by its label, and what the sidebar shows right now.
const nav = (win, label) => win.locator('.nav-item', { hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') })
const labels = async (win) => (await win.locator('.nav-item__label').allInnerTexts()).map((s) => s.trim())
const card = (win) => win.locator('.card', { hasText: 'Sidebar' }).last()

const report = {}
let { app, win } = await open()
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

// 1. As it ships: both entries there with nothing waiting.
report.defaultSidebar = await labels(win)
await shot('01-default-both-there')

// 2. Settings › General › Sidebar: the two switches, both off.
await nav(win, 'Settings').click()
await win.waitForTimeout(500)
await card(win).scrollIntoViewIfNeeded()
await win.waitForTimeout(200)
report.switchesOff = await card(win).locator('.toggle').evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked')))
await shot('02-settings-both-off')

// 3. Both on, and the sidebar loses the two entries.
await card(win).locator('.toggle').nth(0).click()
await win.waitForTimeout(150)
await card(win).locator('.toggle').nth(1).click()
await win.waitForTimeout(400)
report.switchesOn = await card(win).locator('.toggle').evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked')))
await shot('03-settings-both-on')
// Out of settings and into a channel: the Tuca's screen has no sidebar at all.
await win.locator('.nav-item', { hasText: /engineering|geral|general/i }).first().click()
await win.waitForTimeout(500)
report.emptySidebar = await labels(win)
await shot('04-sidebar-clean')

// 4. What the core saved.
const saved = () => {
  const db = new DatabaseSync(join(data, 'tucano.db'), { readOnly: true })
  const get = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return row ? JSON.parse(row.value) : undefined
  }
  const out = { asks: get('hideEmptyAsks'), approvals: get('hideEmptyApprovals') }
  db.close()
  return out
}
report.saved = saved()

// 5. A question and an approval arrive: both entries come back on their own.
await app.close()
{
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const now = Date.now()
  const conv = db.prepare("SELECT id FROM conversations ORDER BY kind = 'dm' DESC LIMIT 1").get()
  const agent = db.prepare('SELECT id, name FROM agents LIMIT 1').get()
  const owner = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get()
  db.prepare('INSERT OR REPLACE INTO questions (id, conversation_id, agent_id, text, asked_to, requested_by, state, deadline_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'q-screen',
    conv.id,
    agent.id,
    'Publico o post de hoje com o case da Clínica, ou espero o material novo?',
    owner.id,
    owner.id,
    'open',
    now + 86_400_000,
    now
  )
  db.prepare(
    'INSERT OR REPLACE INTO approvals (id, hash, agent_id, conversation_id, message_id, connector_id, connector_name, tool, args, why, high_risk, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('ap-screen', 'h-screen', agent.id, conv.id, 'm-screen', 'computador', 'This computer', 'run', JSON.stringify({ command: 'npm run build' }), 'It builds the app.', 0, 'pending', now, now + 86_400_000)
  db.close()
}
;({ app, win } = await open())
report.backSidebar = await labels(win)
report.backBadges = await win.locator('.nav-item .badge').allInnerTexts()
await shot('05-back-with-one-question')

// 6. And the setting is still there after the restart, so the empty state stays quiet next time.
await nav(win, 'Settings').click()
await win.waitForTimeout(400)
await card(win).scrollIntoViewIfNeeded()
report.afterRestart = await card(win).locator('.toggle').evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked')))
await shot('06-settings-after-restart')

report.pageErrors = errors
console.log(JSON.stringify(report, null, 2))
await app.close()
