// Frames for the model's thinking (#235 / PR #245): off unless the person turns it on, then dim and
// small under the steps, live as it arrives, and kept after the turn so it can be read back.
// TUCANO_FAKE_THINKING=1 makes the fake engine think out loud (see src/core/engines/fake.ts).
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

const card = '.card:has-text("The conversation")'
const settings = async () => {
  await win.locator('.nav-item:has-text("Settings")').first().click()
  await win.waitForSelector('.page')
  await win.locator(card).scrollIntoViewIfNeeded()
}
const switchState = () =>
  win.evaluate((sel) => {
    const c = [...document.querySelectorAll('.card')].find((x) => sel.includes('The conversation') && x.textContent?.includes('The conversation'))
    const t = c?.querySelector('.toggle')
    return { found: !!c, on: t?.classList.contains('is-on') ?? null, aria: t?.getAttribute('aria-checked') ?? null }
  }, card)
const channel = async () => {
  await win.locator('.section .nav-item', { hasText: 'engineering' }).first().click()
  await win.waitForSelector('.composer textarea')
}
const ask = async () => {
  await channel()
  await win.locator('.composer textarea').fill('Lia, o test/wiki-git.test.ts falha aqui. É do build ou da máquina?')
  await win.keyboard.press('Enter')
}
// The state of the thinking block, and whether the reply is still at work.
const look = () =>
  win.evaluate(() => {
    const t = document.querySelector('.thought')
    const box = t?.querySelector('.thought__text')
    const b = t?.getBoundingClientRect()
    return {
      blocks: document.querySelectorAll('.thought').length,
      label: t?.querySelector('.thought__label')?.textContent ?? null,
      chars: box?.textContent?.length ?? 0,
      text: box?.textContent?.slice(0, 120) ?? null,
      height: b ? Math.round(b.height) : 0,
      fontPx: box ? getComputedStyle(box).fontSize : null,
      opacity: box ? getComputedStyle(box).opacity : null,
      atTheBottom: b ? Math.round(b.bottom) <= Math.round(document.querySelector('.messages').getBoundingClientRect().bottom) : null,
      working: !!document.querySelector('.steps__stop')
    }
  })

// 1. Out of the box the switch is off, and it is a switch like any other.
await settings()
console.log('the switch before:', JSON.stringify(await switchState()))
await shot('01-the-switch-off')

await win.locator(`${card} .toggle`).click()
await win.waitForTimeout(400)
console.log('the switch after:', JSON.stringify(await switchState()))
await shot('02-the-switch-on')

// 2. Turned on: the reasoning arrives under the steps, live.
await ask()
let live = await look()
for (let i = 0; i < 150; i++) {
  live = await look()
  if (live.label === 'Thinking' && live.chars > 20 && live.chars < 320) break
  await win.waitForTimeout(100)
}
console.log('while thinking:', JSON.stringify(live, null, 1))
await shot('03-thinking-as-it-arrives')

// 3. And it stays after the turn, said in the past.
for (let i = 0; i < 120 && (await look()).working; i++) await win.waitForTimeout(250)
const kept = await look()
console.log('after the turn:', JSON.stringify({ label: kept.label, chars: kept.chars, blocks: kept.blocks }))
await shot('04-kept-after-the-turn')

// 4. Turned off again: the same turn shows the steps and the answer, and nothing of the reasoning.
await settings()
await win.locator(`${card} .toggle`).click()
await win.waitForTimeout(400)
console.log('the switch again:', JSON.stringify(await switchState()))
await ask()
let seenOff = 0
let finished = false
for (let i = 0; i < 80 && !finished; i++) {
  const s = await look()
  seenOff = Math.max(seenOff, s.blocks)
  finished = i > 12 && !s.working
  await win.waitForTimeout(250)
}
console.log('off again:', JSON.stringify({ thoughtBlocksSeen: seenOff, finished }))
await win.waitForTimeout(1000)
await shot('05-off-again-nothing-shown')

console.log('errors:', JSON.stringify(errors))
await app.close()
rmSync(data, { recursive: true, force: true })
