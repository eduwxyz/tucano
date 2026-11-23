// Proves contextual replies on the screen, not in the source: the button on a message, the excerpt
// with Ctrl+L, the quote the sent message carries, the click that goes back to the original, the
// per-person switch, and the two composers (channel and thread) keeping their own quotes.
// Offline throughout: a temp TUCANO_DATA, the seed workspace and fake engines.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'C:/tmp/reply-screens'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-reply-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' }

const ORIGINAL = 'The parser drops the last line of every file it reads.'
const LATER = 'A second one, older, so the click has somewhere to travel.'

// ---------- 1. the workspace, and somewhere to click back to ----------
let channelId
{
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.waitForSelector('.sidebar')
  await app.close()
  const db = new DatabaseSync(join(data, 'tucano.db'))
  channelId = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' ORDER BY rowid LIMIT 1").get().id
  // Threads on, so the same conversation has a thread composer beside the channel one.
  db.prepare('UPDATE conversations SET threads = 1 WHERE id = ?').run(channelId)
  const me = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get().id
  const add = db.prepare("INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, 'person', ?, ?, ?)")
  add.run('orig-1', channelId, me, ORIGINAL, Date.now() - 60_000)
  add.run('later-1', channelId, me, LATER, Date.now() - 120_000)
  for (let i = 0; i < 12; i++) add.run(`filler-${i}`, channelId, me, `Filler line ${i + 1}: room above the original, so getting back to it is something the list has to do.`, Date.now() - 30_000 + i * 1000)
  db.close()
}

// ---------- 2. the screen ----------
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 860 })
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.waitForSelector('.sidebar')
await win.evaluate((id) => { location.hash = `#/c/${id}` }, channelId)
await win.waitForSelector('.composer textarea')
await win.waitForTimeout(400)

const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const row = (id) => `.msg[data-id="${id}"]`
const quoteIn = (scope) => win.evaluate((s) => {
  const el = document.querySelector(`${s} .composer__reply`)
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : null
}, scope)
const clearQuote = async () => {
  const x = win.locator('.composer__reply button').last()
  if (await x.count()) await x.click()
  await win.waitForTimeout(150)
}
const scrollList = async (px) => win.evaluate((p) => { document.querySelector('.messages').scrollTop = p }, px)
const hoverIn = async (id) => {
  const box = await win.locator(`${row(id)} .msg__text`).first().boundingBox()
  if (box) await win.mouse.move(box.x + 30, box.y + 6)
  await win.waitForTimeout(180)
}
// The first `to` characters of the message's text, marked the way a person's pointer marks it.
const selectIn = async (id, to) => win.evaluate(({ id, to }) => {
  const el = document.querySelector(`.msg[data-id="${id}"] .msg__text`)
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let seen = 0
  let start = null
  let end = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent.length
    if (!start && len > 0) start = { node: n, at: 0 }
    if (seen + len >= to) { end = { node: n, at: to - seen }; break }
    seen += len
  }
  if (!start || !end) throw new Error('nothing to select')
  const r = document.createRange()
  r.setStart(start.node, start.at)
  r.setEnd(end.node, end.at)
  const s = getSelection()
  s.removeAllRanges()
  s.addRange(r)
  document.dispatchEvent(new Event('selectionchange'))
  return s.toString()
}, { id, to })

const checks = []

// ---------- 3. the button on a message opens the composer's reply ----------
await scrollList(0)
await hoverIn('orig-1')
await win.locator(`${row('orig-1')} .msg__replyto`).click()
await win.waitForSelector('.composer__reply')
const buttonQuote = await quoteIn('.composer-wrap')
checks.push({ what: 'the message button starts a reply in the composer', got: buttonQuote })
await shot('r1-button-reply')

// ---------- 4. the excerpt, with Ctrl+L, and the button's reply given back ----------
await clearQuote()
await selectIn('orig-1', 25)
await win.keyboard.press('Control+l')
await win.waitForSelector('.composer__reply')
const excerptQuote = await quoteIn('.composer-wrap')
checks.push({ what: 'Ctrl+L on a selection starts a reply to that excerpt', got: excerptQuote })
await shot('r2-excerpt-shortcut')

