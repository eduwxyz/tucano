// Measures the bulk strip on Settings › Models: three picks, flush, same width, no captions.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/models-bulk'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForSelector('.sidebar')
await win.locator('.nav-item:has-text("Settings")').first().click()
await win.locator('.tabs button[role="tab"]:has-text("Models")').first().click()
await win.waitForSelector('.agent-models')
await win.waitForTimeout(500)

const strip = async (label) => {
  const pick = await win.evaluate(() => {
    const box = document.querySelector('.agent-models__picks--bulk')
    if (!box) return null
    const kids = [...box.querySelectorAll(':scope > .select, :scope > .model-picker > .select')]
    const picks = kids.map((k) => {
      const t = k.querySelector('.select__trigger') ?? k
      const v = t.querySelector('.select__trigger__value') ?? t
      const r = t.getBoundingClientRect()
      const cs = getComputedStyle(t)
      return {
        text: (v.textContent ?? '').trim(),
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        top: Math.round(r.top),
        height: Math.round(r.height),
        radius: cs.borderTopLeftRadius + ' ' + cs.borderTopRightRadius,
        leftBorder: cs.borderLeftWidth,
        cut: v.scrollWidth - v.clientWidth
      }
    })
    const gaps = picks.slice(1).map((p, i) => p.left - picks[i].right)
    return { count: picks.length, picks, gaps, captions: box.querySelectorAll('.agent-models__label').length, boxWidth: Math.round(box.getBoundingClientRect().width) }
  })
  console.log(`== ${label} ==`)
  console.log(JSON.stringify(pick, null, 1))
  return pick
}

const at1280 = await strip('1280 px')
await win.locator('.agent-models').screenshot({ path: `${out}/01-bulk-strip-1280.png` })
await win.screenshot({ path: `${out}/01-window-1280.png` })

// The thinking menu still opens from the third cell, and the placeholder says what it is.
const thinking = win.locator('.agent-models__picks--bulk .select').last()
await thinking.locator('.select__trigger').click()
await win.waitForSelector('.select__menu')
console.log('menu options:', JSON.stringify(await win.locator('.select__option .select__label').allInnerTexts()))
await win.waitForTimeout(200)
await win.locator('.agent-models').screenshot({ path: `${out}/02-thinking-menu.png` })
await win.keyboard.press('Escape')
await win.waitForTimeout(150)

// A value picked: the strip keeps its three equal cells.
await thinking.locator('.select__trigger').click()
await win.locator('.select__option:has-text("Low")').first().click()
await win.waitForTimeout(200)
console.log('after picking Low:', JSON.stringify(await win.evaluate(() => [...document.querySelectorAll('.agent-models__picks--bulk > .select > .select__trigger .select__trigger__value')].map((v) => (v.textContent ?? '').trim()))))
await win.locator('.agent-models').screenshot({ path: `${out}/03-thinking-low.png` })

await win.setViewportSize({ width: 420, height: 900 })
await win.waitForTimeout(500)
const at420 = await strip('420 px')
await win.locator('.agent-models').screenshot({ path: `${out}/04-bulk-strip-420.png` })
await win.screenshot({ path: `${out}/05-window-420.png` })
const sideways = await win.evaluate(() => {
  const panel = document.querySelector('.agent-models')
  return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, panel: panel.scrollWidth - panel.clientWidth }
})
console.log('sideways at 420:', JSON.stringify(sideways))
console.log('page errors:', errors.length, JSON.stringify(errors.slice(0, 4)))
await app.close()
rmSync(data, { recursive: true, force: true })
console.log('summary 1280 widths:', JSON.stringify(at1280?.picks.map((p) => p.width)), 'gaps:', JSON.stringify(at1280?.gaps))
console.log('summary 420 widths:', JSON.stringify(at420?.picks.map((p) => p.width)), 'tops:', JSON.stringify(at420?.picks.map((p) => p.top)))
