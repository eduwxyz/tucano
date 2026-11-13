// Built app, fresh workspace: a quick click opens, a hold draws the drop target, and a drop moves.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const output = process.argv[2] ?? 'frames/sidebar-reorder'
mkdirSync(output, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-sidebar-reorder-'))
// TUCANO_ELECTRON runs the installed app instead of this checkout's build: same flow, against the
// bundle a person has. A packaged app takes no project path, so only the checkout gets the '.', and
// both get their own Electron profile so a second instance never races the one on screen.
const installed = process.env.TUCANO_ELECTRON
const profile = `--user-data-dir=${join(data, 'electron')}`
const app = await electron.launch({
  args: installed ? [profile] : ['.', profile],
  ...(installed ? { executablePath: installed } : {}),
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  const agents = win.locator('.nav-item', { has: win.locator('.nav-item__role') })
  await agents.filter({ hasText: 'Lia' }).first().click()
  await win.waitForSelector('.agent-form')
  await win.screenshot({ path: join(output, '01-click-opens-agent.png') })
  const rows = win.locator('[data-order-id]', { has: win.locator('.nav-item__role') })
  assert.ok(await rows.count() >= 2, 'need two agents to reorder')
  const before = await rows.evaluateAll((els) => els.map((el) => el.dataset.orderId))
  const first = await rows.nth(1).boundingBox()
  const second = await rows.nth(0).boundingBox()
  assert.ok(first && second)
  await win.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await win.mouse.down()
  await win.waitForTimeout(450)
  await win.mouse.move(second.x + second.width / 2, second.y + second.height / 2)
  await win.waitForTimeout(150)
  await win.screenshot({ path: join(output, '02-hold-shows-drop-target.png') })
  await win.mouse.up()
  await win.waitForTimeout(250)
  const after = await rows.evaluateAll((els) => els.map((el) => el.dataset.orderId))
  assert.notDeepEqual(after, before, 'the drop must change the order')
  assert.equal(await win.locator('.agent-form').count(), 1, 'a drop must keep the agent page open')
  await win.screenshot({ path: join(output, '03-after-drop.png') })

  // The screens above the lists (Approvals, Wiki…) move the same way: hold one, drop it on the one
  // above, and the order it lands in is what the workspace keeps after a reload.
  const navRows = win.locator('[data-order-group="nav"]')
  assert.ok((await navRows.count()) >= 2, 'need two screens to reorder')
  const navBefore = await navRows.evaluateAll((els) => els.map((el) => el.dataset.orderId))
  const picked = await navRows.nth(1).boundingBox()
  const landed = await navRows.nth(0).boundingBox()
  assert.ok(picked && landed)
  await win.mouse.move(picked.x + picked.width / 2, picked.y + picked.height / 2)
  await win.mouse.down()
  await win.waitForTimeout(450)
  await win.mouse.move(landed.x + landed.width / 2, landed.y + landed.height / 2)
  await win.waitForTimeout(150)
  await win.screenshot({ path: join(output, '04-hold-a-screen.png') })
  await win.mouse.up()
  await win.waitForTimeout(250)
  const navAfter = await navRows.evaluateAll((els) => els.map((el) => el.dataset.orderId))
  assert.equal(navAfter[0], navBefore[1], 'the drop must move the screen to the top')
  assert.equal(await win.locator('.agent-form').count(), 1, 'a drop must keep the page open')
  await win.screenshot({ path: join(output, '05-screens-after-drop.png') })

  await win.reload()
  await win.waitForSelector('.sidebar')
  const kept = await win.locator('[data-order-group="nav"]').evaluateAll((els) => els.map((el) => el.dataset.orderId))
  assert.deepEqual(kept, navAfter, 'the screens must come back in the order they were left')

  // A bot DM's right-click menu offers the two steps the keyboard has, and each wears the arrow it
  // means: the row goes the way the arrow points. The seed has no DM yet, so the agent's own menu
  // writes one first.
  await win.locator('[data-order-group="agents"][data-order-id]').filter({ hasText: 'Lia' }).first().click({ button: 'right' })
  await win.waitForSelector('.menu')
  await win.locator('.menu__item', { hasText: 'Send a message' }).first().click()
  const dmRow = win.locator('[data-order-group="dms"][data-order-id]').first()
  await dmRow.waitFor()
  await dmRow.click({ button: 'right' })
  await win.waitForSelector('.menu')
  const arrows = await win
    .locator('.menu__item')
    .filter({ hasText: /^Move (up|down)$/ })
    .evaluateAll((els) => els.map((el) => el.querySelector('svg path')?.getAttribute('d') ?? null))
  assert.equal(arrows.length, 2, 'the menu must offer both steps')
  assert.ok(
    arrows.every(Boolean),
    'each step must wear a glyph'
  )
  assert.notEqual(arrows[0], arrows[1], 'the two arrows must point different ways')
  await win.screenshot({ path: join(output, '06-dm-menu-glyphs.png') })
  await win.keyboard.press('Escape')

  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ data, before, after, navBefore, navAfter, errors }))
} finally {
  await app.close()
}
