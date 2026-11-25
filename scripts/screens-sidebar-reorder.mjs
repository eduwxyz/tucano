// Sorting the sidebar by hand, in the built app on a fresh workspace: hold a row (a top item, a
// channel, an agent, a sector) and let it go where it should land; Alt+↑/↓ with the keyboard. A quick
// click still opens, a drop doesn't, an item taken out of the sidebar stays out, and the order is
// still there after a restart.
// Run after `npm run build`: node scripts/screens-sidebar-reorder.mjs [out-dir]
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright'

const out = process.argv[2] ?? 'screens/sidebar-reorder'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const errors = []
const open = async () => {
  // Its own Electron profile, so an installed Tucano that is open never takes this one over.
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'electron')}`], env })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForSelector('.sidebar .section')
  await win.waitForTimeout(800)
  return { app, win }
}
let { app, win } = await open()
const shot = (name) => win.locator('.sidebar').screenshot({ path: join(out, `${name}.png`) })
const names = (selector) => win.locator(selector).evaluateAll((els) => els.map((el) => (el.querySelector('.nav-item__label, .fold-toggle') ?? el).textContent.trim()))
const tops = () => win.locator('.top-row[data-order-id]').evaluateAll((els) => els.map((el) => el.dataset.orderId))
const channels = () => names('.channel-row')
const agents = () => names('.agent-row[data-order-id]')
const active = () => win.locator('.sidebar .nav-item.is-active .nav-item__label').allTextContents()
const center = async (loc) => {
  const b = await loc.boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
// Hold `from`, carry it to `to` (a point), take a frame there, let go.
const carry = async (from, to, frame) => {
  const a = await center(from)
  await win.mouse.move(a.x, a.y)
  await win.mouse.down()
  await win.waitForTimeout(450)
  await win.mouse.move(to.x, to.y, { steps: 6 })
  await win.waitForTimeout(150)
  // A place that only takes a drop is zero-height until the row is lifted, so the last look has to be
  // taken once that has been drawn: on a busy machine the first arrival can land before it is there.
  await win.mouse.move(to.x + (to.x > a.x ? -1 : 1), to.y)
  await win.waitForTimeout(80)
  if (frame) await shot(frame)
  await win.mouse.up()
  await win.waitForTimeout(400)
}
const row = (selector, text) => win.locator(selector).filter({ hasText: text }).first()

await shot('01-rest')
const opened = await active()

// The menu's two reorder commands say which way they move with an arrow, like every other command in
// it. A label alone reads as two dead rows, and that is how upstream shipped it from 0.2.45 on.
await row('.channel-row', 'dados').click({ button: 'right' })
await win.waitForTimeout(300)
const reorder = await win.locator('.menu__item').evaluateAll((els) =>
  els
    .filter((el) => /^Mover para (cima|baixo)$/.test(el.textContent.trim()))
    .map((el) => ({ label: el.textContent.trim(), glyphs: el.querySelectorAll('svg').length }))
)
assert.deepEqual(reorder, [
  { label: 'Mover para cima', glyphs: 1 },
  { label: 'Mover para baixo', glyphs: 1 }
])
await win.locator('.menu').screenshot({ path: join(out, '01b-channel-menu.png') })
await win.keyboard.press('Escape')
await win.waitForTimeout(200)

// A channel: held, it dims, and an orange line shows where it lands.
assert.deepEqual(await channels(), ['engenharia', 'dados', 'conteudo'])
await carry(row('.channel-row', 'conteudo'), await center(row('.channel-row', 'engenharia')), '02-channel-carried')
assert.deepEqual(await channels(), ['conteudo', 'engenharia', 'dados'])
assert.deepEqual(await active(), opened, 'a drop must not open the row it was')

// An agent, the same way.
assert.deepEqual(await agents(), ['Lia', 'Theo', 'Nina'])
await carry(row('.agent-row', 'Nina'), await center(row('.agent-row', 'Lia')), '03-agent-carried')
assert.deepEqual(await agents(), ['Nina', 'Lia', 'Theo'])

// A top item: Operação above Aprovações, then Aprovações to the end, past the last one.
assert.deepEqual(await tops(), ['approvals', 'board', 'knowledge', 'operations'])
await carry(row('.top-row', 'Operação'), await center(row('.top-row', 'Aprovações')), '04-top-carried')
assert.deepEqual(await tops(), ['operations', 'approvals', 'board', 'knowledge'])
const last = await win.locator('.top-row[data-order-id]').last().boundingBox()
await carry(row('.top-row', 'Aprovações'), { x: last.x + last.width / 2, y: last.y + last.height + 3 }, '05-top-to-the-end')
assert.deepEqual(await tops(), ['operations', 'board', 'knowledge', 'approvals'])
assert.deepEqual(await active(), opened)

// The keyboard: Alt+↑ on a channel, Alt+↓ on an agent; plain arrows move nothing.
await row('.channel-row', 'dados').locator('.nav-item').focus()
await win.keyboard.press('Alt+ArrowUp')
await win.waitForTimeout(300)
assert.deepEqual(await channels(), ['conteudo', 'dados', 'engenharia'])
await row('.agent-row', 'Nina').locator('.nav-item').focus()
await win.keyboard.press('Alt+ArrowDown')
await win.waitForTimeout(300)
assert.deepEqual(await agents(), ['Lia', 'Nina', 'Theo'])
await win.keyboard.press('ArrowDown')
await win.waitForTimeout(200)
assert.deepEqual(await agents(), ['Lia', 'Nina', 'Theo'])
await shot('06-keyboard')

// Quadro taken out of the sidebar (right click), and the rest sorted: it stays out.
await row('.top-row', 'Quadro').click({ button: 'right' })
await win.locator('.menu__item', { hasText: 'Tirar da barra' }).click()
await win.waitForTimeout(400)
assert.deepEqual(await tops(), ['operations', 'knowledge', 'approvals'])
await carry(row('.top-row', 'Aprovações'), await center(row('.top-row', 'Operação')))
assert.deepEqual(await tops(), ['approvals', 'operations', 'knowledge'])
await row('.top-row', 'Conhecimento').locator('.nav-item').focus()
await win.keyboard.press('Alt+ArrowUp') // steps over where Quadro was
await win.waitForTimeout(300)
assert.deepEqual(await tops(), ['approvals', 'knowledge', 'operations'])
await shot('07-quadro-out')

// A quick click still opens a row.
await row('.channel-row', 'dados').locator('.nav-item').click()
await win.waitForTimeout(300)
assert.deepEqual(await active(), ['dados'])

// After a restart the order is the same, and Quadro is still out. Lia heads a sector now (Theo
// answers to her): the sectors and the agents in them move the same way.
await app.close()
const db = new DatabaseSync(join(data, 'tucano.db'))
const lia = db.prepare("SELECT id FROM agents WHERE name = 'Lia'").get().id
db.prepare("UPDATE agents SET sector_name = 'Pesquisa' WHERE id = ?").run(lia)
db.prepare("UPDATE agents SET reports_to = ? WHERE name = 'Theo'").run(lia)
db.close()
;({ app, win } = await open())
assert.deepEqual(await tops(), ['approvals', 'knowledge', 'operations'])
assert.deepEqual(await channels(), ['conteudo', 'dados', 'engenharia'])
assert.equal(await win.locator('.tucked__toggle').innerText(), '1 escondido')
const sectors = () => names('.agent-sector__head[data-order-id]')
assert.deepEqual(await sectors(), ['Pesquisa', 'Sem setor'])
assert.deepEqual(await agents(), ['Lia', 'Theo', 'Nina'])
await shot('08-after-restart')

// Channel groups: let go on a group's name, a channel goes last in it; under its last channel, too;
// on the line under the channels in no group, last among those.
await row('.channel-row', 'engenharia').click({ button: 'right' })
await win.locator('.menu__item', { hasText: 'Novo grupo com este canal' }).click()
await win.keyboard.press('Enter')
await win.waitForTimeout(300)
const inGroup = () => names('.channel-group .channel-row')
assert.deepEqual(await inGroup(), ['engenharia'])
await carry(row('.channel-row', 'conteudo'), await center(win.locator('.channel-group__head').first()), '08b-onto-a-group')
assert.deepEqual(await inGroup(), ['engenharia', 'conteudo'])
const end = await win.locator('.channel-group .channel-row').last().boundingBox()
await carry(row('.channel-row', 'dados'), { x: end.x + end.width / 2, y: end.y + end.height + 3 }, '08c-group-end')
assert.deepEqual(await inGroup(), ['engenharia', 'conteudo', 'dados'])
await carry(row('.channel-row', 'engenharia'), await center(win.locator('.channel-drop')), '08d-out-of-the-group')
assert.deepEqual(await channels(), ['engenharia', 'conteudo', 'dados'])
assert.deepEqual(await inGroup(), ['conteudo', 'dados'])
await carry(row('.agent-row', 'Theo'), await center(row('.agent-row', 'Lia')), '09-within-a-sector')
assert.deepEqual(await agents(), ['Theo', 'Lia', 'Nina'])
// Let go over another sector's agent: nothing moves.
await carry(row('.agent-row', 'Nina'), await center(row('.agent-row', 'Lia')))
assert.deepEqual(await agents(), ['Theo', 'Lia', 'Nina'])
await carry(row('.agent-sector__head', 'Sem setor'), await center(row('.agent-sector__head', 'Pesquisa')), '10-sector-carried')
assert.deepEqual(await sectors(), ['Sem setor', 'Pesquisa'])
assert.deepEqual(await agents(), ['Nina', 'Theo', 'Lia'])
await row('.agent-row', 'Theo').locator('.nav-item').focus()
await win.keyboard.press('Alt+ArrowDown')
await win.waitForTimeout(300)
assert.deepEqual(await agents(), ['Nina', 'Lia', 'Theo'])
await win.keyboard.press('Alt+ArrowDown') // last in its sector: stays
await win.waitForTimeout(300)
assert.deepEqual(await agents(), ['Nina', 'Lia', 'Theo'])
await shot('11-sectors-sorted')

// A mouse that starts dragging at once, without waiting the hold out first: the row lifts on the same
// hold and lands where it is let go. From 0.2.45 a press that moved cancelled the hold, so dragging a
// row did nothing at all and the sidebar read as something that cannot be sorted by hand.
const dragAtOnce = async (from, to) => {
  const a = await center(from)
  await win.mouse.move(a.x, a.y)
  await win.mouse.down()
  for (let i = 1; i <= 8; i += 1) {
    await win.mouse.move(a.x + ((to.x - a.x) * i) / 8, a.y + ((to.y - a.y) * i) / 8)
    await win.waitForTimeout(60)
  }
  await win.mouse.up()
  await win.waitForTimeout(400)
}
assert.deepEqual(await channels(), ['engenharia', 'conteudo', 'dados'])
await dragAtOnce(row('.channel-row', 'dados'), await center(row('.channel-row', 'engenharia')))
assert.deepEqual(await channels(), ['dados', 'engenharia', 'conteudo'])
await dragAtOnce(row('.agent-row', 'Theo'), await center(row('.agent-row', 'Lia')))
assert.deepEqual(await agents(), ['Nina', 'Theo', 'Lia'])
await shot('12-dragged-at-once')

assert.deepEqual(errors, [])
await app.close()
console.log(`ok: ${out}`)
