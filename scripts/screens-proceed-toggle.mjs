// Rendered proof for the Proceed button setting: the toggle sits at the bottom of Settings ›
// Conversations, is off on a fresh install, and a finished one-action reply shows no button until
// it is turned on. Next steps stays as it was. Usage: node scripts/screens-proceed-toggle.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = 'C:/tmp/frames/proceed-toggle'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-proceed-toggle-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const PROPOSAL = 'They’re still sitting there unstaged; say the word and I’ll restore all six, one branch each.'
const STEPS_TEXT = 'I have checked everything. Say the word and I will do all three steps myself.'
const errors = []

// A fresh data dir, so the toggle starts at its default (unset, off).
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
insert.run('m-proceed-toggle', channel.id, 'agent', agent.id, PROPOSAL, now - 120_000, JSON.stringify({
  status: 'done', steps: [], depth: 1, endedAt: now - 120_000,
  questions: [{ question: PROPOSAL, kind: 'text', proceed: true }], proceedOpen: true
}))
insert.run('m-steps-toggle', channel.id, 'agent', agent.id, STEPS_TEXT, now - 60_000, JSON.stringify({
  status: 'done', steps: [], depth: 1, endedAt: now - 60_000,
  questions: [{ question: 'What comes next?', kind: 'multiple', options: [{ label: 'Run the suite' }, { label: 'Translate the labels' }, { label: 'Write the test' }], nextSteps: true }],
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

  const toChannel = async () => {
    await win.click('.nav-item:has-text("engineering")')
    await win.waitForSelector('.msg', { timeout: 30_000 })
  }
  const toConversations = async () => {
    await win.click('.sidebar__gear')
    await win.waitForSelector('.settings-groups', { timeout: 30_000 })
    const general = win.locator('.settings-groups__bar button', { hasText: /^General$|^Geral$/ }).first()
    if (await general.count()) await general.click()
    const jump = win.locator('.settings-jumps a', { hasText: /Conversations|Conversas/ }).first()
    if (await jump.count()) await jump.click()
    await win.waitForTimeout(1_100)
  }
  const row = () => win.locator('.key-row', { hasText: 'One-click approval button' }).first()
  const measureToggle = async () => row().evaluate((node) => {
    const sw = node.querySelector('button.toggle[role="switch"]')
    const card = node.closest('.settings-group')
    const section = node.closest('[data-settings-section]')
    const rows = card ? [...card.querySelectorAll('.key-row')] : []
    const nextCard = card?.nextElementSibling
    return {
      label: node.querySelector('strong')?.textContent?.trim() ?? null,
      hint: node.querySelector('p')?.textContent?.trim() ?? null,
      ariaChecked: sw?.getAttribute('aria-checked') ?? null,
      switchesInSection: section ? section.querySelectorAll('button.toggle[role="switch"]').length : 0,
      rowIndexInCard: rows.indexOf(node),
      rowsInCard: rows.length,
      cardTitle: card?.querySelector('.settings-group__head h3')?.textContent?.trim() ?? null,
      nextCardTitle: nextCard?.querySelector('.settings-group__head h3')?.textContent?.trim() ?? null
    }
  })
  const measureReply = async (text) => {
    const msg = win.locator('.msg', { hasText: text }).last()
    await msg.scrollIntoViewIfNeeded()
    await win.waitForTimeout(250)
    return msg.evaluate((node) => ({
      proceedWidgets: node.querySelectorAll('.proceed').length,
      proceedButtons: node.querySelectorAll('.proceed button').length,
      approveAriaButtons: node.querySelectorAll('.proceed button[aria-label="Approve the proposed next step"]').length,
      primaryButtons: node.querySelectorAll('.btn--primary.proceed__button').length,
      nextStepsWidgets: node.querySelectorAll('.ask--steps').length,
      nextStepsCheckboxes: node.querySelectorAll('.ask--steps [role="checkbox"]').length,
      label: node.querySelector('.proceed button')?.textContent?.trim() ?? null
    }))
  }
  const frames = { proposal: PROPOSAL, stepsText: STEPS_TEXT, samples: {}, errors: errors.length ? errors : 'none' }

  // Default: the toggle is off, at the bottom of the Conversations card.
  await toConversations()
  for (const width of [1440, 420]) {
    await win.setViewportSize({ width, height: 900 })
    await win.waitForTimeout(600)
    frames.samples[`settings-default-${width}`] = await measureToggle()
    await win.screenshot({ path: join(out, `settings-default-${width}.png`) })
  }

  // With the setting off, one finished reply has no Proceed control; next steps still renders.
  await win.setViewportSize({ width: 1440, height: 900 })
  await toChannel()
  for (const width of [1440, 420]) {
    await win.setViewportSize({ width, height: 900 })
    await win.waitForTimeout(500)
    frames.samples[`reply-off-${width}`] = await measureReply(PROPOSAL)
    await win.screenshot({ path: join(out, `reply-off-${width}.png`) })
    frames.samples[`steps-off-${width}`] = await measureReply(STEPS_TEXT)
  }

  // Turn it on in the same Settings surface, then the very same reply has exactly one button.
  await win.setViewportSize({ width: 1440, height: 900 })
  await toConversations()
  await row().locator('button.toggle[role="switch"]').click()
  await win.waitForTimeout(500)
  frames.samples['settings-on-1440'] = await measureToggle()
  await win.screenshot({ path: join(out, 'settings-on-1440.png') })
  await toChannel()
  for (const width of [1440, 420]) {
    await win.setViewportSize({ width, height: 900 })
    await win.waitForTimeout(500)
    frames.samples[`reply-on-${width}`] = await measureReply(PROPOSAL)
    await win.screenshot({ path: join(out, `reply-on-${width}.png`) })
    frames.samples[`steps-on-${width}`] = await measureReply(STEPS_TEXT)
  }

  frames.verdict = {
    toggleAtBottomOfConversations: [1440, 420].every((w) => frames.samples[`settings-default-${w}`].rowIndexInCard === 2 && frames.samples[`settings-default-${w}`].rowIndexInCard === frames.samples[`settings-default-${w}`].rowsInCard - 1 && frames.samples[`settings-default-${w}`].nextCardTitle?.includes('people who make Tucano')),
    offByDefault: [1440, 420].every((w) => frames.samples[`settings-default-${w}`].ariaChecked === 'false'),
    onAfterClick: frames.samples['settings-on-1440'].ariaChecked === 'true',
    noButtonWhenOff: [1440, 420].every((w) => frames.samples[`reply-off-${w}`].proceedButtons === 0 && frames.samples[`reply-off-${w}`].approveAriaButtons === 0 && frames.samples[`reply-off-${w}`].primaryButtons === 0),
    oneButtonWhenOn: [1440, 420].every((w) => frames.samples[`reply-on-${w}`].proceedWidgets === 1 && frames.samples[`reply-on-${w}`].proceedButtons === 1 && frames.samples[`reply-on-${w}`].approveAriaButtons === 1 && frames.samples[`reply-on-${w}`].primaryButtons === 1),
    nextStepsUnaffected: [1440, 420].every((w) => frames.samples[`steps-off-${w}`].nextStepsWidgets === 1 && frames.samples[`steps-on-${w}`].nextStepsWidgets === 1 && frames.samples[`steps-off-${w}`].nextStepsCheckboxes === 3 && frames.samples[`steps-on-${w}`].nextStepsCheckboxes === 3),
    noErrors: frames.errors === 'none'
  }
  writeFileSync(join(out, 'frames.json'), JSON.stringify(frames, null, 2))
  console.log(JSON.stringify({ verdict: frames.verdict, samples: frames.samples, errors: frames.errors }, null, 2))
} finally {
  await app.close()
}
