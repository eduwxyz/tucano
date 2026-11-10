// Frames for Hermes as a harness (PR #8): the row on the Harnesses card, saying what it needs, and
// the model it lists. No Hermes CLI on this box, so the row is the "not installed" one — which is
// the half a person sees first, and the install command it offers is the real one.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/8'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }

const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

await win.locator('.nav-item:has-text("Settings")').first().click()
await win.waitForSelector('.tabs')
await win.locator('.tabs button[role="tab"]:has-text("Models")').first().click()
await win.waitForTimeout(900)

const card = win.locator('.harnesses').first()
await card.scrollIntoViewIfNeeded()
const rows = await card.locator('.harness').allInnerTexts()
console.log('harnesses on the card:', JSON.stringify(rows.map((r) => r.split(/[ \t]*\n[ \t]*/).filter(Boolean).slice(0, 2).join(' | ')), null, 1))
const hermes = card.locator('.harness:has-text("Hermes")').first()
console.log('hermes row count:', await hermes.count())
await hermes.scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
console.log('hermes row:', (await hermes.innerText()).split(/[ \t]*\n[ \t]*/).filter(Boolean).join(' | ').slice(0, 400))
console.log('hermes install command shown:', await hermes.locator('.harness__install, code').first().innerText().catch(() => 'NONE'))
const box = await hermes.boundingBox()
console.log('row size:', JSON.stringify(box && { w: Math.round(box.width), h: Math.round(box.height) }))
await shot('01-the-harness-row')

// The picker: the harness list an agent's model comes from.
const sidebar = await win.locator('.sidebar').innerText()
console.log('sidebar has Agents:', sidebar.includes('Agents'))
console.log('errors:', JSON.stringify(errors))
await app.close()
rmSync(data, { recursive: true, force: true })
