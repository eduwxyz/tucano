// Shoots the team-up work for the PR: a channel an agent put together, its menu, the setting that
// closes it, a stale one closing itself at boot, and an agent looking the team up with `equipe`.
// Seeds a temp workspace (TUCANO_DATA) with fake engines: nothing touches the real database.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'C:/tmp/team-up-screens'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' }
const day = 86_400_000

const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 820 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// ---------- 1. make the workspace ----------
{
  const { app } = await launch()
  await app.close()
}

// ---------- 2. put two team-ups in it, one of them too old to stay ----------
const seeded = (() => {
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const now = Date.now()
  // The screens read as English, like Apo reads the app.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('language', ?)").run(JSON.stringify('en'))
  const agent = (h) => db.prepare('SELECT id, name, handle FROM agents WHERE handle = ?').get(h)
  const theo = agent('theo')
  const lia = agent('lia')
  const dados = db.prepare("SELECT id, name FROM conversations WHERE kind = 'channel' AND name IN ('data','dados')").get()
  // Two more agents, so the two team-ups are different rooms.
  const guests = db.prepare('SELECT id, name, handle FROM agents WHERE id != ? AND handle != ? ORDER BY handle LIMIT 2').all(theo.id, lia.handle)

  const addChannel = ({ id, name, topic, teamUp, members, capture = 0 }) => {
    db.prepare('INSERT INTO conversations (id, kind, name, topic, team_up, wiki_capture, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      'channel',
      name,
      topic,
      JSON.stringify(teamUp),
      capture,
      now
    )
    for (const m of new Map(members.map((a) => [a.id, a])).values())
      db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run(id, m.id)
  }
  const say = ({ id, conv, by, text, at, run }) =>
    db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      conv,
      by.kind ?? 'agent',
      by.id ?? null,
      text,
      at,
      run ? JSON.stringify(run) : null
    )

  // One an agent opened two days ago, with the work carried over and an answer in it.
  addChannel({
    id: 'tu-fresh',
    name: 'team-up-lia',
    topic: `Opened by ${theo.name}, from #${dados.name}`,
    teamUp: { from: dados.id, title: `#${dados.name}`, by: theo.id, at: now - 2 * day },
    members: [theo, lia]
  })
  say({
    id: 'tu-fresh-1',
    conv: 'tu-fresh',
    by: theo,
    at: now - 2 * day,
    text: `I brought over what was already done in #${dados.name} and called @lia.\n\n— what was said in #${dados.name} —\n\n**Ana** · O painel de vendas está somando duas vezes os pedidos cancelados.\n\n**${theo.name}** · Achei: o total soma as linhas canceladas e depois subtrai de novo, então elas contam duas vezes.\n\n**What's left to do**: conserta o total e confere se o mês fecha.`
  })
  say({
    id: 'tu-fresh-2',
    conv: 'tu-fresh',
    by: lia,
    at: now - 2 * day + 60_000,
    run: { status: 'done', steps: [{ id: 's1', label: 'Thought', status: 'done', ms: 2100 }], endedAt: now - 2 * day + 60_000 },
    text: 'Consertei: a soma agora ignora as linhas canceladas em vez de somar e subtrair. O mês fecha com o extrato. Deixei um teste no relatório pra não voltar.'
  })

  // One nobody came back to: ten days quiet, so it should be closed the moment the app opens.
  addChannel({
    id: 'tu-stale',
    name: 'team-up-auditor',
    topic: `Opened by ${theo.name}, from #${dados.name}`,
    teamUp: { from: dados.id, title: `#${dados.name}`, by: theo.id, at: now - 10 * day },
    members: [theo, guests[0]]
  })
  say({
    id: 'tu-stale-1',
    conv: 'tu-stale',
    by: theo,
    at: now - 10 * day,
    text: `I brought over what was already done in #${dados.name} and called @auditor.\n\n**What's left to do**: dá uma olhada no acesso ao banco.`
  })
  db.close()
  return { dados: dados.name, stale: 'team-up-auditor', fresh: 'team-up-lia' }
})()

// ---------- 3. look at it ----------
const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = async (name) => {
  await win.waitForTimeout(250)
  await win.screenshot({ path: `${out}/${name}.png` })
}
const navItem = (name) => win.locator(`.sidebar .nav-item:has-text("${name}")`).first()
const seen = []
const report = (what, value) => {
  seen.push(`${what}: ${value}`)
  console.log(`${what}: ${value}`)
}

await win.waitForTimeout(1200)

// The stale one closed itself on opening; the fresh one is still there.
report('stale team-up in the sidebar after opening', await win.locator('.sidebar .nav-item:has-text("team-up-auditor")').count())
report('fresh team-up in the sidebar', await win.locator('.sidebar .nav-item:has-text("team-up-lia")').count())
await shot('01-stale-closed-at-boot')

