// Proves where the "Reply in thread" button sits on a run taller than the screen (#270).
// Seeds a workspace, drops a 26-step run into it, then measures and shoots the button at three
// scroll positions. Nothing here touches the real database: a temp TUCANO_DATA and the fake engines.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'C:/tmp/thread-btn-screens'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' }

const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 820 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// ---------- 1. make the workspace ----------
{
  const { app } = await launch()
  await app.close()
}

// ---------- 2. put a long run in it ----------
const id = 'run-270'
const channel = (() => {
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const row = db.prepare("SELECT id, name FROM conversations WHERE kind = 'channel' AND name IN ('engineering', 'engenharia')").get()
  const member = db.prepare('SELECT agent_id FROM members WHERE conversation_id = ? LIMIT 1').get(row.id)
  const steps = Array.from({ length: 26 }, (_, i) => ({
    id: `s${i}`,
    label: [
      'Read src/renderer/src/components/Conversation.tsx',
      'Searched the code for msg__reply',
      'Read src/renderer/src/styles.css',
      'Ran npm run typecheck',
      'Ran npx vitest run test/wiki.test.ts',
      'Read src/renderer/src/components/RunSteps.tsx'
    ][i % 6],
    detail: ['Conversation.tsx', 'msg__reply', 'styles.css', '', '39 passed', 'RunSteps.tsx'][i % 6] || undefined,
    output: ['420 lines', '3 hits', '3 180 lines', 'clean', '39 passed', '96 lines'][i % 6],
    status: 'done',
    ms: 240 + i * 37
  }))
  const run = { status: 'done', steps, endedAt: Date.now() - 60_000 }
  db.prepare('UPDATE conversations SET threads = 1 WHERE id = ?').run(row.id)
  db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    row.id,
    'agent',
    member.agent_id,
    'Achei: o botão é `position: absolute` contra a mensagem inteira, e a lista de passos não tem altura máxima. Proposta: um pino `sticky` de altura zero no topo da execução.',
    Date.now() - 90_000,
    JSON.stringify(run)
  )
  // Enough after it that the run can scroll all the way past the top of the list.
  for (let i = 0; i < 24; i++)
    db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(
      `after-270-${i}`,
      row.id,
      'agent',
      member.agent_id,
      `Resumo ${i + 1}: o botão sai do topo da mensagem e passa a acompanhar a execução enquanto ela rola.

Fica no canto de cima da execução, não no começo da mensagem, então continua à mão quando a cadeia é mais alta que a tela.`,
      Date.now() - 30_000 + i * 1000
    )
  db.close()
  console.log('seeded', row.name, 'in', row.id)
})()

// ---------- 3. look at it ----------
const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await win.locator(`.section .nav-item:has-text("engineering"), .section .nav-item:has-text("engenharia")`).first().click()
await win.waitForSelector(`.msg[data-id="${id}"]`)
// A finished run reads closed; open it, like a person would to look at a long chain.
await win.locator(`.msg[data-id="${id}"] .steps__toggle`).click()
await win.waitForSelector(`.msg[data-id="${id}"] .steps.is-open`)
await win.waitForTimeout(400)

// Hover the message first: the button is revealed on hover, and a shot of an invisible button proves nothing.
const hoverMessage = async () => {
  const box = await win.locator(`.msg[data-id="${id}"] .step__label`).first().boundingBox()
  if (box) await win.mouse.move(box.x + 40, Math.min(Math.max(box.y + 4, 80), 690))
  await win.waitForTimeout(120)
}
const shot = async (name) => {
  await hoverMessage()
  await win.screenshot({ path: `${out}/${name}.png` })
}

// Scroll the conversation so a given step sits at the top of the visible list.
const scrollToStep = async (n) =>
  win.evaluate(
    ({ id, n }) => {
      const list = document.querySelector('.messages')
      const step = document.querySelectorAll(`.msg[data-id="${id}"] .steps__list .step`)[n]
      list.scrollTop += step.getBoundingClientRect().top - list.getBoundingClientRect().top - 20
    },
    { id, n }
  )

