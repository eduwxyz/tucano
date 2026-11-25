// Frames for "Try with instructions": a reply the person stopped, the two ways back, the field that
// opens under them, and the same reply tried again in the direction they wrote.
// One run of the built app, English window, seeded workspace, fake engines.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/try-with-instructions'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 900 })
await win.waitForSelector('.sidebar')
await win.waitForTimeout(600)

const shot = async (name) => { await win.locator('.main').screenshot({ path: `${out}/${name}.png` }); console.log('shot', name) }
const IS_WORKING = () => [...document.querySelectorAll('.composer button')].some((b) => b.textContent?.trim() === 'Stop')
const waitIdle = async () => {
  await win.waitForFunction(() => ![...document.querySelectorAll('.composer button')].some((b) => b.textContent?.trim() === 'Stop'), null, { timeout: 60_000 }).catch(() => {})
  await win.waitForTimeout(600)
}

// A reply that takes its time ("Demore 8 s" is the fake engine's own slow reply), stopped by hand.
await win.fill('.composer textarea', 'Escreva o relatório de outubro da equipe. Demore 8 s.')
await win.keyboard.press('Enter')
await win.waitForSelector('.composer button:has-text("Stop")', { timeout: 25_000 })
await win.waitForTimeout(1500)
console.log('working before the stop:', await win.evaluate(IS_WORKING))
await win.locator('.composer button:has-text("Stop")').click()
await waitIdle()
await win.waitForSelector('.msg--agent button:has-text("Try again")', { timeout: 20_000 })

const stopped = await win.evaluate(() => {
  const msg = [...document.querySelectorAll('.msg--agent')].at(-1)
  return {
    note: msg?.querySelector('.note')?.textContent?.trim(),
    buttons: [...(msg?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim()).filter(Boolean),
    repliesOnScreen: document.querySelectorAll('.msg--agent').length
  }
})
console.log('after the stop:', JSON.stringify(stopped))
await shot('01-stopped-two-ways-back')

// "Try with instructions" opens the field under the buttons — and opening it sends nothing.
await win.locator('.msg--agent button:has-text("Try with instructions")').last().click()
await win.waitForSelector('.retry-note textarea')
await win.waitForTimeout(250)
const opened = await win.evaluate(() => {
  const box = document.querySelector('.retry-note')
  const ta = box?.querySelector('textarea')
  const btn = [...(box?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('Try again with this'))
  const r = ta?.getBoundingClientRect()
  return {
    field: r ? { width: Math.round(r.width), height: Math.round(r.height) } : null,
    placeholder: ta?.placeholder,
    labelled: ta?.getAttribute('aria-label'),
    sendDisabled: btn?.disabled,
    working: [...document.querySelectorAll('.composer button')].some((b) => b.textContent?.trim() === 'Stop'),
    repliesOnScreen: document.querySelectorAll('.msg--agent').length
  }
})
console.log('the field:', JSON.stringify(opened))
await shot('02-the-field-under-the-buttons')

// What should be different: the words go into the new try's prompt, not into a new message.
await win.fill('.retry-note textarea', 'Faça em uma tabela e cite as fontes. Deixe de fora o que ainda não foi fechado.')
await win.waitForTimeout(200)
await shot('03-what-should-be-different')
const typed = await win.evaluate(() => {
  const box = document.querySelector('.retry-note')
  const btn = [...(box?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('Try again with this'))
  return { value: box?.querySelector('textarea')?.value, sendDisabled: btn?.disabled }
})
console.log('typed:', JSON.stringify(typed))

await win.locator('.retry-note button:has-text("Try again with this")').click()
await win.waitForTimeout(600)
const restarted = await win.evaluate(() => ({
  fieldGone: !document.querySelector('.retry-note'),
  working: [...document.querySelectorAll('.composer button')].some((b) => b.textContent?.trim() === 'Stop'),
  replies: document.querySelectorAll('.msg--agent').length
}))
console.log('after sending it:', JSON.stringify(restarted))
await shot('04-tried-again-in-that-direction')
await waitIdle()
const after = await win.evaluate(() => {
  const msg = [...document.querySelectorAll('.msg--agent')].at(-1)
  return {
    replies: document.querySelectorAll('.msg--agent').length,
    stoppedNote: !!msg?.querySelector('.note'),
    buttons: [...(msg?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim()).filter(Boolean)
  }
})
console.log('after the new reply:', JSON.stringify(after))
await shot('05-the-new-reply')

// Narrow window: the field and its buttons fit, and the page does not scroll sideways.
await win.setViewportSize({ width: 420, height: 900 })
await win.waitForTimeout(600)
// Another reply, stopped at this width: the field has to fit here too.
await win.fill('.composer textarea', 'Resuma o trimestre. Demore 8 s.')
await win.keyboard.press('Enter')
await win.waitForSelector('.composer button:has-text("Stop")', { timeout: 25_000 })
await win.waitForTimeout(1500)
await win.locator('.composer button:has-text("Stop")').click()
await waitIdle()
await win.locator('.msg--agent button:has-text("Try with instructions")').last().click()
await win.waitForSelector('.retry-note textarea')
await win.waitForTimeout(300)
const narrow = await win.evaluate(() => {
  const box = document.querySelector('.retry-note')
  if (!box) return { opened: false }
  const r = box.getBoundingClientRect()
  const row = box.querySelector('.retry-note__row')?.getBoundingClientRect()
  return {
    opened: true,
    box: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) },
    rowOverRight: row ? Math.round(row.right - r.right) : null,
    pageSideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})
console.log('at 420 px:', JSON.stringify(narrow))
await shot('06-at-420')
console.log('page errors:', errors.length, JSON.stringify(errors.slice(0, 4)))

await app.close()
rmSync(data, { recursive: true, force: true })
