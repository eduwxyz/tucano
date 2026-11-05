// Screenshots of an agent's profile card: from a message's face and name, in a thread,
// at the top of a DM, in the dark and on a narrow window. Fresh data, fake engines.
// Run after `npm run build`: node scripts/screens-agent-card.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/agent-card'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle() {
  const deadline = Date.now() + 20_000
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

// A channel with a reply from an agent.
await win.locator('.nav-item', { hasText: /^#?\s*geral|general/i }).first().click().catch(() => {})
await send('@lia o que você acha de revisar o checkout hoje?')
await settle()

// The face on the reply opens the card next to it.
await win.locator('.msg--agent .msg__face').last().click()
await win.waitForSelector('.agent-card')
await win.waitForTimeout(250)
await shot('01-card-from-face')

// Esc closes it; the name opens it with the keyboard.
await win.keyboard.press('Escape')
await win.locator('.msg--agent .msg__author').last().focus()
await win.keyboard.press('Enter')
await win.waitForSelector('.agent-card')
await win.waitForTimeout(250)
await shot('02-card-from-name-keyboard')
console.log('focus moved into the card:', await win.evaluate(() => !!document.activeElement?.closest('.agent-card')))
await win.keyboard.press('Escape')
console.log('focus back on the name after Esc:', await win.evaluate(() => !!document.activeElement?.classList.contains('msg__author')))

// While the agent works, the card says on what.
await send('@theo demore 6 s e calcule a mediana de 3, 9 e 4')
await win.waitForSelector('.msg .shimmer', { timeout: 10_000 }).catch(() => {})
await win.locator('.msg--agent .msg__face').last().click()
await win.waitForSelector('.agent-card')
await win.waitForTimeout(250)
await shot('03-card-working')
await win.keyboard.press('Escape')
await settle()

// In a thread on the side.
await win.locator('.msg--agent').last().hover()
await win.locator('.msg--agent .msg__reply').last().click({ force: true })
await win.waitForSelector('.thread .msg__face, .thread__lead .msg__face', { timeout: 5000 }).catch(() => {})
const inThread = win.locator('.thread .msg--agent .msg__face, .thread__lead .msg--agent .msg__face').first()
if (await inThread.count()) {
  await inThread.click()
  await win.waitForSelector('.agent-card')
  await win.waitForTimeout(250)
  await shot('04-card-in-thread')
  await win.keyboard.press('Escape')
  const threadStillOpen = await win.locator('.side-panel--thread').count()
  console.log('thread stays open after Esc on the card:', threadStillOpen > 0)
}

// "Mensagem" on the card opens the DM; its top opens the card again, with the conversation's settings.
await win.locator('.msg--agent .msg__face').first().click()
await win.click('.agent-card button:has-text("Mensagem")')
await win.waitForSelector('.topbar__name[aria-haspopup]')
await win.click('.topbar__name')
await win.waitForSelector('.agent-card')
await win.waitForTimeout(250)
await shot('05-card-dm-top')
await win.keyboard.press('Escape')

// Dark.
await win.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
await win.click('.topbar__name')
await win.waitForSelector('.agent-card')
await win.waitForTimeout(250)
await shot('06-card-dark')
await win.keyboard.press('Escape')
await win.evaluate(() => delete document.documentElement.dataset.theme)

// Narrow, on a reply in the DM.
await win.setViewportSize({ width: 420, height: 800 })
await send('oi, tudo certo?')
await settle()
await win.locator('.msg--agent .msg__face').last().click()
await win.waitForSelector('.agent-card')
await win.waitForTimeout(250)
await shot('07-card-narrow')

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no errors')
await app.close()
