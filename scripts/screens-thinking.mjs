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

// 7. Reading further up while the rest arrives: the block keeps the place the person is reading,
// instead of pulling them to the end with every piece that lands, and it takes the stream up again
// once they are back at the end. A narrow window, so a turn's reasoning already scrolls.
// The block of the turn running now: the only one that says "Thinking", since every block of an
// earlier turn says "Thought". The list unmounts rows that scroll out of view, so counting blocks
// is not a place to stand.
const RUNNING = '.thought:has(.thought__label:text-is("Thinking"))'
const scroller = () =>
  win.evaluate(() => {
    const t = [...document.querySelectorAll('.thought')].filter((b) => b.querySelector('.thought__label')?.textContent === 'Thinking').at(-1)
    const box = t?.querySelector('.thought__text')
    if (!box) return null
    const hidden = box.scrollHeight - box.clientHeight
    return {
      label: t.querySelector('.thought__label')?.textContent ?? null,
      chars: box.textContent?.length ?? 0,
      top: Math.round(box.scrollTop),
      hidden,
      atTheEnd: hidden - Math.round(box.scrollTop) < 24,
      scrollable: hidden > 20,
      working: !!document.querySelector('.steps__stop')
    }
  })
const grew = async (from) => {
  for (let i = 0; i < 40; i++) {
    const s = await scroller()
    if (s && s.chars > from) return s
    await win.waitForTimeout(100)
  }
  return scroller()
}
const scrollBlock = (where) =>
  win.evaluate((w) => {
    const t = [...document.querySelectorAll('.thought')].filter((b) => b.querySelector('.thought__label')?.textContent === 'Thinking').at(-1)
    const box = t?.querySelector('.thought__text')
    if (box) box.scrollTop = w === 'end' ? box.scrollHeight : 0
  }, where)

await win.setViewportSize({ width: 900, height: 880 })
await settings()
await win.locator(`${card} .toggle`).click()
await win.waitForTimeout(300)
await ask()
let arrived = null
for (let i = 0; i < 120; i++) {
  arrived = await scroller()
  if (arrived?.label === 'Thinking' && arrived.scrollable) break
  await win.waitForTimeout(100)
}
console.log('following, at the end:', JSON.stringify(arrived))

// A wheel up over the block, the way a person reads back into it.
const place = await win.locator(RUNNING).last().locator('.thought__text').boundingBox()
await win.mouse.move(place.x + place.width / 2, place.y + place.height / 2)
await win.mouse.wheel(0, -260)
await win.waitForTimeout(120)
const reading = await scroller()
const landing = await grew(reading.chars)
const held = await scroller()
console.log('reading above the stream:', JSON.stringify({ reading, landing, held }))
await shot('08-reading-above-the-stream')

// Back at the end by hand: the block follows the rest of what arrives.
await scrollBlock('end')
await win.waitForTimeout(120)
const back = await scroller()
const after = await grew(back.chars)
await win.waitForTimeout(200)
const following = await scroller()
console.log('back at the end:', JSON.stringify({ back, after, following }))
await shot('09-back-at-the-end')

const fails = []
if (!arrived?.scrollable) fails.push('the block never scrolled, so there was nothing to hold')
if (!arrived?.atTheEnd) fails.push('the block did not open at the end of the reasoning')
if (reading.top === 0 && reading.hidden === 0) fails.push('the wheel over the block moved nothing')
if (held.chars <= reading.chars) fails.push('no reasoning arrived while the block was read further up')
if (held.top !== reading.top) fails.push(`the block moved from ${reading.top} to ${held.top} while it was read further up`)
if (!back.atTheEnd) fails.push('the block did not take the end back when scrolled there')
if (following.chars <= back.chars) fails.push('no reasoning arrived after the block was back at the end')
if (!following.atTheEnd) fails.push('the block stopped following after it was taken back to the end')
console.log('scroll check:', fails.length === 0 ? 'ok' : JSON.stringify(fails))
if (fails.length > 0) process.exitCode = 1

console.log('thinking text seen while it worked:', thoughtSoFar)
console.log('errors:', JSON.stringify(errors))
await app.close()
rmSync(data, { recursive: true, force: true })
