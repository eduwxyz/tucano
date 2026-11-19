// Frames for the Asks page carrying a question the model made with several options at once
// (#240 / PR #247): a multiple-choice decision with long, multi-line option labels, shown on the
// page and answered there.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'C:/tmp/frames/247-multi'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }

const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

const decisions = [
  {
    question: 'Quais destes eu ligo agora, antes de publicar?',
    kind: 'multiple',
    options: [
      { label: 'O teste do macOS', description: 'roda em ~4 min e é o único que já pegou um erro de build de verdade' },
      { label: 'O teste do Windows, shard 3', description: 'falhou duas vezes esta semana por tempo de abertura do Chrome, não por código' },
      { label: 'O lint e o typecheck completos', description: '~40 s, nunca falhou, mas é o que impede um push torto' }
    ]
  },
  { question: 'E o merge: hoje ou amanhã de manhã?', kind: 'single', options: [{ label: 'Hoje' }, { label: 'Amanhã de manhã' }] }
]

{
  const { app } = await launch()
  await app.close()
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const eng = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' AND name = 'engineering'").get()
  const lia = db.prepare("SELECT id, name FROM agents WHERE handle = 'lia'").get()
  const me = db.prepare('SELECT id, name FROM people WHERE removed_at IS NULL LIMIT 1').get()
  const at = Date.now() - 600_000
  db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'q-multi',
    eng.id,
    'agent',
    lia.id,
    'Build limpo nas três plataformas. Antes de publicar eu preciso saber o que você quer que eu confira.',
    at,
    JSON.stringify({
      status: 'waiting_input',
      question: decisions[0].question,
      questions: decisions,
      steps: [{ id: 's1', label: 'Ran npm run build', output: 'clean', status: 'done', ms: 1500 }],
      endedAt: null
    })
  )
  db.prepare(
    "INSERT INTO questions (id, conversation_id, thread_id, agent_id, text, asked_to, requested_by, confirm_state, state, deadline_at, told_at, answered_by, answered_at, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 'open', ?, NULL, NULL, NULL, ?)"
  ).run('q-multi', eng.id, lia.id, decisions[0].question, me.id, me.id, at + 4 * 3_600_000, at)
  db.close()
  console.log('seeded one multiple-choice ask for', me.name)
}

const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => {
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${out}/${name}.png` })
}
const look = () =>
  win.evaluate(() => {
    const card = document.querySelector('.ask')
    const opts = [...document.querySelectorAll('.ask-option')]
    const boxes = opts.map((o) => Math.round(o.getBoundingClientRect().height))
    return {
      card: !!card,
      count: opts.length,
      roles: opts.map((o) => o.getAttribute('role')),
      heights: boxes,
      marked: opts.map((o) => o.querySelector('.ask-option__mark')?.className ?? ''),
      // the longest label wrapped onto more than one line?
      labelLines: opts.map((o) => {
        const l = o.querySelector('.ask-option__label') ?? o
        const s = getComputedStyle(l)
        return Math.round(l.getBoundingClientRect().height / parseFloat(s.lineHeight || '16'))
      }),
      overflows: opts.some((o) => o.scrollWidth > o.clientWidth + 1)
    }
  })

await win.waitForTimeout(1200)
console.log('sidebar:', (await win.locator('.sidebar .nav-item').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).join(' | '))
await win.locator('.sidebar .nav-item', { hasText: 'Asks' }).first().click()
await win.waitForTimeout(800)
console.log('page text:', (await win.locator('main, .page').first().innerText()).slice(0, 400))
await win.waitForSelector('.ask', { timeout: 10000 })
console.log('on the page:', JSON.stringify(await look(), null, 1))
await shot('01-multiple-choice-on-the-page')

// The same card at phone width.
await win.setViewportSize({ width: 420, height: 880 })
await win.waitForTimeout(500)
console.log('at 420:', JSON.stringify(await look(), null, 1))
await shot('02-multiple-choice-at-420')
await win.setViewportSize({ width: 1280, height: 880 })
await win.waitForTimeout(400)

// Two of the three ticked, then confirmed: the card walks decision to decision and reviews.
await win.locator('.ask-option').nth(0).click()
await win.locator('.ask-option').nth(2).click()
const ticked = await win.evaluate(() => [...document.querySelectorAll('.ask-option')].map((o) => `${o.getAttribute('role')}:${o.getAttribute('aria-checked')}`))
console.log('ticked:', JSON.stringify(ticked))
await shot('03-two-of-three-ticked')

await win.locator('.ask__next').click()
await win.waitForTimeout(300)
await win.locator('.ask-option').nth(0).click()
await win.waitForTimeout(300)
const second = await win.evaluate(() => ({ count: document.querySelector('.ask__count')?.textContent ?? null, options: document.querySelectorAll('.ask-option').length }))
console.log('second decision:', JSON.stringify(second))
await win.waitForTimeout(400)
const review = await win.evaluate(() => ({ rows: [...document.querySelectorAll('.ask-review__row')].map((r) => (r.textContent ?? '').slice(0, 90)), count: document.querySelector('.ask__count')?.textContent ?? null }))
console.log('review:', JSON.stringify(review, null, 1))
await shot('04-review-before-sending')

await win.locator('.ask__foot button.btn--primary').click()
await win.waitForTimeout(1200)
const after = await win.evaluate(() => ({
  open: document.querySelectorAll('.ask--answer').length,
  summaries: document.querySelectorAll('.ask-summary').length,
  page: (document.querySelector('main, .page')?.textContent ?? '').slice(0, 200)
}))
console.log('after answering:', JSON.stringify(after, null, 1))
await shot('05-answered-from-the-page')

console.log('errors:', JSON.stringify(errors))
await app.close()
rmSync(data, { recursive: true, force: true })
