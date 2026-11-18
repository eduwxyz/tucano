// Frames for "The Tuca can set a bot's skills" (issue + PR).
// One run of the built app, seeded workspace, fake engines: two skills exist, the Tuca is asked to
// leave Theo with one of them, the card shows both sides, applying it changes the skills, and the
// skills page and Theo's own page read back what changed.
// Run after `npm run build`: node scripts/screens-tuca-skills.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/tuca-skills'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []

const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForSelector('.sidebar')
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
const oneLine = (s) => (s ?? '').replace(/[ \t\r\n]+/g, ' ').trim()

async function settle(ms = 20_000) {
  const deadline = Date.now() + ms
  let quiet = 0
  while (Date.now() < deadline && quiet < 3) {
    await win.waitForTimeout(400)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await settle()
}

// Two skills, made through the page the person uses: one the Tuca keeps, one it drops.
async function makeSkill(name, when, body) {
  await win.locator('.nav-item:has-text("Skills")').first().click()
  await win.waitForSelector('button:has-text("New skill")', { timeout: 10_000 })
  await win.locator('button:has-text("New skill")').first().click()
  await win.waitForSelector('.agent-form input')
  await win.locator('.agent-form input').nth(0).fill(name)
  await win.locator('.agent-form input').nth(1).fill(when)
  await win.locator('.agent-form textarea').first().fill(body)
  await win.locator('.agent-form button:has-text("Create skill")').first().click()
  await win.waitForTimeout(500)
}
await makeSkill('tucano-ops', 'When working on the Tucano harness', 'Read the recipe, then do the thing.\nCheck the result before saying it is done.')
await makeSkill('other-one', 'When doing the other thing', 'Steps for the other thing.')
console.log('skills in the workspace:', JSON.stringify((await win.locator('body').innerText()).match(/tucano-ops|other-one/g)))

// The Tuca's own DM.
await win.locator('.nav-item:has-text("Tuca")').first().click()
await win.waitForSelector('.composer textarea')
// The first turn after a boot can't reach its tools yet: one plain exchange, then the ask.
await send('Hi!')
await send('Leave Theo with only the tucano-ops skill, please.')
await win.waitForSelector('.proposal-rows', { timeout: 30_000 })
await win.waitForTimeout(400)

const rows = await win.locator('.msg--agent').last().locator('.proposal-rows > div').evaluateAll((els) =>
  els.map((el) => {
    const [label, value] = [...el.children].map((c) => c.innerText.trim())
    return { label, value }
  })
)
const box = async () =>
  win.locator('.msg--agent').last().evaluate((el) => {
    const card = el.querySelector('.proposal, .proposal-card, .msg__proposals') ?? el
    const r = card.getBoundingClientRect()
    const pickers = [...card.querySelectorAll('input, button, select')].map((b) => b.getBoundingClientRect())
    return {
      width: Math.round(r.width),
      overflow: Math.round(card.scrollWidth - card.clientWidth),
      widestChild: Math.round(Math.max(...pickers.map((b) => b.right)) - r.right)
    }
  })
console.log('card rows:', JSON.stringify(rows))
console.log('card at 1280:', JSON.stringify(await box()))
await win.locator('.msg--agent').last().screenshot({ path: `${out}/01-the-card.png` })
await win.screenshot({ path: `${out}/01-the-window.png` })

// What the card says once it is applied.
await win.locator('button:has-text("Apply")').last().click()
await win.waitForTimeout(1500)
const after = oneLine(await win.locator('.msg--agent').last().innerText())
console.log('after applying, the card reads:', JSON.stringify(after.slice(0, 260)))
await win.locator('.msg--agent').last().screenshot({ path: `${out}/02-applied.png` })

// The Tuca is a takeover page: Close goes back to the app, where the sidebar is.
await win.locator('button:has-text("Close")').first().click()
await win.waitForSelector('.sidebar')
await win.locator('.nav-item:has-text("Skills")').first().click()
await win.waitForSelector('text=tucano-ops', { timeout: 10_000 })
await win.waitForTimeout(600)
const page = oneLine(await win.locator('.main, .page, body').last().innerText())
console.log('skills page:', JSON.stringify(page.slice(0, 700)))
await win.screenshot({ path: `${out}/03-the-skills-page.png` })

// Back to the card for the narrow window.
await win.locator('.nav-item:has-text("Tuca")').first().click()
await win.waitForTimeout(600)
await win.setViewportSize({ width: 420, height: 900 })
await win.waitForTimeout(600)
const narrow = await box()
console.log('at 420:', JSON.stringify({ page: [await win.evaluate(() => document.documentElement.clientWidth), await win.evaluate(() => document.documentElement.scrollWidth)], ...narrow }))
await win.screenshot({ path: `${out}/04-at-420.png` })

console.log('page errors:', errors.length, errors.slice(0, 3))
await app.close()
