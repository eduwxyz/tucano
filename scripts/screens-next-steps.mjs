// A next-steps card from the built app: it opens with nothing ticked, holds nothing up when the
// person writes something else instead, comes back as a message when ticked, fits a narrow window,
// survives a restart, gives way to a newer card and closes quietly on Cancel. Usage: node scripts/screens-next-steps.mjs <folder for the frames>
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens'
mkdirSync(out, { recursive: true })
const data = process.env.TUCANO_DATA ?? mkdtempSync(join(tmpdir(), 'tucano-steps-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const errors = []

async function open() {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}
let { app, win } = await open()

const shot = (name) => win.screenshot({ path: join(out, `${name}.png`) })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle() {
  const deadline = Date.now() + 20_000
  let quiet = 0
  while (Date.now() < deadline && quiet < 3) {
    await win.waitForTimeout(400)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  await settle()
}
const openCard = () => win.locator('.ask--steps.ask--answer').last()
const stored = () => {
  const db = new DatabaseSync(join(data, 'tucano.db'), { readOnly: true })
  const cards = db.prepare("SELECT json_extract(run, '$.status') AS status, json_extract(run, '$.stepsOpen') AS open, json_extract(run, '$.stepsReplaced') AS replaced FROM messages WHERE json_extract(run, '$.questions[0].nextSteps') = 1 ORDER BY at").all()
  const asked = db.prepare("SELECT count(*) AS n FROM questions WHERE state = 'open'").get().n
  const waiting = db.prepare("SELECT count(*) AS n FROM messages WHERE json_extract(run, '$.status') = 'waiting_input'").get().n
  db.close()
  return { cards: cards.map((c) => `${c.status}${c.open ? '+open' : ''}${c.replaced ? '+replaced' : ''}`), openQuestions: asked, waitingReplies: waiting }
}
const log = (label, value) => console.log(`${label}:`, typeof value === 'string' ? value : JSON.stringify(value))

// 1. It opens clear, and reads as optional: the reply is done.
await send('@Lia me dá os próximos passos')
await win.waitForSelector('.ask--steps', { timeout: 20_000 })
log('steps', await openCard().locator('[role="checkbox"]').count())
log('ticked', await openCard().locator('[aria-checked="true"]').count())
log('Do these disabled', await openCard().locator('.btn--primary').isDisabled())
log('badge', (await openCard().locator('.ask__badge').innerText()).trim())
log('hint', await openCard().locator('.ask__hint').innerText())
log('says waiting anywhere', await win.locator('.ask--steps', { hasText: /Esperando você|Waiting for you/ }).count())
log('field placeholder', await win.locator('.composer textarea').getAttribute('placeholder'))
log('stored', stored())
await openCard().scrollIntoViewIfNeeded()
await shot('01-abre-vazio')

// 2. Ignored: what's written is a request of its own, and the card stays as it was.
const before = await win.locator('.msg').count()
await openCard().locator('[role="checkbox"]').nth(1).click() // ticked and never sent
await send('Outra coisa: qual a capital da França?')
await win.waitForTimeout(600)
log('messages added by writing something else', (await win.locator('.msg').count()) - before)
log('card still open', await win.locator('.ask--steps.ask--answer').count())
log('stored after an unrelated message', stored())
const texts = await win.locator('.msg').allInnerTexts()
log('my last message', texts.filter((t) => t.includes('capital da França')).at(-1)?.slice(0, 120) ?? '')
await shot('02-ignorado')

// 3. Ticked and sent: what was ticked comes back as the person's message.
await openCard().locator('[role="checkbox"]').nth(2).click()
await openCard().scrollIntoViewIfNeeded()
log('ticked before sending', await openCard().locator('[aria-checked="true"]').count())
log('Do these enabled', await openCard().locator('.btn--primary').isEnabled())
await shot('03-marcados')
await openCard().locator('.btn--primary').click()
await settle()
await win.waitForTimeout(600)
log('cards answered', await win.locator('.ask--steps.ask--done').count())
log('stored after answering', stored())
await win.locator('.ask--steps.ask--done').last().scrollIntoViewIfNeeded()
await shot('04-respondido')

// 4. A new card, in a narrow window: nothing past its edge.
await send('@Lia e agora, os próximos passos')
await win.waitForSelector('.ask--steps.ask--answer', { timeout: 20_000 })
await win.setViewportSize({ width: 420, height: 860 })
await win.waitForTimeout(700)
await openCard().scrollIntoViewIfNeeded()
log('420px: past the card edge', await openCard().evaluate((card) => {
  const edge = card.getBoundingClientRect().right
  return [...card.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > edge + 0.5).map((el) => el.className || el.tagName)
}))
log('420px: page scrolls sideways', await win.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
await shot('05-420px')
await win.setViewportSize({ width: 1280, height: 860 })

// 5. A restart keeps it open and answerable.
await app.close()
;({ app, win } = await open())
await win.waitForSelector('.ask--steps.ask--answer', { timeout: 25_000 })
await win.waitForTimeout(500)
log('after a restart: open cards', await win.locator('.ask--steps.ask--answer').count())
log('after a restart: stored', stored())
await openCard().scrollIntoViewIfNeeded()
await shot('06-depois-de-reiniciar')

// 6. No Skip on this card, and a newer card from the same agent takes the place of the open one.
log('Skip buttons on the card', await openCard().getByRole('button', { name: /^(Pular|Skip)$/ }).count())
await send('@Lia mais uma vez, os próximos passos')
await win.waitForTimeout(600)
log('after a newer card: open cards', await win.locator('.ask--steps.ask--answer').count())
log('after a newer card: stored', stored())
await win.locator('.ask--steps.ask--done', { hasText: /Substituído|Replaced/ }).last().scrollIntoViewIfNeeded()
await shot('07-substituido')

// 7. Cancel closes it, and no one is woken.
const replies = await win.locator('.msg').count()
await openCard().getByRole('button', { name: /^(Cancelar|Cancel)$/ }).click()
await settle()
log('messages added by Cancel', (await win.locator('.msg').count()) - replies)
log('after Cancel: stored', stored())

log('page errors', errors.length ? errors : 'none')
await app.close()
