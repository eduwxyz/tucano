// A next-steps card: the work the agent proposes after its reply, in boxes that are all ticked.
// With Jev on, only the steps it would do now keep their tick — and what stays ticked comes back
// as the person's message. TypeSafe can't be reached from a seeded run, so that subset is written
// onto the waiting message the way the core writes it, then the app reloads.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const NL = String.fromCharCode(10)
const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'screens'
mkdirSync(out, { recursive: true })

const data = mkdtempSync(join(tmpdir(), 'tucano-steps-'))
for (const dir of [tmpdir(), '/tmp']) rmSync(join(dir, 'tucano-demo-tasks.json'), { force: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = async (name) => win.screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle() {
  const deadline = Date.now() + 15_000
  let quiet = 0
  while (Date.now() < deadline && quiet < 3) {
    await win.waitForTimeout(500)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
}
const ticked = async () => win.locator('.ask--steps .ask-option[aria-checked="true"]').count()

// The fake engine answers "os próximos passos" with four steps, one of them plainly optional.
await send('@Lia me dá os próximos passos')
await settle()
await win.waitForSelector('.ask--steps', { timeout: 20_000 })
await win.waitForTimeout(400)
console.log('steps on the card:', await win.locator('.ask--steps .ask-option[role="checkbox"]').count())
console.log('ticked with Jev off:', await ticked())
console.log('pill in the head:', await win.locator('.ask--steps .ask__head .ask-option__pill').count())
console.log('button:', await win.locator('.ask--steps .btn--primary').innerText())
await shot('01-todas-marcadas')

// Jev's subset, written where the core writes it: steps 1 and 3 are worth doing now, 2 and 4 wait.
const db = new DatabaseSync(join(data, 'tucano.db'))
const row = db.prepare("SELECT id FROM messages WHERE json_extract(run, '$.status') = 'waiting_input' ORDER BY at DESC LIMIT 1").get()
if (!row) throw new Error('no waiting card in the seeded run')
db.prepare("UPDATE messages SET run = json_set(run, '$.questions[0].ticked', json('[0,2]')) WHERE id = ?").run(row.id)
const check = db.prepare("SELECT json_extract(run, '$.questions[0].ticked') AS t FROM messages WHERE id = ?").get(row.id)
db.close()
console.log('ticked on the message:', check?.t)

await win.reload()
await win.waitForSelector('.ask--steps', { timeout: 25_000 })
await win.waitForTimeout(400)
console.log('ticked with Jev on:', await ticked())
await shot('02-so-os-que-importam')

// A narrow window: the steps still read as a to-do, nothing clipped.
await win.setViewportSize({ width: 420, height: 820 })
await win.waitForTimeout(700)
const overflow = await win.evaluate(() => [...document.querySelectorAll('.ask--steps')].map((el) => el.scrollWidth - el.clientWidth))
console.log('overflow at 420px:', JSON.stringify(overflow))
const wide = await win.evaluate(() => {
  const card = document.querySelector('.ask--steps')
  if (!card) return 'no card'
  const box = card.getBoundingClientRect()
  return [...card.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right + 0.5).map((el) => (el.getAttribute('class') || el.tagName) + ' ' + Math.round(el.getBoundingClientRect().right - box.right))
})
console.log('past the right edge:', JSON.stringify(wide))
await shot('03-420px')

// What stays ticked comes back as my message, and the agent reads it as the next task.
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForTimeout(500)
console.log('button disabled before clicking:', await win.locator('.ask--steps .btn--primary').isDisabled())
await win.locator('.ask--steps .btn--primary').click()
await settle()
await win.waitForTimeout(900)
console.log('my messages:', await win.locator('.msg--me').count(), '| cards answered:', await win.locator('.ask--done').count(), '| still answering:', await win.locator('.ask--answer').count())
const arts = await win.evaluate(() => [...document.querySelectorAll('.msg')].map((el) => (el.getAttribute('class') || '') + ' » ' + (el.innerText || '').slice(0, 90)))
console.log('messages:', JSON.stringify(arts, null, 1))
await shot('04-de-volta-como-mensagem')

// The setting, off by default, in the same card as the other thing Jev does on a question.
try {
  await win.locator('.sidebar__foot .nav-item').last().click()
  await win.waitForSelector('.tabs', { timeout: 8000 })
  await win.waitForTimeout(500)
  // The Agents tab: the machine's own label, whichever language the seeded workspace is in.
  const tabs = win.locator('.tabs [role="tab"]')
  const names = await tabs.allInnerTexts()
  const i = names.findIndex((n) => /^(Agentes|Agents)$/.test(n.trim()))
  if (i < 0) throw new Error('no Agents tab in ' + JSON.stringify(names))
  await tabs.nth(i).click()
  await win.waitForTimeout(900)
  const rowLoc = win.locator('.key-row').filter({ hasText: /próximos passos que importam|next steps worth doing/ })
  await rowLoc.first().scrollIntoViewIfNeeded({ timeout: 8000 })
  await win.waitForTimeout(400)
  await shot('05-configuracao-desligada')
  const onBefore = await rowLoc.first().locator('.toggle[aria-checked="true"]').count()
  await rowLoc.first().locator('.toggle').click()
  await win.waitForTimeout(700)
  const onAfter = await rowLoc.first().locator('.toggle[aria-checked="true"]').count()
  console.log('toggle before/after:', onBefore, onAfter)
  await shot('06-configuracao-ligada')
} catch (e) {
  console.log('settings frame skipped:', String(e).split(NL)[0])
}
console.log('page errors:', errors.length ? errors.join(' | ') : 'none')
await app.close()
