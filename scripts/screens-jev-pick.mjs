// The pill on a question with options: the card as it is, then the same card with a pick on it.
// TypeSafe can't be reached from a seeded run, so the pick is written onto the waiting message the
// way the core writes it (one entry per decision, by index into its options), then the app reloads.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'screens'
mkdirSync(out, { recursive: true })

const data = mkdtempSync(join(tmpdir(), 'tucano-pick-'))
for (const dir of [tmpdir(), '/tmp']) rmSync(join(dir, 'tucano-demo-tasks.json'), { force: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = async (name) => win.screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle() {
  const deadline = Date.now() + 15_000
  let quiet = 0
  while (Date.now() < deadline && quiet < 3) {
    await win.waitForTimeout(500)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
}

// The agent asks one decision with options and one in free text.
await send('@Lia me ajuda a decidir')
await settle()
await win.waitForSelector('.ask--answer', { timeout: 15_000 })
await win.waitForTimeout(300)
await shot('01-pergunta-sem-selo')

// The pick, written where the core writes it: option 2 of the decision with options, nothing for
// the text one. Then a reload, so the renderer reads the message again.
const db = new DatabaseSync(join(data, 'tucano.db'))
const row = db.prepare("SELECT id FROM messages WHERE json_extract(run, '$.status') = 'waiting_input' ORDER BY at DESC LIMIT 1").get()
if (!row) throw new Error('no waiting question in the seeded run')
db.prepare("UPDATE messages SET run = json_set(run, '$.recommended', json('[1, null]')) WHERE id = ?").run(row.id)
const check = db.prepare("SELECT json_extract(run, '$.recommended') AS r FROM messages WHERE id = ?").get(row.id)
db.close()
console.log('recommended on the message:', check?.r)

await win.reload()
await win.waitForSelector('.sidebar')
// The app comes back on the conversation it was on, which is the one that asked.
await win.waitForSelector('.ask-option__pill', { timeout: 20_000 })
await win.waitForTimeout(300)
await shot('02-pergunta-com-selo')

// The pill is on exactly one option, and nothing is ticked by it.
const pills = await win.locator('.ask-option__pill').count()
const pillText = await win.locator('.ask-option__pill').first().innerText()
const pillOption = await win.locator('.ask-option:has(.ask-option__pill) .ask-option__label').first().innerText()
const ticked = await win.locator('.ask-option.is-on').count()
const checked = await win.locator('.ask-option[aria-checked="true"]').count()
console.log(JSON.stringify({ pills, pillText, pillOption, ticked, checked }))

// Narrow: the pill wraps under the label rather than squeezing it, and nothing overflows sideways.
await win.setViewportSize({ width: 420, height: 820 })
await win.waitForTimeout(300)
const picked = win.locator('.ask-option:has(.ask-option__pill)').first()
await picked.scrollIntoViewIfNeeded()
const rowBox = await picked.boundingBox()
const pillBox = await win.locator('.ask-option__pill').first().boundingBox()
const labelBox = await win.locator('.ask-option:has(.ask-option__pill) .ask-option__label').first().boundingBox()
const overflowX = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
await shot('05-estreito')
console.log(JSON.stringify({ rowBox, pillBox, labelBox, overflowX }))
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForTimeout(200)

// The setting: off by default, and what it looks like turned on.
await win.click('.nav-item:has-text("Settings")')
await win.click('.tabs [role=tab]:has-text("Agents")')
const toggle = win.locator('.key-row:has-text("Mark the recommended option")')
await toggle.scrollIntoViewIfNeeded()
await shot('03-ajuste-desligado')
console.log('toggle off by default:', (await toggle.locator('.toggle').getAttribute('aria-checked')) === 'false')
await toggle.locator('.toggle').click()
await win.waitForTimeout(400)
await shot('04-ajuste-ligado')
console.log('toggle on after a click:', (await toggle.locator('.toggle').getAttribute('aria-checked')) === 'true')

console.log('page errors:', errors.length ? errors : 'none')
await app.close()
