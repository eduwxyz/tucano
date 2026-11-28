// Screenshots and measurements of the single Proceed button (issue: one-action proposals). It seeds
// a finished reply that offered one action, then clicks the button and checks that no prompt from the
// person was written. Run after `npm run build`: node scripts/screens-proceed.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens/proceed'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-proceed-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const PROPOSAL = 'They’re still sitting there unstaged; say the word and I’ll restore all six, one branch each.'

const seed = await electron.launch({ args: ['.'], env })
await seed.firstWindow().then((w) => w.waitForSelector('.sidebar', { timeout: 60_000 }))
await seed.close()

const dbFile = join(data, 'tucano.db')
const db = new DatabaseSync(dbFile)
const agent = db.prepare("SELECT id FROM agents WHERE handle = 'lia' LIMIT 1").get()
const channel = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' AND name IN ('engineering', 'engenharia') LIMIT 1").get()
if (!agent || !channel) throw new Error('seeded workspace has no Lia or engineering channel')
const at = Date.now() - 60_000
db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  'm-proceed',
  channel.id,
  'agent',
  agent.id,
  PROPOSAL,
  at,
  JSON.stringify({ status: 'done', steps: [], depth: 1, endedAt: at, questions: [{ question: PROPOSAL, kind: 'text', proceed: true }], proceedOpen: true })
)
const peopleBefore = db.prepare("SELECT count(*) AS n FROM messages WHERE author_kind = 'person'").get().n
db.close()

const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1440, height: 900 })
await win.waitForSelector('.sidebar', { timeout: 60_000 })
await win.click('.nav-item:has-text("engineering"), .nav-item:has-text("engenharia")')
await win.waitForSelector('.proceed button', { timeout: 30_000 })
await win.waitForTimeout(600)

const card = win.locator('.proceed')
const button = win.locator('.proceed button')
const measure = async () =>
  win.evaluate(() => {
    const widget = document.querySelector('.proceed')
    const el = widget?.querySelector('button')
    if (!widget || !el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const hex = accent.replace('#', '')
    const wanted = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`
    return {
      buttons: widget.querySelectorAll('button').length,
      controls: widget.querySelectorAll('button, input, select, textarea, a').length,
      disabled: el.disabled,
      label: el.textContent?.trim(),
      aria: el.getAttribute('aria-label'),
      height: Math.round(r.height),
      width: Math.round(r.width),
      background: cs.backgroundColor,
      accent: accent,
      accentColor: wanted,
      colorMatchesAccent: cs.backgroundColor === wanted,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }
  })

await card.scrollIntoViewIfNeeded()
const beforeWide = await measure()
await win.screenshot({ path: join(out, 'before-1440.png') })
await win.waitForTimeout(300)
await card.scrollIntoViewIfNeeded()
const beforeAgain = await measure() // a second draw of the same message: the word must not change
await win.screenshot({ path: join(out, 'before-1440-repeat.png') })

await win.setViewportSize({ width: 420, height: 900 })
await win.waitForTimeout(500)
await card.scrollIntoViewIfNeeded()
const beforeNarrow = await measure()
await win.screenshot({ path: join(out, 'before-420.png') })

await button.click()
await win.waitForSelector('.proceed button[aria-label="Approved"]', { timeout: 30_000 })
await win.waitForTimeout(500)
const afterNarrow = await measure()
await win.screenshot({ path: join(out, 'after-420.png') })
await win.setViewportSize({ width: 1440, height: 900 })
await win.waitForTimeout(500)
await card.scrollIntoViewIfNeeded()
const afterWide = await measure()
await win.screenshot({ path: join(out, 'after-1440.png') })

const after = new DatabaseSync(dbFile, { readOnly: true })
const peopleAfter = after.prepare("SELECT count(*) AS n FROM messages WHERE author_kind = 'person'").get().n
const stored = after.prepare("SELECT run FROM messages WHERE id = 'm-proceed'").get()
after.close()
const saved = JSON.parse(stored.run)

const frames = {
  proposal: PROPOSAL,
  before: { wide1440: beforeWide, narrow420: beforeNarrow },
  after: { wide1440: afterWide, narrow420: afterNarrow },
  labelStableAcrossTwoRenders: beforeWide?.label === beforeAgain?.label,
  repeatedLabel: beforeAgain?.label,
  noUserMessageAdded: peopleAfter === peopleBefore,
  peopleMessages: { before: peopleBefore, after: peopleAfter },
  storedCard: { proceedOpen: saved.proceedOpen ?? null, answeredText: saved.answers?.[0]?.text ?? null, answeredBy: saved.answeredBy ?? null },
  errors: errors.length ? errors : 'none'
}
writeFileSync(join(out, 'frames.json'), JSON.stringify(frames, null, 2))
console.log(JSON.stringify(frames, null, 2))
await app.close()
