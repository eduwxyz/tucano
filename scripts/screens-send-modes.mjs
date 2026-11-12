// Frames for the send-mode fix: the chip that says what Enter does while a reply runs, and the mark on
// a message handed into the running reply. Seeded data and fake engines: nothing real is touched.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'screens-send-modes'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-sm-'))
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
const shot = (n) => win.screenshot({ path: `${out}/${n}.png` })
const out_ = {}
const openChannel = async (name) => {
  await win.locator('.nav-item', { hasText: name }).first().click()
  await win.waitForSelector('.composer textarea')
  await win.waitForTimeout(400)
}

// 1. The channel, and a reply that takes its time.
await openChannel('engineering')
await win.fill('.composer textarea', '@Lia conte uma história sobre um jardim, demore 9 s')
await win.keyboard.press('Enter')
await win.waitForTimeout(1000)
await shot('01-reply-running')

// 2. Settings: Enter hands a new prompt to the reply that's running (the choice Apo made once).
await win.locator('.nav-item', { hasText: 'Settings' }).first().click()
await win.waitForTimeout(700)
await win.locator('[role=tab], .tabs button', { hasText: 'Agents' }).first().click()
await win.waitForTimeout(600)
const field = win.locator('.field', { hasText: 'A new prompt while a reply is running' }).first()
await field.scrollIntoViewIfNeeded()
await field.locator('button').first().click()
await win.waitForTimeout(300)
await shot('02-settings-options')
await win.locator('[role=option]', { hasText: 'Handed to the running reply' }).first().click()
await win.waitForTimeout(500)
out_.settingsValue = (await field.innerText()).replace(/\s+/g, ' ').trim()
await shot('03-settings-picked')

// 3. Back in the channel: the composer says what Enter will do, so it can't act invisibly.
await openChannel('engineering')
await win.waitForTimeout(300)
out_.chip = await win.locator('.composer__mode').first().innerText()
await shot('04-composer-chip')

// 4. A plain Enter while the reply runs: handed into it, and the message says where it went.
await win.fill('.composer textarea', 'mude de plano: fale do inverno')
await win.keyboard.press('Enter')
await win.waitForTimeout(800)
out_.handedTags = await win.locator('.msg__queued').allInnerTexts()
await shot('05-handed-over')

// 5. The reply ends without taking it: it gets a reply of its own, so nothing stays silent.
let quiet = 0
const deadline = Date.now() + 60_000
while (Date.now() < deadline && quiet < 4) {
  await win.waitForTimeout(500)
  quiet = (await win.locator('.msg .shimmer, .msg .typing, .system-line.is-pending').count()) === 0 ? quiet + 1 : 0
}
await win.waitForTimeout(800)
out_.replies = await win.locator('.msg--agent').count()
out_.handedTagsAfter = await win.locator('.msg__queued').allInnerTexts()
await shot('06-answered')

// 6. One click on the chip and Enter is plain again.
await win.locator('.composer__mode').first().click()
await win.waitForTimeout(400)
out_.chipAfterClick = await win.locator('.composer__mode').count()
await shot('07-back-to-plain')

// 7. Back on the plain one (the chip click above set it): a second Enter while a reply runs goes
// beside it, a reply of its own, two on the floor at once: the way `parallel` is meant to read.
await openChannel('engineering')
out_.chipOnParallel = await win.locator('.composer__mode').count()
await win.fill('.composer textarea', '@Lia conte uma história sobre um jardim, demore 8 s')
await win.keyboard.press('Enter')
await win.waitForTimeout(1200)
await win.fill('.composer textarea', '@Lia e fale também do outono, demore 6 s')
await win.keyboard.press('Enter')
await win.waitForTimeout(1200)
out_.atOnce = await win.locator('.msg--agent').evaluateAll((els) =>
  els.map((el) => ({ working: !!el.querySelector('.steps.is-working, .shimmer'), text: (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 40) }))
)
out_.workingAtOnce = out_.atOnce.filter((m) => m.working).length
out_.queuedMarks = await win.locator('.msg__queued').count()
await shot('08-two-replies-at-once')

// 8. And both end, each with an answer of its own.
let done = 0
const until = Date.now() + 90_000
while (Date.now() < until && done < 4) {
  await win.waitForTimeout(700)
  done = (await win.locator('.msg--agent .shimmer, .msg--agent .steps.is-working').count()) === 0 ? done + 1 : 0
}
await win.waitForTimeout(800)
out_.atOnceAfter = await win.locator('.msg--agent').count()
out_.repliesText = await win.locator('.msg--agent .msg__body').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60)))
await shot('09-both-answered')

console.log(JSON.stringify({ data, out: out_, errors }, null, 2))
await app.close()
