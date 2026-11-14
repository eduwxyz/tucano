// The skills folders: where Tucano reads skills from, the ones each harness keeps on this computer and
// the ones added by hand. Frames of Settings › Agents › "De onde vêm as skills" / "Where skills come
// from": every folder found, one turned off, and the card at 420 px.
// Usage: npx electron-vite build && node scripts/screens-skill-folders.mjs <frames dir>
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? join(tmpdir(), 'skill-folder-frames')
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-skill-folders-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
await win.setViewportSize({ width: 1360, height: 900 })
await win.waitForSelector('.sidebar')

// Settings › Agents, where the card lives.
await win.click('.nav-item:has-text("Configurações"), .nav-item:has-text("Settings")')
await win.getByRole('tab', { name: /^(Agentes|Agents)$/ }).click()
const card = win.locator('.card:has-text("De onde vêm as skills"), .card:has-text("Where skills come from")')
await card.waitFor()
await card.scrollIntoViewIfNeeded()
await win.waitForTimeout(400)

const rows = async () =>
  card.locator('.key-row').evaluateAll((els) =>
    els.map((e) => ({
      text: e.querySelector('p')?.textContent ?? '',
      on: e.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true'
    }))
  )

const before = await rows()
await card.screenshot({ path: join(out, 'pastas-1280.png') })

// One folder turned off: it stays in the list, and its skills leave the list the bots pick from.
const hermes = card.locator('.key-row').filter({ hasText: 'Hermes' }).first()
await hermes.locator('[role="switch"]').click()
await win.waitForTimeout(600)
const after = await rows()
const offRow = after.find((r) => /hermes/i.test(r.text) && !r.on)
await card.screenshot({ path: join(out, 'pastas-hermes-off.png') })

// The footer counts what is on, and the x on a folder found here turns it off (never deletes it).
const footer = await card.locator('.row .muted').first().textContent().catch(() => null)

await win.setViewportSize({ width: 420, height: 900 })
await win.waitForTimeout(500)
await card.scrollIntoViewIfNeeded()
await card.screenshot({ path: join(out, 'pastas-420.png') })
const sideways = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

// Back on, so the frame above is the only one with it off.
await win.setViewportSize({ width: 1360, height: 900 })
await hermes.locator('[role="switch"]').click()
await win.waitForTimeout(400)
const restored = await rows()

console.log(JSON.stringify({ before, after, offRow, footer, restored, sideways, errors }, null, 2))
await app.close()
