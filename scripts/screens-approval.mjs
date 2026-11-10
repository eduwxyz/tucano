// Screenshots of the approval card (issue #252, direction A): the action and its target first, the
// status a quiet row, decisions one line at the bottom, and the reminder over the field that counts
// the requests still waiting. A seeded workspace, approvals written straight into its database, no
// model called: what's shot is the app drawing the card, in every state it can be in.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2]
if (!out) throw new Error('usage: node scripts/screens-approval.mjs <out-dir>')
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-approval-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1' }

// 1. A workspace the app makes itself: demo team, three channels.
const seed = await electron.launch({ args: ['.'], env })
const w = await seed.firstWindow()
await w.waitForSelector('.sidebar', { timeout: 60_000 })
await w.waitForTimeout(1200)
await seed.close()

// 2. The approvals, written where the app reads them.
const db = new DatabaseSync(join(data, 'tucano.db'))
const agent = db.prepare('SELECT id FROM agents ORDER BY rowid LIMIT 1').get()
const owner = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get()
const chan = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' ORDER BY rowid LIMIT 1").get()
const now = Date.now()
const hour = 3_600_000

const say = (id, text, run, at) =>
  db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, chan.id, 'agent', agent.id, text, at, run ? JSON.stringify(run) : null)

const approve = (a, at, expires = now + hour) =>
  db
    .prepare(
      `INSERT INTO approvals (id, hash, agent_id, conversation_id, message_id, connector_id, connector_name, tool, args, why, high_risk, state, created_at, expires_at, requested_by, decided_by, decided_at, reason, outcome, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      a.id,
      'h-' + a.id,
      agent.id,
      chan.id,
      a.messageId,
      a.connectorId,
      a.connectorName,
      a.tool,
      JSON.stringify(a.args),
      a.why,
      a.highRisk ? 1 : 0,
      a.state,
      at,
      expires,
      owner.id,
      a.decidedBy ?? null,
      a.decidedAt ?? null,
      a.reason ?? null,
      a.outcome ?? null,
      a.result ?? null
    )

// The safe one, still waiting: an action and a target, nothing to open.
say('m-merge', 'Encontrei a PR verde. Posso fazer o merge?', { status: 'waiting_approval', steps: [], approvalId: 'ap-merge', endedAt: now - hour }, now - hour)
approve(
  {
    id: 'ap-merge',
    messageId: 'm-merge',
    connectorId: 'github',
    connectorName: 'GitHub',
    tool: 'merge_pull_request',
    args: { repo: 'eduwxyz/tucano', number: 268 },
    why: 'This merges the pull request into main.',
    state: 'pending'
  },
  now - hour
)

// The high-risk one: the exact call open from the start, and a hold instead of a click.
say('m-cmd', 'Vou limpar a saída do build antes de empacotar.', { status: 'waiting_approval', steps: [], approvalId: 'ap-cmd', endedAt: now - 40 * 60_000 }, now - 40 * 60_000)
approve(
  {
    id: 'ap-cmd',
    messageId: 'm-cmd',
    connectorId: 'computador',
    connectorName: 'Computador da Lia',
    tool: 'bash',
    args: { command: 'rm -rf out && npm run build' },
    why: 'This deletes the build output and builds it again.',
    highRisk: true,
    state: 'pending'
  },
  now - 40 * 60_000
)

// Decided, and what became of it afterwards.
say('m-wait', 'Feito: a PR está aberta. Deixei o comentário do revisor junto.', { status: 'done', steps: [], approvalId: 'ap-wait', endedAt: now - 30 * 60_000 }, now - 30 * 60_000)
approve(
  {
    id: 'ap-wait',
    messageId: 'm-wait',
    connectorId: 'github',
    connectorName: 'GitHub',
    tool: 'create_pull_request',
    args: { repo: 'eduwxyz/tucano', title: 'Quotas: the longest window in the session header' },
    why: 'This opens a pull request against main.',
    state: 'approved',
    decidedBy: owner.id,
    decidedAt: now - 29 * 60_000
  },
  now - 30 * 60_000
)

say('m-done', 'Apaguei a tarefa Demo task.', { status: 'done', steps: [], approvalId: 'ap-done', endedAt: now - 20 * 60_000 }, now - 20 * 60_000)
approve(
  {
    id: 'ap-done',
    messageId: 'm-done',
    connectorId: 'tasks',
    connectorName: 'Tasks',
    tool: 'delete_task',
    args: { title: 'Demo task', id: 2 },
    why: 'This deletes the selected task.',
    state: 'approved',
    decidedBy: owner.id,
    decidedAt: now - 21 * 60_000,
    outcome: 'Ran.',
    result: 'done'
  },
  now - 22 * 60_000
)

say('m-fail', 'Tentei apagar a tarefa, mas a chamada voltou com erro.', { status: 'done', steps: [], approvalId: 'ap-fail', endedAt: now - 10 * 60_000 }, now - 10 * 60_000)
approve(
  {
    id: 'ap-fail',
    messageId: 'm-fail',
    connectorId: 'tasks',
    connectorName: 'Tasks',
    tool: 'delete_task',
    args: { title: 'Demo task', id: 2 },
    why: 'This deletes the selected task.',
    state: 'approved',
    decidedBy: owner.id,
    decidedAt: now - 11 * 60_000,
    outcome: 'Ran, with an error: 401 Unauthorized.',
    result: 'error'
  },
  now - 12 * 60_000
)

say('m-refused', 'Certo, não envio então.', { status: 'done', steps: [], approvalId: 'ap-refused', endedAt: now - 5 * 60_000 }, now - 5 * 60_000)
approve(
  {
    id: 'ap-refused',
    messageId: 'm-refused',
    connectorId: 'gmail',
    connectorName: 'Gmail',
    tool: 'send_email',
    args: { to: 'cliente@exemplo.com', subject: 'Proposta' },
    why: 'This sends the proposal to the client.',
    state: 'refused',
    decidedBy: owner.id,
    decidedAt: now - 6 * 60_000,
    reason: 'not this client yet',
    outcome: 'Nothing was run.'
  },
  now - 7 * 60_000
)
db.close()

// 3. The app again, on that data.
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const cardOf = (id) => win.locator(`[data-approval="${id}"]`)

await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForSelector('.sidebar', { timeout: 60_000 })
await win.click('.nav-item:has-text("engineering")').catch(() => {})
await win.waitForSelector('[data-approval="ap-merge"]', { timeout: 30_000 })
await win.waitForTimeout(900)

// The last cards first: the whole conversation is long, so each state is shot where it sits.
await cardOf('ap-merge').scrollIntoViewIfNeeded()
await shot('01-pendente')
await cardOf('ap-merge').screenshot({ path: `${out}/02-cartao-pendente.png` })
await cardOf('ap-cmd').scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
await cardOf('ap-cmd').screenshot({ path: `${out}/03-alto-risco.png` })
for (const [id, name] of [
  ['ap-wait', '04-aprovado-esperando'],
  ['ap-done', '05-concluido'],
  ['ap-fail', '06-falhou'],
  ['ap-refused', '07-recusado']
]) {
  await cardOf(id).scrollIntoViewIfNeeded()
  await win.waitForTimeout(250)
  await cardOf(id).screenshot({ path: `${out}/${name}.png` })
}

// The reminder over the field, and what a click on it does.
await win.locator('.composer').scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
await win.locator('.approval-reminder').screenshot({ path: `${out}/08-aviso.png` })
const reminder = await win.evaluate(() => {
  const el = document.querySelector('.approval-reminder')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { height: Math.round(r.height), text: el.textContent?.trim() }
})
const before = await win.evaluate(() => Math.round(document.querySelector('.messages')?.scrollTop ?? 0))
await win.click('.approval-reminder .link')
await win.waitForTimeout(900)
const focused = await win.evaluate(() => {
  const el = document.activeElement
  return { tag: el?.tagName, cls: el?.className, text: el?.textContent?.trim().slice(0, 40) }
})
const after = await win.evaluate(() => Math.round(document.querySelector('.messages')?.scrollTop ?? 0))
await shot('09-review')

// What the card measures, with the sizes the spec asks for.
const measured = await win.evaluate(() => {
  const card = document.querySelector('[data-approval="ap-merge"]')
  const title = card?.querySelector('.approval__title')
  const badge = card?.querySelector('.approval__badge')
  const approveBtn = card?.querySelector('.approval__approve')
  const refuse = card?.querySelector('.approval__refuse-btn')
  const actions = card?.querySelector('.approval__actions')
  const box = (el) => (el ? el.getBoundingClientRect() : null)
  const cs = (el) => (el ? getComputedStyle(el) : null)
  const r = box(card)
  return {
    card: r && { width: Math.round(r.width), height: Math.round(r.height), padding: cs(card)?.padding, radius: cs(card)?.borderRadius },
    title: title && { size: cs(title)?.fontSize, line: cs(title)?.lineHeight, weight: cs(title)?.fontWeight },
    badge: badge && { size: cs(badge)?.fontSize, weight: cs(badge)?.fontWeight },
    approve: box(approveBtn) && { width: Math.round(box(approveBtn).width), height: Math.round(box(approveBtn).height) },
    refuse: box(refuse) && { width: Math.round(box(refuse).width), height: Math.round(box(refuse).height) },
    gap: actions ? cs(actions)?.gap : null,
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})

// 420 px: the decisions take the card's own line, full width.
await win.setViewportSize({ width: 420, height: 880 })
await win.waitForTimeout(700)
await cardOf('ap-merge').scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
await cardOf('ap-merge').screenshot({ path: `${out}/10-420.png` })
const narrow = await win.evaluate(() => {
  const card = document.querySelector('[data-approval="ap-merge"]')
  const approveBtn = card?.querySelector('.approval__approve')
  const refuse = card?.querySelector('.approval__refuse-btn')
  const r = (el) => el && el.getBoundingClientRect()
  return {
    page: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
    card: r(card) && Math.round(r(card).width),
    approve: r(approveBtn) && { width: Math.round(r(approveBtn).width), top: Math.round(r(approveBtn).top) },
    refuse: r(refuse) && { width: Math.round(r(refuse).width), top: Math.round(r(refuse).top) },
    stacked: !!r(approveBtn) && !!r(refuse) && Math.round(r(refuse).top) > Math.round(r(approveBtn).bottom)
  }
})

// The hold: a press held for 1.6s decides, and the button doesn't change size under the pointer
// (the progress is a 3px track along its bottom, not a fill that reflows the label).
await win.setViewportSize({ width: 1280, height: 900 })
await cardOf('ap-cmd').scrollIntoViewIfNeeded()
await win.waitForTimeout(500)
const holdSize = await win.evaluate(() => {
  const el = document.querySelector('[data-approval="ap-cmd"] .approval__approve')
  const r = el?.getBoundingClientRect()
  return r && { width: Math.round(r.width), height: Math.round(r.height) }
})
const holdBox = await cardOf('ap-cmd').locator('.approval__approve').boundingBox()
await win.mouse.move(holdBox.x + holdBox.width / 2, holdBox.y + holdBox.height / 2)
await win.mouse.down()
await win.waitForTimeout(800)
await win.locator('[data-approval="ap-cmd"]').screenshot({ path: `${out}/11-segurando.png` })
const holding = await win.evaluate(() => document.querySelector('[data-approval="ap-cmd"] .approval__approve')?.className)
const during = await win.evaluate(() => {
  const el = document.querySelector('[data-approval="ap-cmd"] .approval__approve')
  const r = el?.getBoundingClientRect()
  const track = el ? getComputedStyle(el, '::before') : null
  return { width: r && Math.round(r.width), height: r && Math.round(r.height), track: track && { height: track.height, background: track.backgroundColor, transform: track.transform } }
})
await win.waitForTimeout(900)
await win.mouse.up()
await win.waitForTimeout(1200)
const afterHold = await win.evaluate(() => document.querySelector('[data-approval="ap-cmd"] .approval__head')?.textContent?.trim())
await win.locator('[data-approval="ap-cmd"]').screenshot({ path: `${out}/12-depois-de-segurar.png` }).catch(() => {})

// What each card reads, in order: the states side by side, as plain text.
await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForTimeout(400)
const said = await win.evaluate(() =>
  [...document.querySelectorAll('[data-approval]')].map((el) => ({
    id: el.getAttribute('data-approval'),
    text: [...el.querySelectorAll('.approval__head, .approval__title, .approval__why, .approval__meta, .approval__decided, .approval__actions, .approval__refuse')]
      .map((x) => x.textContent?.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  }))
)
console.log(JSON.stringify({ reminder, focusAfterReview: focused, scroll: { before, after }, measured, narrow, hold: { size: holdSize, holding, during, afterHold }, said, errors }, null, 2))
await app.close()