// The channel itself: the team-up tag, the topic line, the hand-off and the answer.
await navItem(seeded.fresh).click()
await win.waitForSelector('.msg')
await win.waitForTimeout(400)
report('top bar', (await win.locator('.topbar .tag, .topbar__topic').allInnerTexts()).join(' | ') || '(see frame)')
await shot('02-team-up-channel')

// Right-click: closing it by hand.
await navItem(seeded.fresh).click({ button: 'right' })
await win.waitForSelector('.menu, .ctx, [role="menu"]')
await win.waitForTimeout(200)
report('menu on a team-up', (await win.locator('.menu, .ctx, [role="menu"]').first().innerText()).replace(/\n+/g, ' / '))
await shot('03-close-menu')
await win.keyboard.press('Escape')

// An agent in a DM looking the team up: the real thing, through the core, with the fake engine.
// Lia's DM, through the app's own command palette (Ctrl+K lists a DM for every agent).
const hasDm = 1
report('Lia in the sidebar', hasDm)
if (hasDm) {
  await win.keyboard.press('Control+k')
  await win.waitForTimeout(400)
  const search = win.locator('.dialog input, .search input, [role="dialog"] input').first()
  await search.fill('Lia')
  await win.waitForTimeout(500)
  await win
    .locator('.dialog button, [role="dialog"] button, .hit, li')
    .filter({ hasText: /conversation|conversa/ })
    .first()
    .click()
  await win.waitForSelector('.composer textarea, .composer input')
  await win.waitForTimeout(900)
  report('conversation opened', await win.locator('.topbar h1, .topbar__name').first().innerText().catch(() => '(none)'))
  await win.locator('.composer textarea, .composer input').first().fill('quem e o time')
  await win.locator('.composer textarea, .composer input').first().press('Enter')
  await win.waitForTimeout(800)
  report('what was sent', (await win.locator('.msg').allInnerTexts()).filter((t) => /time|team/i.test(t)).join(' / ').slice(0, 200))
  // Long enough for the reply to finish: a frame of "Thinking…" proves nothing.
  await win.waitForTimeout(9000)
  const steps = (await win.locator('.msg .step__label').allInnerTexts()).join(' | ')
  report('steps on the reply', steps)
  report('reply text starts', (await win.locator('.msg').last().innerText()).slice(0, 160).replace(/\n+/g, ' / '))
  await shot('04-equipe-tool')
}

// Settings › Agents: the days, and the wording that says what closing means.
await win.keyboard.press('Escape')
// Ctrl+, is the app's own shortcut to Settings (App.tsx), then the tab the card is on.
await win.keyboard.press('Control+,')
await win.waitForTimeout(900)
const agentsTab = win.locator('[role="tab"]:has-text("Agents"), [role="tab"]:has-text("Agentes")').first()
report('Agents tab', await agentsTab.count())
if (await agentsTab.count()) await agentsTab.click()
await win.waitForTimeout(600)
const card = win.locator('.card:has-text("Team-ups agents put together")').first()
report('setting card present', await card.count())
if (await card.count()) {
  await card.scrollIntoViewIfNeeded()
  await win.waitForTimeout(300)
  const field = card.locator('.field:has-text("Close on its own after")').first()
  report('days field value', await field.locator('input').inputValue().catch(() => '(no input)'))
  await shot('05-settings-days')
  // 3 days, then back to 7: the value has to survive a round trip through the database, not just render.
  await field.locator('input').fill('3')
  await field.locator('input').blur()
  await win.waitForTimeout(600)
  await win.reload()
  await win.waitForSelector('.sidebar')
  await win.waitForTimeout(1200)
  report('fresh team-up after reload', await win.locator('.sidebar .nav-item:has-text("team-up-lia")').count())
  await win.keyboard.press('Control+,')
  await win.waitForTimeout(900)
  await win.locator('[role="tab"]:has-text("Agents"), [role="tab"]:has-text("Agentes")').first().click()
  await win.waitForTimeout(600)
  const again = win.locator('.card:has-text("Team-ups agents put together")').first()
  await again.scrollIntoViewIfNeeded()
  await win.waitForTimeout(300)
  report('days value after reload', await again.locator('.field:has-text("Close on its own after") input').first().inputValue().catch(() => '(no input)'))
  await shot('06-settings-days-saved')
  // Back to a week, so the frames and the database agree on what the default is.
  await again.locator('.field:has-text("Close on its own after") input').first().fill('7')
  await again.locator('.field:has-text("Close on its own after") input').first().blur()
  await win.waitForTimeout(500)
}

report('page errors', errors.length ? errors.join(' ;; ') : 'none')
await app.close()
console.log(`\nframes in ${out}`)
