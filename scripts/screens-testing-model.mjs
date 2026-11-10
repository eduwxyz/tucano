// Frames for "Every testing checkout runs on DeepSeek 4.1 Flash, not on a Claude model assumed to
// be there". Two runs of the built app on this machine, which has no Claude subscription:
//
//   1. fake engines — the demo team as it seeds on a testing checkout, read off Settings › Models,
//      at 1280 px and at 420 px;
//   2. real engines — the same team answering an actual message through Pi, so the model is not
//      only written down somewhere but is one this computer can reach.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODEL = process.env['TUCANO_TEST_MODEL'] ?? 'pi:opencode-go/deepseek-v4.1-flash'
const out = process.argv[2] ?? 'C:/tmp/frames/testing-setup'
const only = process.argv[3] // 'fake' or 'real': run one half while fixing the other
mkdirSync(out, { recursive: true })
const errors = []

async function open(extra) {
  const data = mkdtempSync(join(tmpdir(), 'tucano-'))
  const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_LOCALE: 'en-US', TUCANO_TEST_MODEL: MODEL, ...extra }
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.setViewportSize({ width: 1280, height: 900 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

async function models(win) {
  await win.locator('.nav-item:has-text("Settings")').first().click()
  await win.waitForSelector('.tabs')
  await win.locator('.tabs button[role="tab"]:has-text("Models")').first().click()
  await win.waitForSelector('.agent-models__row')
  await win.waitForTimeout(400)
  return win.locator('.agent-models__row').evaluateAll((els) =>
    els.map((el) => {
      const parts = el.innerText.split(/\n+/).map((s) => s.trim()).filter(Boolean)
      return parts.find((p) => p.startsWith('Current:')) ?? parts.join(' | ')
    })
  )
}

// 1. fake engines: what a testing checkout seeds, and how it reads at both widths.
if (only !== 'real') {
  const { app, win } = await open({ TUCANO_FAKE_ENGINES: '1' })
  const rows = await models(win)
  console.log('== fake engines, Settings › Models ==')
  rows.forEach((r) => console.log('  ', r))
  console.log('   every row on the testing model:', rows.every((r) => r.includes('opencode-go/deepseek-v4.1-flash')))
  console.log('   any row on a Claude model:', rows.some((r) => /Sonnet|Opus|Haiku/.test(r)))
  await win.locator('.agent-models').screenshot({ path: `${out}/models-1280.png` })
  await win.setViewportSize({ width: 420, height: 900 })
  await win.waitForTimeout(400)
  const measure = await win.locator('.agent-models').evaluate((el) => ({ w: el.clientWidth, scroll: el.scrollWidth, page: document.documentElement.scrollWidth, win: innerWidth }))
  console.log('   at 420 px:', JSON.stringify(measure))
  await win.locator('.agent-models').screenshot({ path: `${out}/models-420.png` })
  await app.close()
}

// 2. real engines: the team answers on this computer, with no Claude anywhere.
if (only !== 'fake') {
  const { app, win } = await open({})
  await win.locator('.section:has-text("Agents") .nav-item:has-text("Lia")').first().click()
  await win.locator('button:has-text("Open DM")').first().click().catch(async () => win.locator('text=Open DM').first().click())
  await win.waitForSelector('.composer textarea', { timeout: 30_000 })
  await win.fill('.composer textarea', 'In one short line: which model are you running on?')
  await win.keyboard.press('Enter')
  const started = Date.now()
  // The reply lands in the message that was already there: it says Thinking… while the model works,
  // then Done and the text. So wait for that, not for a button.
  await win
    .waitForFunction(
      () => {
        const all = [...document.querySelectorAll('.msg--agent')]
        const last = all[all.length - 1]
        return !!last && last.innerText.length > 60 && !/Thinking…/.test(last.innerText)
      },
      null,
      { timeout: 240_000 }
    )
    .catch(() => errors.push('the reply never finished'))
  await win.waitForTimeout(2000)
  const said = await win.locator('.msg--agent').last().innerText().catch(() => '')
  console.log('== real engines, a DM with Lia ==')
  console.log('   seconds:', Math.round((Date.now() - started) / 1000))
  console.log('   said:', said.replace(/\s+/g, ' ').slice(0, 200))
  await win.screenshot({ path: `${out}/reply-real.png` })
  await app.close()
}

console.log('== page errors ==', errors.length ? errors : 'none')
