// Frames for "Settings › Models: the thinking on the bulk change and on every agent" (issue + PR).
// One run of the built app: the panel as it is, the thinking menu, a bulk change of the thinking
// alone, one agent's thinking on its own, and the same values after a relaunch — plus 420 px.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/models-thinking'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []
const flat = (s) => (s ?? '').split(/[ \t]*\n[ \t]*/).filter(Boolean).join(' | ')

async function open() {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.setViewportSize({ width: 1280, height: 900 })
  await win.waitForSelector('.sidebar')
  await win.locator('.nav-item:has-text("Settings")').first().click()
  await win.waitForSelector('.tabs')
  await win.locator('.tabs button[role="tab"]:has-text("Models")').first().click()
  await win.waitForSelector('.agent-models')
  await win.waitForTimeout(400)
  return { app, win }
}

const rows = async (win) => win.locator('.agent-models__row').evaluateAll((els) => els.map((el) => {
  const parts = el.innerText.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  return parts.find((p) => p.startsWith('Current:')) ?? parts.join(' | ')
}))

const { app, win } = await open()
const panel = win.locator('.agent-models')
const bulkTrigger = panel.locator('[aria-label="Thinking for the bulk change"]')
const applyBtn = panel.locator('button:has-text("Apply to selected")')

console.log('== before ==')
console.log('bulk thinking picker:', await bulkTrigger.count(), '| value:', await bulkTrigger.innerText())
console.log('bulk model picker:', await panel.locator('.model-picker').count())
console.log('apply enabled with nothing picked:', !(await applyBtn.isDisabled()))
const bots = await rows(win)
console.log('agents:', JSON.stringify(bots, null, 1))
console.log('rows that show a thinking picker:', await panel.locator('.agent-models__row .select').count(), 'of', bots.length)
const rowHeights = async (w) => w.locator('.agent-models__row').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
console.log('row heights at 1280:', JSON.stringify(await rowHeights(win)))
console.log('picks at 1280:', JSON.stringify(await win.locator('.agent-models__picks').first().evaluate((el) => ({ width: Math.round(el.getBoundingClientRect().width), kids: [...el.children].map((c) => Math.round(c.getBoundingClientRect().width)) }))))
await panel.screenshot({ path: `${out}/01-the-panel.png` })
await win.screenshot({ path: `${out}/01-the-panel-window.png` })

// The thinking menu, on the bulk change.
await bulkTrigger.click()
await win.waitForSelector('.select__menu')
const options = await win.locator('.select__option .select__label').allInnerTexts()
console.log('menu options:', JSON.stringify(options))
console.log('menu placeholder option:', flat(await bulkTrigger.innerText()))
await win.waitForTimeout(200)
await win.screenshot({ path: `${out}/02-the-thinking-menu.png` })

// The thinking alone: no model picked, so the button only wakes once agents are selected.
await win.locator('.select__option:has-text("Low")').first().click()
await win.waitForTimeout(150)
console.log('after picking Low — bulk value:', await bulkTrigger.innerText(), '| apply enabled:', !(await applyBtn.isDisabled()))
await panel.locator('label:has-text("Select all displayed") input').check()
console.log('with 3 selected — apply enabled:', !(await applyBtn.isDisabled()))
await win.screenshot({ path: `${out}/03-thinking-chosen.png` })
await applyBtn.click()
await win.waitForTimeout(600)
console.log('status after applying:', flat(await panel.locator('[role="status"]').innerText()))
console.log('agents now:', JSON.stringify(await rows(win), null, 1))
await panel.screenshot({ path: `${out}/04-after-the-bulk-change.png` })

// One agent's thinking on its own.
const theo = panel.locator('.agent-models__row[aria-label="Theo"]')
await theo.locator('[aria-label="Theo’s thinking"]').click()
await win.waitForSelector('.select__menu')
await win.locator('.select__option:has-text("Max")').first().click()
await win.waitForTimeout(150)
const theoSave = theo.locator('button.btn')
console.log('Theo’s Save enabled after picking Max:', !(await theoSave.isDisabled()))
await theo.scrollIntoViewIfNeeded()
await theo.screenshot({ path: `${out}/05-one-agent-before-save.png` })
await theoSave.click()
await win.waitForTimeout(600)
console.log('status after one agent:', flat(await panel.locator('[role="status"]').innerText()))
console.log('agents now:', JSON.stringify(await rows(win), null, 1))
console.log('Theo’s Save disabled again:', await theoSave.isDisabled())
await theo.screenshot({ path: `${out}/06-one-agent-after-save.png` })

// 420 px: the model and the thinking side by side, nothing past the edge.
await win.setViewportSize({ width: 420, height: 900 })
await win.waitForTimeout(400)
const narrow = await win.evaluate(() => ({
  page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
  panel: (() => { const p = document.querySelector('.agent-models'); return p ? [p.scrollWidth, p.clientWidth] : [0, 0] })(),
  widestRow: Math.max(...[...document.querySelectorAll('.agent-models__row')].map((r) => r.scrollWidth - r.clientWidth)),
  picks: [...document.querySelectorAll('.agent-models__picks')].map((p) => {
    const kids = [...p.children].map((c) => Math.round(c.getBoundingClientRect().width))
    return { width: Math.round(p.getBoundingClientRect().width), kids, over: p.scrollWidth - p.clientWidth }
  })
}))
console.log('at 420 px:', JSON.stringify(narrow))
console.log('row heights at 420:', JSON.stringify(await rowHeights(win)))
const clipped = await win.evaluate(() => [...document.querySelectorAll('.agent-models__row .model-picker__value, .agent-models__row .select__trigger__value')].map((el) => ({ text: (el.textContent ?? '').trim(), over: el.scrollWidth - el.clientWidth })))
console.log('text cut inside the pickers at 420:', JSON.stringify(clipped.filter((c) => c.over > 0)))
await panel.scrollIntoViewIfNeeded()
await panel.screenshot({ path: `${out}/07-at-420.png` })

await app.close()

// The same workspace, opened again: what was saved is what the panel reads.
console.log('== relaunch ==')
const again = await open()
const kept = await rows(again.win)
console.log('agents after relaunch:', JSON.stringify(kept, null, 1))
await again.win.locator('.agent-models').screenshot({ path: `${out}/08-after-relaunch.png` })
console.log('errors:', JSON.stringify(errors))
await again.app.close()
rmSync(data, { recursive: true, force: true })
