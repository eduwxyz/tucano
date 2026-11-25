// Frames and measurements for "every session in a channel keeps its own action buttons": a channel
// with three sessions and what each row offers, read from the built app.
//
//   node scripts/screens-session-buttons.mjs <out dir> [app dir] [shape]
//
// `shape` is one of:
//   finished  three sessions that ended: each one's ways on (Continue, Try again, Try with
//             instructions) has to be in sight and each has to act on its own row.
//   mixed     two ended and one at work: the ended pair keeps its ways on, the row at work carries
//             the steer instead.
//   running   three at work at once: each carries its own steer, and the note under the second goes
//             into the second and into no other.
//
// A reply that takes its time is stopped by hand ("finished" and "mixed"); "Try again" on an ended
// row starts a fresh reply beside whatever runs, which is how three are put to work at once.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/session-buttons'
const appDir = process.argv[3] ?? 'C:/Users/theap/orca/workspaces/tucano/session-buttons'
const shape = process.argv[4] ?? 'finished'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []
const app = await electron.launch({ args: ['.'], cwd: appDir, env })
const win = await app.firstWindow()
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForSelector('.sidebar')
await win.waitForTimeout(800)

const WAIT_IDLE = () => ![...document.querySelectorAll('.composer button')].some((b) => b.textContent?.trim() === 'Stop')
const waitIdle = async () => {
  await win.waitForFunction(WAIT_IDLE, null, { timeout: 90_000 }).catch(() => {})
  await win.waitForTimeout(700)
}

await win.locator('.sidebar').getByText('engineering', { exact: false }).first().click()
await win.waitForTimeout(500)

// A reply that takes its time, stopped by hand: one that ended early is the one that needs its ways on.
const started = async (ask) => {
  await win.fill('.composer textarea', ask)
  await win.keyboard.press('Enter')
  await win.waitForSelector('.composer button:has-text("Stop")', { timeout: 30_000 })
  await win.waitForTimeout(1800)
}
const stopOne = async (ask) => {
  await started(ask)
  await win.locator('.composer button:has-text("Stop")').click()
  await waitIdle()
}

await stopOne('Summarise what the last release changed for the sidebar. Demore 8 s.')
await stopOne('Which of those changes can break a saved layout? Demore 8 s.')
if (shape === 'finished') {
  await stopOne('Write the short note we send to the team about it. Demore 8 s.')
} else {
  // The third one left at work. In "running", the two ended rows are put back to work beside it.
  await started('Write the short note we send to the team about it. Demore 14 s.')
  if (shape === 'running') {
    // By id, not by position: a reply that goes back to work moves to the end of the channel, so the
    // rows a person sees shift the moment the first retry starts.
    const ids = await win.evaluate(() => [...document.querySelectorAll('.msg--agent')].map((m) => m.getAttribute('data-id')))
    for (const id of ids.slice(0, 2)) {
      const row = win.locator(`.msg--agent[data-id="${id}"]`)
      await row.scrollIntoViewIfNeeded()
      await row.hover()
      await win.waitForTimeout(250)
      await row.locator('button:has-text("Try again")').first().click()
      await win.waitForTimeout(1200)
    }
    await win.waitForFunction(
      () => [...document.querySelectorAll('.msg--agent')].filter((m) => m.querySelector('.steps.is-working')).length >= 3,
      null,
      { timeout: 30_000 }
    ).catch(() => {})
  }
}

// The pointer parked on the channel's title: no row is hovered, so what is measured is what the
// channel shows on its own.
await win.locator('.topbar__title').hover()
await win.waitForTimeout(400)

const measure = () =>
  win.evaluate(() => {
    const rows = [...document.querySelectorAll('.msg--agent')].map((m, i) => {
      const foot = m.querySelector('.msg__meta')
      const onScreen = (el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
      }
      const box = foot?.getBoundingClientRect()
      return {
        row: i + 1,
        id: m.getAttribute('data-id'),
        author: m.querySelector('.msg__author')?.textContent?.trim(),
        // A row at work says so in its own chain, and is the one a steer can reach.
        working: !!m.querySelector('.steps.is-working'),
        steers: m.querySelectorAll('.step--steer').length,
        footer: !!foot,
        note: m.querySelector('.msg__body > .note')?.textContent?.trim().slice(0, 60) ?? null,
        box: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
        controls: [...(foot?.querySelectorAll('button') ?? [])].map((b) => ({
          label: b.getAttribute('aria-label') ?? b.textContent?.trim(),
          // `msg__hire` was the class that kept a way on hidden until the pointer reached the row.
          hoverOnly: b.classList.contains('msg__hire'),
          opacity: getComputedStyle(b).opacity,
          onScreen: onScreen(b)
        }))
      }
    })
    return { rows, agentRows: rows.length }
  })

const report = { shape, ...(await measure()) }
report.pageErrors = errors.length
report.errors = errors.slice(0, 4)
// The frame is the content column, so the callout coordinates (viewport space) are shifted by this.
const main = await win.locator('.main').boundingBox()
report.main = main && { x: Math.round(main.x), y: Math.round(main.y) }
writeFileSync(join(out, 'frames.json'), JSON.stringify(report, null, 2))
await win.locator('.main').screenshot({ path: join(out, `channel-three-sessions-${shape}.png`) })

if (shape === 'running') {
  // The note under the second row, typed and sent: it has to land in that row's own chain.
  const target = report.rows[1].id
  const second = win.locator(`.msg--agent[data-id="${target}"]`)
  await second.scrollIntoViewIfNeeded()
  await second.hover()
  await second.locator('.steps__steer-pill').click()
  await second.locator('.retry-note textarea').fill('Take the second layout and say why.')
  await second.locator('.retry-note__row button').first().click()
  await win.waitForTimeout(2500)
  const after = await measure()
  report.steered = {
    target,
    // The row that was steered is the only one that gained a steer in its chain.
    steers: after.rows.map((r) => ({ id: r.id, steers: r.steers })),
    idsBefore: report.rows.map((r) => r.id),
    idsAfter: after.rows.map((r) => r.id),
    postedAsMessage: after.agentRows > report.agentRows
  }
  report.pageErrors = errors.length
  writeFileSync(join(out, 'frames.json'), JSON.stringify(report, null, 2))
  await win.locator('.main').screenshot({ path: join(out, `channel-three-sessions-${shape}-steered.png`) })
}

console.log(JSON.stringify(report, null, 1))
await app.close()
rmSync(data, { recursive: true, force: true })
