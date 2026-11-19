// Frames and numbers for the Knowledge › Wiki toolbar: where the taxonomy, search, settings and
// New page controls sit, and how far the canvas reaches. Run after `npm run build`:
//   node scripts/screens-wiki-tools.mjs <out-dir>
// A scratch data dir, the seed and fake engines keep the real wiki untouched.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/wiki-tools'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }

const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForSelector('.sidebar')
  await win.waitForTimeout(900)
  return { app, win }
}

// The first start makes the workspace and the wiki file; then the graph is written the way the
// curator would, so the canvas has something to draw.
const first = await launch()
await first.app.close()

const PAGES = [
  ['release-discipline', 'Release discipline', 'Project', 'How a build reaches the person and what it owes them.'],
  ['settings-by-task', 'Settings by task', 'Decision', 'The settings page is arranged by what a person is trying to do.'],
  ['the-wiki-graph', 'The wiki graph', 'Topic', 'Pages are nodes, a link is an edge, and a page nobody links to still shows.'],
  ['lia-engineering', 'Lia', 'Person', 'Engineering, answers to nobody, owns the channels about code.'],
  ['theo-data', 'Theo', 'Person', 'Data, the numbers that move a decision.'],
  ['nina-content', 'Nina', 'Person', 'Content, the words that leave the workspace.'],
  ['delegation', 'Delegation', 'Topic', 'An agent hands part of a job to the agent that holds the part.'],
  ['correction-windows', 'Correction windows', 'Decision', 'Notes land in one build per window instead of one build per note.'],
  ['the-install-lock', 'The install lock', 'Project', 'One install at a time, with a lock that outlives a crashed session.'],
  ['read-only-wiki', 'The key only reads', 'Topic', 'A git-backed wiki shows what is in the repository and takes no writes.'],
  ['the-drawer', 'The work drawer', 'Project', 'The replies running now, above the field.'],
  ['first-start', 'First start', 'Topic', 'What a new workspace already has before anyone writes anything.']
]
const LINKS = [
  ['release-discipline', 'correction-windows'],
  ['correction-windows', 'the-install-lock'],
  ['settings-by-task', 'lia-engineering'],
  ['the-wiki-graph', 'read-only-wiki'],
  ['delegation', 'theo-data'],
  ['delegation', 'nina-content'],
  ['the-drawer', 'the-wiki-graph'],
  ['first-start', 'the-wiki-graph']
]
const now = Date.now()
const q = (v) => "'" + String(v).replace(/'/g, "''") + "'"
const sql = [
  "DELETE FROM pages", "DELETE FROM links",
  ...PAGES.map(([file, title, kind, summary]) => {
    const body = `# ${title}\n\n${summary}\n\nThis page exists so the graph has a shape: it links to other pages and other pages link back.`
    return `INSERT INTO pages (file, title, kind, summary, body, hash, mtime, updated_at, updated_by) VALUES ('${file}.md', '${title}', '${kind}', '${summary}', '${body.replace(/'/g, "''")}', 'h-${file}', ${now}, ${now}, 'lia')`
  }),
  ...LINKS.map(([a, b]) => `INSERT INTO links (src, target) VALUES (${q(a + '.md')}, ${q(b + '.md')})`)
].join('; ')
execFileSync('sqlite3', [join(data, 'wiki.db'), sql])

const { app, win } = await launch()
await win.locator('.sidebar button[title^="Knowledge"], .sidebar button:has-text("Knowledge")').first().click()
await win.waitForSelector('.hub', { timeout: 20000 })
await win.locator('.hub__tab[data-tab="wiki"]').click()
await win.waitForTimeout(1800)

const box = (sel) => win.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}).catch(() => null)

const report = { tabs: await win.locator('.hub__tab').allInnerTexts() }
for (const sel of ['.hub__head', '.hub__tabs', '.hub__tools', '.wk-kinds', '.wk-search-btn', '.wk-stage', '.wk-canvas', '.page-body--fill', '.sheet__head']) {
  report[sel] = await box(sel)
}
const head = report['.hub__head']
const search = report['.wk-search-btn']
const stage = report['.wk-stage']
report.checks = {
  tools_above_hairline: !!(head && search && search.y + search.h <= head.y + head.h + 1),
  canvas_starts_at_hairline: !!(head && stage && Math.abs(stage.y - (head.y + head.h)) <= 2),
  kinds_shown: report['.wk-kinds'] !== null
}
console.log(JSON.stringify(report, null, 2))

await win.screenshot({ path: `${out}/wiki-1280.png` })
await win.setViewportSize({ width: 1024, height: 800 })
await win.waitForTimeout(700)
await win.screenshot({ path: `${out}/wiki-1024.png` })
await app.close()
console.log('done ->', out)
