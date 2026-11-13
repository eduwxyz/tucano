// Screenshots of asking with a picture and a file from the Team board (issue #405): the box at the
// bottom takes them, shows them above the field before it sends, and the request arrives in the
// agent's DM with both. Fresh data, fake engines. Run after `npm run build`:
// node scripts/screens-team-ask.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/team-ask'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// The first start makes the seed's team; then Theo and Nina answer to Lia, so there is a top to ask.
const first = await launch()
await first.app.close()
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(join(data, 'tucano.db'))
db.exec("UPDATE agents SET reports_to = (SELECT id FROM agents WHERE handle = 'lia') WHERE handle IN ('theo', 'nina')")
db.close()

const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
// A 1x1 PNG: enough for the picture to be read, scaled up to the chip by object-fit.
const png = { name: 'conversao.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }
const pdf = { name: 'briefing.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n') }

await win.click('.nav-item:has-text("Time")')
await win.waitForSelector('.orgb .org-card')
await win.waitForSelector('.org-ask')
await win.waitForTimeout(700)
await shot('00-team-box-text-only')
console.log('clip button on the box:', (await win.locator('.org-ask .icon-btn').count()) === 1)

// What a drop, a paste or the picker hands the box.
await win.locator('.org-ask input[type="file"]').setInputFiles([png, pdf])
await win.waitForSelector('.org-ask .composer__images')
await win.waitForTimeout(400)
await shot('01-team-box-with-attachments')
const chips = { pictures: await win.locator('.org-ask .composer__image').count(), files: await win.locator('.org-ask .composer__file').count() }
console.log('attached before sending:', JSON.stringify(chips), 'send enabled with no words:', !(await win.locator('.org-ask .btn--primary').isDisabled()))

// Sent: the box empties, and the board stays where it is, with the request on its way.
await win.locator('.org-ask .btn--primary').click()
await win.waitForTimeout(1200)
await shot('02-sent-box-emptied')
console.log('box emptied after sending:', (await win.locator('.org-ask .composer__images').count()) === 0, '| still on the board:', (await win.locator('.orgb').count()) === 1)

// In her DM: the request arrived with the picture and the file, as one message.
await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
await win.click('button:has-text("Abrir DM")')
await win.waitForSelector('.composer textarea', { timeout: 20_000 })
await win.waitForTimeout(1500)
await shot('03-in-the-dm')
const last = win.locator('.msg').last()
console.log('in the DM — the picture by name:', await win.getByText('conversao.png').count(), '| the file by name:', await win.getByText('briefing.pdf').count())
console.log('the message the agent answered:', (await last.innerText()).slice(0, 60).replace(/\n/g, ' '))

// Back on the board, one attached and taken off again: it never goes.
await win.click('.nav-item:has-text("Time")')
await win.waitForSelector('.org-ask')
await win.waitForTimeout(500)
await win.locator('.org-ask input[type="file"]').setInputFiles([png])
await win.waitForSelector('.org-ask .composer__image')
await win.locator('.org-ask .composer__image-x').click()
await win.waitForTimeout(300)
await shot('04-taken-off-before-sending')
console.log('after taking it off:', await win.locator('.org-ask .composer__image').count(), 'pictures left')

// A text-only request reads as it did before.
await win.fill('.org-ask input', 'como foi o dia?')
await win.waitForTimeout(300)
await shot('05-text-only-as-before')

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors')
await app.close()