// What the screen says: where the button is, and whether it sits on anything of the run.
const measure = async () => {
  await hoverMessage()
  return win.evaluate((id) => {
    const r = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
    }
    const list = document.querySelector('.messages')
    const msg = document.querySelector(`.msg[data-id="${id}"]`)
    const btn = msg.querySelector('.msg__anchor-pin .msg__reply')
    const b = btn.getBoundingClientRect()
    const lb = list.getBoundingClientRect()
    const over = []
    for (const el of msg.querySelectorAll('.step__ms, .step__label, .step__output, .step__detail, .step__note, .md')) {
      const s = el.getBoundingClientRect()
      if (s.width && s.height && b.left < s.right && b.right > s.left && b.top < s.bottom && b.bottom > s.top) over.push(el.className)
    }
    const first = msg.querySelector('.steps__list .step')
    const mb = msg.getBoundingClientRect()
    return {
      scrollTop: Math.round(list.scrollTop),
      button: r(btn),
      buttonInView: b.top >= lb.top && b.bottom <= lb.bottom,
      buttonOpacity: getComputedStyle(btn).opacity,
      fromMessageRight: Math.round(mb.right - b.right), // 4px is where it sat before
      fromVisibleTop: Math.round(b.top - lb.top),
      over,
      firstStepTop: Math.round(first.getBoundingClientRect().top),
      stepsTop: Math.round(msg.querySelector('.steps').getBoundingClientRect().top),
      stepsBottom: Math.round(msg.querySelector('.steps').getBoundingClientRect().bottom),
      // The gap the head's margin and the steps' own top margin made before there was an anchor (1px).
      headGap: Math.round(
        msg.querySelector('.steps').getBoundingClientRect().top - msg.querySelector('.msg__head').getBoundingClientRect().bottom
      )
    }
  }, id)
}

const report = {}
report.top = (await scrollToStep(0), await win.waitForTimeout(200), await measure())
await shot('01-run-top')

report.middle = (await scrollToStep(12), await win.waitForTimeout(200), await measure())
await shot('02-run-middle')

report.last = (await scrollToStep(24), await win.waitForTimeout(200), await measure())
await shot('03-run-last')

// The message half out of viewport: its head is above the top, its last steps are on screen.
await scrollToStep(18)
await win.waitForTimeout(200)
report.halfOut = await measure()
await shot('04-half-out')

// The run has scrolled completely past: the button must leave with it, not hang over what follows.
await scrollToStep(25)
await win.evaluate(() => (document.querySelector('.messages').scrollTop += 400))
await win.waitForTimeout(250)
report.past = await measure()
await shot('05-past')

// The end of the conversation, with the run behind us.
await win.evaluate(() => {
  const list = document.querySelector('.messages')
  list.scrollTop = list.scrollHeight
})
await win.waitForTimeout(250)
report.end = await measure()
await shot('06-end')

// Nothing shifts: the pin is zero-height, so taking it out moves no step.
const shift = await win.evaluate((id) => {
  const msg = document.querySelector(`.msg[data-id="${id}"]`)
  const steps = msg.querySelector('.steps')
  const before = steps.getBoundingClientRect().top
  const pin = msg.querySelector('.msg__anchor-pin')
  pin.style.display = 'none'
  const after = steps.getBoundingClientRect().top
  pin.style.display = ''
  const anchor = msg.querySelector('.msg__anchor')
  return { before: Math.round(before), after: Math.round(after), anchorMarginTop: getComputedStyle(anchor).marginTop }
}, id)

// A message with no run keeps the corner it always had.
await win.evaluate(() => (document.querySelector('.messages').scrollTop = 0))
await win.locator('.composer textarea').fill('@lia onde fica o botão da thread numa mensagem curta?')
await win.keyboard.press('Enter')
await win.waitForTimeout(1500)
const shortTab = await win.evaluate((id) => {
  const msgs = [...document.querySelectorAll('.msg')]
  const short = msgs.filter((m) => !m.querySelector('.steps__list')).at(-1)
  if (!short) return null
  const btn = short.querySelector('.msg__reply')
  if (!btn) return null
  const b = btn.getBoundingClientRect()
  const m = short.getBoundingClientRect()
  return { pinned: !!btn.closest('.msg__anchor-pin'), fromMessageRight: Math.round(m.right - b.right), fromMessageTop: Math.round(b.top - m.top) }
}, id)

console.log(JSON.stringify({ report, shift, shortTab, errors }, null, 2))
await app.close()
rmSync(data, { recursive: true, force: true })
