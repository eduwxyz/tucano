// Screenshots and measurements for the right-click menu on a picture: in a reply and in the album,
// saving for real (the dialog is answered by this script), the one-click save into the folder the
// last picture went to, copying to the clipboard, and sending the picture to the prompt below.
// Fresh data, fake engines.
// Run after `npm run build`: node scripts/screens-image-menu.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/image-menu'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const saveDir = join(data, 'Pictures')
mkdirSync(saveDir, { recursive: true })
const saveTo = join(saveDir, 'chosen-in-the-dialog.png')
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

// The picture the conversation will hold: drawn in the page, saved to a file, then attached and sent.
const png = await win.evaluate(() => {
  const c = document.createElement('canvas')
  c.width = 600
  c.height = 400
  const x = c.getContext('2d')
  x.fillStyle = '#efece6'
  x.fillRect(0, 0, 600, 400)
  x.fillStyle = '#d9581a'
  x.fillRect(40, 40, 520, 70)
  x.fillStyle = '#3c2814'
  x.font = '30px sans-serif'
  x.fillText('a picture in a reply', 56, 200)
  x.font = '20px sans-serif'
  x.fillStyle = '#6b635a'
  x.fillText('right-click it', 56, 250)
  return c.toDataURL('image/png').split(',')[1]
})
const picture = join(data, 'pic.png')
writeFileSync(picture, Buffer.from(png, 'base64'))

// A channel, a picture attached to a message of mine, sent.
await win.locator('.nav-item', { hasText: /^#?\s*geral|general/i }).first().click().catch(() => {})
await win.setInputFiles('.composer input[type=file]', picture)
await win.waitForSelector('.composer__images img')
await win.fill('.composer textarea', 'here is the picture')
await win.keyboard.press('Enter')
await win.waitForSelector('.artifacts--mine .artifact-image img', { timeout: 20_000 })
await win.waitForTimeout(400)
console.log('the picture landed in a reply:', await win.locator('.artifacts--mine .artifact-image').count())

const menu = () => win.locator('.image-menu')
const items = async () => menu().locator('button').evaluateAll((els) => els.map((e) => e.textContent.trim()))
const rightClick = async () => {
  await win.locator('.artifacts--mine .artifact-image').first().click({ button: 'right' })
  await menu().waitFor()
  await win.waitForTimeout(150)
}

// 1. Right-click the picture in the reply. Nothing has been saved yet, so the one-click entry names
//    the system's downloads folder, which is where a first save goes without a dialog.
await rightClick()
await shot('01-right-click-a-reply')
console.log('items before anything was saved:', JSON.stringify(await items()))
const look = await menu().evaluate((el) => {
  const r = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  const one = getComputedStyle(el.querySelector('button'))
  return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top), radius: s.borderRadius, bg: s.backgroundColor, font: one.fontSize, itemPad: one.padding, focused: document.activeElement?.textContent?.trim() }
})
console.log('the menu:', JSON.stringify(look))

// Esc closes it and nothing happens.
await win.keyboard.press('Escape')
await win.waitForTimeout(120)
console.log('closed by Esc:', (await menu().count()) === 0)

// 2. Save as… — this script answers the dialog, and the file is checked on disk afterwards.
await app.evaluate(async ({ dialog }, path) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path, bookmark: '' })
}, saveTo)
await rightClick()
await menu().getByText(/Save as/i).click()
await win.waitForSelector('.toast')
await win.waitForTimeout(300)
const saved = existsSync(saveTo) ? readFileSync(saveTo) : null
console.log('saved where the dialog said:', !!saved, 'same bytes as the picture:', !!saved && saved.equals(Buffer.from(png, 'base64')), 'toast:', await win.locator('.toast__text').last().textContent())
await shot('02-saved')

// 3. The folder the file landed in is the one the menu names now, under Save as….
await rightClick()
console.log('items once a folder is remembered:', JSON.stringify(await items()))
const withFolder = await menu().evaluate((el) => {
  const r = el.getBoundingClientRect()
  const first = el.querySelector('button')
  return { w: Math.round(r.width), h: Math.round(r.height), first: first?.textContent?.trim(), firstW: Math.round(first?.getBoundingClientRect().width ?? 0), focused: document.activeElement?.textContent?.trim() }
})
console.log('the menu with a folder:', JSON.stringify(withFolder))
await shot('03-the-folder-is-remembered')

