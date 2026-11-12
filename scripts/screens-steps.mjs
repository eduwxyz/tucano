// Frames for a reply's steps (#314 / this PR): every step (as always), the latest 20 in a window
// that fades the oldest out, or one line of current activity — chosen in Settings › General right under
// the thinking switch, and per agent on the agent's own page.
// The 25-step reply is seeded: no fake turn makes 25 tool calls, and the window only shows itself
// past 20. Everything else is a real turn of the app.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'C:/tmp/frames/314'
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

const settingsCard = async (win) => {
  await win.locator('.nav-item:has-text("Settings")').first().click()
  await win.waitForSelector('.page')
  const card = win.locator('.card').filter({ hasText: 'The conversation' }).first()
  await card.scrollIntoViewIfNeeded()
  return card
}

// What the steps of the last reply look like: how many rows, the ones left behind, the fading, the window.
const look = (win) =>
  win.evaluate(() => {
    const steps = [...document.querySelectorAll('.steps')].filter((s) => s.querySelector('.steps__toggle')).pop()
    const list = steps?.querySelector('.steps__list')
    const rows = list ? [...list.querySelectorAll('.step')] : []
    const faded = rows.filter((r) => r.classList.contains('step--fading'))
    const opacities = faded.map((r) => Number(getComputedStyle(r).opacity).toFixed(2))
    const box = list?.getBoundingClientRect()
    const mask = list ? getComputedStyle(list).maskImage || getComputedStyle(list).webkitMaskImage : null
    return {
      mode: steps ? [...steps.classList].find((c) => c.startsWith('steps--')) : null,
      hasButton: !!steps?.querySelector('button.steps__toggle'),
      line: steps?.querySelector('.steps__toggle')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      rows: rows.length,
      earlier: list?.querySelector('.steps__earlier')?.textContent ?? null,
      faded: faded.length,
      opacities,
      windowPx: list ? Math.round(list.clientHeight) : 0,
      scrollable: list ? list.scrollHeight > list.clientHeight + 1 : false,
      atTheBottom: list ? Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) < 4 : null,
      mask: mask && mask !== 'none' ? mask.slice(0, 46) : null,
      listTop: box ? Math.round(box.top) : null,
      stop: !!steps?.querySelector('.steps__stop')
    }
  })

// Every reply on screen, as it reads: the one-line mode is proven over all of them at once.
const lines = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.steps')]
      .filter((x) => x.querySelector('.steps__toggle'))
      .map((x) => ({
        mode: [...x.classList].find((c) => c.startsWith('steps--')) ?? null,
        line: x.querySelector('.steps__toggle')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
        rows: x.querySelectorAll('.step').length,
        button: !!x.querySelector('button.steps__toggle')
      }))
  )

// The seeded reply, by its id: the 25-step one, wherever it sits in the conversation.
const SEED = '[data-id="seed-long-reply"]'
const seekSeed = async () => {
  await win.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), SEED)
  await win.waitForTimeout(500)
}
const openSeed = async () => {
  await win.evaluate((sel) => {
    const box = document.querySelector(sel)
    if (box && !box.querySelector('.steps__list')) box.querySelector('.steps__toggle')?.click()
  }, SEED)
  await win.waitForTimeout(500)
}
const lookSeed = () =>
  win.evaluate((sel) => {
    const steps = document.querySelector(sel)?.querySelector('.steps')
    const list = steps?.querySelector('.steps__list')
    const rows = list ? [...list.querySelectorAll('.step')] : []
    const faded = rows.filter((r) => r.classList.contains('step--fading'))
    return {
      mode: steps ? [...steps.classList].find((c) => c.startsWith('steps--')) : null,
      line: steps?.querySelector('.steps__toggle')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      rows: rows.length,
      earlier: list?.querySelector('.steps__earlier')?.textContent ?? null,
      faded: faded.length,
      opacities: faded.map((r) => Number(getComputedStyle(r).opacity).toFixed(2)),
      windowPx: list ? Math.round(list.clientHeight) : 0,
      scrollable: list ? list.scrollHeight > list.clientHeight + 1 : false,
      mask: list ? (getComputedStyle(list).maskImage || getComputedStyle(list).webkitMaskImage).slice(0, 40) : null,
      totalPx: steps ? Math.round(steps.getBoundingClientRect().height) : 0,
      button: !!steps?.querySelector('button.steps__toggle')
    }
  }, SEED)

const channel = async (win, name) => {
  await win.locator('.section .nav-item', { hasText: name }).first().click()
  await win.waitForSelector('.composer textarea')
}
const ask = async (win, text) => {
  await win.locator('.composer textarea').fill(text)
  await win.keyboard.press('Enter')
}
const settle = async (win) => {
  for (let i = 0; i < 200; i++) {
    const working = await win.evaluate(() => !!document.querySelector('.steps__stop'))
    if (!working && i > 6) return
    await win.waitForTimeout(250)
  }
}

