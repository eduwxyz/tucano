// Screenshots of a hand-off answer that comes back however it ends (issue #376): Lia hands Theo a
// piece of work in her DM, Theo's reply stops at a question, and what he wrote before asking reaches
// Lia instead of the question alone. Fresh data, fake engines. Run after `npm run build`:
// node scripts/screens-answer-back.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/answer-back'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'en' }
const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// The first start makes the seed's team; then Theo and Nina answer to Lia, as the agent page would set it.
const first = await launch()
await first.app.close()
execFileSync('sqlite3', [
  join(data, 'tucano.db'),
  "UPDATE agents SET reports_to = (SELECT id FROM agents WHERE handle = 'lia') WHERE handle IN ('theo', 'nina')"
])

const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle(ms = 40_000) {
  const deadline = Date.now() + ms
  let quiet = 0
  while (Date.now() < deadline && quiet < 4) {
    await win.waitForTimeout(500)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
const said = async () => win.locator('.msg').allInnerTexts().catch(() => [])

// Lia's DM: I ask her to hand Theo some work, and Theo answers with a question of his own.
await win.click('.sidebar .nav-item:has-text("Lia")')
await win.click('button:has-text("Open DM")')
await win.waitForSelector('.composer textarea')
await shot('01-dm-before')
await win.fill('.composer textarea', 'delegue a theo: ajuda a decidir o escopo do relatório')
await win.keyboard.press('Enter')
await settle()
await shot('02-dm-what-theo-said-before-asking')

const dm = await said()
const lines = await win.locator('.returned-line').allInnerTexts().catch(() => [])
console.log('--- returned lines, as they arrive ---')
for (const t of lines) console.log(JSON.stringify(t.trim()))
// How each came: an answer folded, a question open by itself (that is the one waiting on the person).
const state = async () =>
  win.locator('.returned-line button.link:not(:has-text("thread"))').evaluateAll((bs) =>
    bs.map((b) => ({ label: b.textContent, open: b.getAttribute('aria-expanded') }))
  )
console.log('fold state on arrival:', JSON.stringify(await state()))
// Whatever is still folded, open it: opened, the question line says what it wrote before asking.
for (const b of await win.locator('.returned-line button.link[aria-expanded="false"]').all()) {
  if (await b.count()) await b.click()
}
await win.waitForTimeout(500)
await win.locator('.returned-line').last().scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
await shot('02b-dm-answer-opened')
const opened = await win.locator('.returned-line').allInnerTexts().catch(() => [])
console.log('--- returned lines (opened) ---')
for (const t of opened) console.log(JSON.stringify(t.trim().slice(0, 300)))
console.log('fold state once opened:', JSON.stringify(await state()))
console.log('so-far text on screen:', opened.some((t) => /So far, on the request|Até agora, sobre o pedido/.test(t)))
console.log('question text on screen:', opened.some((t) => /Paginação|scroll|Quando|When/.test(t)))
console.log('--- in Lia\'s DM ---')
for (const t of dm) console.log(JSON.stringify(t.slice(0, 220)))

// Theo's own thread, in the channel the request landed in: the question he left there.
const chip = win.locator('.delegation-chip button').first()
if (await chip.count()) {
  await chip.click()
  await win.waitForTimeout(900)
  await shot('03-theo-question-in-the-channel')
}

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors')
await app.close()
console.log('data:', data)
