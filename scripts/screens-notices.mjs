// A real notification, not a card drawn for a look: a DM with an agent, a prompt whose reply lands
// while the app is not on that conversation, the app's own notify path (src/main/index.ts, `notify`),
// and the card it puts over every window. Then the card is clicked, and the app opens what it is
// about.
//
// `--qa-background` suppresses notifications on purpose (docs/background-qa.md), so this run cannot
// use it and the app window is visible for the few seconds it takes. Everything else follows the
// runner's contract: a fresh scratch data directory, reserved ports, fake engines, a seeded
// workspace, a report with the source commit, and a nonzero exit when a check fails.
//
//   node scripts/screens-notices.mjs [output directory]
//   TUCANO_ELECTRON=<installed TucanoNext.exe> node scripts/screens-notices.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const reserve = async () => {
  const server = createServer()
  await new Promise((yes, no) => {
    server.once('error', no)
    server.listen(0, '127.0.0.1', yes)
  })
  return { server, port: server.address().port }
}

const output = resolve(process.argv[2] ?? '.tucano-local/audit/notices')
mkdirSync(output, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-notices-'))
const reservations = await Promise.all([reserve(), reserve()])
const env = {
  ...process.env,
  TUCANO_DATA: data,
  TUCANO_SEED: '1',
  TUCANO_FAKE_ENGINES: '1',
  TUCANO_LOCALE: 'en-US',
  TUCANO_WEBHOOK_PORT: String(reservations[0].port),
  TUCANO_GIT_PORT: String(reservations[1].port)
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const report = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
  data,
  ports: reservations.map((r) => r.port),
  checks: [],
  errors: [],
  passed: false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let app
try {
  await Promise.all(reservations.map(({ server }) => new Promise((yes, no) => server.close((e) => (e ? no(e) : yes())))))
  app = await electron.launch({
    ...(env.TUCANO_ELECTRON ? { executablePath: env.TUCANO_ELECTRON } : { args: ['.'] }),
    env
  })
  report.runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    executable: process.execPath,
    data: app.getPath('userData')
  }))

  const win = await app.firstWindow()
  win.setDefaultTimeout(25_000)
  win.on('pageerror', (e) => report.errors.push(String(e)))
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  await win.screenshot({ path: join(output, '01-workspace.png') })
  report.checks.push('workspace')

  // Lia's DM: the profile's own way in, as a person would open it.
  const agents = win.locator('.nav-item', { has: win.locator('.nav-item__role') })
  assert.ok((await agents.count()) >= 2, 'Seeded agents must load')
  await agents.filter({ hasText: 'Lia' }).first().click()
  await win.waitForSelector('.agent-form')
  await win.getByRole('button', { name: 'Open DM', exact: true }).click()
  await win.locator('.composer textarea').waitFor()
  report.checks.push('dm-open')

  // The prompt, then away from that conversation: a reply finishing on the screen the person is
  // looking at is deliberately silent, so the run must not be looking at it.
  await win.locator('.composer textarea').fill('Reply with one short sentence about the menu bug.')
  await win.keyboard.press('Enter')
  await win.locator('.sidebar .nav-item').filter({ hasText: 'Settings' }).first().click()
  await win.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  report.checks.push('away-from-the-conversation')

  // The card: a window of its own, made by the notify path.
  let notice = null
  for (let i = 0; i < 120 && !notice; i++) {
    const found = app.windows().filter((w) => !w.isClosed() && w.url().includes('notice.html'))
    if (found.length) {
      const first = found[0]
      notice = await first
        .waitForSelector('.nc-wrap', { timeout: 5_000 })
        .then(() => first)
        .catch(() => null)
    }
    if (!notice) await sleep(500)
  }
  assert.ok(notice, 'the notify path never put a card on screen')
  notice.on('pageerror', (e) => report.errors.push('notice: ' + String(e)))
  notice.setDefaultTimeout(15_000)

  const overlay = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.webContents.getURL().includes('notice.html'))
      .map((w) => ({ visible: w.isVisible(), alwaysOnTop: w.isAlwaysOnTop(), bounds: w.getBounds() }))
  )
  report.overlay = overlay
  assert.equal(overlay.length, 1, 'exactly one notice window')
  assert.ok(overlay[0].visible, 'the notice window must be on screen')
  assert.ok(overlay[0].alwaysOnTop, 'the notice window must stay above the app')
  report.checks.push('card-window-over-every-window')

  const cards = await notice.evaluate(() =>
    [...document.querySelectorAll('.nc-wrap')].map((el) => ({
      id: el.dataset['card'] ?? null,
      cls: el.querySelector('.nc')?.className ?? '',
      title: el.querySelector('.nc__title')?.textContent?.trim() ?? '',
      rect: (() => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })()
    }))
  )
  report.cards = cards
  assert.ok(cards.length >= 1, 'a card must be drawn')
  // The test cards from Settings carry `preview:` ids and nothing behind them. This one has to be a
  // real record, or the run proves nothing about the path a person meets.
  assert.ok(cards.every((c) => c.id && !c.id.startsWith('preview:')), 'the card must be a real notification, not a test card')
  report.checks.push('real-card:' + cards.map((c) => c.id).join(','))

  await notice.screenshot({ path: join(output, '02-card.png') })

  // Where the card is, and whether the page's own hit test can see it there: this is the test the
  // window's interactivity hangs on (`notice:hit` follows it).
  const hit = await notice.evaluate((card) => {
    const x = card.rect.x + card.rect.w / 2
    const y = card.rect.y + card.rect.h / 2
    const el = document.elementFromPoint(x, y)
    return { x, y, insideCard: !!el?.closest('.nc-wrap'), tag: el?.tagName ?? null }
  }, cards[0])
  report.hit = hit
  assert.ok(hit.insideCard, 'the page must hit-test the card where it is drawn')
  report.checks.push('hit-test')

  // Clicking the card opens what it is about, and the card goes.
  await notice.mouse.click(hit.x, hit.y)
  let left = -1
  for (let i = 0; i < 40; i++) {
    left = await notice.evaluate(() => document.querySelectorAll('.nc-wrap').length).catch(() => 0)
    if (left === 0) break
    await sleep(250)
  }
  report.cardsLeftAfterClick = left
  assert.equal(left, 0, 'the card must go once it is opened')
  await win.locator('.topbar__name').filter({ hasText: 'Lia' }).waitFor()
  report.checks.push('click-opens-the-conversation')
  await win.screenshot({ path: join(output, '03-opened.png') })

  const hidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.webContents.getURL().includes('notice.html'))
      .map((w) => w.isVisible())
  )
  report.noticeVisibleAfterClick = hidden
  assert.ok(hidden.every((v) => v === false), 'the cards window hides when it has nothing to show')
  report.checks.push('card-window-hides')

  assert.deepEqual(report.errors, [], 'no renderer errors')
  report.passed = true
} catch (error) {
  report.failure = String(error)
  try {
    for (const [i, window] of (app?.windows() ?? []).entries()) {
      if (window.isClosed()) continue
      await window.screenshot({ path: join(output, `failure-${i}.png`) }).catch(() => {})
      report.pageText = await window.evaluate(() => document.body.innerText.slice(0, 4_000)).catch(() => null)
    }
  } catch {
    // the app is gone; the report still says what failed
  }
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
}
