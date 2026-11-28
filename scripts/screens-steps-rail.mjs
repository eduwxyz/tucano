// Frames for the line beside a run's steps being a handle (#—/this PR): a double-click on it folds the
// steps from wherever the run has scrolled to, instead of scrolling back up to the toggle at the top.
// The long reply is seeded (25 steps): no fake turn makes that many tool calls, and the point of the
// handle is a run too long to reach its own toggle.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'C:/tmp/frames/steps-rail'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []

const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return { app, win }
}

const SEED = '[data-id="seed-long-reply"]'

// Everything about the handle and the line it sits on, measured rather than asserted.
const look = (sel) =>
  win.evaluate((s) => {
    const box = s ? document.querySelector(s) : [...document.querySelectorAll('.steps')].filter((x) => x.querySelector('.steps__toggle')).pop()
    const steps = box?.matches('.steps') ? box : box?.querySelector('.steps')
    const body = steps?.querySelector('.steps__body')
    const rail = steps?.querySelector('.steps__rail')
    const list = steps?.querySelector('.steps__list')
    const firstIcon = list?.querySelector('.step__icon')
    const r = rail?.getBoundingClientRect()
    const l = list?.getBoundingClientRect()
    const i = firstIcon?.getBoundingClientRect()
    return {
      hasList: !!list,
      rows: list ? list.querySelectorAll('.step').length : 0,
      rail: rail
        ? {
            tag: rail.tagName,
            label: rail.getAttribute('aria-label'),
            title: rail.getAttribute('title'),
            cursor: getComputedStyle(rail).cursor,
            width: Math.round(r.width),
            height: Math.round(r.height),
            // The handle is centred on the line: its middle against the list's border.
            centreOffset: Math.round(r.left + r.width / 2 - l.left),
            // It must stop short of what a person reads.
            gapToIcon: i ? Math.round(i.left - r.right) : null,
            background: getComputedStyle(rail).backgroundColor,
            lineColor: getComputedStyle(list).borderLeftColor,
            lineWidth: getComputedStyle(list).borderLeftWidth
          }
        : null,
      line: steps?.querySelector('.steps__toggle')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      stepsTopInView: steps ? Math.round(steps.getBoundingClientRect().top) : null,
      stepsHeight: steps ? Math.round(steps.getBoundingClientRect().height) : null,
      viewport: window.innerHeight,
      sideways: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth
    }
  }, sel)

let { app, win } = await launch()

// A real turn first: the handle on a reply the app actually made.
await win.locator('.section .nav-item', { hasText: 'engineering' }).first().click()
await win.waitForSelector('.composer textarea')
await win.locator('.composer textarea').fill('Lia, o test/wiki-git.test.ts falha aqui. É do build ou da máquina?')
await win.keyboard.press('Enter')
for (let i = 0; i < 120; i++) {
  const working = await win.evaluate(() => !!document.querySelector('.steps__stop'))
  if (!working && i > 6) break
  await win.waitForTimeout(250)
}
// A finished reply starts folded: open it, as a person would.
await win.evaluate(() => {
  const all = [...document.querySelectorAll('.steps')].filter((x) => x.querySelector('.steps__toggle'))
  const last = all[all.length - 1]
  if (last && !last.querySelector('.steps__list')) last.querySelector('.steps__toggle').click()
})
await win.waitForTimeout(400)
console.log('a real turn, open:', JSON.stringify(await look(null)))

