// Screenshots of the work drawer above the composer: a reply running with the glyph that stops it,
// the reply that already ended (kept, marked with how it ended), jumping to it, the trash that takes
// a row off, and that each conversation keeps its own drawer. Fake engines, fresh data.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens-work-drawer'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const head = async () => ((await win.locator('.work-drawer__count').count()) ? await win.locator('.work-drawer__count').innerText() : '(no drawer)')
const rows = () => win.locator('.work-row').count()
const step = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    errors.push(`${name}: ${String(e).split('\n')[0]}`)
    await shot(`erro-${name}`)
  }
}
const say = async (text, opts = {}) => {
  await win.fill('.composer textarea', text)
  if (opts.queue) {
    await win.keyboard.down('Shift')
    await win.keyboard.press('Enter')
    await win.keyboard.up('Shift')
  } else await win.keyboard.press('Enter')
}
// The same DM comes back when it already exists, so its drawer's memory is what's on trial here.
const dm = async (name) => {
  await win.click(`.section:has-text("Agents") .nav-item:has-text("${name}")`)
  const open = win.locator('button:has-text("Open DM")')
  if (await open.count()) await open.first().click()
  await win.waitForSelector('.composer textarea')
}
const openIt = async () => {
  if (!(await win.locator('.work-drawer.is-open').count())) await win.locator('.work-drawer__head').click()
}

await step('abrir', async () => {
  await dm('Lia')
})

// A reply that ends stays: the head counts it, its row says how it ended, and it still jumps.
await step('terminada', async () => {
  await say('demore 3 s e organize o relatório do mês')
  // Closed while it's the only thing running: the head is what says it ended.
  await win.waitForSelector('.work-drawer__count:has-text("finished")', { timeout: 30_000 })
  await openIt()
  await win.waitForTimeout(400)
  console.log(`head after it ended: ${JSON.stringify(await head())}`)
  console.log(`rows: ${await rows()}, finished rows: ${await win.locator('.work-row--done').count()}, done glyphs: ${await win.locator('.work-row__state--ok').count()}`)
  console.log(`trash on the finished row: ${await win.locator('.work-row--done button[title*="Remove"]').count()}`)
  await shot('01-terminada')
  await win.locator('.work-row--done .work-row__go').first().click()
  await win.waitForTimeout(700)
  console.log(`flashed on jump: ${await win.locator('.msg.is-flash').count()}`)
  await shot('02-pulo')
})

// The x in a running row stops that one; the row stays and says it was stopped.
await step('parar', async () => {
  await say('demore 6 s e revise o diff do PR 247')
  await win.waitForSelector('.work-drawer__count:has-text("replying")', { timeout: 15_000 })
  await openIt()
  await win.waitForSelector('.work-row button[title*="Stop"]', { timeout: 10_000 })
  await win.waitForTimeout(400)
  console.log(`head with one running: ${JSON.stringify(await head())}`)
  const stop = win.locator('.work-row button[title*="Stop"]').first()
  console.log(`stop glyph has no square: ${(await stop.locator('svg rect').count()) === 0}, paths: ${JSON.stringify(await stop.locator('svg path').getAttribute('d'))}`)
  await shot('03-respondendo-com-x')
  await stop.click()
  await win.waitForTimeout(9000)
  console.log(`head after stopping: ${JSON.stringify(await head())}`)
  console.log(`stopped rows: ${await win.locator('.work-row__state--off').count()}, rows: ${await rows()}`)
  await shot('04-parada-fica')
})

// It sits on the composer's width and nothing inside it runs off, wide or narrow.
await step('medidas', async () => {
  const box = () =>
    win.evaluate(() => {
      const wr = document.querySelector('.work-drawer')
      const co = document.querySelector('.composer')
      const rows = [...document.querySelectorAll('.work-row')]
      return {
        drawer: wr ? Math.round(wr.getBoundingClientRect().width) : 0,
        composer: co ? Math.round(co.getBoundingClientRect().width) : 0,
        rowsOverflowing: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
      }
    })
  await openIt()
  console.log(`at 1280: ${JSON.stringify(await box())}`)
  await win.setViewportSize({ width: 420, height: 860 })
  await win.waitForTimeout(500)
  console.log(`at 420: ${JSON.stringify(await box())}`)
  await shot('05-aperto')
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForTimeout(400)
})