let { app, win } = await launch()

// 1. Settings › General: the choice sits under the thinking switch, in the same card.
const card = await settingsCard(win)
const choices = await card.evaluate((c) => [...c.querySelectorAll('.steps-pick button')].map((b) => ({ label: b.textContent?.trim(), on: b.classList.contains('is-active'), role: b.getAttribute('role') })))
console.log('the three choices:', JSON.stringify(choices))
await win.screenshot({ path: `${out}/01-settings-the-three-choices.png` })

// The field itself: the steps line sits under the thinking line, in the same card, and the three
// choices fit without spilling at either width.
const layout = () =>
  win.evaluate(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent?.includes('The conversation'))
    const rows = [...(card?.querySelectorAll('.key-row') ?? [])]
    const thinking = rows.find((r) => r.querySelector('.toggle'))
    const stepsRow = rows.find((r) => r.querySelector('.steps-pick'))
    const pick = stepsRow?.querySelector('.steps-pick')
    const buttons = pick ? [...pick.querySelectorAll('button')] : []
    const rects = buttons.map((b) => b.getBoundingClientRect())
    return {
      sameCard: !!card && !!stepsRow,
      thinkingTop: thinking ? Math.round(thinking.getBoundingClientRect().top) : null,
      stepsTop: stepsRow ? Math.round(stepsRow.getBoundingClientRect().top) : null,
      under: thinking && stepsRow ? stepsRow.getBoundingClientRect().top > thinking.getBoundingClientRect().bottom - 1 : null,
      cardWidth: card ? Math.round(card.getBoundingClientRect().width) : 0,
      pickWidth: pick ? Math.round(pick.getBoundingClientRect().width) : 0,
      pickFits: pick ? pick.scrollWidth <= pick.clientWidth + 1 : null,
      buttonLines: new Set(rects.map((r) => Math.round(r.top))).size,
      cut: buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent?.trim())
    }
  })
console.log('the field at 1280:', JSON.stringify(await layout()))
await win.setViewportSize({ width: 420, height: 880 })
await win.waitForTimeout(400)
await card.scrollIntoViewIfNeeded()
console.log('the field at 420:', JSON.stringify(await layout()))
await win.screenshot({ path: `${out}/02-settings-at-420.png` })
await win.setViewportSize({ width: 1280, height: 880 })
await win.waitForTimeout(300)

// The seeded reply needs 25 steps, so its list is opened by a click: a finished reply starts folded.
const openLast = async () => {
  await win.evaluate(() => {
    const all = [...document.querySelectorAll('.steps')].filter((x) => x.querySelector('.steps__toggle'))
    const last = all[all.length - 1]
    if (last && !last.querySelector('.steps__list')) last.querySelector('.steps__toggle').click()
  })
  await win.waitForTimeout(500)
}

// 2. A real turn first, so the settings are proven on a live reply and not only on a seed.
await channel(win, 'engineering')
await ask(win, 'Lia, o test/wiki-git.test.ts falha aqui. É do build ou da máquina?')
await win.waitForTimeout(2500)
await settle(win)
console.log('a real turn, every step:', JSON.stringify(await look(win)))
await win.screenshot({ path: `${out}/03-all-steps-real-turn.png` })

// 3. The latest 20, picked in the settings.
const card2 = await settingsCard(win)
await card2.locator('.steps-pick button', { hasText: 'Last 20' }).click()
await win.waitForTimeout(300)
const picked = await card2.evaluate((c) => ({
  on: [...c.querySelectorAll('.steps-pick button')].filter((b) => b.classList.contains('is-active')).map((b) => b.textContent?.trim()),
  keep: c.querySelector('.steps-keep input')?.value ?? null,
  hint: c.querySelector('.steps-keep')?.textContent ?? null
}))
console.log('after picking the window:', JSON.stringify(picked))
await win.screenshot({ path: `${out}/04-settings-the-window-picked.png` })
// Back to every step, to shoot the 25 of them as they are today.
await card2.locator('.steps-pick button', { hasText: 'All steps' }).click()
await win.waitForTimeout(200)

// 4. A reply with 25 steps, seeded: no fake turn makes 25 tool calls, and the window shows itself
// only past 20. Every step first — the message runs off the screen — then the window.
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
// Two minutes back, so the real turns after it are what the conversation ends on.
const at = Date.now() - 120_000
db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run, routine, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
  'seed-long-reply',
  conv.id,
  'agent',
  agent.id,
  'Os testes passam agora. O problema era o caminho do Node, não o teste.',
  at,
  JSON.stringify({ status: 'done', endedAt: at + 21_000, steps }),
  null,
  null
)
db.close()

;({ app, win } = await launch())
await channel(win, 'engineering')
await win.evaluate(() => document.querySelector('.messages')?.scrollTo({ top: 1e9 }))
await win.waitForTimeout(800)
await seekSeed()
await openSeed()
const every = await lookSeed()
console.log('every step, 25 of them:', JSON.stringify(every))
await win.screenshot({ path: `${out}/05-every-step.png` })

