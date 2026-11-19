// Screenshots of a reply's pictures as an album: several images from one tool-call session drawn as
// one large and the rest beside it, the golden section, instead of one big picture under another.
// A single picture keeps the shape it had, a reply that also made a document keeps its card, and
// past four the last cell says how many are left. The images are written into the app's own
// artifact store and named by the reply that made them, so what is photographed is the real screen.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens-artifact-gallery'
// The same replies on a build without the album, to have the before beside the after.
const before = process.argv.includes('--before')
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-gallery-'))

// A PNG of a few coloured blocks: enough to be told apart in a gallery, drawn without a browser.
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, body) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const named = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc(named))
  return Buffer.concat([len, named, sum])
}
// `color(x, y)` gives the pixel; the bands and the bar make it read as a small window.
const png = (w, h, color) => {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y)
      const at = y * (w * 3 + 1) + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bits
  ihdr[9] = 2 // truecolour
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PALETTE = [
  [32, 39, 61],
  [72, 46, 96],
  [24, 72, 78],
  [96, 52, 33],
  [38, 60, 100],
  [64, 36, 52],
  [30, 74, 52],
  [84, 66, 26]
]
const picture = (n, w = 900, h = 620) => {
  const [r, g, b] = PALETTE[n % PALETTE.length]
  return png(w, h, (x, y) => {
    if (y < 46) return [18, 19, 22] // the window's bar
    if (y < 46 + 3) return [60, 62, 70]
    // rows of text-like blocks, and one accent block per picture
    const row = Math.floor((y - 70) / 42)
    if (y > 70 && y < h - 40 && (y - 70) % 42 < 12 && x > 40 && x < w * (0.35 + 0.06 * ((row * 7 + n) % 6))) return [r + 26, g + 26, b + 26]
    if (x > w * 0.62 && x < w * 0.62 + 180 && y > h * 0.55 && y < h * 0.55 + 120) return [r + 60, g + 40, b + 20]
    return [r, g, b]
  })
}

const say = async (win, text) => {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
}
const idle = async (win) => {
  await win.waitForTimeout(600)
  for (let i = 0; i < 60; i++) {
    if (!(await win.locator('.steps.is-working').count())) break
    await win.waitForTimeout(250)
  }
  await win.waitForTimeout(900)
}

// ---- first run: two replies in Lia's DM, one of each picture shape ----
let app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' } })
let win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForSelector('.sidebar')
await win.click('.section:has-text("Agents") .nav-item:has-text("Lia")')
const openDm = win.locator('button:has-text("Open DM")')
if (await openDm.count()) await openDm.first().click()
await win.waitForSelector('.composer textarea')
await say(win, 'olha os quatro modelos do painel de vendas que eu te mandei')
await idle(win)
await say(win, 'e agora compare as versões de julho e agosto, uma em cada janela')
await idle(win)
await say(win, 'gere só o gráfico do mês, uma imagem')
await idle(win)
await app.close()

// ---- name those pictures on the replies that made them (what a tool-call session leaves) ----
const db = new DatabaseSync(join(data, 'tucano.db'))
const dm = db.prepare("SELECT id FROM conversations WHERE kind = 'dm' LIMIT 1").get()
const withRuns = db
  .prepare("SELECT id, author_id, run FROM messages WHERE conversation_id = ? AND run IS NOT NULL AND author_kind = 'agent' ORDER BY at")
  .all(dm.id)
  .map((r) => ({ id: r.id, agentId: r.author_id, run: JSON.parse(r.run) }))
