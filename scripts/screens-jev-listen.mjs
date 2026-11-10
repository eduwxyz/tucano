// Frames of a channel in listen mode: the dialog that puts an agent in it, the line where you write,
// the message Jev brings the listener in for, and one the room handles alone. Fake engines and the
// TypeSafe stand-in (TUCANO_FAKE_LISTEN), so nothing is spent and no key is needed.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-listen-'))
const errors = []

async function open(handle, width = 1280) {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TUCANO_DATA: data, TUCANO_FAKE_ENGINES: '1', TUCANO_FAKE_LISTEN: handle }
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width, height: 900 })
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForTimeout(2200)
  return { app, win }
}
const channel = async (win, name) => {
  await win.getByRole('button', { name, exact: true }).first().click({ timeout: 20000 })
  await win.waitForTimeout(500)
}
const listenTheo = async (win) => {
  await win.click('button[title="Add or remove agents"]')
  await win.waitForSelector('.member-list')
  await win.locator('input[aria-label="Listen mode for Theo"]').check()
  await win.waitForTimeout(250)
}
const save = async (win) => {
  await win.click('button:has-text("Save")')
  await win.waitForTimeout(600)
}
const notes = (win) => win.locator('.system-line').allInnerTexts().catch(() => [])
const replies = (win) =>
  win.locator('.msg').evaluateAll((ms) =>
    ms
      .map((m) => ({
        who: (m.querySelector('.msg__author, .msg__name, strong')?.textContent ?? '').trim(),
        text: (m.querySelector('.msg__body')?.textContent ?? '').trim().slice(0, 50)
      }))
      .filter((r) => !!r.text)
  )
const shot = (win, name) => win.screenshot({ path: `${out}/${name}.png` })

// ---- 1. the dialog: an agent in a channel, one mode at a time
const a = await open('theo')
const win = a.win
await channel(win, 'engineering')
await listenTheo(win)
await shot(win, '01-dialogo-modo-escuta')
console.log('dialogo:', (await win.locator('.modal__foot').innerText()).replace(/\n+/g, ' '))
await save(win)

// ---- 2. the line where you write says who can come in
console.log('composer (engineering):', (await win.locator('.composer__hint').innerText()).trim())
await shot(win, '02-a-linha-do-campo')

// ---- 3. a channel where the listener is the only one: Jev brings him in and he answers
await channel(win, 'data')
await listenTheo(win)
await save(win)
await win.fill('.composer textarea', 'quantos usuários ativos tivemos ontem?')
await win.keyboard.press('Enter')
await win.waitForSelector('.system-line', { timeout: 25000 }).catch(() => {})
await win.waitForTimeout(3000)
console.log('notas (#data):', JSON.stringify(await notes(win)))
console.log('respostas (#data):', JSON.stringify(await replies(win)))
await shot(win, '03-jev-trouxe-theo')

// ---- 4. at 420 px, the same channel and the same line
await win.setViewportSize({ width: 420, height: 900 })
await win.waitForTimeout(700)
console.log('420:', JSON.stringify(await win.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])))
console.log('composer (420):', (await win.locator('.composer__hint').innerText()).trim())
await shot(win, '04-420')
await a.app.close()

// ---- 5. the room handles the message: the listener stays out, and nothing is said about him
const b = await open('none')
const w2 = b.win
await channel(w2, 'engineering')
const before = (await notes(w2)).length
await w2.fill('.composer textarea', 'o build quebrou ontem, alguém olha?')
await w2.keyboard.press('Enter')
await w2.waitForTimeout(4000)
console.log('notas novas (a sala resolve):', JSON.stringify((await notes(w2)).slice(before)))
console.log('respostas (a sala resolve):', JSON.stringify(await replies(w2)))
await shot(w2, '05-a-sala-resolve')
await b.app.close()

console.log('erros:', JSON.stringify(errors))
