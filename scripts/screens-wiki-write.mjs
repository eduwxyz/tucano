// Screenshots of the wiki's card on the agent's Tools tab and of an agent that keeps the wiki itself:
// it writes the page it was asked to write, the step says so, and the page's history says it was her.
// Run after `npm run build`: node scripts/screens-wiki-write.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'frames/wiki-write'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const app = await electron.launch({
  args: ['.', `--user-data-dir=${join(data, 'electron')}`],
  ...(process.env.TUCANO_ELECTRON ? { executablePath: process.env.TUCANO_ELECTRON } : {}),
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
})
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForSelector('.sidebar')
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle() {
  const deadline = Date.now() + 25_000
  let quiet = 0
  while (Date.now() < deadline && quiet < 3) {
    await win.waitForTimeout(400)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  await settle()
}
const card = (title) => win.locator('.card', { has: win.locator(`h2:text-is("${title}")`) }).first()

// The agent's page, on the Tools tab, where the wiki's card now lives. (The agent row, not her DM:
// the DM has no role line under the name.)
const agentRow = () => win.locator('.nav-item', { has: win.locator('.nav-item__role') }).filter({ hasText: /Lia/ }).first()
await agentRow().click()
await win.waitForSelector('.agent-form')
await win.locator('[role="tab"], .tabs button, .tab', { hasText: /^(Ferramentas|Tools)$/ }).first().click().catch(() => {})
await win.waitForTimeout(300)
const wiki = card('Wiki')
await wiki.scrollIntoViewIfNeeded()
await win.waitForTimeout(250)
const levels = await wiki.locator('[role="radio"]').allTextContents()
const picked = async () => (await wiki.locator('[role="radio"][aria-checked="true"]').allTextContents()).join()
console.log('levels:', levels, '· picked:', await picked())
const cardBox = await wiki.boundingBox()
await shot('01-the-card-on-tools')

// Read and write, picked on the card itself: it saves right away, as the other cards on that tab do.
await wiki.locator('[role="radio"]', { hasText: /^(Lê e escreve|Read and write)$/ }).first().click()
await win.waitForTimeout(400)
console.log('picked after the click:', await picked())
await shot('02-read-and-write-picked')

// And the same card on a narrow window, still on the agent's page.
await agentRow().click()
await win.waitForSelector('.agent-form')
await win.locator('.card', { has: win.locator('h2:text-is("Wiki")') }).first().scrollIntoViewIfNeeded()
await win.waitForTimeout(400)
await win.setViewportSize({ width: 420, height: 860 })
await win.waitForTimeout(600)
await card('Wiki').scrollIntoViewIfNeeded().catch(() => {})
await win.waitForTimeout(300)
const narrow = await card('Wiki').boundingBox().catch(() => null)
console.log('at 420 px:', narrow, 'page overflow:', await win.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
await shot('03-at-420')


await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForTimeout(400)

// Her DM: she writes the page she was asked to write.
await win.locator('button', { hasText: /^(Abrir DM|Open DM)$/ }).first().click()
await win.waitForSelector('.composer textarea')
await win.waitForTimeout(800)
await send('anote na wiki: Viagem a Morretes | Trem pela Serra do Mar em fevereiro.')
const reply = win.locator('.msg--agent').last()
await reply.scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
await reply.locator('.steps__toggle').click()
await win.waitForTimeout(300)
const steps = await reply.locator('.step').allTextContents().catch(() => [])
console.log('the reply says:', (await reply.locator('.md').last().textContent())?.slice(0, 120))
console.log('steps:', steps.filter((s) => /wiki/i.test(s)))
await shot('04-the-reply-and-its-step')

// Twice more, so the page grows instead of being written over.
await send('anote na wiki: Viagem a Morretes | Ficamos três dias, no hotel perto da praça.')
await send('anote na wiki: Reforma do apto 302 | Orçamento aprovado em três parcelas, começando em janeiro.')

// The page, in the wiki, with its history saying it was her.
await win.locator('.nav-item', { hasText: /^Wiki$/ }).first().click()
await win.waitForSelector('.wk-stage, .wk-empty')
await win.waitForTimeout(600)
await win.locator('.wk-search-btn').click()
await win.waitForSelector('.wk-palette input')
await win.fill('.wk-palette input', 'Morretes')
await win.waitForTimeout(500)
await win.locator('.wk-palette__row', { hasText: /Viagem a Morretes/ }).first().click()
await win.waitForSelector('.wk-page__title')
await win.waitForTimeout(900)
await shot('05-the-page-she-wrote')
await win.locator('.wk-page__tools button').filter({ hasText: /Histórico|History/ }).first().click()
await win.waitForSelector('.wk-history li')
await win.waitForTimeout(300)
const body = await win.evaluate(() => document.querySelector('.wk-doc')?.textContent ?? '')
console.log('page body has both lines:', /Serra do Mar/.test(body), /três dias/.test(body))
const history = await win.evaluate(() => [...document.querySelectorAll('.wk-history li')].slice(0, 4).map((n) => n.textContent?.replace(/\s+/g, ' ').trim()))
console.log('history:', history)
console.log('who the page says wrote it:', await win.evaluate(() => document.querySelector('.wk-page__meta')?.textContent?.replace(/\s+/g, ' ').trim()))
await shot('06-its-history')

console.log('page errors:', errors)
await app.close()