const shapes = [
  { count: 3, titles: ['Painel de vendas — julho', 'Painel de vendas — agosto', 'Comparativo mês a mês'] },
  { count: 7, titles: ['Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro', 'O ano em uma tela'] },
  { count: 1, titles: ['Vendas do mês'] }
]
const insert = db.prepare('INSERT INTO artifacts (id, agent_id, conversation_id, message_id, kind, name, title, source, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
let pictureNo = 0
shapes.forEach((shape, runNo) => {
  const target = withRuns[withRuns.length - shapes.length + runNo]
  const ids = []
  for (let i = 0; i < shape.count; i++) {
    const id = randomUUID() // the app serves an artifact only under a real id
    const name = `screenshot-${++pictureNo}.png`
    const file = picture(pictureNo)
    mkdirSync(join(data, 'artifacts', id), { recursive: true })
    writeFileSync(join(data, 'artifacts', id, name), file)
    insert.run(id, target.agentId, dm.id, target.id, 'image', name, shape.titles[i] ?? `Imagem ${i + 1}`, `C:/Users/theap/Desktop/${name}`, file.length, Date.now())
    ids.push(id)
  }
  target.run.artifactIds = ids
  db.prepare('UPDATE messages SET run = ? WHERE id = ?').run(JSON.stringify(target.run), target.id)
})
// The last reply also made a document: the album must not swallow it.
const docId = randomUUID()
const docName = 'vendas-2026.pdf'
mkdirSync(join(data, 'artifacts', docId), { recursive: true })
const docBytes = Buffer.from('%PDF-1.4\n% seeded for the gallery screenshot\n')
writeFileSync(join(data, 'artifacts', docId, docName), docBytes)
const last = withRuns[withRuns.length - 1]
insert.run(docId, last.agentId, dm.id, last.id, 'pdf', docName, 'Vendas 2026 — relatório', 'C:/Users/theap/Desktop/vendas-2026.pdf', docBytes.length, Date.now())
last.run.artifactIds = [...(last.run.artifactIds ?? []), docId]
db.prepare('UPDATE messages SET run = ? WHERE id = ?').run(JSON.stringify(last.run), last.id)
db.close()

// ---- second run: the same replies, read with the pictures named ----
app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '0', TUCANO_FAKE_ENGINES: '1' } })
win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
win.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url().slice(0, 120)}`))
await win.click('.section:has-text("Agents") .nav-item:has-text("Lia")')
if (await win.locator('button:has-text("Open DM")').count()) await win.locator('button:has-text("Open DM")').first().click()
await win.waitForSelector(before ? '.artifacts .artifact-image' : '.artifacts-gallery')
await win.waitForTimeout(600)
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const box = async (selector) => win.locator(selector).first().boundingBox()
const galleries = () => win.locator('.artifacts-gallery').count()
const cellsOf = (n) => win.locator('.artifacts-gallery').nth(n).locator('.gallery__cell').count()

const report = {}
report.galleries = await galleries()
report.stackHeights = await win.locator('.artifacts').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
report.pageHeight = await win.evaluate(() => Math.round(document.querySelector('.messages, .chat, .conversation')?.scrollHeight ?? document.documentElement.scrollHeight))
if (before) {
  // The old shape: every picture at its own size, one under the other.
  report.pictures = await win.locator('.artifact-image').count()
  report.pictureBoxes = await win.locator('.artifact-image').evaluateAll((els) => els.slice(0, 4).map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`))
  await shot('01-tres-imagens')
  await win.locator('.artifacts').nth(1).scrollIntoViewIfNeeded()
  await win.waitForTimeout(300)
  await shot('02-sete-imagens')
  await win.locator('.artifact-image').first().scrollIntoViewIfNeeded()
  await win.waitForTimeout(300)
  await shot('03-uma-imagem')
  console.log(JSON.stringify({ ...report, errors }, null, 1))
  await app.close()
  process.exit(0)
}
report.cells = [await cellsOf(0), await cellsOf(1)]
report.singleImages = await win.locator('.artifact-image:not(.gallery__cell)').count()
report.more = await win.locator('.gallery__more').first().innerText().catch(() => '(none)')
const g = await box('.artifacts-gallery')
const hero = await box('.artifacts-gallery .gallery__cell--hero')
const beside = await box('.artifacts-gallery .gallery__cell:not(.gallery__cell--hero)')
report.container = { w: Math.round(g.width), h: Math.round(g.height) }
report.hero = { w: Math.round(hero.width), h: Math.round(hero.height) }
report.beside = { w: Math.round(beside.width), h: Math.round(beside.height) }
report.ratio = +(hero.width / beside.width).toFixed(3)
report.containerRatio = +(g.width / g.height).toFixed(3)
report.docCard = await win.locator('.artifact-card').count()
report.imagesLoaded = await win.locator('.gallery__cell img').evaluateAll((els) => els.filter((e) => e.naturalWidth > 0).length)
report.images = await win.locator('.gallery__cell img').count()
report.rowsOverflowing = await win.locator('.gallery__cell').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length)
await shot('01-tres-imagens')

// The big album, with what is left counted on the last cell.
await win.locator('.artifacts-gallery').nth(1).scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
await shot('02-sete-imagens')
report.moreRendered = await win.locator('.artifacts-gallery').nth(1).locator('.gallery__more').innerText()

// A single picture is not an album.
await win.locator('.artifact-image:not(.gallery__cell)').first().scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
await shot('03-uma-imagem')

// Pressing a cell opens the window on that picture.
await win.locator('.artifacts-gallery').nth(0).locator('.gallery__cell').nth(1).click()
await win.waitForTimeout(500)
report.lightbox = await win.locator('.lightbox__title').innerText().catch(() => '(none)')
report.lightboxCount = await win.locator('.lightbox .lightbox__bar span.small').first().innerText().catch(() => '')
await shot('04-janela')
await win.keyboard.press('Escape')
await win.waitForTimeout(300)

// The same album in a narrow window.
await win.setViewportSize({ width: 420, height: 900 })
await win.waitForTimeout(500)
await win.locator('.artifacts-gallery').nth(1).scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
const narrow = await box('.artifacts-gallery')
const narrowHero = await box('.artifacts-gallery .gallery__cell--hero')
const narrowBeside = await box('.artifacts-gallery .gallery__cell:not(.gallery__cell--hero)')
report.narrow = { w: Math.round(narrow.width), h: Math.round(narrow.height), ratio: +(narrowHero.width / narrowBeside.width).toFixed(3) }
report.sidewaysScroll = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
await shot('05-420')

console.log(JSON.stringify({ ...report, errors }, null, 1))
await app.close()
