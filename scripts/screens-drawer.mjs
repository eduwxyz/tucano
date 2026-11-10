// Proves the drawer above the message field: what is running here now, and what waits its turn.
// Seeds a workspace, then in a DM starts two replies at once (the fake engine's "demore 20 s") and
// queues a third with Shift+Enter. Shoots it open, a row that goes to its reply, a row that stops
// only its own reply, and the closed strip once one thing is left. Nothing here touches the real
// database: a temp TUCANO_DATA and the fake engines.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'C:/tmp/drawer-screens'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-drawer-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' }

const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.waitForSelector('.sidebar')

// ---------- a DM, with two replies at once and one prompt queued ----------
const dm = win.locator('.section .nav-item').nth(1)
await dm.click()
await win.waitForSelector('.composer textarea')
const send = async (text, keys = 'Enter') => {
  await win.locator('.composer textarea').fill(text)
  await win.keyboard.press(keys)
  await win.waitForTimeout(250)
}
await send('Publica o post de hoje? demore 20 s')
await send('Agora o resumo semanal demore 20 s')
await send('depois revisa o texto do post demore 8 s', 'Shift+Enter')
await win.waitForSelector('.drawer.is-open', { timeout: 15_000 })
await win.waitForTimeout(600)

const shot = async (name) => {
  await win.screenshot({ path: `${out}/${name}.png` })
}

// What the screen says. Geometry too: the drawer must sit on the composer, as wide as it, with no
// row running past its edge (a one-line prompt that wraps breaks the whole idea of a row).
const measure = async () =>
  win.evaluate(() => {
    const box = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
    }
    const drawer = document.querySelector('.drawer')
    const composer = document.querySelector('.composer')
    const rows = [...document.querySelectorAll('.drawer__row, .drawer__go--queued')]
    const overflow = rows.filter((r) => {
      const go = r.classList.contains('drawer__go') ? r : r.querySelector('.drawer__go')
      return go.scrollWidth > go.clientWidth + 1
    }).length
    return {
      drawer: box(drawer),
      composer: box(composer),
      closed: drawer.classList.contains('is-closed'),
      title: document.querySelector('.drawer__title')?.textContent ?? '',
      live: document.querySelectorAll('.drawer__row').length,
      queued: document.querySelectorAll('.drawer__go--queued').length,
      prompts: [...document.querySelectorAll('.drawer__prompt')].map((p) => p.textContent),
      names: [...document.querySelectorAll('.drawer__name')].map((p) => p.textContent),
      stopGlyphs: document.querySelectorAll('.drawer__stop').length,
      rowsOverflowing: overflow,
      // Hover a row: the stop glyph is only visible on the row under the mouse or always? measured below.
      sameWidth: Math.round(drawer.getBoundingClientRect().width) === Math.round(composer.getBoundingClientRect().width),
      gap: Math.round(composer.getBoundingClientRect().top - drawer.getBoundingClientRect().bottom)
    }
  })

const report = {}
report.open = await measure()
await shot('01-open-two-live-one-queued')

// The conversation itself: how many replies are live there (the drawer's rows are closed when the
// strip is, so the steps are the honest count).
const live = () => win.evaluate(() => document.querySelectorAll('.steps.is-working').length)
const waitLive = async (n) => win.waitForFunction((n) => document.querySelectorAll('.steps.is-working').length === n, n, { timeout: 60_000 })

// ---------- a row goes where its reply is now ----------
const firstWorking = await win.evaluate(() => {
  for (const m of document.querySelectorAll('.msg')) if (m.querySelector('.steps.is-working')) return m.getAttribute('data-id')
  return null
})
await win.locator('.drawer__row .drawer__go').first().click()
await win.waitForTimeout(600)
report.jump = await win.evaluate((id) => {
  const list = document.querySelector('.messages')
  const el = id ? document.querySelector(`.msg[data-id="${id}"]`) : null
  if (!el) return { found: false }
  const b = el.getBoundingClientRect()
  const lb = list.getBoundingClientRect()
  return {
    found: true,
    inView: b.bottom > lb.top && b.top < lb.bottom,
    // "jump to the end of a prompt": its end is what comes into view, not its start
    endsInView: b.bottom <= lb.bottom + 2,
    flashed: el.classList.contains('is-flash'),
    drawerStillThere: !!document.querySelector('.drawer')
  }
}, firstWorking)
await shot('02-row-takes-you-to-the-reply')

// ---------- the glyph stops that one reply, and only that one ----------
report.stop = { workingBefore: await live() }
await win.locator('.drawer__stop').first().click()
await waitLive(1)
await win.waitForTimeout(400)
report.stop.workingAfter = await live()
report.stop.title = await win.evaluate(() => document.querySelector('.drawer__title')?.textContent ?? '')
report.stop.stoppedLines = await win.evaluate(() => (document.body.innerText.match(/Interrompido por você|Stopped by you/g) ?? []).length)
report.stop.secondStillRunning = await win.evaluate(() => document.querySelectorAll('.steps.is-working').length === 1)
report.stop.anyToast = await win.evaluate(() => /Não consegui|I couldn’t|I couldn't/.test(document.body.innerText))
await shot('03-stop-one-reply-only')

// ---------- one thing left: a closed strip, to open if wanted ----------
await win.locator('.drawer__stop').first().click()
await win.waitForSelector('.drawer.is-closed', { timeout: 60_000 })
await win.waitForTimeout(400)
report.closed = await measure()
await shot('04-closed-strip-when-only-one-is-left')

await win.locator('.drawer__head').click()
await win.waitForSelector('.drawer.is-open', { timeout: 15_000 })
await win.waitForTimeout(300)
report.opened = await measure()
await shot('05-opened-by-hand')

// ---------- nothing running, nothing queued: no drawer at all ----------
await win.waitForFunction(() => !document.querySelector('.drawer'), null, { timeout: 60_000 })
report.gone = await win.evaluate(() => ({ drawer: !!document.querySelector('.drawer'), composer: !!document.querySelector('.composer') }))
await shot('06-gone-when-there-is-nothing-to-say')

report.errors = errors
console.log(JSON.stringify(report, null, 2))
await app.close()
