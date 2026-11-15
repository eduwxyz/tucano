// Proves where a prompt sits when two sessions run at once, and the glyph that goes back to it.
// A temp TUCANO_DATA and the fake engines: nothing here touches the real database.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'C:/tmp/prompt-order-screens'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' }
const errors = []
const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 820 })
  await win.waitForSelector('.sidebar')
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return { app, win }
}

// The rows in the order they are drawn: mine by "você", an agent by its name.
const rowsIn = (win) =>
  win.$$eval('.messages > .msg', (els) =>
    els.map((e) => ({
      id: e.dataset.id,
      mine: e.classList.contains('msg--me'),
      who: e.querySelector('.msg__author')?.textContent?.trim() ?? '',
      live: !!e.querySelector('.steps__pulse, .shimmer'),
      up: !!e.querySelector('.msg__reply--up')
    }))
  )

// ---------- 1. two prompts written while both replies are still at work ----------
let live
{
  const { app, win } = await launch()
  const send = async (text) => {
    await win.fill('.composer textarea', text)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(120)
  }
  await win.click('.sidebar >> text=engineering')
  await win.waitForSelector('.composer textarea')
  for (const line of ['Resume o que mudou no asSaid.', 'E o que isso muda na tela?', 'Tem teste pra isso?'])
    await send(`@lia ${line}`)
  await win.waitForTimeout(1500)
  await send('@lia revise o diff do Conversation.tsx e me diga se o asSaid mudou de ordem.')
  await send('@theo rode a suíte de testes e liste o que falhou.')
  let both = []
  for (let i = 0; i < 40; i++) {
    both = await rowsIn(win)
    if (both.filter((r) => r.live).length >= 2) break
    await win.waitForTimeout(120)
  }
  await win.screenshot({ path: `${out}/01-dois-pedidos.png` })
  live = both.map((r) => `${r.mine ? 'me' : r.who}${r.live ? ' (ao vivo)' : ''}`)
  await app.close()
}

// ---------- 2. a tall reply whose prompt is far above it ----------
const tall = 'tall-270'
{
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const conv = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' AND name IN ('engineering', 'engenharia')").get()
  const member = db.prepare('SELECT agent_id FROM members WHERE conversation_id = ? LIMIT 1').get(conv.id)
  const prompt = 'Leia Conversation.tsx inteiro e me diga, passo a passo, onde cada pedido é posicionado.'
  db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, ?, ?, ?, ?)').run('tall-prompt', conv.id, 'person', 'owner', prompt, Date.now() - 300_000)
  // Said after the prompt, before the reply ended: that is what leaves the prompt behind, several
  // rows above the reply that answers it.
  const between = ['Vai com calma, mas me responde por partes.', 'Começa pelo começo.', 'Depois o meio.', 'E o fim.', 'Isso.']
  between.forEach((text, i) =>
    db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(`tall-mid-${i}`, conv.id, 'person', 'owner', text, Date.now() - 295_000 + i * 1000)
  )
  const steps = Array.from({ length: 26 }, (_, i) => ({
    id: `s${i}`,
    label: ['Read src/renderer/src/components/Conversation.tsx', 'Searched the code for asSaid', 'Read src/shared/types.ts', 'Ran npm run typecheck', 'Ran npx vitest run test/reply-order.test.ts'][i % 5],
    detail: ['Conversation.tsx', 'asSaid', 'types.ts', '', '11 passed'][i % 5] || undefined,
    output: ['420 lines', '6 hits', '384 lines', 'clean', '11 passed'][i % 5],
    status: 'done',
    ms: 240 + i * 37
  }))
  db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    tall,
    conv.id,
    'agent',
    member.agent_id,
    'O pedido fica na posição dele, e a resposta atrás: é o `asSaid` que decide isso.',
    Date.now() - 240_000,
    JSON.stringify({ status: 'done', steps, endedAt: Date.now() - 200_000, replyTo: 'tall-prompt' })
  )
  for (let i = 0; i < 8; i++)
    db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(
      `after-${i}`,
      conv.id,
      'person',
      'owner',
      ['E no fim da lista?', 'Certo.', 'E quando a resposta demora?', 'Ok.', 'Isso muda o scroll?', 'Bom.', 'Obrigado.', 'Só isso mesmo.'][i],
      Date.now() - 120_000 + i * 1000
    )
  db.close()
}

// ---------- 3. hover it, click the glyph, and see where the list lands ----------
let upBox
let threadBox
let scrolled
let flashed
let atTop
{
  const { app, win } = await launch()
  await win.click('.sidebar >> text=engineering')
  await win.waitForSelector('.messages > .msg')
  await win.waitForTimeout(700)
  const scroller = win.locator('.messages')
  // A run that ended arrives folded; open it, or the chain is three lines tall.
  const tallRow = win.locator(`.messages > .msg[data-id="${tall}"]`)
  await tallRow.locator('.steps__toggle').click()
  await win.waitForTimeout(400)
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await win.waitForTimeout(500)
  // Its first line at the top of the list: that is where the corner the glyphs live in is.
  const row = tallRow
  await row.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await win.waitForTimeout(300)
  await row.hover()
  await win.waitForTimeout(300)
  const up = row.locator('.msg__reply--up')
  const thread = row.locator('.msg__reply:not(.msg__reply--up)')
  upBox = await up.boundingBox()
  threadBox = await thread.boundingBox()
  await win.screenshot({ path: `${out}/02-glyph-under-thread.png` })
  if (threadBox.y > 40)
    await win.screenshot({ path: `${out}/03-glyph-corner.png`, clip: { x: Math.max(0, threadBox.x - 330), y: threadBox.y - 40, width: 360, height: 92 } })
  const before = await scroller.evaluate((el) => el.scrollTop)
  await up.click()
  await win.waitForTimeout(800)
  const after = await scroller.evaluate((el) => el.scrollTop)
  scrolled = { before, after, delta: after - before }
  flashed = await win.$$eval('.messages > .msg.is-flash', (els) => els.map((e) => e.dataset.id))
  atTop = await win.evaluate(() => {
    const el = document.querySelector('.messages')
    if (!el) return null
    const first = [...el.querySelectorAll(':scope > .msg')].find((r) => r.getBoundingClientRect().top >= el.getBoundingClientRect().top - 30)
    return first ? { id: first.dataset.id } : null
  })
  await win.screenshot({ path: `${out}/04-de-volta-ao-pedido.png` })
  await app.close()
}

console.log(JSON.stringify({ live, upBox, threadBox, gap: upBox.y - threadBox.y, scrolled, flashed, atTop, errors }, null, 2))