// ---------- 5. what is sent carries the quote ----------
await win.fill('.composer textarea', 'Then the last line needs its own read.')
await win.press('.composer textarea', 'Enter')
await win.waitForTimeout(900)
const afterSend = await win.evaluate(() => ({
  field: document.querySelector('.composer textarea').value,
  toast: document.querySelector('.toast')?.textContent ?? null,
  inList: document.querySelectorAll('.msg .reply-quote').length,
  inComposer: document.querySelectorAll('.composer__reply .reply-quote').length,
  where: [...document.querySelectorAll('.msg .reply-quote')].map((q) => ({ id: q.closest('.msg')?.dataset.id, cls: q.closest('.msg')?.className, parent: q.parentElement.className }))
}))
console.log('AFTER SEND', JSON.stringify(afterSend))
await win.waitForSelector('.msg .reply-quote')
const sentQuote = await win.evaluate(() => document.querySelector('.msg .reply-quote').textContent.replace(/\s+/g, ' ').trim())
const fieldAfter = await win.evaluate(() => ({ text: document.querySelector('.composer textarea').value, quote: !!document.querySelector('.composer__reply') }))
checks.push({ what: 'the sent message carries the quote', got: sentQuote, field: fieldAfter })
await shot('r3-quote-sent')

// ---------- 6. the quote goes back to the original ----------
const listScroll = () => win.evaluate(() => Math.round(document.querySelector('.messages').scrollTop))
await win.evaluate(() => { const l = document.querySelector('.messages'); l.scrollTop = l.scrollHeight })
await win.waitForTimeout(400)
const reachable = (id) => win.evaluate((id) => {
  const list = document.querySelector('.messages')
  const msg = document.querySelector(`.msg[data-id="${id}"]`)
  if (!msg) return null
  const b = msg.getBoundingClientRect()
  const lb = list.getBoundingClientRect()
  return { inView: b.top >= lb.top - 2 && b.bottom <= lb.bottom + 2, top: Math.round(b.top - lb.top) }
}, id)
const before = { ...(await reachable('orig-1')), scrollTop: await listScroll() }
await win.locator('.msg .reply-quote').last().click()
await win.waitForTimeout(700)
const after = { ...(await reachable('orig-1')), scrollTop: await listScroll() }
checks.push({ what: 'clicking the quote brings the original into view', before, after })
await shot('r4-quote-navigation')

// ---------- 7. the switch: off, the key says nothing and the button still replies ----------
// The desktop app keeps its screen in memory, so settings are reached by the button, not the address.
await win.locator('.sidebar__gear').click()
await win.waitForSelector('button.toggle')
// The switch in that row, read by its own row: 0.2.45's page has other toggles before it.
const replySwitch = () => {
  const strong = [...document.querySelectorAll('strong')].find((s) => /Responder ao trecho|Reply to the excerpt/.test(s.textContent))
  return strong.closest('.key-row').querySelector('button.toggle')
}
const was = await win.evaluate(`(${replySwitch.toString()})().getAttribute('aria-checked')`)
await win.evaluate(`(${replySwitch.toString()})().click()`)
await win.waitForTimeout(500)
const now = await win.evaluate(`(${replySwitch.toString()})().getAttribute('aria-checked')`)
const flipped = { was, now }
const settled = now
await shot('r5-setting-off')
await win.locator('.section .nav-item').first().click()
await win.waitForSelector('.composer textarea')
await win.waitForTimeout(300)
await selectIn('orig-1', 25)
await win.keyboard.press('Control+l')
await win.waitForTimeout(400)
const offKey = await quoteIn('.composer-wrap')
// The selection given back, so the button is asked for the whole message.
await win.evaluate(() => getSelection().removeAllRanges())
await win.evaluate(() => document.dispatchEvent(new Event('selectionchange')))
await hoverIn('orig-1')
await win.locator(`${row('orig-1')} .msg__replyto`).click()
await win.waitForTimeout(300)
const offButton = await quoteIn('.composer-wrap')
checks.push({ what: 'switch off: the key is silent, the button still replies', flipped, settled, afterKey: offKey, afterButton: offButton })
await shot('r6-setting-off-button')
await clearQuote()

// ---------- 8. the same conversation, two composers, one quote each ----------
await hoverIn('orig-1')
await win.locator(`${row('orig-1')} .msg__replyto`).click()
await win.waitForTimeout(250)
const channelSide = await quoteIn('.composer-wrap')
await win.locator(`${row('orig-1')} .msg__reply`).click()
await win.waitForTimeout(600)
const inThread = await win.evaluate(() => {
  const wraps = [...document.querySelectorAll('.composer-wrap')]
  return { composers: wraps.length, quotes: wraps.map((w) => (w.querySelector('.composer__reply') ? w.querySelector('.composer__reply').textContent.replace(/\s+/g, ' ').trim() : null)) }
})
checks.push({ what: 'the channel composer and the thread composer keep their own quotes', channelSide, inThread })
await shot('r7-two-composers')

const result = { checks, errors, out, data }
console.log(JSON.stringify(result, null, 1))
await app.close()