// 4. One click, no dialog at all: the dialog is stubbed to fail loudly if it is ever opened.
await app.evaluate(async ({ dialog }) => {
  dialog.showSaveDialog = async () => {
    throw new Error('the dialog was opened for a save that should not need one')
  }
})
await menu().getByText(/Save to Pictures/i).click()
await win.waitForTimeout(500)
const inFolder = readdirSync(saveDir)
console.log('saved with no dialog:', JSON.stringify(inFolder), 'toast:', await win.locator('.toast__text').last().textContent())
await shot('04-saved-in-one-click')

// 5. A name already there gets a number instead of being replaced.
await rightClick()
await menu().getByText(/Save to Pictures/i).click()
await win.waitForTimeout(500)
console.log('saved again, nothing replaced:', JSON.stringify(readdirSync(saveDir)))

// 6. A folder that has gone: the one click says so and opens the dialog instead.
rmSync(saveDir, { recursive: true, force: true })
const elsewhere = join(data, 'somewhere-else.png')
await app.evaluate(async ({ dialog }, path) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path, bookmark: '' })
}, elsewhere)
await rightClick()
await menu().getByText(/Save to Pictures/i).click()
await win.waitForTimeout(600)
console.log('a folder that has gone:', JSON.stringify(await win.locator('.toast__text').allTextContents()), 'saved anyway:', existsSync(elsewhere))
await shot('05-the-folder-is-gone')

// 7. Copy to clipboard.
await rightClick()
await menu().getByText(/clipboard/i).click()
await win.waitForTimeout(400)
const held = await app.evaluate(async ({ clipboard }) => {
  const items = await clipboard.read()
  return items.flatMap((i) => i.types)
})
console.log('the clipboard now holds:', JSON.stringify(held), 'toast:', await win.locator('.toast__text').last().textContent())

// 8. Send to prompt: the picture comes back as an attachment to the field below.
await rightClick()
await menu().getByText(/prompt/i).click()
await win.waitForTimeout(600)
const attached = await win.evaluate(() => {
  const imgs = [...document.querySelectorAll('.composer__images img')]
  const field = document.querySelector('.composer')
  return { count: imgs.length, name: imgs[0]?.getAttribute('title'), focused: document.activeElement?.tagName, fieldTop: field ? Math.round(field.getBoundingClientRect().top) : null }
})
console.log('back in the prompt:', JSON.stringify(attached))
await win.locator('.composer').scrollIntoViewIfNeeded()
await shot('06-back-in-the-prompt')

// 9. A one-line message can go with it: the attachment rides the message it was copied for.
await win.fill('.composer textarea', 'and here it is again')
await win.keyboard.press('Enter')
await win.waitForTimeout(1200)
console.log('sent with the picture attached:', (await win.locator('.artifacts--mine .artifact-image').count()) >= 2)

// 10. The album (fullscreen): right-click gives the ways out of the app, and not the prompt.
await win.locator('.artifacts--mine .artifact-image').first().click()
await win.waitForSelector('.lightbox img')
await win.waitForTimeout(250)
await win.locator('.lightbox__stage img').click({ button: 'right' })
await menu().waitFor()
await win.waitForTimeout(150)
await shot('07-right-click-the-album')
console.log('items in the album:', JSON.stringify(await items()))
await win.keyboard.press('Escape')
await win.waitForTimeout(150)
console.log('Esc closes the menu, and the album is still there:', (await menu().count()) === 0 && (await win.locator('.lightbox').count()) === 1)
await win.keyboard.press('Escape')
await win.waitForTimeout(200)

// 11. A narrow window: the menu stays inside it.
await win.setViewportSize({ width: 420, height: 820 })
await win.waitForTimeout(300)
await rightClick()
const narrow = await win.evaluate(() => {
  const r = document.querySelector('.image-menu').getBoundingClientRect()
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), pageW: document.documentElement.clientWidth, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }
})
console.log('at 420 px:', JSON.stringify(narrow), 'items:', JSON.stringify(await items()))
await shot('08-420')

console.log('page errors:', errors.length, errors.slice(0, 3))
await app.close()
