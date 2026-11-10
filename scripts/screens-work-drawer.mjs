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

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await app.close()
