// Frames for the model's thinking shown as it arrives (#235 / PR #245): dim, small, live, under the
// reply it belongs to — and kept after the turn, so it can be read back.
// TUCANO_FAKE_THINKING=1 makes the fake engine think out loud first (see src/core/engines/fake.ts).
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/245'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_FAKE_THINKING: '1', TUCANO_LOCALE: 'en-US' }

const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 880 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

await win.locator('.section .nav-item', { hasText: 'engineering' }).first().click()
await win.waitForSelector('.composer textarea')
await win.locator('.composer textarea').fill('Lia, o test/wiki-git.test.ts falha aqui. É do build ou da máquina?')
await win.keyboard.press('Enter')

// While it is still thinking
await win.waitForSelector('.thought', { timeout: 15000 })
await win.waitForTimeout(900)
const live = await win.evaluate(() => {
  const t = document.querySelector('.thought')
  if (!t) return 'NO THOUGHT'
  const box = t.querySelector('.thought__text')
  const b = t.getBoundingClientRect()
  return {
    label: t.querySelector('.thought__label')?.textContent,
    chars: box?.textContent?.length,
    text: box?.textContent?.slice(0, 160),
    height: Math.round(b.height),
    fontPx: box ? getComputedStyle(box).fontSize : null,
    opacity: box ? getComputedStyle(box).opacity : null,
    atTheBottom: Math.round(b.bottom) <= Math.round(document.querySelector('.messages').getBoundingClientRect().bottom)
  }
})
console.log('while thinking:', JSON.stringify(live, null, 1))
await shot('01-thinking-as-it-arrives')

// And after the turn, kept to read back
await win.waitForSelector('.msg .run--done, .msg:has(.thought__label)', { timeout: 30000 }).catch(() => {})
await win.waitForTimeout(3500)
const after = await win.evaluate(() => {
  const t = document.querySelector('.thought')
  return t ? { label: t.querySelector('.thought__label')?.textContent, chars: t.querySelector('.thought__text')?.textContent?.length } : 'NO THOUGHT'
})
console.log('after the turn:', JSON.stringify(after))
await shot('02-kept-after-the-turn')

console.log('errors:', JSON.stringify(errors))
await app.close()
rmSync(data, { recursive: true, force: true })