// Hover the line: it has to read as something you can press.
const railBox = await win.evaluate(() => {
  const all = [...document.querySelectorAll('.steps')].filter((x) => x.querySelector('.steps__toggle'))
  const rail = all[all.length - 1].querySelector('.steps__rail')
  const r = rail.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
console.log('at rest:', JSON.stringify(await look(null)))
await win.mouse.move(railBox.x, railBox.y)
await win.waitForTimeout(300)
console.log('hovered:', JSON.stringify(await look(null)))
await win.screenshot({ path: `${out}/01-the-line-hovered.png` })

// One click must not fold it.
await win.mouse.click(railBox.x, railBox.y)
await win.waitForTimeout(300)
console.log('after one click:', JSON.stringify(await look(null)))

// The keyboard has no double-click: Enter on the focused handle folds it.
await win.evaluate(() => {
  const all = [...document.querySelectorAll('.steps')].filter((x) => x.querySelector('.steps__toggle'))
  all[all.length - 1].querySelector('.steps__rail').focus()
})
await win.keyboard.press('Enter')
await win.waitForTimeout(400)
console.log('after Enter on the handle:', JSON.stringify(await look(null)))

// Now the long one: 25 steps, seeded, in a window too short to hold them — so its toggle is above the
// viewport and the handle is the only way to fold it from where the reader is.
await app.close()
const db = new DatabaseSync(join(data, 'tucano.db'))
const conv = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' AND name = 'engineering'").get()
const agent = db.prepare('SELECT id FROM agents LIMIT 1').get()
const steps = Array.from({ length: 25 }, (_, i) => ({
  id: `seed-s${i + 1}`,
  label: ['read src/core/runs.ts', 'run npx vitest run test/runs.test.ts', 'write src/core/runs.ts', 'read the failing output', 'run npx tsc --noEmit'][i % 5] + ` (${i + 1})`,
  status: 'done',
  ms: 400 + i * 37
}))
const at = Date.now() - 120_000
db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run, routine, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  'seed-long-reply',
  conv.id,
  'agent',
  agent.id,
  'Os testes passam agora. O problema era o caminho do Node, não o teste.',
  at,
  JSON.stringify({ status: 'done', endedAt: at + 21_000, steps }),
  null,
  null
)
db.close()
;({ app, win } = await launch())
await win.setViewportSize({ width: 1280, height: 620 })
await win.locator('.section .nav-item', { hasText: 'engineering' }).first().click()
await win.waitForSelector('.composer textarea')
await win.waitForTimeout(600)
await win.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), SEED)
await win.waitForTimeout(400)
await win.evaluate((sel) => {
  const box = document.querySelector(sel)
  if (box && !box.querySelector('.steps__list')) box.querySelector('.steps__toggle')?.click()
}, SEED)
await win.waitForTimeout(500)
// Where a person reading a long run is: its bottom, with the toggle scrolled off the top.
await win.evaluate((sel) => {
  const last = [...document.querySelectorAll(`${sel} .step`)].pop()
  last?.scrollIntoView({ block: 'end' })
}, SEED)
await win.waitForTimeout(400)
const before = await look(SEED)
const toggleInView = await win.evaluate((sel) => {
  const t = document.querySelector(`${sel} .steps__toggle`).getBoundingClientRect()
  return { top: Math.round(t.top), bottom: Math.round(t.bottom), inView: t.bottom > 0 && t.top < window.innerHeight }
}, SEED)
console.log('the 25-step run, at its bottom:', JSON.stringify(before))
console.log('the toggle it would have had to scroll back to:', JSON.stringify(toggleInView))
await win.screenshot({ path: `${out}/02-the-long-run-at-its-bottom.png` })

// The double-click, from down there: no scrolling back up first.
const bottomRail = await win.evaluate((sel) => {
  const rail = document.querySelector(`${sel} .steps__rail`)
  const r = rail.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: Math.min(r.bottom - 30, window.innerHeight - 80), top: Math.round(r.top), bottom: Math.round(r.bottom) }
}, SEED)
console.log('the handle, from where the reader is:', JSON.stringify(bottomRail))
await win.mouse.move(bottomRail.x, bottomRail.y)
await win.waitForTimeout(250)
await win.screenshot({ path: `${out}/02b-the-handle-hovered.png` })
await win.mouse.dblclick(bottomRail.x, bottomRail.y)
await win.waitForTimeout(700)
console.log('after the double-click:', JSON.stringify(await look(SEED)))
await win.screenshot({ path: `${out}/03-folded-from-the-bottom.png` })

// Narrow: the handle is where it was, and nothing scrolls sideways.
await win.setViewportSize({ width: 420, height: 620 })
await win.waitForTimeout(400)
await win.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), SEED)
await win.waitForTimeout(300)
await win.evaluate((sel) => {
  const box = document.querySelector(sel)
  if (box && !box.querySelector('.steps__list')) box.querySelector('.steps__toggle')?.click()
}, SEED)
await win.waitForTimeout(500)
await win.evaluate((sel) => {
  const last = [...document.querySelectorAll(`${sel} .step`)].pop()
  last?.scrollIntoView({ block: 'end' })
}, SEED)
await win.waitForTimeout(400)
const narrowRail = await win.evaluate((sel) => {
  const r = document.querySelector(`${sel} .steps__rail`).getBoundingClientRect()
  return { x: r.left + r.width / 2, y: Math.min(r.bottom - 30, window.innerHeight - 80) }
}, SEED)
await win.mouse.move(narrowRail.x, narrowRail.y)
await win.waitForTimeout(300)
console.log('at 420, hovered:', JSON.stringify(await look(SEED)))
await win.screenshot({ path: `${out}/04-at-420.png` })
await win.mouse.dblclick(narrowRail.x, narrowRail.y)
await win.waitForTimeout(700)
console.log('at 420, after the double-click:', JSON.stringify(await look(SEED)))
await win.screenshot({ path: `${out}/05-at-420-folded.png` })

console.log('page errors:', errors.length, errors.slice(0, 3))
await app.close()
