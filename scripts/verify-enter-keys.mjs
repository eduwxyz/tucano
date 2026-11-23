// Proves the four keys on the real app: Shift+Enter stays the line break (nothing is sent), Ctrl+Enter
// queues, Alt+Enter hands the prompt into the running reply. Seeded data and fake engines: nothing real
// is touched. Run after `npm run build`: node scripts/verify-enter-keys.mjs
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const data = mkdtempSync(join(tmpdir(), 'tucano-keys-'))
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en' }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const out = {}
const say = (k, v) => {
  out[k] = v
  console.log(k, '=', JSON.stringify(v))
}

await win.locator('.nav-item', { hasText: 'engineering' }).first().click()
await win.waitForSelector('.composer textarea')
await win.waitForTimeout(400)

// A reply that takes its time, so the next prompt meets it while it runs.
await win.fill('.composer textarea', '@Lia conte uma história sobre um jardim, demore 9 s')
await win.keyboard.press('Enter')
await win.waitForTimeout(1200)
say('replyRunning', (await win.locator('.msg__working, .tag').allInnerTexts()).slice(0, 3))

// Shift+Enter: a new line in the field, and nothing sent.
const before = await win.locator('.msg').count()
await win.fill('.composer textarea', 'linha um')
await win.locator('.composer textarea').press('Shift+Enter')
await win.waitForTimeout(200)
await win.keyboard.type('linha dois')
await win.waitForTimeout(200)
say('shiftEnterField', await win.locator('.composer textarea').inputValue())
say('shiftEnterSent', (await win.locator('.msg').count()) - before)

// The chip in the bar still names the keys it says.
say('chip', await win.locator('.composer__mode').count())

// Ctrl+Enter with that text: it goes out, queued (the setting is still the default, parallel).
await win.locator('.composer textarea').press('Control+Enter')
await win.waitForTimeout(900)
say('ctrlEnterSent', (await win.locator('.msg').count()) - before)
say('ctrlEnterMarks', (await win.locator('.msg__queued').allInnerTexts()).map((t) => t.trim()))
say('fieldAfterSend', await win.locator('.composer textarea').inputValue())

// Alt+Enter: handed into the reply that is still running.
await win.fill('.composer textarea', 'mude de plano: fale do inverno')
await win.locator('.composer textarea').press('Alt+Enter')
await win.waitForTimeout(900)
say('altEnterMarks', (await win.locator('.msg__queued').allInnerTexts()).map((t) => t.trim()))

// The setting's own hint, as the person reads it.
await win.locator('.nav-item', { hasText: 'Settings' }).first().click()
await win.waitForTimeout(700)
await win.locator('[role=tab], .tabs button', { hasText: 'Agents' }).first().click()
await win.waitForTimeout(600)
const field = win.locator('.field', { hasText: 'A new prompt while a reply is running' }).first()
await field.scrollIntoViewIfNeeded()
say('hint', (await field.innerText()).replace(/\s+/g, ' ').trim())

say('pageErrors', errors.slice(0, 5))
await app.close()
