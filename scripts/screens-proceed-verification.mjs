// Rendered proof that a one-action reply shows one proceed control and a next_steps reply shows
// only the Next Steps card. Uses a throwaway seeded data dir and fake engines. Run after build:
// node scripts/screens-proceed-verification.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = 'C:/tmp/frames/proceed-verification'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-proceed-verify-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const PROPOSAL = 'They’re still sitting there unstaged; say the word and I’ll restore all six, one branch each.'
const STEPS_TEXT = 'I have checked everything. Say the word and I will do all three steps myself.'
const PROCEED_BTN = '.proceed button[aria-label="Approve the proposed next step"]'
const errors = []

const seed = await electron.launch({ args: ['.'], env })
await seed.firstWindow().then((w) => w.waitForSelector('.sidebar', { timeout: 60_000 }))
await seed.close()

const dbFile = join(data, 'tucano.db')
const db = new DatabaseSync(dbFile)
const agent = db.prepare("SELECT id FROM agents WHERE handle = 'lia' LIMIT 1").get()
const channel = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' AND name IN ('engineering', 'engenharia') LIMIT 1").get()
if (!agent || !channel) throw new Error('seeded workspace has no Lia or engineering channel')
const now = Date.now()
const insert = db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)')
insert.run('m-proceed-verify', channel.id, 'agent', agent.id, PROPOSAL, now - 120_000, JSON.stringify({
  status: 'done', steps: [], depth: 1, endedAt: now - 120_000,
  questions: [{ question: PROPOSAL, kind: 'text', proceed: true }], proceedOpen: true
}))
insert.run('m-steps-verify', channel.id, 'agent', agent.id, STEPS_TEXT, now - 60_000, JSON.stringify({
  status: 'done', steps: [], depth: 1, endedAt: now - 60_000,
  questions: [{ question: 'What comes next?', kind: 'multiple', options: [{ label: 'Rodar a suíte' }, { label: 'Traduzir os rótulos' }, { label: 'Escrever o teste' }], nextSteps: true }],
  stepsOpen: true
}))
db.close()

const app = await electron.launch({ args: ['.'], env })
try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.setViewportSize({ width: 1440, height: 900 })
  await win.waitForSelector('.sidebar', { timeout: 60_000 })
  await win.click('.nav-item:has-text("engineering"), .nav-item:has-text("engenharia")')
  await win.waitForSelector('.proceed button', { timeout: 30_000 })
  await win.waitForSelector('.ask--steps', { timeout: 30_000 })
  await win.waitForTimeout(700)

  const messageFor = (text) => win.locator('.msg', { hasText: text }).last()
  const measure = async (kind, text) => {
    const msg = messageFor(text)
    await msg.scrollIntoViewIfNeeded()
    await win.waitForTimeout(250)
    return msg.evaluate((node, kind) => {
      const widget = node.querySelector(kind === 'proceed' ? '.proceed' : '.ask--steps')
      const button = widget?.querySelector('button')
      const cs = button ? getComputedStyle(button) : undefined
      const rect = button?.getBoundingClientRect()
      return {
        widgetFound: !!widget,
        widgetCount: node.querySelectorAll(kind === 'proceed' ? '.proceed' : '.ask--steps').length,
        proceedWidgetCount: node.querySelectorAll('.proceed').length,
        stepsWidgetCount: node.querySelectorAll('.ask--steps').length,
        controlsInWidget: widget ? widget.querySelectorAll('button, input, select, textarea, a').length : 0,
        buttonsInWidget: widget ? widget.querySelectorAll('button').length : 0,
        messageControls: node.querySelectorAll('button, input, select, textarea, a').length,
        proceedButtonsInMessage: node.querySelectorAll('.proceed button').length,
        approveAriaButtons: node.querySelectorAll('.proceed button[aria-label="Approve the proposed next step"]').length,
        proceedPrimaryButtons: node.querySelectorAll('.btn--primary.proceed__button').length,
        checkboxes: widget ? widget.querySelectorAll('[role="checkbox"]').length : 0,
        badge: node.querySelector('.ask__badge')?.textContent?.trim() ?? null,
        label: button?.textContent?.trim() ?? null,
        aria: button?.getAttribute('aria-label') ?? null,
        buttonBackground: cs?.backgroundColor ?? null,
        buttonFontSize: cs?.fontSize ?? null,
        buttonHeight: rect ? Math.round(rect.height) : null,
        buttonWidth: rect ? Math.round(rect.width) : null,
        messageText: node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? ''
      }
    }, kind)
  }

  const frames = { proposal: PROPOSAL, stepsText: STEPS_TEXT, samples: {}, errors: errors.length ? errors : 'none' }
  for (const width of [1440, 420]) {
    await win.setViewportSize({ width, height: 900 })
    await win.waitForTimeout(500)
    frames.samples[`${width}-proceed`] = await measure('proceed', PROPOSAL)
    await win.screenshot({ path: join(out, `proceed-${width}.png`) })
    frames.samples[`${width}-steps`] = await measure('steps', STEPS_TEXT)
    await win.screenshot({ path: join(out, `steps-${width}.png`) })
  }
  frames.verdict = {
    proceedHasOneControl: [1440, 420].every((w) => frames.samples[`${w}-proceed`].buttonsInWidget === 1 && frames.samples[`${w}-proceed`].controlsInWidget === 1),
    proceedHasNoStepsCard: [1440, 420].every((w) => frames.samples[`${w}-proceed`].proceedWidgetCount === 1 && frames.samples[`${w}-proceed`].stepsWidgetCount === 0 && frames.samples[`${w}-proceed`].checkboxes === 0),
    stepsHasNoProceedButton: [1440, 420].every((w) => frames.samples[`${w}-steps`].stepsWidgetCount === 1 && frames.samples[`${w}-steps`].proceedWidgetCount === 0 && frames.samples[`${w}-steps`].proceedButtonsInMessage === 0 && frames.samples[`${w}-steps`].approveAriaButtons === 0 && frames.samples[`${w}-steps`].proceedPrimaryButtons === 0),
    stepsHasThreeCheckboxes: [1440, 420].every((w) => frames.samples[`${w}-steps`].checkboxes === 3)
  }
  writeFileSync(join(out, 'frames.json'), JSON.stringify(frames, null, 2))
  console.log(JSON.stringify({ verdict: frames.verdict, samples: frames.samples, errors: frames.errors }, null, 2))
} finally {
  await app.close()
}
