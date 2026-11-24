// Frames for the session trash: the rail under the thread button, the trash in the thread header,
// and the armed state after one press. Fresh seeded data and fake engines, no real workspace data.
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

await win.locator('.nav-item', { hasText: /^#?\s*geral|general/i }).first().click().catch(() => {})
await send('guarda o plano de hoje')
await settle()
await send('agora revisa o checkout')
await settle()

const mine = win.locator('.msg--me').first()
await mine.hover()
await win.waitForTimeout(200)
await shot('00-prompt-pencil-and-trash')

const last = win.locator('.msg--agent').last()
const replyId = await last.getAttribute('data-id')
await last.hover()
await win.waitForTimeout(250)
await shot('01-rail-thread-and-trash')
const spot = await last.evaluate((row) => {
  const box = (sel) => {
    const el = row.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return { thread: box('.msg__reply'), trash: box('.msg__delete') }
})
console.log('the reply to delete:', replyId)
console.log('rail glyphs:', JSON.stringify(spot))
if (!spot.trash || !spot.thread) throw new Error('a glyph is missing: the two belong together')

await last.locator('.msg__reply').first().click()
await win.waitForSelector('.side-panel__head .msg__delete--head', { timeout: 10_000 })
await win.waitForTimeout(250)
await shot('02-trash-in-the-thread-header')
console.log('header trash:', await win.locator('.side-panel__head .msg__delete--head').count())

await win.locator('.side-panel__head button[aria-label="Fechar a thread"]').click().catch(async () => {
  await win.locator('.side-panel__head button').last().click()
})
await last.hover()
await last.locator('.msg__delete').click()
await win.waitForTimeout(200)
await shot('03-armed-red-after-the-first-press')
console.log('armed:', await last.locator('.msg__delete.is-armed').count(), 'title:', await last.locator('.msg__delete').getAttribute('title'))
console.log('page errors:', errors.length ? errors : 'none')
await app.close()
