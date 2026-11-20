// Screenshots of the Asks page developed: every agent's question in one place, answered from the
// page itself, dismissed in two steps with the reply going on, and the ones that left the list
// under a History. Fake engines, fresh data.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens-asks'
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
const ASK = 'Pra quando você precisa disso?'
// The open list is the first one; the History below is a stack-list too.
const open = () => win.locator('.ask').count()
const wait = () => win.locator('.ask').count()
const step = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    errors.push(`${name}: ${String(e).split('\n')[0]}`)
    await shot(`erro-${name}`)
  }
}

// An ask in a DM with Lia, and another in the #engineering channel: the page's whole point is that
// they come from different places.
await step('perguntas', async () => {
  await win.click('.section:has-text("Agents") .nav-item:has-text("Lia")')
  await win.click('button:has-text("Open DM")')
  await win.waitForSelector('.composer textarea')
  await win.fill('.composer textarea', 'me pergunta pra quando eu preciso do relatório')
  await win.keyboard.press('Enter')
  await win.waitForSelector(`text=${ASK}`, { timeout: 25_000 })
  await win.waitForTimeout(500)
  await win.click('.section:has-text("Channels") .nav-item:has-text("engineering")')
  await win.waitForSelector('.composer textarea')
  await win.fill('.composer textarea', 'theo, me pergunta o escopo da migração')
  await win.keyboard.press('Enter')
  await win.waitForSelector(`.msg:has-text("${ASK}")`, { timeout: 25_000 })
  await win.waitForTimeout(600)
})

await step('pagina', async () => {
  await win.click('.nav-item:has-text("Asks")')
  await win.waitForSelector('.ask')
  await win.waitForTimeout(500)
  await shot('01-perguntas-de-todos')
  console.log(`asks waiting: ${await open()}`)
  console.log(`answer fields on the page: ${await win.locator('.ask__text, .question__answer input').count()}`)
  console.log(`where they came from: ${JSON.stringify(await win.locator('.list-meta > span').allTextContents())}`)
})

await step('responder', async () => {
  const card = win.locator('.ask').first()
  await card.locator('.ask__text').fill('pra sexta')
  await shot('02-resposta-na-pagina')
  await card.locator('button:has-text("Send")').click()
  await win.waitForTimeout(1500)
  await shot('03-depois-de-responder')
  console.log(`asks waiting after answering one: ${await open()}`)
  console.log(`history heading: ${await win.locator('h3.section-title').count()}`)
  console.log(`history rows: ${await win.locator('.question.is-answered').count()}`)
})

await step('dispensar', async () => {
  const row = win.locator('.stack-list').first().locator('> div').first()
  await row.locator('button:text-is("Dismiss")').click()
  await win.waitForSelector('text=Leave it unanswered?')
  await shot('04-confirmar-dispensar')
  const before = await open()
  await win.locator('button:text-is("Yes, dismiss")').first().click()
  await win.waitForTimeout(1800)
  await shot('05-depois-de-dispensar')
  console.log(`waiting before dismissing: ${before}, after: ${await open()}`)
  console.log(`history rows now: ${await win.locator('.question.is-answered').count()}`)
})

await step('conversa', async () => {
  // The reply goes on: the question closed, and the agent was told in so many words.
  await win.click('.section:has-text("Channels") .nav-item:has-text("engineering")')
  await win.waitForTimeout(2000)
  console.log(`the line the agent got: ${await win.locator('.msg:has-text("leaving your question unanswered")').count()}`)
  await shot('06-a-resposta-segue')
})

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await app.close()
