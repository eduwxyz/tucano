// Screenshots of work handed down the tree (src/shared/org.ts): Theo and Nina answer to Lia, I ask
// Lia in her DM, she hands each their part, the answers come back and she closes it. Fresh data,
// fake engines. Run after `npm run build`: node scripts/screens-org.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/org'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// The first start makes the seed's team; then the tree is set the way the agent's page would.
const first = await launch()
// Before anyone answers to anyone: every agent on the board, and a word on what it is for.
await first.win.click('.nav-item:has-text("Time")')
await first.win.waitForSelector('.org-coach')
await first.win.waitForTimeout(900)
await first.win.screenshot({ path: `${out}/00-organogram-start.png` })
await first.app.close()
const db = join(data, 'tucano.db')
const more = [
  ['vera', 'Vera', 'Revisão', 'theo', 'engenharia'],
  ['quim', 'Quim', 'Testes', 'theo', 'engenharia'],
  ['caio', 'Caio', 'Posts', 'nina', 'conteudo'],
  ['duda', 'Duda', 'Finanças', null, null]
]
execFileSync('sqlite3', [
  db,
  [
    "UPDATE agents SET reports_to = (SELECT id FROM agents WHERE handle = 'lia') WHERE handle IN ('theo', 'nina')",
    ...more.flatMap(([handle, name, role, boss, channel]) => [
      'DROP TABLE IF EXISTS one',
      "CREATE TEMP TABLE one AS SELECT * FROM agents WHERE handle = 'nina'",
      `UPDATE one SET id = 'x-${handle}', handle = '${handle}', name = '${name}', role = '${role}', reports_to = ${boss ? `(SELECT id FROM agents WHERE handle = '${boss}')` : 'NULL'}, created_at = created_at + 1`,
      'INSERT INTO agents SELECT * FROM one',
      ...(channel ? [`INSERT INTO members (conversation_id, agent_id) SELECT id, 'x-${handle}' FROM conversations WHERE name = '${channel}'`] : [])
    ])
  ].join('; ')
])

const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle() {
  const deadline = Date.now() + 40_000
  let quiet = 0
  while (Date.now() < deadline && quiet < 4) {
    await win.waitForTimeout(500)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}

// The card on an agent's page.
await win.click('.section:has-text("Agentes") .nav-item:has-text("Theo")')
await win.click('[role="tab"]:has-text("Canais e skills")')
await win.waitForTimeout(300)
await shot('01-agent-page-team')

// I ask Lia; she hands a part to each.
await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
await win.click('button:has-text("Abrir DM")')
await win.waitForSelector('.composer textarea')
await win.fill('.composer textarea', 'delegue a theo em #dados: veja por que a conversão caiu ontem\ndelegue a nina: escreva o post do lançamento')
await win.keyboard.press('Enter')
await settle()
await shot('02-dm-asked-and-back')

// One of the requests, in its own channel.
await win.locator('.delegation-chip button:has-text("Abrir a thread")').first().click()
await win.waitForTimeout(600)
await shot('03-thread-in-channel')

// The organogram: at rest, an agent picked, a line pulled from one card to another, a card moved.
const mid = async (sel) => {
  const b = await win.locator(sel).boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
await win.click('.nav-item:has-text("Time")')
await win.waitForSelector('.orgb .org-card')
await win.waitForTimeout(900)
await shot('04-organogram')
await win.locator('.orgb .org-card:has-text("Theo")').click()
await win.waitForSelector('.org-side')
await win.waitForTimeout(400)
await shot('05-organogram-details')
await win.keyboard.press('Escape')
// Lia's dot, pulled onto Duda: Duda answers to Lia from then on.
await win.locator('.orgb .org-card:has-text("Lia")').hover()
const from = await mid('.orgb .org-card:has-text("Lia") .org-port--out')
const to = await mid('.orgb .org-card:has-text("Duda")')
await win.mouse.move(from.x, from.y)
await win.mouse.down()
await win.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
await win.mouse.move(to.x, to.y, { steps: 6 })
await win.waitForTimeout(200)
await shot('06-organogram-pulling-a-line')
await win.mouse.up()
await win.waitForTimeout(900)
await shot('06b-organogram-after-link')
console.log('lines after the link (7: six agents answer to someone, and me to Lia):', await win.locator('.orgb__lines g').count())
// A card moved by hand takes its branch along and stays there.
const theo = await mid('.orgb .org-card:has-text("Theo")')
await win.mouse.move(theo.x, theo.y)
await win.mouse.down()
await win.mouse.move(theo.x - 60, theo.y + 40, { steps: 8 })
await win.mouse.up()
await win.waitForTimeout(500)
await shot('06c-organogram-after-move')
console.log('"Organizar" is offered once something was placed by hand:', (await win.locator('.org-tidy').count()) === 1)
await win.click('.org-tidy')
await win.waitForTimeout(600)

// Work under way: asked from the board itself, watched on it.
await win.fill('.org-ask input', 'delegue a vera: demore 9 s\ndelegue a caio: demore 9 s')
await win.keyboard.press('Enter')
await win.waitForSelector('.orgb__lines .is-flow', { timeout: 20_000 })
await win.waitForTimeout(700)
await shot('07-organogram-under-way')
await win.emulateMedia({ colorScheme: 'dark' })
await win.waitForTimeout(400)
await shot('08-organogram-dark')
await win.emulateMedia({ colorScheme: 'light' })
await settle()

console.log('chips on screen:', await win.locator('.delegation-chip').count())
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors')
await app.close()
