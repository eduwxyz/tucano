// A next-steps card: the work the agent proposes after its reply, in boxes that all open clear —
// like a question. With a classifier assigned to that job in Settings › Models › Classifiers, only the
// steps it would do now open ticked, with the Recommended pill; what gets ticked comes back as the
// person's message. No classifier can be reached from a seeded run, so that subset is written onto
// the waiting message the way the core writes it, then the app reloads.
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
console.log('ticked with no classifier on the job:', await ticked())
console.log('pill in the head:', await win.locator('.ask--steps .ask__head .ask-option__pill').count())
console.log('button:', await win.locator('.ask--steps .btn--primary').innerText())
console.log('button disabled with nothing ticked:', await win.locator('.ask--steps .btn--primary').isDisabled())
await shot('01-todas-desmarcadas')

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
console.log('ticked with a classifier on the job:', await ticked())
console.log('pills on the picked steps:', await win.locator('.ask--steps .ask-option__pill').count())
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

// The job, in Settings › Models › Classifiers: add one classifier, then read the three jobs and set
// the next-steps one to it.
try {
  await win.locator('.sidebar__foot .nav-item').last().click()
  await win.waitForSelector('.tabs', { timeout: 8000 })
  await win.waitForTimeout(500)
  const tabs = win.locator('.tabs [role="tab"]')
  const names = await tabs.allInnerTexts()
  const i = names.findIndex((n) => /^(Modelos|Models)$/.test(n.trim()))
  if (i < 0) throw new Error('no Models tab in ' + JSON.stringify(names))
  await tabs.nth(i).click()
  await win.waitForTimeout(900)
  const card = win.locator('.card').filter({ hasText: 'Classifiers' }).last()
  await card.scrollIntoViewIfNeeded({ timeout: 8000 })
  const add = card.locator('button').filter({ hasText: /Adicionar classificador|Add classifier/ })
  await add.click()
  await win.waitForTimeout(400)
  await card.locator('button').filter({ hasText: /^Adicionar$|^Add$/ }).click()
  await win.waitForTimeout(500)
  await card.locator('button').filter({ hasText: /^Cancelar$|^Cancel$/ }).first().click()
  await win.waitForTimeout(500)
  // The third job in the section: its own label, beside who replies and what an agent clicks.
  const job = win.locator('.field').filter({ has: win.locator('.field__label', { hasText: /^(Quais próximos passos já vêm marcados|Which next steps start ticked)$/ }) })
  await job.scrollIntoViewIfNeeded({ timeout: 8000 })
  await win.waitForTimeout(400)
  console.log('job before:', JSON.stringify((await job.innerText()).replace(/\n/g, ' | ').slice(0, 90)))
  await shot('05-classificadores-desligado')
  await job.locator('.select__trigger').click({ timeout: 8000 })
  await win.waitForTimeout(400)
  await win.locator('[role="option"]').filter({ hasText: /^Jev/ }).first().click()
  await win.waitForTimeout(700)
  console.log('job now:', (await job.innerText()).replace(/\n/g, ' | ').slice(0, 160))
  await shot('06-classificadores-ligado')
} catch (e) {
  console.log('settings frame skipped:', String(e).split(NL)[0])
}
console.log('page errors:', errors.length ? errors.join(' | ') : 'none')
await app.close()
