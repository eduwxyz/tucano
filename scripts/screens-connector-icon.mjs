// The frames of the connector-picture change, shot in the built app: a server added by hand wears a
// terminal or a globe, and from its own window it takes a picture (a PNG shrunk to 96 px, or an SVG as
// it came) that shows on its card and stays in the database. Temp data folder, fake engines.
//
//   npm run build && node scripts/screens-connector-icon.mjs frames/connector-icon
//
// It needs build/icon.png for the bitmap and the Google mark as an SVG beside it; the frames it writes
// are what the pull request shows.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'frames/connector-icon'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
rmSync(join(tmpdir(), 'tucano-demo-tasks.json'), { force: true })
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => {
  await win.waitForTimeout(250)
  await win.screenshot({ path: `${out}/${name}.png` })
}
const nameField = '.field:has(.field__label:text-is("Name")) input'

// What a connector's card shows: which tile it wears, and the picture on it if it has one.
const card = (text) =>
  win.evaluate((t) => {
    const el = [...document.querySelectorAll('.catalog__card')].find((c) => c.textContent?.includes(t))
    if (!el) return null
    const tile = el.querySelector('.catalog__logo')
    const img = tile?.querySelector('img')
    return {
      name: el.querySelector('strong')?.textContent,
      tile: tile ? [...tile.classList].find((c) => c.startsWith('catalog__logo--') || c === 'catalog__logo') : null,
      picture: !!img,
      src: img ? `${img.getAttribute('src')?.slice(0, 22)}… (${img.getAttribute('src')?.length} chars)` : null,
      drawn: img ? `${img.naturalWidth}×${img.naturalHeight}` : null,
      own: !!el.querySelector('.catalog__logo--own'),
      mark: !!tile?.querySelector('svg path'),
      box: tile ? Math.round(tile.getBoundingClientRect().width) : null
    }
  }, text)

await win.click('.nav-item:has-text("Connectors")')
await win.waitForSelector('.catalog')
await shot('01-connectors')

// A server added by hand: nothing set, so it wears the terminal of a local server.
await win.click('button:has-text("Add custom")')
await win.click('button[role=radio]:has-text("Local")')
await win.click('text=Fill in with the demo server')
await win.fill(nameField, 'Google Services')
await win.click('.connector__actions button.btn--primary')
await win.waitForSelector('.connector-modal .tag:text-is("connected")', { timeout: 30_000 })
await shot('02-window-before')
const before = await card('Google Services')
const controls = await win.evaluate(() => {
  const row = document.querySelector('.connector-modal__icon')
  return row ? [...row.querySelectorAll('button, input[type=file]')].map((b) => (b.tagName === 'INPUT' ? `input[type=file] accept=${b.getAttribute('accept')}` : b.textContent?.trim())) : null
})

// Pick a picture in the connector's own window: it shrinks to 128 px and lands on the tile.
await win.setInputFiles('.connector-modal__icon input[type=file]', 'build/icon.png')
await win.waitForSelector('.connector-modal__icon .catalog__logo--pic img', { timeout: 10_000 })
await win.waitForTimeout(400)
await shot('03-window-picked')
const inWindow = await win.evaluate(() => {
  const img = document.querySelector('.connector-modal__icon .catalog__logo--pic img')
  const row = document.querySelector('.connector-modal__icon')
  return {
    picture: !!img,
    src: img ? `${img.getAttribute('src')?.slice(0, 22)}… (${img.getAttribute('src')?.length} chars)` : null,
    drawn: img ? `${img.naturalWidth}×${img.naturalHeight}` : null,
    buttons: row ? [...row.querySelectorAll('button')].map((b) => b.textContent?.trim()) : null
  }
})
await win.click('.modal__head button')
await shot('04-card-after')
const after = await card('Google Services')

// Back to the default from the same window: the terminal again.
await win.click('.catalog__card.is-mine:has-text("Google Services")')
await win.click('.connector-modal__icon button:has-text("Use the default")')
await win.waitForTimeout(600)
await shot('05-window-default')
const resetInWindow = await win.evaluate(() => ({
  picture: !!document.querySelector('.connector-modal__icon .catalog__logo--pic img'),
  terminal: !!document.querySelector('.connector-modal__icon .catalog__logo--own')
}))
await win.click('.modal__head button')
const reset = await card('Google Services')

// A second server, with the picture put back, so the database keeps one: what a restart would read.
await win.click('.catalog__card.is-mine:has-text("Google Services")')
await win.setInputFiles('.connector-modal__icon input[type=file]', 'build/icon.png')
await win.waitForSelector('.connector-modal__icon .catalog__logo--pic img', { timeout: 10_000 })
await win.waitForTimeout(500)
const stored = await win.evaluate(() => {
  const img = document.querySelector('.connector-modal__icon .catalog__logo--pic img')
  return { src: img?.getAttribute('src') ?? null }
})
await shot('06-kept')

// An SVG goes in as it came (it keeps its edges at any size), and lands on the tile too.
await win.setInputFiles('.connector-modal__icon input[type=file]', process.env.ICON_SVG ?? 'frames/connector-icon/google.svg')
await win.waitForTimeout(800)
const svg = await win.evaluate(() => {
  const img = document.querySelector('.connector-modal__icon .catalog__logo--pic img')
  return { src: img ? `${img.getAttribute('src')?.slice(0, 34)}… (${img.getAttribute('src')?.length} chars)` : null, drawn: img ? `${img.naturalWidth}×${img.naturalHeight}` : null }
})
await shot('07-svg')

console.log(JSON.stringify({ data, before, controls, inWindow, after, resetInWindow, reset, stored: { prefix: stored.src?.slice(0, 22), chars: stored.src?.length }, svg, errors }, null, 2))
await app.close()
