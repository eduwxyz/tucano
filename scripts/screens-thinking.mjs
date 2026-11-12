// Frames for the model's thinking (#235 / PR #245): off unless the person turns it on, then dim and
// small under the run's steps, live as it arrives — and, the reply over, folded to the line it ended
// on, the whole of it one click away. TUCANO_FAKE_THINKING=1 makes the fake engine think out loud
// (see src/core/engines/fake.ts).
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
  win.evaluate(() => {
    const c = [...document.querySelectorAll('.card')].find((x) => x.textContent?.includes('The conversation'))
    const t = c?.querySelector('.toggle')
    return { found: !!c, on: t?.classList.contains('is-on') ?? null, aria: t?.getAttribute('aria-checked') ?? null }
  })
const channel = async () => {
  await win.locator('.section .nav-item', { hasText: 'engineering' }).first().click()
  await win.waitForSelector('.composer textarea')
}
const ask = async () => {
  await channel()
  await win.locator('.composer textarea').fill('Lia, o test/wiki-git.test.ts falha aqui. É do build ou da máquina?')
  await win.keyboard.press('Enter')
}
// The state of the thinking block, and whether the reply is still at work. Folded, there is no text
// node at all: the head carries the label and the line it ended on, nothing else.
const look = () =>
  win.evaluate(() => {
    const blocks = [...document.querySelectorAll('.thought')]
    const t = blocks[blocks.length - 1]
    const box = t?.querySelector('.thought__text')
    const head = t?.querySelector('.thought__head')
    const steps = t?.closest('.steps')
    const list = steps?.querySelector('.steps__list')
    const b = t?.getBoundingClientRect()
    const l = list?.getBoundingClientRect()
    const lh = t?.querySelector('.thought__last')
    return {
      blocks: blocks.length,
      open: t?.classList.contains('is-open') ?? null,
      atWork: t?.classList.contains('is-working') ?? null,
      label: t?.querySelector('.thought__label')?.textContent ?? null,
      expanded: head?.getAttribute('aria-expanded') ?? null,
      headTitle: head?.getAttribute('title') ?? null,
      lastLine: lh?.textContent ?? null,
      lastClipped: lh ? lh.scrollWidth > lh.clientWidth : null,
      hasText: !!box,
      chars: box?.textContent?.length ?? 0,
      text: box?.textContent?.slice(0, 160) ?? null,
      height: b ? Math.round(b.height) : 0,
      insideTheSteps: !!steps,
      underTheList: l && b ? Math.round(b.top) >= Math.round(l.bottom) - 1 : null,
      gapBelowTheList: l && b ? Math.round(b.top - l.bottom) : null,
      fontPx: box ? getComputedStyle(box).fontSize : null,
      opacity: box ? getComputedStyle(box).opacity : null,
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

// 2. Turned on: the reasoning arrives under the steps, live, and stays open while it works.
await ask()
let live = await look()
for (let i = 0; i < 150; i++) {
  live = await look()
  if (live.label === 'Thinking' && live.chars > 20) break
  await win.waitForTimeout(100)
}
console.log('while thinking:', JSON.stringify(live))
await shot('03-thinking-as-it-arrives')
const thoughtSoFar = live.chars

// 3. The reply over: folded to the line it ended on, no text node, one line tall.
for (let i = 0; i < 160 && (await look()).working; i++) await win.waitForTimeout(250)
await win.waitForTimeout(600)
const folded = await look()
console.log('after the turn, folded:', JSON.stringify(folded))
await shot('04-folded-when-the-reply-is-over')

// 4. One click: the whole of it, in the page.
await win.locator('.thought__head').last().click()
await win.waitForTimeout(300)
const opened = await look()
console.log('one click opens it:', JSON.stringify(opened))
console.log('the whole of it, as read back:', JSON.stringify({ chars: opened.chars, endsWith: opened.text?.slice(-60) ?? null }))
await shot('05-one-click-opens-it')

// 5. Another click: folded again, to the same line.
await win.locator('.thought__head').last().click()
await win.waitForTimeout(300)
const refolded = await look()
console.log('a click folds it back:', JSON.stringify({ open: refolded.open, height: refolded.height, lastLine: refolded.lastLine?.slice(-60) ?? null, foldedHeight: folded.height }))
await shot('06-a-click-folds-it-back')

// 6. Turned off again: the same turn shows the steps and the answer, and nothing of the reasoning.
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
await shot('07-off-again-nothing-shown')

console.log('thinking text seen while it worked:', thoughtSoFar)
console.log('errors:', JSON.stringify(errors))
await app.close()
rmSync(data, { recursive: true, force: true })
