// Screenshots of the work drawer above the composer: what it looks like with two replies at work at
// once, a prompt marked as queued under its own group, jumping to a reply, stopping one, and the
// drawer closed by hand. Fake engines, fresh data.
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

await step('abrir', async () => {
  await win.click('.section:has-text("Agents") .nav-item:has-text("Lia")')
  await win.click('button:has-text("Open DM")')
  await win.waitForSelector('.composer textarea')
})

// The stop glyph first, on its own slow reply: the fake engine only notices the abort when its sleep
// ends, so the proof is that the row goes and the reply ends as stopped, not in a flash.
await step('parar', async () => {
  await say('demore 6 s e organize o relatório do mês')
  await win.waitForSelector('.work-drawer', { timeout: 15_000 })
  await win.waitForTimeout(700)
  console.log(`one at work: ${JSON.stringify(await win.locator('.work-drawer__count').innerText())}, rows: ${await rows()}`)
  await win.locator('.work-drawer__head').click() // closed with one reply: opened by hand
  await win.waitForTimeout(300)
  console.log(`rows once opened: ${await rows()}`)
  await shot('01-uma-respondendo')
  await win.locator('.work-row button[title*="Stop"]').first().click()
  await win.waitForTimeout(7000)
  console.log(`rows after stopping: ${await rows()}, drawer: ${await win.locator('.work-drawer').count()}`)
  console.log(`said stopped: ${await win.locator('.note:has-text("Stopped by you")').count()}`)
  await shot('02-depois-de-parar')
})

await step('duas', async () => {
  await say('demore 25 s e organize o relatório do mês')
  await win.waitForTimeout(400)
  await say('demore 25 s e revise o diff do PR 247')
  await win.waitForSelector('.work-drawer.is-open', { timeout: 15_000 })
  await win.waitForTimeout(600)
  console.log(`head says: ${JSON.stringify(await win.locator('.work-drawer__count').innerText())}`)
  console.log(`rows: ${await rows()}`)
  console.log(`prompts: ${JSON.stringify(await win.locator('.work-row__text').allInnerTexts())}`)
  await shot('03-duas-respondendo')
})

await step('fila', async () => {
  await say('isto pode esperar: some as horas do relatório', { queue: true })
  await win.waitForSelector('.work-drawer__group', { timeout: 15_000 })
  await win.waitForTimeout(600)
  console.log(`head says: ${JSON.stringify(await win.locator('.work-drawer__count').innerText())}`)
  console.log(`queued group: ${JSON.stringify(await win.locator('.work-drawer__group').innerText())}`)
  console.log(`rows now: ${await rows()}`)
  await shot('04-com-um-na-fila')
})

await step('ir', async () => {
  await win.locator('.work-row__go').first().click()
  await win.waitForTimeout(700)
  console.log(`flashed: ${await win.locator('.msg.is-flash').count()}`)
  await shot('05-pulo-pra-resposta')
})

await step('fechar', async () => {
  await win.locator('.work-drawer__head').click()
  await win.waitForTimeout(500)
  console.log(`open after closing by hand: ${await win.locator('.work-drawer.is-open').count()}`)
  console.log(`rows drawn while closed: ${await rows()}`)
  await shot('06-fechado-a-mao')
})

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await app.close()
