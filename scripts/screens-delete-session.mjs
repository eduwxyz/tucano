// Screenshots of the session trash: the glyph under the thread button on a reply, red from the first
// press on, and the conversation without that reply after the second. Fresh data, fake engines.
// Run after `npm run build`: node scripts/screens-delete-session.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/delete-session'
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
  const deadline = Date.now() + 40_000
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

// A channel with two replies: one of them is the session to delete.
await win.locator('.nav-item', { hasText: /^#?\s*geral|general/i }).first().click().catch(() => {})
await send('guarda o plano de hoje')
await settle()
await send('agora revisa o checkout')
await settle()

const last = win.locator('.msg--agent').last()
const replyId = await last.getAttribute('data-id')
console.log('the reply to delete:', replyId)
// The trash shows with the row hovered, next to the thread button it sits under.
await last.hover()
await win.waitForTimeout(250)
await shot('01-trash-under-the-thread-button')
console.log('trash on an ended reply:', await last.locator('.msg__delete').count())

// Where the two glyphs are: the trash has to sit in the thread button's column, right under it.
const spot = await last.evaluate((row) => {
  const box = (sel) => {
    const el = row.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return { thread: box('.msg__reply'), trash: box('.msg__delete') }
})
console.log('thread button:', JSON.stringify(spot.thread), 'trash:', JSON.stringify(spot.trash))
if (!spot.trash || !spot.thread) throw new Error('a glyph is missing: the two belong together')

// The first press only arms it: the glyph goes red and says what the next press does.
await last.locator('.msg__delete').click()
await win.waitForTimeout(200)
await shot('02-armed-red-after-the-first-press')
console.log('armed:', await last.locator('.msg__delete.is-armed').count(), 'title:', await last.locator('.msg__delete').getAttribute('title'))
console.log('deleted after one press:', (await win.locator(`[data-id="${replyId}"]`).count()) === 0 ? 'yes' : 'no')

// The second press deletes it: the reply goes, with the thread it started, and the rest stays.
await last.locator('.msg__delete').click()
await win.waitForTimeout(600)
await shot('03-gone-after-the-second-press')
console.log('the reply is still there:', await win.locator(`[data-id="${replyId}"]`).count())
console.log('replies left in the room:', await win.locator('.msg--agent').count())

// A reply still at work has one too: its second press is said to stop it first.
await send('demore 6s')
// The reply itself, not the routing line above it: the row that is drawing its work.
const atWork = win.locator('.msg--agent', { has: win.locator('.shimmer, .typing') }).last()
await atWork.waitFor({ timeout: 15_000 })
const workingId = await atWork.getAttribute('data-id')
const working = win.locator(`[data-id="${workingId}"]`)
await working.hover()
await win.waitForTimeout(200)
await shot('04-trash-on-a-reply-at-work')
console.log('trash on the reply at work:', await working.locator('.msg__delete').count(), 'id:', workingId)
console.log('still working:', await win.locator(busy).count(), 'title before the first press:', await working.locator('.msg__delete').getAttribute('title'))
await working.locator('.msg__delete').click()
await win.waitForTimeout(200)
console.log('armed on a reply at work:', await working.locator('.msg__delete').getAttribute('title'))
await shot('05-armed-on-a-reply-at-work')
await working.locator('.msg__delete').click()
await win.waitForTimeout(800)
console.log('the reply at work is gone:', (await win.locator(`[data-id="${workingId}"]`).count()) === 0 ? 'yes' : 'no')
// And nothing of it lands afterwards: the run was stopped, not left to write its half reply back.
await win.waitForTimeout(2000)
console.log('agent replies left after it:', await win.locator('.msg--agent').count())
await shot('06-nothing-of-it-came-back')
await settle()

console.log('page errors:', errors.length ? errors : 'none')
await app.close()
