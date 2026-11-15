// Screenshots of one agent answering to more than one boss (src/shared/org.ts bossesOf): three
// campaigns, each with its bot, and one artist the three of them share. Fresh data, fake engines.
// Run after `npm run build`: node scripts/screens-shared-boss.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/shared-boss'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const launch = async (width) => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width, height: 860 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// The first start makes the seed's team; then the tree and the shared artist are set the way a page would.
const first = await launch(1280)
await first.app.close()
const db = join(data, 'tucano.db')
const sql = (q) => execFileSync('sqlite3', [db, q])
const id = (handle) => execFileSync('sqlite3', [db, `SELECT id FROM agents WHERE handle = '${handle}'`]).toString().trim()
// Theo heads one campaign, Nina another; Lia is the artist both of them (and one more) share.
sql(`UPDATE agents SET reports_to = (SELECT id FROM agents WHERE handle = 'theo') WHERE handle = 'nina'`)
sql(`UPDATE agents SET reports_to = (SELECT id FROM agents WHERE handle = 'theo'), also_to = '["${id('nina')}"]' WHERE handle = 'lia'`)
sql(`UPDATE agents SET role = 'Campanha A' WHERE handle = 'theo'`)
sql(`UPDATE agents SET role = 'Campanha B' WHERE handle = 'nina'`)
sql(`UPDATE agents SET role = 'Arte das três campanhas' WHERE handle = 'lia'`)

// One window, the board at the two widths: the team page at 1280, then the same page narrowed to 420.
const { app, win } = await launch(1280)
await win.click('.nav-item:has-text("Time")')
await win.waitForSelector('.orgb')
await win.waitForTimeout(900)
const picked = async () => {
  // A press and a release, as the board listens for them, off screen included.
  await win.evaluate(() => {
    const el = [...document.querySelectorAll('.org-card')].find((c) => c.textContent?.includes('Lia'))
    const at = { bubbles: true, button: 0, clientX: 10, clientY: 10 }
    el.dispatchEvent(new PointerEvent('pointerdown', at))
    document.dispatchEvent(new PointerEvent('pointerup', at))
  })
  await win.waitForSelector('.org-side', { timeout: 10_000 })
  await win.waitForTimeout(400)
}
// What the board drew: one line per link, which of them are the extras, and how an extra one is drawn.
const drawn = () =>
  win.evaluate(() => ({
    lines: document.querySelectorAll('.orgb__lines g').length,
    extra: document.querySelectorAll('.orgb__lines g.is-also').length,
    cards: document.querySelectorAll('.org-card').length,
    extraDash: getComputedStyle(document.querySelector('.orgb__lines g.is-also .orgb__line')).strokeDasharray,
    panel: document.querySelector('.org-side')?.textContent?.includes('Também responde a') ?? false
  }))
// Where each card is, and where each line starts and ends: a picture says less than these.
const where = () =>
  win.evaluate(() => ({
    cards: Object.fromEntries(
      [...document.querySelectorAll('.org-card')].map((c) => {
        const r = c.getBoundingClientRect()
        return [c.querySelector('strong')?.textContent ?? '?', `${Math.round(r.left)}x${Math.round(r.top)}`]
      })
    ),
    lines: [...document.querySelectorAll('.orgb__lines g')].map((g) => {
      const path = g.querySelector('.orgb__line')
      const a = path.getPointAtLength(0)
      const b = path.getPointAtLength(path.getTotalLength())
      const how = g.classList.contains('is-also') ? 'extra' : g.classList.contains('is-me') ? 'from me' : 'tree'
      return `${how}: ${Math.round(a.x)},${Math.round(a.y)} → ${Math.round(b.x)},${Math.round(b.y)}`
    })
  }))
await win.screenshot({ path: `${out}/1280-board.png` })
console.log('1280 where', JSON.stringify(await where(), null, 1))
console.log('1280 board', JSON.stringify(await drawn()))
await picked()
await win.screenshot({ path: `${out}/1280-panel.png` })
console.log('1280 panel', JSON.stringify(await drawn()))
await win.setViewportSize({ width: 420, height: 860 })
await win.waitForTimeout(600)
console.log('420 panel', JSON.stringify(await drawn()))
await win.screenshot({ path: `${out}/420-panel.png` })
await win.keyboard.press('Escape')
await win.waitForTimeout(400)
await win.screenshot({ path: `${out}/420-board.png` })
await app.close()
console.log('done', out)
