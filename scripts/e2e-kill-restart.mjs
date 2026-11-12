// The app killed in the middle of a reply, then opened again: the session comes back with the run marked
// interrupted and the work it had got done kept, Continue is offered when there is work to go on with,
// Try again always, and what it wrote before the kill is still there. A reply killed before any tool
// call came back offers Try again alone. Every offer is checked against canContinue, the rule the window
// and the core both read, rather than against a list of labels copied here.
// Run after `npm run build`: node scripts/e2e-kill-restart.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canContinue, workedOn, WORKLESS_LABELS } from '../src/shared/run-progress.ts'

const out = process.argv[2] ?? 'screens/kill-restart'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-kill-'))
const HOLD = 30_000
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_FAKE_HOLD_MS: String(HOLD), TUCANO_LOCALE: 'en-US' }
const errors = []
const dbFile = join(data, 'tucano.db')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}
const report = (name, value) => console.log(`     ${name}: ${JSON.stringify(value)}`)

const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return { app, win }
}
const shot = (win, name) => win.screenshot({ path: `${out}/${name}.png` })
const open = async (win, name) => {
  await win.locator('.section .nav-item', { hasText: name }).first().click()
  await win.waitForSelector('.composer textarea')
  await win.waitForTimeout(300)
}
const ask = async (win, text) => {
  await win.locator('.composer textarea').fill(text)
  await win.keyboard.press('Enter')
}

// The runs as the database has them: read with the app running and with it gone, so no reading here
// depends on what the window happens to be drawing.
const runs = () => {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    return db
      .prepare("SELECT id, author_kind, substr(text, 1, 90) AS text, run, at FROM messages WHERE run IS NOT NULL ORDER BY at")
      .all()
      .map((r) => ({ id: r.id, author: r.author_kind, text: r.text, at: r.at, ...JSON.parse(r.run) }))
  } finally {
    db.close()
  }
}
const memories = () => {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    return db.prepare('SELECT text FROM memories ORDER BY created_at').all().map((r) => r.text)
  } finally {
    db.close()
  }
}
const steps = (run) => (run?.steps ?? []).map((s) => `${s.label}:${s.status}`)
const lastAgent = () => runs().filter((r) => r.author === 'agent').at(-1)
// The work a reply got done, by the rule the app itself uses: the rows are every reply's thought row
// until a tool call comes back, so counting them as work would let the first kill go too early.
const worked = (run) => (run?.steps ?? []).filter((s) => s.status !== 'running' && !WORKLESS_LABELS.includes(s.label))

// Kill the window's whole process tree, the way a crash or Task Manager does: the core dies with it,
// no shutdown path runs, and the run is left marked as working in the database.
const kill = (app) => {
  const pid = app.process().pid
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // already gone
  }
}

const waitForWork = async (win, want) => {
  for (let i = 0; i < 240; i++) {
    const last = lastAgent()
    const working = await win.evaluate(() => !!document.querySelector('.steps__stop'))
    if (worked(last).length >= want && working) return { done: worked(last).length, steps: steps(last), working }
    await win.waitForTimeout(250)
  }
  return { done: 0, steps: [], working: false }
}
const buttons = (win) => win.evaluate(() => [...document.querySelectorAll('.retry')].map((b) => b.textContent.trim()))

// A first run, only to create the database, then enough older memories that some fall past the
// prompt's budget: `buscar_memorias` is offered only while there are, so the reply has something to
// read back as well as something to write.
{
  const { app: first } = await launch()
  await first.close()
  const db = new DatabaseSync(dbFile)
  const now = Date.now()
  const me = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get()
  const put = db.prepare(
    'INSERT OR REPLACE INTO memories (id, scope, text, state, origin, agent_id, conversation_id, message_ids, replaces, reason, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < 32; i++) {
    const text = `Nota antiga ${i}: ${'o time combinou de sempre revisar o que sai antes de mandar. '.repeat(5)}`
    put.run(`old-${i}`, `person:${me.id}`, text, 'active', 'you', null, null, '[]', null, null, now - 60_000 - i * 1000, now - 60_000 - i * 1000)
  }
  db.close()
}

