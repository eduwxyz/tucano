// Frames for the wiki hand-off: a missing page offers an agent with write access (#255 / PR #258),
// and the agent's Tools tab offers the same "Read and write" access as PR #355.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'C:/tmp/frames/258'
const mode = process.argv[3] ?? 'missing' // missing (258) | orphan (259)
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }

const launch = async () => {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'electron')}`], env, ...(process.env.TUCANO_ELECTRON ? { executablePath: process.env.TUCANO_ELECTRON } : {}) })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// 1. seed the workspace
{
  const { app } = await launch()
  await app.close()
}

// 2. give two agents write access, and put the finding in the wiki
{
  const db = new DatabaseSync(join(data, 'tucano.db'))
  db.prepare("UPDATE agents SET wiki = 'read_write' WHERE handle IN ('lia', 'theo')").run()
  db.close()
}

const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => {
  await win.waitForTimeout(350)
  await win.screenshot({ path: `${out}/${name}.png` })
}

// 3. open the wiki once so wiki.db exists
await win.locator('.nav-item:has-text("Wiki")').first().click()
await win.waitForSelector('.wk-stage')
await win.waitForTimeout(600)
await app.close()

// 4. write the finding
{
  const wiki = join(data, 'wiki.db')
  console.log('wiki.db exists:', existsSync(wiki))
  const db = new DatabaseSync(wiki)
  const pages = ['Campaign agent Keeper', 'Designer interface agent', 'Engineer full-stack agent', 'Herald LinkedIn agent', 'Founder Foundry agent']
  const at = Date.now()
  if (mode === 'missing')
    db.prepare("INSERT INTO findings (id, key, at, kind, pages, text, name, change_id, state) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'open')").run(
      'f-missing',
      'missing:On Nov',
      at,
      'missing',
      JSON.stringify(pages),
      `**On Nov** shows up in ${pages.slice(0, 3).join(', ')} and 2 more, and has no page.`,
      'On Nov'
    )
  else
    db.prepare("INSERT INTO findings (id, key, at, kind, pages, text, name, change_id, state) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'open')").run(
      'f-orphan',
      'orphan:On Nov|Founder Foundry agent',
      at,
      'orphan',
      JSON.stringify(['On Nov', 'Founder Foundry agent', 'OpenLibExtended']),
      'No page links to **On Nov**, **Founder Foundry agent**, **OpenLibExtended**. They are only found by searching.'
    )
  db.close()
}

// 5. look at it
const again = await launch()
const w = again.win
w.on('pageerror', (e) => errors.push(String(e)))
w.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot2 = async (name) => {
  await w.waitForTimeout(400)
  await w.screenshot({ path: `${out}/${name}.png` })
}

await w.locator('.nav-item:has-text("Wiki")').first().click()
await w.waitForSelector('.wk-stage')
await w.waitForTimeout(500)
await w.locator('.wk-foot button:has-text("Review the wiki")').click()
await w.waitForSelector('.wk-finding', { timeout: 10000 }).catch(() => {})
console.log('findings on screen:', await w.locator('.wk-finding').count())
console.log('pane text:', (await w.locator('.wk-pane').count()) ? (await w.locator('.wk-pane').innerText()).slice(0, 700) : 'NO PANE')
{
  const db = new DatabaseSync(join(data, 'wiki.db'))
  console.log('open findings in db:', JSON.stringify(db.prepare("SELECT kind, state, name FROM findings").all()))
  db.close()
}
await shot2(mode === 'missing' ? '01-finding' : '01-orphan-finding')

// the picker, open, so the reader sees who can be chosen
const trigger = w.locator('.wk-finding__actions .select__trigger').first()
if (await trigger.count()) {
  await trigger.click()
  await w.waitForSelector('.select__menu')
  await shot2(mode === 'missing' ? '02-picker-open' : '02-orphan-picker-open')
  const opt = w.locator('.select__menu .select__option').nth(1)
  if (await opt.count()) await opt.click()
  await w.waitForTimeout(200)
}
await shot2(mode === 'missing' ? '03-picked' : '03-orphan-picked')

// Nothing overflows the panel, and the row of actions fits on one line.
const layout = await w.evaluate(() => {
  const r = (s) => document.querySelector(s)
  const out = {}
  for (const s of ['.wk-panel', '.wk-finding__actions', '.select__trigger']) {
    const el = r(s)
    if (el) out[s] = { w: Math.round(el.getBoundingClientRect().width), scroll: el.scrollWidth, over: el.scrollWidth > el.clientWidth + 1 }
  }
  const acts = r('.wk-finding__actions')
  if (acts) out.actionTops = [...acts.children].map((c) => Math.round(c.getBoundingClientRect().top))
  out.bodyOverflow = document.body.scrollWidth > window.innerWidth
  return out
})
console.log('layout:', JSON.stringify(layout))

// click the action: it must reach the agent
const action = w.locator(`.wk-finding__actions button:has-text("${mode === 'missing' ? 'Write the page' : 'Link the pages'}")`).first()
if (await action.count()) {
  await action.click()
  await w.waitForTimeout(1800)
  const msgs = await w.locator('.messages').innerText().catch(() => 'NO MESSAGES')
  console.log('after the click:', msgs.slice(0, 500).replace(/\n+/g, ' | '))
  await shot2(mode === 'missing' ? '04-dm-handoff' : '04-dm-orphan-handoff')
}



// The agent's own settings, rather than her DM.
await w.locator('.nav-item', { has: w.locator('.nav-item__role') }).filter({ hasText: 'Lia' }).first().click()
await w.waitForTimeout(600)
await w.locator('.tabs button[role="tab"]:has-text("Tools")').first().click()
await w.waitForTimeout(500)
const card = w.locator('.card:has-text("Read and write")').first()
if (await card.count()) {
  await card.scrollIntoViewIfNeeded()
  await w.waitForTimeout(300)
  console.log('wiki card text:', (await card.innerText()).split('\n').filter(Boolean).join(' | ').slice(0, 400))
  await shot2('05-agent-writes-the-wiki')
} else console.log('NO WIKI CARD')

console.log('errors:', JSON.stringify(errors, null, 1))
await again.app.close()
rmSync(data, { recursive: true, force: true })
