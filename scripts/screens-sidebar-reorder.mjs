// Built app, fresh workspace: a quick click opens, a hold draws the drop target, and a drop moves.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const output = process.argv[2] ?? 'frames/sidebar-reorder'
mkdirSync(output, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-sidebar-reorder-'))
const app = await electron.launch({
  args: ['.', `--user-data-dir=${join(data, 'electron')}`],
  ...(process.env.TUCANO_ELECTRON ? { executablePath: process.env.TUCANO_ELECTRON } : {}),
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
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ data, before, after, errors }))
} finally {
  await app.close()
}
