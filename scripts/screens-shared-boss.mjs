// Screenshots of one agent answering to more than one boss (src/shared/org.ts bossesOf): four campaigns,
// each with its bot, and one artist the four of them share. Fresh data, fake engines. Proves the three ways
// an extra boss is made — the dot beside the one above a card, a line pulled from under a boss and let go on
// that dot, and the field in its panel — that every one of those lines lands on its own point of the card's
// top edge instead of on the same one, and that the field names every boss instead of counting them.
// Run after `npm run build`: node scripts/screens-shared-boss.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens/shared-boss'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const launch = async (width) => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width, height: 860 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// The first start makes the seed's team; then the tree, two more campaigns and the shared artist are set
// the way a page would, and the extra bosses are left for the board to make.
const first = await launch(1280)
await first.app.close()
const db = new DatabaseSync(join(data, 'tucano.db'))
const row = (handle) => db.prepare('SELECT * FROM agents WHERE handle = ?').get(handle)
const id = (handle) => row(handle).id
const exec = (q, ...args) => db.prepare(q).run(...args)
const col = (handle, name) => db.prepare(`SELECT ${name} AS v FROM agents WHERE handle = ?`).get(handle)?.v
// A copy of an agent under another name: another campaign's bot, the same way the app makes one.
const clone = (from, handle, name, role) => {
  const cols = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name)
  const src = row(from)
  const values = { ...src, id: `${src.id}-${handle}`, handle, name, role }
  db.prepare(`INSERT INTO agents (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => values[c]))
}
exec('UPDATE agents SET reports_to = ? WHERE handle = ?', id('theo'), 'nina')
clone('nina', 'ada', 'Ada', 'Campanha C')
clone('nina', 'bia', 'Bia', 'Campanha D')
for (const handle of ['ada', 'bia']) exec('UPDATE agents SET reports_to = ?, role = ? WHERE handle = ?', id('theo'), handle === 'ada' ? 'Campanha C' : 'Campanha D', handle)
exec('UPDATE agents SET reports_to = ? WHERE handle = ?', id('theo'), 'lia') // the artist hangs under the first campaign
exec('UPDATE agents SET role = ? WHERE handle = ?', 'Campanha A', 'theo')
exec('UPDATE agents SET role = ? WHERE handle = ?', 'Campanha B', 'nina')
exec('UPDATE agents SET role = ? WHERE handle = ?', 'Arte das quatro campanhas', 'lia')

const { app, win } = await launch(1280)
await win.click('.nav-item:has-text("Time")')
await win.waitForSelector('.orgb')
await win.waitForTimeout(900)

// The two dots above each card: where each sits, and how far apart they are — they never overlap.
const ports = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('.org-card')].flatMap((c) => {
      const name = c.querySelector('strong')?.textContent
      const dots = [...c.querySelectorAll('.org-port--in, .org-port--also')].map((d) => {
        const r = d.getBoundingClientRect()
        return { which: d.className.includes('--also') ? 'also' : 'in', x: Math.round(r.left + r.width / 2), top: Math.round(r.top) }
      })
      if (!dots.length) return []
      const xs = dots.map((d) => d.x).sort((a, b) => a - b)
      return [{ card: name, dots: dots.map((d) => `${d.which}@${d.x}`), apart: xs.length > 1 ? xs.slice(1).map((x, i) => x - xs[i]) : [] }]
    })
  )
// Where every boss's line lands on the shared card's own top edge: one point each, never the same one twice.
const landings = () =>
  win.evaluate(() => {
    const card = [...document.querySelectorAll('.org-card')].find((c) => c.querySelector('strong')?.textContent === 'Lia')
    const box = card.getBoundingClientRect()
    const ends = [...document.querySelectorAll('.orgb__lines g')].map((g) => {
      const path = g.querySelector('.orgb__line')
      const end = path.getPointAtLength(path.getTotalLength())
      const toScreen = new DOMPoint(end.x, end.y).matrixTransform(path.getScreenCTM())
      return { x: Math.round(toScreen.x), y: Math.round(toScreen.y), extra: g.classList.contains('is-also') }
    })
    // Only the ones that land on this card's own top edge, not on a neighbour's on the same row.
    const onTop = ends
      .filter((e) => Math.abs(e.y - box.top) <= 2 && e.x >= box.left - 2 && e.x <= box.right + 2)
      .map((e) => e.x)
      .sort((a, b) => a - b)
    const also = card.querySelector('.org-port--also')
    const dot = also ? Math.round(also.getBoundingClientRect().left + also.getBoundingClientRect().width / 2) : null
    return {
      card: Math.round(box.left),
      landings: onTop,
      distinct: new Set(onTop).size,
      apart: onTop.slice(1).map((x, i) => x - onTop[i]),
      nextDot: dot,
      nextClear: dot === null ? null : Math.min(...onTop.map((x) => Math.abs(x - dot)))
    }
  })
// What the board drew: one line per link, which of them are the extras, and how an extra one is drawn.
const drawn = () =>
  win.evaluate(() => ({
    lines: document.querySelectorAll('.orgb__lines g').length,
    extra: document.querySelectorAll('.orgb__lines g.is-also').length,
    cards: document.querySelectorAll('.org-card').length,
    extraDash: (() => { const l = document.querySelector('.orgb__lines g.is-also .orgb__line'); return l ? getComputedStyle(l).strokeDasharray : null })(),
    pickable: document.querySelectorAll('.orgb__hit').length,
    panel: [...document.querySelectorAll('.org-side .field__label')].some((l) => l.textContent?.startsWith('Também responde'))
  }))
// The field that names every boss it answers to: what it holds, whether it folds them into a count, and how
// tall it grew to hold them.
// The field's own trigger, found by its label: the panel has more than one select, and the first in the
// document is not always this one.
const field = () =>
  win.evaluate(() => {
    const label = [...document.querySelectorAll('.org-side label.field')].find((l) => l.querySelector('.field__label')?.textContent?.startsWith('Também responde'))
    const el = label?.querySelector('.select__trigger')
    if (!el) return null
    const value = el.querySelector('.select__trigger__value')
    const r = el.getBoundingClientRect()
    return {
      chips: [...el.querySelectorAll('.select__chip')].map((c) => c.textContent),
      folds: (value?.textContent ?? '').includes('selecionados'),
      wrapped: el.className.includes('is-wrapped') && !!value?.className.includes('is-wrap'),
      height: Math.round(r.height),
      valueLines: [...(value?.querySelectorAll('.select__chip') ?? [])].map((c) => Math.round(c.getBoundingClientRect().top))
    }
  })
// Pulling a line from a card's dot and letting it go: on another card, or on the dot beside the one above
// another card, as the board listens for it.
const pull = (from, side, onto, where = 'card') =>
  win.evaluate(
    ([from, side, onto, where]) => {
      const cardOf = (name) => [...document.querySelectorAll('.org-card')].find((c) => c.querySelector('strong')?.textContent === name)
      const port = cardOf(from).querySelector(`.org-port--${side}`)
      const r = port.getBoundingClientRect()
      const at = { bubbles: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
      port.dispatchEvent(new PointerEvent('pointerdown', at))
      const onto_ = where === 'dot' ? cardOf(onto).querySelector('.org-port--also') : cardOf(onto)
      const to = onto_.getBoundingClientRect()
      const there = { ...at, clientX: to.left + to.width / 2, clientY: to.top + to.height / 2 }
      onto_.dispatchEvent(new PointerEvent('pointerover', there))
      onto_.dispatchEvent(new PointerEvent('pointerenter', there))
      document.dispatchEvent(new PointerEvent('pointerup', there))
    },
    [from, side, onto, where]
  )
const pick = async (name) => {
  await win.evaluate((name) => {
    const el = [...document.querySelectorAll('.org-card')].find((c) => c.querySelector('strong')?.textContent === name)
    const at = { bubbles: true, button: 0, clientX: 10, clientY: 10 }
    el.dispatchEvent(new PointerEvent('pointerdown', at))
    document.dispatchEvent(new PointerEvent('pointerup', at))
  }, name)
  await win.waitForSelector('.org-side .org-pop__boss .select__trigger', { timeout: 10_000 })
  await win.waitForTimeout(400)
}
// Ticking one more in the field's own list, with the mouse: the trigger, then the option.
// Ticking one more in the field's own list: the trigger, then the option, both clicked as the DOM has them.
// (A real mouse click on the option lands wide while the side sheet is still settling, and the board under it
// takes the press and closes the panel.)
const tick = async (name) => {
  const opened = await win.evaluate(() => {
    const label = [...document.querySelectorAll('.org-side label.field')].find((l) => l.querySelector('.field__label')?.textContent?.startsWith('Também responde'))
    label?.querySelector('.select__trigger')?.click()
    return !!label
  })
  if (!opened) throw new Error('the field is not in the panel')
  await win.waitForSelector('.select__menu .select__option')
  const picked = await win.evaluate((name) => {
    const opt = [...document.querySelectorAll('.select__menu .select__option')].find((o) => o.textContent?.includes(name))
    opt?.click()
    return !!opt
  }, name)
  if (!picked) throw new Error(`no option ${name}`)
  await win.waitForTimeout(500)
}

await win.screenshot({ path: `${out}/1280-board.png` })
console.log('1280 ports', JSON.stringify(await ports()))
console.log('1280 board', JSON.stringify(await drawn()))
console.log('1280 dangling', JSON.stringify({ also: col('lia', 'also_to') }))

// The dot beside the one above the artist's card, pulled onto the second campaign: one more boss.
await pull('Lia', 'also', 'Nina')
await win.waitForTimeout(700)
console.log('1280 pulled', JSON.stringify({ also: col('lia', 'also_to'), nina: id('nina'), dashed: (await drawn()).extraDash }))
console.log('1280 board after the pull', JSON.stringify(await drawn()))
console.log('1280 after one extra', JSON.stringify(await landings()))
await win.screenshot({ path: `${out}/1280-extras.png` })

// The other way round: from under a boss onto the dot beside the one above the artist's card.
await pull('Ada', 'out', 'Lia', 'dot')
await win.waitForTimeout(700)
console.log('1280 from above', JSON.stringify({ also: col('lia', 'also_to'), ada: id('ada'), reportsTo: col('lia', 'reports_to') }))
console.log('1280 three bosses', JSON.stringify(await landings()))
await win.screenshot({ path: `${out}/1280-from-above.png` })

// The field in its panel: one more boss ticked there, every one of them named in the field.
await pick('Lia')
await tick('Bia')
await win.waitForTimeout(300)
console.log('1280 field', JSON.stringify(await field()))
console.log('1280 field, stored', JSON.stringify({ also: col('lia', 'also_to') }))
console.log('1280 panel', JSON.stringify(await drawn()))
console.log('1280 four bosses', JSON.stringify(await landings()))
console.log('1280 four bosses, ports', JSON.stringify(await ports()))
await win.screenshot({ path: `${out}/1280-panel.png` })
await win.keyboard.press('Escape')
await win.waitForTimeout(400)

await win.setViewportSize({ width: 420, height: 860 })
await win.waitForTimeout(700)
// A resize can close the panel, so it is opened again here: the shot below has to be the panel itself, not the
// board it was closed back to.
if (!(await win.$('.org-side .org-pop__boss'))) await pick('Lia')
await win.waitForTimeout(300)
console.log('420 field', JSON.stringify(await field()))
console.log('420 panel', JSON.stringify(await drawn()))
console.log('420 four bosses', JSON.stringify(await landings()))
await win.screenshot({ path: `${out}/420-panel.png` })
await win.keyboard.press('Escape')
await win.waitForTimeout(400)
console.log('420 board', JSON.stringify(await drawn()))
await win.screenshot({ path: `${out}/420-board.png` })
await app.close()
console.log('done', out)
