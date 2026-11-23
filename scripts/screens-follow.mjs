// Frames for Follow and for where its pill sits: on the reply's own line under the answer, next to the
// receipt and the way into the wiki, reading Follow where it read Steer while the reply worked. It
// opens the same field under that line, and what the person writes goes to that reply: the reply goes
// on in the same row, keeping its text and its steps, with the instruction as a row of its own in the
// chain. Nothing of it is posted as a message in the conversation.
// The fake engine answers quickly, so the reply has ended before anything is shot: this is the state
// the feature exists for.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'C:/tmp/frames/631'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
// A profile of its own: the installed app on screen must not turn this launch into no window at all.
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []

const launch = async () => {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'electron')}`], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  app.process().stderr?.on('data', (d) => {
    const line = String(d)
    if (/error|exception|unhandled/i.test(line) && !/gpu|command_buffer|GLES|vulkan/i.test(line))
      errors.push(`main: ${line.trim().slice(0, 300)}`)
  })
  return { app, win }
}

// The skill the fake turn reads, so the chain has real steps to keep. A workspace made from scratch
// has whatever the harness folders on this computer hold; inserting one keeps the run off them.
const SEED_SKILL = 'follow-demo'
const seedSkill = () => {
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const now = Date.now()
  db.prepare(
    `INSERT INTO skills (id, name, description, body, agents, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', 'active', ?, ?)
     ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at`
  ).run('demo-skill', SEED_SKILL, 'A skill that exists so a reply has something to read', 'Read this, then do the work.', now, now)
  db.close()
}

const channel = async (win, name) => {
  await win.locator('.section .nav-item', { hasText: name }).first().click()
  await win.waitForSelector('.composer textarea')
}
const ask = async (win, text) => {
  await win.locator('.composer textarea').fill(text)
  await win.keyboard.press('Enter')
}
const settled = async (win) => {
  for (let i = 0; i < 240; i++) {
    const done = await win.evaluate(() => {
      const msgs = [...document.querySelectorAll('.msg--agent')]
      const last = msgs[msgs.length - 1]
      return !!last?.querySelector('.steps__summary') && !last.querySelector('.steps__stop')
    })
    if (done) return true
    await win.waitForTimeout(250)
  }
  return false
}

// The pill on the reply that ended: what it says, and where it sits on the reply's own line.
const pillLook = (win) =>
  win.evaluate(() => {
    const msgs = [...document.querySelectorAll('.msg--agent')]
    const msg = msgs[msgs.length - 1]
    const meta = msg?.querySelector('.msg__meta')
    const pill = meta?.querySelector('.steps__steer-pill')
    if (!meta || !pill) return { pill: false, line: !!meta }
    const p = pill.getBoundingClientRect()
    const m = meta.getBoundingClientRect()
    const receipt = meta.querySelector('.receipt')?.getBoundingClientRect()
    const wiki = meta.querySelector('.wiki-keep')?.getBoundingClientRect()
    const text = msg?.querySelector('.md')?.getBoundingClientRect()
    const steps = msg?.querySelector('.steps')?.getBoundingClientRect()
    const st = getComputedStyle(pill)
    return {
      pill: true,
      tag: pill.tagName,
      text: pill.textContent?.replace(/\s+/g, ' ').trim(),
      title: pill.getAttribute('title'),
      width: Math.round(p.width),
      height: Math.round(p.height),
      radius: st.borderRadius,
      fontSize: st.fontSize,
      color: st.color,
      line: meta.className,
      onTheLine: meta.contains(pill),
      firstOnTheLine: meta.firstElementChild === pill,
      underTheAnswer: text ? Math.round(p.top - text.bottom) : null,
      underTheChain: steps ? Math.round(p.top - steps.bottom) : null,
      leftAgainstTheLine: Math.round(p.left - m.left),
      receiptAfterIt: receipt ? Math.round(receipt.left - p.right) : null,
      wikiAfterIt: wiki ? Math.round(wiki.left - p.right) : null,
      lineWidth: Math.round(m.width),
      working: !!msg.querySelector('.steps__stop'),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }
  })

const fieldLook = (win) =>
  win.evaluate(() => {
    const note = document.querySelector('.steps__steer-note')
    if (!note) return { open: false }
    const ta = note.querySelector('textarea')
    const send = [...note.querySelectorAll('button')].find((b) => b.className.includes('btn--primary'))
    const t = ta.getBoundingClientRect()
    // The pill of the same reply: the first one in the page belongs to the reply above it.
    const pill = note.closest('.msg__meta')?.querySelector('.steps__steer-pill')?.getBoundingClientRect()
    return {
      open: true,
      placeholder: ta.getAttribute('placeholder'),
      labelled: ta.getAttribute('aria-label'),
      width: Math.round(t.width),
      height: Math.round(t.height),
      underThePill: pill ? Math.round(t.top - pill.bottom) : null,
      lineWidth: Math.round(note.closest('.msg__meta')?.getBoundingClientRect().width ?? 0),
      sendDisabled: !!send?.disabled,
      sendText: send?.textContent?.trim(),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }
  })

// The instruction as the chain holds it, and the reply it belongs to.
const chainLook = (win) =>
  win.evaluate(() => {
    const msgs = [...document.querySelectorAll('.msg--agent')]
    const msg = msgs[msgs.length - 1]
    const steps = msg?.querySelector('.steps')
    const rows = [...(steps?.querySelectorAll('.step') ?? [])]
    const at = rows.findIndex((r) => r.classList.contains('step--steer'))
    const row = rows[at]
    const paragraphs = [...(msg?.querySelectorAll('.md p') ?? [])].map((p) => p.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    return {
      replies: msgs.length,
      rows: rows.length,
      instructionAt: at,
      labels: rows.map((r) => r.querySelector('.step__label')?.textContent ?? ''),
      instructionLabel: row?.querySelector('.step__label')?.textContent ?? null,
      instructionText: row?.querySelector('.step__input')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      instructionStatus: row?.className ?? null,
      summary: steps?.querySelector('.steps__summary')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      paragraphs: paragraphs.length,
      answer: paragraphs.map((p) => p.slice(0, 90)),
      working: !!steps?.querySelector('.steps__stop')
    }
  })
const replies = (win) => win.evaluate(() => document.querySelectorAll('.msg--agent').length)
const mineCount = (win) => win.evaluate(() => document.querySelectorAll('.msg--me').length)

let { app, win } = await launch()
await win.waitForSelector('.sidebar')
seedSkill()
await app.close()
;({ app, win } = await launch())

await channel(win, 'engineering')
await ask(win, 'Lia, read the skill `follow-demo` and do the work')
await settled(win)
await win.waitForTimeout(400)

// 01: the reply has ended, and the pill reads Follow under its chain.
console.log('the pill on a finished reply:', JSON.stringify(await pillLook(win)))
const repliesBefore = await replies(win)
const mineBefore = await mineCount(win)
await win.screenshot({ path: `${out}/follow-01-follow-under-a-finished-reply.png` })

// 02: what it opens. Empty, and the send asleep.
await win.locator('.msg__meta .steps__steer-pill').last().click()
await win.waitForTimeout(250)
console.log('the field it opens:', JSON.stringify(await fieldLook(win)))
const stillNothingSent = { replies: await replies(win), mine: await mineCount(win) }
console.log('opening it sent nothing:', JSON.stringify(stillNothingSent))
await win.screenshot({ path: `${out}/follow-02-the-field-it-opens.png` })

// 03: what the person writes.
await win.locator('.steps__steer-note textarea').fill('Add the two fixes from today as their own entries, with the file each one touched')
await win.waitForTimeout(200)
console.log('typed:', JSON.stringify(await fieldLook(win)))
await win.screenshot({ path: `${out}/follow-03-what-they-write.png` })

// 04: sending it. The field closes, the same reply is at work again, and nothing was posted.
await win.locator('.steps__steer-note button.btn--primary').click()
await win.waitForTimeout(600)
console.log(
  'after sending, the same reply is at work:',
  JSON.stringify({
    field: await fieldLook(win),
    pill: await pillLook(win),
    replies: { before: repliesBefore, after: await replies(win) },
    personMessages: { before: mineBefore, after: await mineCount(win) }
  })
)
await win.screenshot({ path: `${out}/follow-04-the-instruction-and-the-reply-at-work.png` })

// 05: when it ends, the instruction is a row of its own and the answer is two paragraphs.
await settled(win)
await win.waitForTimeout(400)
await win.locator('.steps__toggle').last().click()
await win.waitForTimeout(250)
console.log('the reply carried on:', JSON.stringify(await chainLook(win)))
await win.screenshot({ path: `${out}/follow-05-the-row-and-the-answer.png` })

// 06: 420 px, on a reply that ended: the pill and its field inside the column.
await win.setViewportSize({ width: 420, height: 880 })
await win.waitForTimeout(400)
// Its own reply first: reading the last message before this one exists measures the reply above it.
const repliesBeforeNarrow = await replies(win)
await ask(win, 'Lia, read the skill `follow-demo` and do the work')
for (let i = 0; i < 200; i++) {
  if ((await replies(win)) > repliesBeforeNarrow) break
  await win.waitForTimeout(100)
}
await settled(win)
await win.waitForTimeout(400)
const narrowPill = await pillLook(win)
await win.locator('.msg__meta .steps__steer-pill').last().click()
await win.waitForTimeout(250)
console.log('at 420:', JSON.stringify({ pill: narrowPill, field: await fieldLook(win) }))
await win.screenshot({ path: `${out}/follow-06-at-420.png` })

console.log('page errors:', JSON.stringify(errors.slice(0, 6)))
await app.close()
