// Proof for the Witnessed team-ups rework: restored membership dialog, the @-to-include card,
// Skip, Include with the answer in the same turn, a no-card refusal and the team-up room row.
// Run from the built checkout: node scripts/screens.mjs witnessed-rework --out C:/tmp/frames/witnessed-teamups-rework/<size>
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { close, idle, measure, openApp, parseSize, settle, shot, until, writeFrames } from './screens/lib.mjs'

export const title = 'Witnessed team-ups rework: membership and @-to-include'
export const size = '1280x820'

const row = async (t, selector, data, props = [], note = null) => {
  const [found] = await measure(t, selector, props, { optional: true })
  return found ? { ...found, data, note } : { selector, props: {}, box: null, data, note: 'nothing matched' }
}

export default async function story(t) {
  const rows = []
  // A fresh seeded build first, so the schema exists before any direct seed of the two states the
  // UI cannot make from one owner account: a second person (the card's interactive mode) and an
  // archived agent (no card, the same path that hides a restricted agent's name).
  let app = await openApp()
  await until(app.win, '.sidebar')
  await close(app)
  const db = new DatabaseSync(join(app.data, 'tucano.db'))
  db.prepare('INSERT INTO people (id, name, role, about, created_at, named) VALUES (?, ?, ?, ?, ?, 1)').run('bia-proof', 'Bia', 'member', '', Date.now())
  db.prepare('INSERT INTO agents (id, name, handle, role, color, instructions, model, effort, limit_tokens, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').run('ghost', 'Ghost', 'ghost', '', 'sky', '', 'sonnet', 'low', 1_000_000, Date.now())
  // A room row made by pedir, kept as an ordinary channel with the team_up record.
  const ownerId = db.prepare("SELECT id FROM people WHERE role = 'owner'").get().id
  const liaId = db.prepare("SELECT id FROM agents WHERE handle = 'lia'").get().id
  const theoId = db.prepare("SELECT id FROM agents WHERE handle = 'theo'").get().id
  db.prepare('INSERT INTO conversations (id, kind, name, created_at, created_by, team_up) VALUES (?, ?, ?, ?, ?, ?)').run(
    'room-proof', 'channel', 'auditoria', Date.now(), ownerId,
    JSON.stringify({ from: 'dm', title: 'auditoria', by: liaId, at: Date.now(), guests: [liaId, theoId] })
  )
  db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run('room-proof', liaId)
  db.close()
  app = await openApp({ data: app.data })

  const { win } = app
  const target = parseSize(app.size)
  // Navigate while the sidebar is open; at 420 and 360 it folds away by design.
  await win.setViewportSize({ width: 1360, height: 880 })
  await until(win, '.sidebar')
  await settle(win, 800)
  await win.locator('.sidebar .nav-item', { hasText: 'engineering' }).first().click()
  await until(win, '.composer textarea')
  await win.setViewportSize(target)
  await settle(win, 500)

  // 1. The old membership control: one toggle per agent, checks only for the two in the room.
  await win.locator('.stack__add').first().scrollIntoViewIfNeeded()
  await win.locator('.stack__add').first().click()
  await until(win, '.member-list .member')
  const memberBoxes = await measure(win, '.member-list .member', ['background-color'])
  const checkboxCount = await win.locator('.member-list .member.is-on .member__check').count()
  const selectCount = await win.locator('.member-list select').count()
  assert.equal(memberBoxes.length, 3, 'one row per agent')
  assert.equal(checkboxCount, 2, 'two agents checked in')
  assert.equal(selectCount, 0, 'no mode select in the members dialog')
  const checked = await measure(win, '.member-list .member.is-on .member__check', ['background-color'])
  rows.push({ ...memberBoxes[0], frame: await shot(app, '01-members-dialog'), data: { rows: memberBoxes.length, checked: checkboxCount, selects: selectCount, checkedBackground: checked[0]?.props['background-color'] }, note: 'one toggle per agent; the checked rows are the membership' })
  rows.push({ ...checked[0], frame: null, data: { role: 'check glyph background' } })
  await win.locator('.member-list').locator('..').getByRole('button', { name: 'Cancel' }).first().click()
  await until(win, '.member-list', { state: 'hidden' })

  // 2. A person names a reachable non-member: one Tuca card with Include and Skip.
  await win.fill('.composer textarea', '@nina please review the build')
  await win.keyboard.press('Enter')
  await until(win, '.ask--answer')
  await idle(win)
  const card = await measure(win, '.ask--answer', ['background-color'])
  const question = (await win.locator('.ask--answer .ask__title').first().innerText()).trim()
  const options = (await win.locator('.ask-option__label').allInnerTexts()).map((s) => s.trim())
  assert.match(question, /Include Nina/i)
  assert.ok(options.some((o) => o.startsWith('Include')), 'Include offered')
  assert.ok(options.some((o) => o.startsWith('Skip')), 'Skip offered')
  rows.push({ ...card[0], frame: await shot(app, '02-mention-card'), data: { question, options: options.filter((o) => /^(Include|Skip)/.test(o)), cards: card.length } })

  // 3. Skip leaves the room as it was: the dialog still shows two checked agents.
  await win.locator('.ask-option', { hasText: 'Skip' }).first().scrollIntoViewIfNeeded()
  await win.locator('.ask-option', { hasText: 'Skip' }).first().click()
  await until(win, '.ask--answer', { state: 'hidden' })
  await idle(win)
  await win.locator('.stack__add').first().scrollIntoViewIfNeeded()
  await win.locator('.stack__add').first().click()
  await until(win, '.member-list .member')
  const afterSkip = await measure(win, '.member-list .member', ['background-color'])
  const skipChecks = await win.locator('.member-list .member.is-on .member__check').count()
  assert.equal(skipChecks, 2, 'Skip added no member')
  rows.push({ ...afterSkip[0], frame: await shot(app, '03-skip-unchanged'), data: { rows: afterSkip.length, checked: skipChecks } })
  await win.locator('.member-list').locator('..').getByRole('button', { name: 'Cancel' }).first().click()
  await until(win, '.member-list', { state: 'hidden' })

  // 4. Include adds Nina, and the original mention wakes her in this one approval turn.
  await win.fill('.composer textarea', '@nina please review the build')
  await win.keyboard.press('Enter')
  await until(win, '.ask--answer')
  await win.getByRole('button', { name: /Go with the recommendation/ }).click()
  await until(win, '.ask--answer', { state: 'hidden' })
  await idle(win)
  const reply = await measure(win, '.msg--agent', ['opacity'])
  const ninaReply = await win.locator('.msg--agent', { hasText: 'Nina' }).count()
  assert.ok(ninaReply > 0, 'the included agent answered')
  rows.push({ ...reply.at(-1), frame: await shot(app, '04-include-answer'), data: { agentRows: reply.length, ninaRows: ninaReply } })
  await win.locator('.stack__add').first().scrollIntoViewIfNeeded()
  await win.locator('.stack__add').first().click()
  await until(win, '.member-list .member')
  const afterInclude = await measure(win, '.member-list .member', ['background-color'])
  const includeChecks = await win.locator('.member-list .member.is-on .member__check').count()
  assert.equal(includeChecks, 3, 'Include added one member')
  rows.push({ ...afterInclude[0], frame: await shot(app, '05-include-members'), data: { rows: afterInclude.length, checked: includeChecks } })
  await win.locator('.member-list').locator('..').getByRole('button', { name: 'Cancel' }).first().click()
  await until(win, '.member-list', { state: 'hidden' })

  // 5. An unavailable agent produces no card. The core test proves the restricted-person path;
  // this local harness launches as the owner, so an archived agent is the visible no-card state.
  await win.fill('.composer textarea', '@ghost are you there?')
  await win.keyboard.press('Enter')
  await idle(win)
  const noCard = await measure(win, '.ask--answer', [], { optional: true })
  assert.equal(noCard.length, 0, 'no approval card for an unavailable name')
  rows.push(await row(app, '.main', { role: 'no card for an unavailable agent', cards: noCard.length }, ['display'], 'owner-only harness: a restricted writer cannot be rendered here'))

  // 6. The team-up room row is still an ordinary channel row with its own icon.
  await until(win, '.sidebar .nav-item[title*="Team-up"]', { state: 'attached' })
  const roomRows = await measure(win, '.sidebar .nav-item[title*="Team-up"]', ['display', 'color'])
  assert.equal(roomRows.length, 1, 'one team-up room row')
  assert.ok(roomRows[0].props.display !== 'none' || target.width < 600, 'the row is visible unless the sidebar is folded')
  rows.push({ ...roomRows[0], frame: await shot(app, '06-sidebar-rooms'), data: { teamUpRows: roomRows.length, title: await win.locator('.sidebar .nav-item[title*="Team-up"]').first().getAttribute('title') }, note: 'the room keeps the existing sidebar row and icon' })

  writeFrames(app.out, rows, { data: { states: ['members', 'card', 'skip', 'include', 'no-card', 'sidebar'], agentRows: reply.length, checkedByState: { start: checkboxCount, skip: skipChecks, include: includeChecks }, viewport: app.size } })
  await close(app)
}
