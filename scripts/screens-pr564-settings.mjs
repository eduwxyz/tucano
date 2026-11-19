// Frames for PR #564: settings organized by task, with section navigation.
// Run after `npm run build`: node scripts/screens-pr564-settings.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/pr564-settings'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-564-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }

const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForSelector('.sidebar')
await win.waitForTimeout(600)

// The settings view opens from the sidebar's gear, which is also Ctrl+,.
await win.locator('.sidebar [aria-label="Settings"]').click()
await win.waitForSelector('.settings-layout', { timeout: 20000 })
await win.waitForTimeout(900)

const tabs = await win.locator('.tabs [role="tab"], [role="tab"]').allInnerTexts()
console.log('tabs:', JSON.stringify(tabs))
const sections = await win.locator('.settings-sections a, .settings-sections button').allInnerTexts()
console.log('sections:', JSON.stringify(sections))
const current = await win.locator('.settings-sections [aria-current]').count()
console.log('aria-current elements:', current)

await win.screenshot({ path: `${out}/pr564-1-settings-by-task.png` })

if (tabs.length > 1) {
  const tab = win.locator('[role="tab"]').nth(1)
  const label = (await tab.innerText()).trim()
  await tab.click()
  await win.waitForTimeout(900)
  await win.screenshot({ path: `${out}/pr564-2-second-page.png` })
  console.log('second page:', label)
}

const links = win.locator('.settings-sections a, .settings-sections button')
const count = await links.count()
if (count > 2) {
  const link = links.nth(2)
  const label = (await link.innerText()).trim()
  await link.click()
  await win.waitForTimeout(800)
  await win.screenshot({ path: `${out}/pr564-3-section-selected.png` })
  console.log('section clicked:', label)
  const active = await win.locator('.settings-sections [aria-current]').count()
  console.log('aria-current after click:', active)
}

// The narrow window is where a section list either works or falls apart.
await win.setViewportSize({ width: 900, height: 780 })
await win.waitForTimeout(600)
await win.screenshot({ path: `${out}/pr564-4-narrow.png` })

await app.close()
console.log('done ->', out)
