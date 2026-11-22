// The routing's pick, drawn where it belongs: at the head of the reply it started, before anything that
// reply did or said, and not as a row of the channel above the field. A channel with several agents and
// the fake engines routes for real, so the numbers come from a pick the app made.
//
// Usage: node scripts/screens-routing-pick.mjs [out dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames-routing-pick'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-pick-'))
const errors = []

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
})
const win = await app.firstWindow()
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForSelector('.sidebar', { timeout: 60_000 })
await win.waitForTimeout(3000)

const channel = async (name) => {
  await win.locator('.sidebar [data-order-group="channels"] button', { hasText: name }).first().click({ timeout: 20_000 })
  await win.waitForTimeout(600)
}
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

// ---------- 1. a message in a channel, routed: the pick rides the reply ----------
await channel('engineering')
const before = await win.locator('.system-line').count()
await win.fill('.composer textarea', 'the build broke this morning, can someone look at it?')
await win.keyboard.press('Enter')
await win.locator('.msg__routed').first().waitFor({ timeout: 60_000 })
await win.waitForTimeout(2500)

const facts = await win.evaluate(() => {
  const list = document.querySelector('.messages')
  const row = document.querySelector('.msg__routed')?.closest('.msg')
  const body = row?.querySelector('.msg__body')
  const pick = row?.querySelector('.msg__routed')
  const head = row?.querySelector('.msg__head')
  const text = row?.querySelector('.md, .msg__text, .steps, .msg__anchor')
  const r = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }
  }
  const kids = row ? [...row.querySelectorAll('.msg__body > *')].map((el) => el.className.split(' ').slice(0, 2).join(' ')) : []
  return {
    channelSystemLines: document.querySelectorAll('.system-line').length,
    pickText: pick?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    pickTitle: pick?.getAttribute('title') ?? null,
    inReplyRow: !!row,
    orderInBody: kids,
    box: { pick: r(pick), head: r(head), firstBelow: r(text), body: r(body) },
    oneLine: pick ? pick.scrollHeight <= pick.clientHeight + 1 : null,
    listOverflowX: list ? list.scrollWidth - list.clientWidth : null,
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})
console.log('routed reply:', JSON.stringify({ ...facts, systemLinesBefore: before }, null, 1))
await shot('01-pick-on-the-reply')

// the pick line's own frame, for the PR
const pickRow = win.locator('.msg__routed').first().locator('xpath=ancestor::*[contains(@class,"msg")][1]')
await pickRow.screenshot({ path: `${out}/02-the-row.png` })

// ---------- 2. a narrow window: the reason gives way, the line stays one line ----------
await win.setViewportSize({ width: 420, height: 860 })
await win.waitForTimeout(700)
const narrow = await win.evaluate(() => {
  const pick = document.querySelector('.msg__routed')
  const why = document.querySelector('.msg__routed-why')
  const b = (el) => (el ? { w: Math.round(el.getBoundingClientRect().width), scroll: el.scrollWidth, client: el.clientWidth } : null)
  return {
    pick: b(pick),
    why: b(why),
    oneLine: pick ? pick.scrollHeight <= pick.clientHeight + 1 : null,
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})
console.log('narrow:', JSON.stringify(narrow))
await shot('03-narrow')

console.log('page errors:', errors.length ? JSON.stringify(errors) : 'none')
await app.close()
