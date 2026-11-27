// Before/after frames on the built app (fake engines, seeded workspace, pt-BR).
// node scripts/ba-ui.mjs <out dir> <prefix> <decisions|sidebar>
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const [out, prefix, scene] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-ba-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'pt-BR' }
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar', { timeout: 90_000 })
await win.waitForTimeout(1500)
const shot = async (name, loc) => {
  for (const c of await win.locator('.toast__close').all()) await c.click().catch(() => {})
  await win.waitForTimeout(500)
  await (loc ?? win).screenshot({ path: join(out, `${prefix}-${name}.png`) })
}
const dm = async (name) => {
  await win.locator(`.agent-row .nav-item:has-text("${name}")`).first().click()
  await win.waitForSelector('.composer textarea')
  await win.waitForTimeout(400)
}
const send = async (text) => {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(600)
}
if (scene === 'decisions') {
  await dm('Lia')
  await send('recomende')
  const card = win.locator('.ask').last()
  await card.waitFor({ timeout: 20_000 })
  await win.waitForTimeout(800)
  await card.scrollIntoViewIfNeeded()
  await shot('wide')
  await shot('card', card)
  await win.setViewportSize({ width: 420, height: 820 })
  await win.waitForTimeout(700)
  await card.scrollIntoViewIfNeeded()
  await shot('narrow')
}
if (scene === 'sidebar') {
  await dm('Lia')
  await send('me ajuda a decidir')
  await win.locator('.ask').last().waitFor({ timeout: 20_000 })
  await dm('Theo')
  await send('demore 300 s')
  await dm('Nina')
  await send('demore 4 s e me conta uma coisa')
  await win.locator('.nav-item:has-text("Conhecimento")').first().click()
  await win.waitForTimeout(7000)
  const side = win.locator('.sidebar')
  await shot('open', side)
  await win.locator('.fold-toggle:has-text("Agentes"), button:has-text("Agentes")').first().click()
  await win.waitForTimeout(900)
  await shot('folded', side)
}
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors')
await app.close()
