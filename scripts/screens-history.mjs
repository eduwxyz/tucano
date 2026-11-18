// Screenshots of Settings › History and a bot's own, on the built app: the period, the two wipes, and what
// the confirm window says before anything goes. Run after `npm run build`:
//   node scripts/screens-history.mjs [out-dir]
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { _electron as electron } from 'playwright'

const out = process.argv[2] ?? 'frames/history'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-history-'))
// Refuse before launching a build that cannot keep its window hidden. Background QA support
// is proposed separately in #372; passing its flag to an older build alone does not hide it.
const installed = process.env.TUCANO_ELECTRON
const bundle = installed ? join(dirname(installed), 'resources', 'app.asar') : 'out/main/index.js'
assert.ok(readFileSync(bundle).includes(Buffer.from('--qa-background')), 'Build with background QA support (#372) before running this harness')
const reservations = await Promise.all([0, 1].map(async () => {
  const server = createServer()
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  return { server, port: server.address().port }
}))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en', TUCANO_WEBHOOK_PORT: String(reservations[0].port), TUCANO_GIT_PORT: String(reservations[1].port) }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
await Promise.all(reservations.map(({ server }) => new Promise((yes, no) => server.close((error) => error ? no(error) : yes()))))
const errors = []

async function open() {
  const app = await electron.launch({
    ...(installed ? { executablePath: installed } : {}),
    args: [...(installed ? [] : ['.']), '--qa-background'], env
  })
  const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused() && !w.isFocusable()))
  assert.ok(hidden, 'History QA must remain hidden and unfocusable')
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// Use the fake-engine demo in one fresh hidden instance. Age/override behavior is tested
// against real databases in retention-core.test.ts; this flow exercises the visible wipe controls.
// 3. Settings › General, at the danger area: Backups, the history, and the workspace delete.
const { app, win } = await open()
const checks = []
const shot = async (name) => {
  const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused() && !w.isFocusable()))
  assert.ok(hidden, 'History QA exposed a window')
  await win.screenshot({ path: `${out}/${name}.png` })
  checks.push(name)
}
try {

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
assert.deepEqual(errors, [])
writeFileSync(join(out, 'report.json'), JSON.stringify({ checks, errors, passed: true, data, executable: installed ?? 'source Electron' }, null, 2))
console.log('ok, no page errors; all history captures stayed hidden')
} finally { await app.close() }
