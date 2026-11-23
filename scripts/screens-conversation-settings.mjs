// Frames for Settings › Conversations: reasoning panel height and a long reply's step window.
// Usage: node scripts/screens-conversation-settings.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/conversation-settings'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-conv-'))
const env = {
  ...process.env,
  TUCANO_DATA: data,
  TUCANO_SEED: '1',
  TUCANO_FAKE_ENGINES: '1',
  TUCANO_FAKE_THINKING: '1',
  TUCANO_LOCALE: 'en-US'
}

const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 960 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => {
  await win.waitForTimeout(250)
  await win.screenshot({ path: join(out, `${name}.png`) })
  console.log('shot:', name)
}
const log = (label, value) => console.log(`${label}:`, typeof value === 'string' ? value : JSON.stringify(value))

async function openSettings() {
  const gear = win.locator('.sidebar__gear[aria-label="Settings"]').first()
  if (await gear.count()) {
    await gear.click()
  } else {
    await win.locator('.nav-item:has-text("Settings")').first().click()
  }
  await win.waitForSelector('.page')
  await win.waitForTimeout(400)
}

async function scrollToConversations() {
  const section = win.locator('[data-settings-section="app-conversation"]').first()
  await section.scrollIntoViewIfNeeded()
  await win.waitForTimeout(200)
  return section
}

async function readConversationState() {
  return win.evaluate(() => {
    const section = document.querySelector('[data-settings-section="app-conversation"]')
    if (!section) return { found: false }
    const rows = [...section.querySelectorAll('.key-row')].map((row) => {
      const strong = row.querySelector('strong')?.textContent?.trim() ?? ''
      const hint = row.querySelector('.muted.small')?.textContent?.trim() ?? ''
      const toggle = row.querySelector('.toggle')
      const active = row.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim() ?? null
      const radios = [...row.querySelectorAll('[role="radio"]')].map((r) => r.textContent?.trim())
      const number = row.querySelector('input[type="number"]')
      return { strong, hint: hint.slice(0, 80), toggle: toggle ? toggle.classList.contains('is-on') : null, active, radios, number: number ? Number(number.value) : null }
    })
    return { found: true, rows }
  })
}

await openSettings()
await scrollToConversations()

// 1. Default state: steps open, all steps, reasoning off, small height.
log('default', await readConversationState())
await shot('01-conversations-default')

// 2. Switch to "Last 20" and reveal the step count field.
const conv = win.locator('[data-settings-section="app-conversation"]').first()
await conv.locator('[role="radiogroup"][aria-label="Step display"] [role="radio"]', { hasText: 'Last 20' }).click()
await win.waitForTimeout(300)
log('latest', await readConversationState())
await shot('02-steps-latest')

// 3. Turn on reasoning and set height to Large.
const toggles = conv.locator('.toggle')
const toggleCount = await toggles.count()
// Show reasoning is the second toggle in this card (after "Show the steps while the agent works")
if (toggleCount >= 2) await toggles.nth(1).click()
await win.waitForTimeout(300)
await conv.locator('[role="radiogroup"][aria-label="Reasoning panel height"] [role="radio"]', { hasText: 'Large' }).click()
await win.waitForTimeout(300)
log('reasoning-large', await readConversationState())
await shot('03-reasoning-large')

// 4. Show reasoning in action with a live conversation.
await win.locator('.section .nav-item', { hasText: 'engineering' }).first().click()
await win.waitForSelector('.composer textarea')
await win.locator('.composer textarea').fill('Lia, explain how you would debug a flaky test in this repo.')
await win.keyboard.press('Enter')

// Wait for thinking to appear and grow.
let saw = null
for (let i = 0; i < 180; i++) {
  saw = await win.evaluate(() => {
    const blocks = [...document.querySelectorAll('.thought')]
    const t = blocks[blocks.length - 1]
    const box = t?.querySelector('.thought__text')
    const b = t?.getBoundingClientRect()
    return {
      blocks: blocks.length,
      open: t?.classList.contains('is-open') ?? null,
      working: t?.classList.contains('is-working') ?? null,
      size: t?.getAttribute('data-size') ?? null,
      chars: box?.textContent?.length ?? 0,
      height: b ? Math.round(b.height) : 0,
      maxHeight: box ? getComputedStyle(box).maxHeight : null,
      busy: !!document.querySelector('.steps__stop')
    }
  })
  if (saw.working && saw.chars > 60) break
  await win.waitForTimeout(150)
}
log('thinking-live', saw)
await shot('04-reasoning-live-large')

// 5. Let it finish, then capture folded state.
for (let i = 0; i < 160; i++) {
  const busy = await win.locator('.steps__stop').count()
  if (busy === 0) break
  await win.waitForTimeout(250)
}
await win.waitForTimeout(800)
const folded = await win.evaluate(() => {
  const blocks = [...document.querySelectorAll('.thought')]
  const t = blocks[blocks.length - 1]
  const b = t?.getBoundingClientRect()
  return {
    open: t?.classList.contains('is-open') ?? null,
    working: t?.classList.contains('is-working') ?? null,
    size: t?.getAttribute('data-size') ?? null,
    label: t?.querySelector('.thought__label')?.textContent ?? null,
    lastLine: t?.querySelector('.thought__last')?.textContent?.slice(0, 80) ?? null,
    height: b ? Math.round(b.height) : 0
  }
})
log('thinking-folded', folded)
await shot('05-reasoning-folded')

// 6. Back to settings: capture the full Conversations card (includes reply shortcut row).
await openSettings()
await scrollToConversations()
await win.waitForTimeout(300)
await shot('06-conversations-configured')

// 7. Appearance: clock format setting.
const appearance = win.locator('[data-settings-section="app-appearance"]').first()
await appearance.scrollIntoViewIfNeeded()
await win.waitForTimeout(300)
await shot('07-appearance-clock')

log('page errors', errors.filter((e) => !/ResizeObserver|favicon/i.test(e)))
await app.close()
rmSync(data, { recursive: true, force: true })