// Each DM and channel has its own drawer: another one has none, and coming back finds this one.
await step('por-conversa', async () => {
  const before = await head()
  await dm('Theo')
  await win.waitForTimeout(700)
  console.log(`drawer in Theo's DM: ${await win.locator('.work-drawer').count()}`)
  await shot('06-outro-dm-sem-gaveta')
  await dm('Lia')
  await win.waitForTimeout(700)
  console.log(`back in Lia's DM: ${JSON.stringify(await head())} (was ${JSON.stringify(before)})`)
  await openIt()
  await win.waitForTimeout(300)
  console.log(`rows back: ${await rows()}`)
  await shot('07-de-volta')
})

// The trash takes a row off; the drawer goes when its last row does.
await step('tirar', async () => {
  await openIt()
  let guard = 0
  while ((await rows()) > 0 && guard++ < 10) {
    await win.locator('.work-row button[title*="Remove"]').first().click()
    await win.waitForTimeout(250)
  }
  console.log(`rows after removing all: ${await rows()}, drawer: ${await win.locator('.work-drawer').count()}`)
  await shot('08-limpa')
})

// A reply that lives in a thread is work the conversation is carrying too: it has its own row in the
// DM's drawer, saying which thread in the thread's own words, and pressing it opens that thread on
// the reply. Laid out over the whole conversation, not only its room.
await step('thread', async () => {
  await say('demore 20 s e organize os anexos do mes')
  await win.waitForSelector('.work-drawer__count:has-text("replying")', { timeout: 15_000 })
  const last = win.locator('.msg.msg--me').last() // the thread is opened on my own prompt, which has words
  await last.hover()
  await last.locator('.msg__reply').click({ force: true })
  await win.waitForSelector('.side-panel--thread .composer textarea', { timeout: 10_000 })
  await win.fill('.side-panel--thread .composer textarea', 'demore 20 s e conte as linhas do anexo')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  await openIt()
  const chips = win.locator('.work-drawer .work-row__thread')
  console.log(`head with one reply in the room and one in a thread: ${JSON.stringify(await head())}`)
  console.log(`rows: ${await rows()}, thread chips: ${await chips.count()}, chip says: ${JSON.stringify(await chips.first().innerText())}`)
  // The chip has to be readable and the row has to fit, wide and narrow, like the rest of the drawer.
  const look = async (tag) => {
    const seen = await win.evaluate(() => {
      const chip = document.querySelector('.work-row__thread')
      const drawer = document.querySelector('.work-drawer')
      const row = chip && chip.closest('.work-row')
      if (!chip || !drawer || !row) return null
      const cs = getComputedStyle(chip)
      const word = chip.querySelector('.work-row__thread-text')
      return {
        color: cs.color,
        bg: getComputedStyle(drawer).backgroundColor,
        font: cs.fontSize,
        chip: Math.round(chip.getBoundingClientRect().width),
        word: word ? Math.round(word.getBoundingClientRect().width) : 0,
        clipped: word ? word.scrollWidth - word.clientWidth : 0,
        rowsOverflowing: [...document.querySelectorAll('.work-row')].filter((r) => r.scrollWidth > r.clientWidth + 1).length,
        drawer: Math.round(drawer.getBoundingClientRect().width),
        composer: Math.round(document.querySelector('.composer').getBoundingClientRect().width),
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
      }
    })
    if (!seen) return console.log(`${tag}: no chip to measure`)
    // WCAG 2.1 relative luminance, on the colours the chip is actually drawn in.
    const lum = (css) => {
      const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map((n) => {
        const v = Number(n) / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const [a, b] = [lum(seen.color), lum(seen.bg)].sort((x, y) => y - x)
    console.log(`${tag}: ${JSON.stringify(seen)}, contrast ${((a + 0.05) / (b + 0.05)).toFixed(2)}:1`)
  }
  await look('chip at 1280')
  await shot('09-thread-na-gaveta')
  await win.setViewportSize({ width: 420, height: 860 })
  await win.waitForTimeout(500)
  await look('chip at 420')
  await shot('09b-thread-na-gaveta-aperto')
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForTimeout(400)
  await win.locator('.side-panel--thread button[title*="Close"]').first().click()
  await win.waitForTimeout(500)
  console.log(`thread closed: ${await win.locator('.side-panel--thread').count()} panels`)
  await win.locator('.work-row:has(.work-row__thread) .work-row__go').first().click()
  await win.waitForSelector('.side-panel--thread', { timeout: 10_000 })
  await win.waitForTimeout(700)
  console.log(`opened by the drawer: ${await win.locator('.side-panel--thread').count()} panel, ${await win.locator('.side-panel--thread .msg.is-flash').count()} reply flashed inside it`)
  await shot('10-pulo-pra-dentro-da-thread')
})

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await app.close()