// ---------- 1. a reply killed after it read and wrote ----------
let { app, win } = await launch()
await open(win, 'engineering')
await ask(win, 'Lia, lembre e procure: prefiro respostas curtas')
const midRun = await waitForWork(win, 2)
const before = lastAgent()
report('the reply while it worked', { status: before.status, steps: steps(before), working: midRun.working })
check('it had two steps of real work before the kill', worked(before).length >= 2, steps(before))
check('one of them is what it wrote', worked(before).some((s) => /memory|memória/i.test(s.label)))
check('it was still working when the app was killed', midRun.working)
await shot(win, '01-working-when-killed')
kill(app)
await new Promise((r) => setTimeout(r, 1500))

const afterKill = lastAgent()
report('the run with the app gone', { status: afterKill.status, steps: steps(afterKill) })
check('with no shutdown path, it is still marked working', afterKill.status === 'working')
check('what it wrote before the kill is in the database', memories().some((m) => m.includes('prefiro respostas curtas')), memories().filter((m) => m.includes('prefiro')))

// ---------- 2. the same session, opened again ----------
;({ app, win } = await launch())
await open(win, 'engineering')
const recovered = lastAgent()
report('the run after reopening', { status: recovered.status, steps: steps(recovered) })
check('the session comes back with the run marked interrupted', recovered.status === 'interrupted')
check(
  'every step of work it finished survived the kill',
  JSON.stringify(worked(recovered).map((s) => s.label)) === JSON.stringify(worked(before).map((s) => s.label)),
  { before: steps(before), after: steps(recovered) }
)
const offered = await buttons(win)
report('what the window offers on the cut reply', offered)
check('the rule says this reply can go on', canContinue(recovered))
check('Continue is offered', offered.includes('Continue'))
check('Try again stands beside it', offered.includes('Try again'))
await shot(win, '02-after-reopening')

// ---------- 3. Continue: the work goes on, carrying what was done ----------
await win.locator('.retry', { hasText: 'Continue' }).click()
let wentOn
for (let i = 0; i < 160; i++) {
  const last = lastAgent()
  if (last && last.id !== recovered.id && last.status !== 'working') {
    wentOn = last
    break
  }
  await win.waitForTimeout(250)
}
report('the reply Continue produced', { text: wentOn?.text, steps: steps(wentOn) })
check('Continue produced a second reply rather than rewriting the first', runs().filter((r) => r.author === 'agent').length === 2)
check('the new reply says it went on from there', /went on from there|Continuei dali/.test(wentOn?.text ?? ''), wentOn?.text)
check('the one it went on from now reads as answered, not as an offer', runs().find((r) => r.id === recovered.id)?.status === 'done')
// The fake names the steps its task carried, so the reply is the proof that the cut reply's work
// reached it: a count alone would not say which steps, and the task itself is not kept on the run.
check(
  'the new reply was told the steps the cut one had taken',
  /Saved to memory/.test(wentOn?.text ?? '') && /Searched memory/.test(wentOn?.text ?? ''),
  wentOn?.text
)
await win.waitForTimeout(600)
await shot(win, '03-continued')
await app.close()

// ---------- 4. a reply killed before any call came back ----------
;({ app, win } = await launch())
await open(win, 'engineering')
await ask(win, 'Lia, pergunte em 30 s: quando você precisa disso?')
await win.waitForTimeout(2500)
const thin = lastAgent()
report('the second run before the kill', { status: thin.status, steps: steps(thin) })
check('nothing but thinking had happened', worked(thin).length === 0, steps(thin))
kill(app)
await new Promise((r) => setTimeout(r, 1500))

;({ app, win } = await launch())
await open(win, 'engineering')
const thinAfter = lastAgent()
const thinOffered = await buttons(win)
report('a run cut before any call came back', { status: thinAfter.status, steps: steps(thinAfter), offered: thinOffered })
check('it still comes back as interrupted', thinAfter.status === 'interrupted')
check('the rule says it has nothing to go on with', !workedOn(thinAfter) && !canContinue(thinAfter))
check('Continue is not offered', !thinOffered.includes('Continue'), thinOffered)
check('Try again is still offered', thinOffered.includes('Try again'), thinOffered)
await shot(win, '04-no-work-no-continue')

console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none')
check('the window raised no errors across four launches', errors.length === 0)
await app.close()

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0