// 5. The window: 20 rows, the 5 left out said, the oldest faded out at the top.
const card3 = await settingsCard(win)
await card3.locator('.steps-pick button', { hasText: 'Last 20' }).click()
await win.waitForTimeout(300)
await channel(win, 'engineering')
await win.evaluate(() => document.querySelector('.messages')?.scrollTo({ top: 1e9 }))
await win.waitForTimeout(400)
await seekSeed()
await openSeed()
const windowed = await lookSeed()
console.log('the window on a 25-step reply:', JSON.stringify(windowed))
await win.screenshot({ path: `${out}/06-window-at-1280.png` })

// The same window at 420 px: nothing sideways, the fade still there.
await win.setViewportSize({ width: 420, height: 880 })
await win.waitForTimeout(400)
await win.evaluate((sel) => {
  document.querySelector(sel)?.scrollIntoView({ block: 'center' })
  const list = document.querySelector(sel)?.querySelector('.steps__list')
  list?.scrollTo({ top: list.scrollHeight })
}, SEED)
await win.waitForTimeout(600)
const narrow = await lookSeed()
const sideways = await win.evaluate(() => ({ page: [document.documentElement.scrollWidth, document.documentElement.clientWidth], overflow: [...document.querySelectorAll('.steps, .steps__list, .step')].filter((e) => e.scrollWidth > e.clientWidth + 1).length }))
console.log('at 420 px:', JSON.stringify({ ...narrow, ...sideways }))
await win.screenshot({ path: `${out}/07-window-at-420.png` })
await win.setViewportSize({ width: 1280, height: 880 })

// 6. One line: current activity, folded by default, the stop and the time still there.
const card4 = await settingsCard(win)
await card4.locator('.steps-pick button', { hasText: 'One line' }).click()
await win.waitForTimeout(300)
await channel(win, 'engineering')
await ask(win, 'Rafa, quem responde o ticket 412?')
let oneLine = null
for (let i = 0; i < 60; i++) {
  const l = await look(win)
  if (l.mode === 'steps--one-line' && l.stop) {
    oneLine = l
    break
  }
  await win.waitForTimeout(150)
}
console.log('one line, while it works:', JSON.stringify(oneLine))
await win.screenshot({ path: `${out}/08-one-line.png` })
await settle(win)
await win.waitForTimeout(800)
const oneLineDone = await look(win)
const allLines = await lines(win)
console.log('one line, after it ends:', JSON.stringify(oneLineDone))
console.log('every reply in the conversation, one line chosen:', JSON.stringify(allLines))
await win.screenshot({ path: `${out}/09-one-line-done.png` })

// 7. One agent's own page: "App setting" plus the three, and its own choice winning over the app's.
const card5 = await settingsCard(win)
await card5.locator('.steps-pick button', { hasText: 'All steps' }).click()
await win.waitForTimeout(200)
await win.locator('.nav-item', { hasText: 'Lia' }).first().click()
await win.waitForSelector('.agent-form, .page')
await win.waitForTimeout(400)
await win.locator('.tabs button', { hasText: 'Tools' }).first().click()
await win.waitForTimeout(300)
const agentPick = win.locator('.steps-pick').first()
await agentPick.scrollIntoViewIfNeeded()
const agentChoices = await win.evaluate(() => [...document.querySelectorAll('.steps-pick button')].map((b) => ({ label: b.textContent?.trim(), on: b.classList.contains('is-active') })))
console.log("the agent's own page:", JSON.stringify(agentChoices))
const agentLayout = await agentPick.evaluate((p) => {
  const buttons = [...p.querySelectorAll('button')]
  return {
    width: Math.round(p.getBoundingClientRect().width),
    fits: p.scrollWidth <= p.clientWidth + 1,
    lines: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
    cut: buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent?.trim())
  }
})
console.log("the agent's pick:", JSON.stringify(agentLayout))
await win.screenshot({ path: `${out}/10-agent-own-setting.png` })
await agentPick.locator('button', { hasText: 'One line' }).click()
await win.waitForTimeout(600)

// The app says All steps; this agent says one line. Its reply draws without a list.
await win.locator('.nav-item:has-text("engineering"), .section .nav-item', { hasText: 'engineering' }).first().click()
await ask(win, 'Lia, e o resto do build?')
let own = null
for (let i = 0; i < 60; i++) {
  const l = await look(win)
  if (l.mode?.startsWith('steps--') && l.stop) {
    own = l
    break
  }
  await win.waitForTimeout(150)
}
console.log("the agent's own line, app on All steps:", JSON.stringify(own))
await win.screenshot({ path: `${out}/11-agent-own-line.png` })

console.log('errors:', JSON.stringify(errors))
await app.close()
rmSync(data, { recursive: true, force: true })
