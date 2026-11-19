// Screenshots of the Memory page's "You" tab: the label that used to read
// "About you" and wrapped to two lines once the tab strip got crowded.
// Run after `npm run build`: node scripts/screens-memory-you.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens/memory-you'
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

// 2. Your own memory plus a note on each agent, and one forgotten: a strip with a tab per agent.
{
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const now = Date.now()
  const me = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get()
  const agents = db.prepare('SELECT id, name FROM agents ORDER BY created_at LIMIT 3').all()
  const put = db.prepare(
    'INSERT OR REPLACE INTO memories (id, scope, text, state, origin, agent_id, conversation_id, message_ids, replaces, reason, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  put.run('m-you', `person:${me.id}`, 'Prefers small pull requests.', 'active', 'you', null, null, '[]', null, null, now, now)
  for (const a of agents) put.run(`m-${a.id}`, a.id, `How ${a.name} works.`, 'active', 'agent', a.id, null, '[]', null, null, now, now)
  put.run('m-gone', `person:${me.id}`, 'An old preference, forgotten.', 'forgotten', 'you', null, null, '[]', null, null, now, now)
  db.close()
}

// 3. Back up, on the Memory page, and measure the tab that carried the old name.
;({ app, win } = await open(1280))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

const measure = (label) =>
  win.evaluate((wanted) => {
    const buttons = [...document.querySelectorAll('.tabs-line__strip > button')]
    const b = buttons.find((x) => x.textContent.trim() === wanted)
    if (!b) return { found: false, labels: buttons.map((x) => x.textContent.trim()) }
    const range = document.createRange()
    range.selectNodeContents(b)
    const rects = [...range.getClientRects()]
    const tops = new Set(rects.map((r) => Math.round(r.top)))
    const row = document.querySelector('.tabs-line')
    return {
      found: true,
      label: b.textContent.trim(),
      lines: tops.size,
      buttonW: Math.round(b.getBoundingClientRect().width),
      buttonH: Math.round(b.getBoundingClientRect().height),
      rowH: Math.round(row.getBoundingClientRect().height),
      rowOverflow: row.scrollWidth - row.clientWidth,
      labels: buttons.map((x) => x.textContent.trim())
    }
  }, label)

await win.locator('.nav-item', { hasText: /Memory|Memória/ }).first().click()
await win.waitForSelector('.tabs-line')
await win.waitForTimeout(400)

const tabLabel = process.env.TAB_LABEL ?? 'You'
console.log('tabs:', JSON.stringify((await measure(tabLabel)).labels))
console.log('tab at 1280:', JSON.stringify(await measure(tabLabel)))
await shot('01-memory-tabs-1280')

// The tab itself, and the group heading inside it (both carried the old name).
await win.locator('.tabs-line__strip > button', { hasText: new RegExp(`^${tabLabel}$`) }).click()
await win.waitForTimeout(300)
const heading = await win.evaluate(() => document.querySelector('.read-group h2')?.textContent.trim() ?? null)
console.log('group heading:', JSON.stringify(heading))
await shot('02-you-tab-with-a-memory')

// Narrow window: this is where a two-word label had no room left.
await win.setViewportSize({ width: 420, height: 820 })
await win.waitForTimeout(500)
console.log('tab at 420:', JSON.stringify(await measure(tabLabel)))
await shot('03-memory-tabs-420')

console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none')
await app.close()
