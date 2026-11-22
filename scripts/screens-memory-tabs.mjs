// Screenshots of the Memory page's tab strip when there are more bots than fit: it scrolls inside
// the bar, the tab picked comes to the middle, and the two borderless arrows page it (#396).
// Run after `npm run build`: node scripts/screens-memory-tabs.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens/memory-tabs'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en' }
const errors = []

async function open(width) {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.setViewportSize({ width, height: 820 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// 1. A first run, only to create the database file.
let { app, win } = await open(1280)
await win.waitForTimeout(800)
await app.close()

// 2. A note on every bot, so the strip has a tab for each one.
{
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const now = Date.now()
  const me = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get()
  // Six more bots than the seed makes: the strip is meant to hold a tab per bot, without a limit.
  const add = db.prepare(
    'INSERT OR IGNORE INTO agents (id, name, handle, role, color, instructions, model, effort, limit_tokens, grants, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const seeded = db.prepare('SELECT model, effort, limit_tokens FROM agents LIMIT 1').get()
  for (const [i, name] of ['Ada', 'Bram', 'Clio', 'Dora', 'Emil', 'Fern'].entries()) {
    add.run(`a-extra-${i}`, name, `extra${i}`, 'helper', '#8a8a8a', '', seeded.model, seeded.effort, seeded.limit_tokens, '{}', 0, now + i)
  }
  const agents = db.prepare('SELECT id, name FROM agents WHERE archived = 0 ORDER BY created_at').all()
  const put = db.prepare(
    'INSERT OR REPLACE INTO memories (id, scope, text, state, origin, agent_id, conversation_id, message_ids, replaces, reason, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  put.run('m-you', `person:${me.id}`, 'Prefers small pull requests.', 'active', 'you', null, null, '[]', null, null, now, now)
  for (const a of agents) put.run(`m-${a.id}`, a.id, `How ${a.name} works.`, 'active', 'agent', a.id, null, '[]', null, null, now, now)
  put.run('m-gone', `person:${me.id}`, 'An old preference, forgotten.', 'forgotten', 'you', null, null, '[]', null, null, now, now)
  db.close()
}

// 3. The bar at rest, narrow enough that the tabs cannot fit, then a tab picked from the far end.
;({ app, win } = await open(1280))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const state = () =>
  win.evaluate(() => {
    const strip = document.querySelector('.tabs-line__strip')
    const on = strip?.querySelector('button.is-on')
    const box = on?.getBoundingClientRect()
    const own = strip?.getBoundingClientRect()
    return {
      tabs: [...(strip?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
      overflow: strip ? strip.scrollWidth - strip.clientWidth : 0,
      scrollLeft: strip ? Math.round(strip.scrollLeft) : 0,
      arrows: [...document.querySelectorAll('.tabs-line__page')].map((b) => (b.classList.contains('tabs-line__page--back') ? 'back' : 'on')),
      // How far the chosen tab sits from the middle of the strip, in pixels.
      offCentre: box && own ? Math.round(box.left + box.width / 2 - (own.left + own.width / 2)) : null
    }
  })

await win.locator('.nav-item', { hasText: /Memory|Memória/ }).first().click()
await win.waitForSelector('.tabs-line')
// Narrow enough that the tabs cannot fit, which is the case the arrows are for.
await win.setViewportSize({ width: 560, height: 820 })
await win.waitForTimeout(950)
console.log('at rest:', JSON.stringify(await state()))
await shot('01-strip-overflowing')

const forward = win.locator('.tabs-line__page:not(.tabs-line__page--back)')
const back = win.locator('.tabs-line__page--back')

// The tabs past the right edge cannot be clicked at all until the strip moves, which is what the
// arrow is for: page along, then pick the bot that arrived.
if (await forward.count()) {
  await forward.click()
  await win.waitForTimeout(950)
  console.log('after the forward arrow:', JSON.stringify(await state()))
  await shot('02-paged-forward')
}

// A bot that came into view, picked: it should come back to the middle.
const reachable = await win.evaluate(() => {
  const strip = document.querySelector('.tabs-line__strip')
  const own = strip?.getBoundingClientRect()
  return [...(strip?.querySelectorAll('button') ?? [])]
    .filter((b) => {
      const box = b.getBoundingClientRect()
      return own && box.left >= own.left && box.right <= own.right && !['All', 'You', 'Forgotten'].includes(b.textContent.trim())
    })
    .map((b) => b.textContent.trim())
})
const picked = reachable.pop()
if (picked) {
  await win.locator('.tabs-line__strip > button', { hasText: new RegExp(`^${picked}$`) }).click()
  await win.waitForTimeout(950)
  console.log(`after picking ${JSON.stringify(picked)}:`, JSON.stringify(await state()))
  await shot('03-picked-tab-in-the-middle')
}

// Back again, from the arrow rather than from a tab.
if (await back.count()) {
  await back.click()
  await win.waitForTimeout(950)
  console.log('after the back arrow:', JSON.stringify(await state()))
  await shot('04-paged-back')
}

// The bar lives in a 720 px column, so widening the window does not widen the strip: the tabs of a
// workspace with this many bots always overflow it. Take the notes away and the strip fits, and then
// there is nothing to page and no arrow is offered.
await app.close()
{
  const db = new DatabaseSync(join(data, 'tucano.db'))
  db.prepare("DELETE FROM memories WHERE scope LIKE 'a-extra-%'").run()
  db.close()
}
;({ app, win } = await open(1280))
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.locator('.nav-item', { hasText: /Memory|Memória/ }).first().click()
await win.waitForSelector('.tabs-line')
await win.waitForTimeout(950)
console.log('a strip that fits:', JSON.stringify(await state()))
await shot('05-nothing-to-page')

console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none')
await app.close()
