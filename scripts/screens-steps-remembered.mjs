// Frames for a conversation remembering its steps folded: fold a run from the line, leave the
// conversation, come back, restart the app — and it is still folded, and a run that starts there
// opens folded too. The 25-step reply is seeded: no fake turn makes 25 tool calls.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'C:/tmp/frames/steps-remembered'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []

const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return { app, win }
}
const channel = async (win, name) => {
  await win.locator('.section .nav-item', { hasText: name }).first().click()
  await win.waitForSelector('.composer textarea')
  await win.waitForTimeout(400)
}
const ask = async (win, text) => {
  await win.locator('.composer textarea').fill(text)
  await win.keyboard.press('Enter')
}

const SEED = '[data-id="seed-long-reply"]'
const seekSeed = async (win) => {
  await win.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), SEED)
  await win.waitForTimeout(400)
}

// Every reply on screen that has steps, as it reads: open (how many rows) or folded (one line).
const chains = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.steps')]
      .filter((x) => x.querySelector('.steps__toggle'))
      .map((x) => ({
        line: x.querySelector('.steps__toggle')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
        open: !!x.querySelector('.steps__list'),
        rows: x.querySelectorAll('.step').length,
        rail: !!x.querySelector('.steps__rail'),
        stop: !!x.querySelector('.steps__stop'),
        expanded: x.querySelector('.steps__toggle')?.getAttribute('aria-expanded') ?? null
      }))
  )
const seedChain = (win) =>
  win.evaluate((sel) => {
    const steps = document.querySelector(sel)?.querySelector('.steps')
    return {
      line: steps?.querySelector('.steps__toggle')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      open: !!steps?.querySelector('.steps__list'),
      rows: steps?.querySelectorAll('.step').length ?? 0,
      rail: !!steps?.querySelector('.steps__rail')
    }
  }, SEED)
// Until what the app is doing settles: a run starts a moment after the message is sent.
const until = async (win, what, fn, ms = 20_000) => {
  const stop = Date.now() + ms
  let last = null
  while (Date.now() < stop) {
    last = await fn()
    if (last) return last
    await win.waitForTimeout(200)
  }
  console.log(`   (waited ${ms} ms for ${what} and did not see it)`)
  return null
}
const foldedInDb = () => {
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const row = db.prepare("SELECT value FROM settings WHERE key = 'folded'").get()
  db.close()
  return row ? row.value : null
}

let { app, win } = await launch()

// The 25-step reply, seeded: a finished reply starts folded, so it is opened by a click.
await app.close()
const db = new DatabaseSync(join(data, 'tucano.db'))
const conv = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' AND name = 'engineering'").get()
const agent = db.prepare('SELECT id FROM agents LIMIT 1').get()
const steps = Array.from({ length: 25 }, (_, i) => ({
  id: `seed-s${i + 1}`,
  label: ['read src/core/runs.ts', 'run npx vitest run test/runs.test.ts', 'write src/core/runs.ts', 'read the failing output', 'run npx tsc --noEmit'][i % 5] + ` (${i + 1})`,
  status: 'done',
  ms: 400 + i * 37
}))
const at = Date.now() - 120_000
db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run, routine, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  'seed-long-reply',
  conv.id,
  'agent',
  agent.id,
  'The tests pass now. The problem was the Node path, not the test.',
  at,
  JSON.stringify({ status: 'done', endedAt: at + 21_000, steps }),
  null,
  null
)
db.close()

;({ app, win } = await launch())
await channel(win, 'engineering')
await seekSeed(win)
await win.evaluate((sel) => document.querySelector(sel)?.querySelector('.steps__toggle')?.click(), SEED)
await win.waitForTimeout(500)
await seekSeed(win)
console.log('1 a fresh app, the reply opened by its toggle:', JSON.stringify(await seedChain(win)), 'db:', foldedInDb())
await win.screenshot({ path: `${out}/01-a-run-opened.png` })

// The line, double-clicked where the pointer already is.
const rail = await win.locator(`${SEED} .steps__rail`).boundingBox()
await win.mouse.move(rail.x + 4, rail.y + Math.min(140, rail.height / 2))
await win.mouse.dblclick(rail.x + 4, rail.y + Math.min(140, rail.height / 2))
await win.waitForTimeout(800)
await seekSeed(win)
console.log('2 after the double-click on the line:', JSON.stringify(await seedChain(win)))
console.log('   written down:', foldedInDb())
await win.screenshot({ path: `${out}/02-folded-and-written-down.png` })

// Away to another conversation and back: the fold is the conversation's, not the screen's.
await channel(win, 'data')
await channel(win, 'engineering')
await seekSeed(win)
console.log('3 back in the conversation:', JSON.stringify(await seedChain(win)))
await win.screenshot({ path: `${out}/03-still-folded-on-return.png` })

// A run that starts in a conversation left folded opens folded, even while it works.
await ask(win, 'Lia, demore 12 s e me diga o que acha do teste de hoje')
const working = await until(win, 'a run at work', async () => {
  const all = await chains(win)
  return all.some((c) => c.stop) ? all : null
})
console.log('4 a run that starts now, while the conversation is folded:', JSON.stringify(working))
await win.screenshot({ path: `${out}/04-a-new-run-opens-folded.png` })
await until(win, 'the run to end', async () => !(await chains(win)).some((c) => c.stop), 60_000)

// Restart the app: it was written down, so the restart changes nothing.
await app.close()
;({ app, win } = await launch())
await channel(win, 'engineering')
await seekSeed(win)
console.log('5 after a restart:', JSON.stringify(await chains(win)))
await win.screenshot({ path: `${out}/05-still-folded-after-a-restart.png` })

// Unfolded from the toggle, and that is written down too: the next run in the conversation opens.
await win.evaluate((sel) => document.querySelector(sel)?.querySelector('.steps__toggle')?.click(), SEED)
await win.waitForTimeout(600)
await seekSeed(win)
console.log('6 opened from the toggle:', JSON.stringify(await seedChain(win)), 'db:', foldedInDb())
await win.screenshot({ path: `${out}/06-opened-again.png` })

// Narrow window: the same handle, the same fold, nothing sideways.
await win.setViewportSize({ width: 420, height: 880 })
await win.waitForTimeout(600)
await seekSeed(win)
const narrow = await win.evaluate((sel) => {
  const steps = document.querySelector(sel)?.querySelector('.steps')
  const box = steps?.querySelector('.steps__rail')?.getBoundingClientRect()
  return {
    page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    rail: box ? { left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) } : null,
    rows: steps?.querySelectorAll('.step').length ?? 0
  }
}, SEED)
console.log('7 at 420 px, open:', JSON.stringify(narrow))
await win.screenshot({ path: `${out}/07-at-420-open.png` })
const narrowRail = await win.locator(`${SEED} .steps__rail`).boundingBox()
if (narrowRail) {
  await win.mouse.dblclick(narrowRail.x + 4, narrowRail.y + Math.min(120, narrowRail.height / 2))
  await win.waitForTimeout(700)
  await seekSeed(win)
  console.log('   folded at 420:', JSON.stringify(await seedChain(win)), 'sideways:', await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
  await win.screenshot({ path: `${out}/08-at-420-folded.png` })
}

console.log('page errors:', JSON.stringify(errors))
await app.close()
