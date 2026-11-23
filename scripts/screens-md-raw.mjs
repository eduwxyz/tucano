import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'frames/panel-md-raw'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-md-raw-'))

let app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' } })
let win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 900 })
await win.waitForSelector('.sidebar')
await win.click('.section:has-text("Agents") .nav-item:has-text("Lia")')
const openDm = win.locator('button:has-text("Open DM"), button:has-text("Abrir DM")')
if (await openDm.count()) await openDm.first().click()
await win.waitForSelector('.composer textarea')
const say = async (text) => { await win.fill('.composer textarea', text); await win.keyboard.press('Enter') }
const idle = async () => { await win.waitForTimeout(600); for (let i = 0; i < 60; i++) { if (!(await win.locator('.steps.is-working').count())) break; await win.waitForTimeout(250) } await win.waitForTimeout(900) }
await say('here are the notes')
await idle()
await app.close()

const db = new DatabaseSync(join(data, 'tucano.db'))
const dm = db.prepare("SELECT id FROM conversations WHERE kind='dm' LIMIT 1").get()
const msg = db.prepare("SELECT id, author_id, run FROM messages WHERE conversation_id=? AND run IS NOT NULL AND author_kind='agent' ORDER BY at DESC LIMIT 1").get(dm.id)
const run = JSON.parse(msg.run)
const artId = randomUUID()
const name = 'release-notes.md'
const content = `# Release Notes\n\n## Added\n\n- **Copy** button on attachment cards\n- Raw markdown toggle in side panel\n\n## Fixed\n\n- Expanded markdown panel reflows to full width\n\n\`\`\`ts\nexport function hello(name: string) {\n  return \`Hello, \${name}\`\n}\n\`\`\`\n`
const bytes = Buffer.from(content)
mkdirSync(join(data, 'artifacts', artId), { recursive: true })
writeFileSync(join(data, 'artifacts', artId, name), bytes)
db.prepare('INSERT INTO artifacts (id, agent_id, conversation_id, message_id, kind, name, title, source, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(artId, msg.author_id, dm.id, msg.id, 'markdown', name, 'Release Notes', 'local', bytes.length, Date.now())
run.artifactIds = [...(run.artifactIds ?? []), artId]
db.prepare('UPDATE messages SET run=? WHERE id=?').run(JSON.stringify(run), msg.id)
db.close()

app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '0', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' } })
win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 900 })
await win.waitForSelector('.sidebar')
await win.click('.section:has-text("Agents") .nav-item:has-text("Lia")')
if (await win.locator('button:has-text("Open DM"), button:has-text("Abrir DM")').count()) await win.locator('button:has-text("Open DM"), button:has-text("Abrir DM")').first().click()
await win.waitForSelector('.artifact-card')
await win.waitForTimeout(800)

await win.locator('.artifact-card__main').first().click()
await win.waitForSelector('.side-panel__doc.md')
await win.waitForTimeout(500)
await win.screenshot({ path: `${out}/01-markdown-preview.png` })

const rawBtn = win.locator('button[aria-label="View markdown source"]')
await rawBtn.first().click()
await win.waitForTimeout(400)
await win.screenshot({ path: `${out}/02-raw-markdown.png` })
console.log(JSON.stringify({ rawPressed: await rawBtn.first().getAttribute('aria-pressed').catch(() => null) }, null, 2))
await app.close()
