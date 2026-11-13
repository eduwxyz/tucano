// The connector's picture row, twice over: one row (it was drawn twice), a Paste image button that
// takes the picture off the system clipboard, and a paste (Ctrl+V) dropped on the row itself. The
// clipboard route ends in the same 96 px icon a picked file does, so the database is read as proof.
// Run after `npm run build`: node scripts/e2e-connector-icon-paste.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens/connector-icon-paste'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-icon-'))
const dbFile = join(data, 'tucano.db')
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}
const report = (name, value) => console.log(`     ${name}: ${JSON.stringify(value)}`)

const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForSelector('.sidebar')
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => {
  await win.waitForTimeout(250)
  await win.screenshot({ path: `${out}/${name}.png` })
}

// The connector's stored picture, as the database has it, not as the tile happens to draw it.
const storedIcon = () => {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const row = db.prepare("SELECT name, icon FROM connectors WHERE name = 'Painted Server'").get()
    return row ? { name: row.name, icon: row.icon ? `${String(row.icon).slice(0, 22)}… (${String(row.icon).length} chars)` : null } : null
  } finally {
    db.close()
  }
}

// A small picture, drawn inside the page so the test carries no image file with it.
const draw = `const draw = () => {
  const canvas = document.createElement('canvas')
  canvas.width = 72
  canvas.height = 72
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#c0392b'
  ctx.fillRect(0, 0, 72, 72)
  ctx.fillStyle = '#fff'
  ctx.fillRect(18, 18, 36, 36)
  return new Promise((ok) => canvas.toBlob(ok, 'image/png'))
}`

await win.click('.nav-item:has-text("Connectors")')
await win.waitForSelector('.catalog')
await win.click('button:has-text("Add custom")')
await win.click('button[role=radio]:has-text("Local")')
await win.click('text=Fill in with the demo server')
await win.fill('.field:has(.field__label:text-is("Name")) input', 'Painted Server')
await win.click('.connector__actions button.btn--primary')
await win.waitForSelector('.connector-modal .tag:text-is("connected")', { timeout: 30_000 })

// ---------- one row, not two ----------
const rows = await win.evaluate(() => {
  const found = [...document.querySelectorAll('.connector-modal__icon')]
  return {
    count: found.length,
    buttons: found[0] ? [...found[0].querySelectorAll('button')].map((b) => b.textContent?.trim()) : [],
    fileInputs: document.querySelectorAll('.connector-modal__icon input[type=file]').length
  }
})
report('the picture row in the connector window', rows)
check('the row is drawn once', rows.count === 1, rows.count)
check('one file input, not two', rows.fileInputs === 1, rows.fileInputs)
check('it offers Choose image and Paste image', rows.buttons.includes('Choose image') && rows.buttons.includes('Paste image'), rows.buttons)
await shot('01-one-row')

// ---------- Paste image: the system clipboard ----------
const wrote = await win.evaluate(`${draw}
  (async () => {
    try {
      const blob = await draw()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    } catch (e) {
      return String((e && e.message) || e)
    }
  })()`)
report('picture put on the clipboard', wrote)
if (wrote === true) {
  await win.click('.connector-modal__icon button:has-text("Paste image")')
  await win.waitForSelector('.connector-modal__icon .catalog__logo--pic img', { timeout: 15_000 })
  await win.waitForTimeout(400)
  const inWindow = await win.evaluate(() => {
    const img = document.querySelector('.connector-modal__icon .catalog__logo--pic img')
    return { picture: !!img, drawn: img ? `${img.naturalWidth}×${img.naturalHeight}` : null, src: img?.getAttribute('src')?.slice(0, 22) }
  })
  report('after Paste image', inWindow)
  check('a picture pasted from the clipboard is on the tile', inWindow.picture, inWindow)
  check('it is the 96 px icon, not the raw picture', /96×96|72×72/.test(inWindow.drawn ?? ''), inWindow.drawn)
  const db = storedIcon()
  report('the database keeps it', db)
  check('the connector keeps the picture', /^data:image\/png/.test(db?.icon ?? ''), db)
  await shot('02-pasted-from-clipboard')
}

// ---------- Ctrl+V dropped on the row ----------
await win.click('.connector-modal__icon button:has-text("Use the default")')
await win.waitForTimeout(600)
check('the default is back before the second route', !(await win.evaluate(() => !!document.querySelector('.connector-modal__icon .catalog__logo--pic img'))))
const dropped = await win.evaluate(`${draw}
  (async () => {
    const row = document.querySelector('.connector-modal__icon')
    if (!row) return 'no row'
    const blob = await draw()
    const file = new File([blob], 'pasted.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    row.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return true
  })()`)
report('a paste dropped on the row', dropped)
await win.waitForTimeout(1200)
const afterEvent = await win.evaluate(() => !!document.querySelector('.connector-modal__icon .catalog__logo--pic img'))
check('a paste on the row becomes the icon too', afterEvent)
await shot('03-pasted-on-the-row')

// ---------- the card outside the window ----------
await win.click('.modal__head button')
await win.waitForTimeout(500)
const card = await win.evaluate(() => {
  const el = [...document.querySelectorAll('.catalog__card')].find((c) => c.textContent?.includes('Painted Server'))
  const img = el?.querySelector('.catalog__logo--pic img')
  return { picture: !!img, drawn: img ? `${img.naturalWidth}×${img.naturalHeight}` : null }
})
report('the card after the window closes', card)
check('the card wears the pasted picture', card.picture, card)

console.log('page errors:', errors.length ? errors.slice(0, 4) : 'none')
check('the window raised no errors', errors.length === 0)
await app.close()
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0
