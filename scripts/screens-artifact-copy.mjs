// Screenshots for the Copy action on artifact cards: Copy button visible on a file attachment,
// and the toast after copying.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'frames/artifact-copy'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-copy-'))

let app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' } })
let win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 900 })
await win.waitForSelector('.sidebar')
await win.click('.section:has-text("Agents") .nav-item:has-text("Lia")')
const openDm = win.locator('button:has-text("Open DM"), button:has-text("Abrir DM")')
if (await openDm.count()) await openDm.first().click()
await win.waitForSelector('.composer textarea')
const say = async (text) => { await win.fill('.composer textarea', text); await win.keyboard.press('Enter') }
const idle = async () => { await win.waitForTimeout(600); for (let i=0;i<60;i++){ if (!(await win.locator('.steps.is-working').count())) break; await win.waitForTimeout(250) } await win.waitForTimeout(900) }
await say('here is the report')
await idle(win)
await say('and the notes')
await idle(win)
await app.close()

const db = new DatabaseSync(join(data, 'tucano.db'))
const dm = db.prepare("SELECT id FROM conversations WHERE kind='dm' LIMIT 1").get()
const withRuns = db.prepare("SELECT id, author_id, run FROM messages WHERE conversation_id=? AND run IS NOT NULL AND author_kind='agent' ORDER BY at").all(dm.id).map(r => ({ id: r.id, agentId: r.author_id, run: JSON.parse(r.run) }))
const insert = db.prepare('INSERT INTO artifacts (id, agent_id, conversation_id, message_id, kind, name, title, source, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
const make = (msg, kind, name, title, content) => {
  const id = randomUUID()
  const bytes = Buffer.from(content)
  mkdirSync(join(data, 'artifacts', id), { recursive: true })
  writeFileSync(join(data, 'artifacts', id, name), bytes)
  insert.run(id, msg.agentId, dm.id, msg.id, kind, name, title, `C:/Users/theap/Desktop/${name}`, bytes.length, Date.now())
  msg.run.artifactIds = [...(msg.run.artifactIds ?? []), id]
  db.prepare('UPDATE messages SET run=? WHERE id=?').run(JSON.stringify(msg.run), msg.id)
}
const m1 = withRuns[withRuns.length - 2]
const m2 = withRuns[withRuns.length - 1]
make(m1, 'markdown', 'quarterly-report.md', 'Quarterly report', '# Q2 Report\n\nRevenue grew 12% quarter over quarter.\n')
make(m2, 'pdf', 'very-long-filename-for-a-quarterly-financial-report-with-notes.pdf', 'A very long title for a quarterly financial report with notes that wraps across several lines in the card', '%PDF-1.4\n% fake\n')
db.close()

app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '0', TUCANO_FAKE_ENGINES: '1' } })
win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 900 })
await win.waitForSelector('.sidebar')
await win.click('.section:has-text("Agents") .nav-item:has-text("Lia")')
if (await win.locator('button:has-text("Open DM"), button:has-text("Abrir DM")').count()) await win.locator('button:has-text("Open DM"), button:has-text("Abrir DM")').first().click()
await win.waitForSelector('.artifact-card')
await win.waitForTimeout(800)

const report = {}
report.buttons = await win.locator('.artifact-card').first().locator('.artifact-card__open').allTextContents()
report.stacked = await win.locator('.artifact-card.is-stacked').count()
report.actionsBottom = await win.locator('.artifact-card.is-stacked .artifact-card__actions').count()
await win.screenshot({ path: `${out}/01-copy-buttons.png` })

// Click copy on markdown card
await win.locator('.artifact-card').first().locator('button', { hasText: /Copiar|Copy/ }).click()
await win.waitForTimeout(600)
report.toast = await win.locator('.toast, [role="status"]').first().innerText().catch(() => '')
await win.screenshot({ path: `${out}/02-copy-toast.png` })
console.log(JSON.stringify(report, null, 2))
await app.close()
