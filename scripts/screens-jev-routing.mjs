// Frames for Settings › Routing, shot in the built app on a throwaway folder with the fake engines:
// the switch that reveals the tab, the pool workspace, the rail's selected state in both themes and
// at 900 px, and the thin line over a routed reply, collapsed and open.
//
// Usage: node scripts/screens-jev-routing.mjs [out dir]
// It seeds its own data folder, so it never touches a person's workspace. Needs a build first
// (`npm run build`), and Playwright's Electron driver (`npx playwright install` not needed).
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames-routing'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-routing-frames-'))

/** A setup worth photographing: six pools with models, two roles with specialists, free as fallback. */
const routing = (() => {
  const t = (engine, model, effort) => ({ id: `${engine}/${model}#${effort}`, engine, model, effort })
  return {
    enabled: true,
    pools: {
      free: { descriptor: "Only free providers: for what isn't worth spending on.", chain: [t('opencode', 'beam-free', 'low'), t('opencode', 'big-pickle', 'medium'), t('pi', 'opencode-go/beam-free', 'low')] },
      t1: { descriptor: 'Cheap and fast: small edits, a question, a routine run.', chain: [t('claude', 'claude-haiku-5-5', 'low'), t('codex', 'gpt-5.6-luna', 'medium')] },
      t2: { descriptor: 'The everyday tier: most work lands here.', chain: [t('pi', 'openai-codex/gpt-5.6-sol', 'medium'), t('claude', 'claude-sonnet-4-6', 'medium')] },
      t3: { descriptor: 'Serious work: real code, real review.', chain: [t('pi', 'openai-codex/gpt-6.1-sol', 'high'), t('pi', 'openai-codex/gpt-6.1-terra', 'high'), t('codex', 'gpt-6.1-sol', 'high')] },
      t4: { descriptor: 'The expensive models, when the work is worth it.', chain: [t('pi', 'openai-codex/gpt-6.1-sol', 'xhigh')] },
      t5: { descriptor: 'The very top, only when the read qualifies.', chain: [] }
    },
    roles: {
      code: { descriptor: 'Writing or changing code, scripts or configuration until it works', chain: [{ ...t('pi', 'openai-codex/gpt-6.1-sol', 'high'), minTier: 't3' }] },
      review: { descriptor: 'Auditing code, a diff, a document or a plan for problems and risks', chain: [{ ...t('claude', 'claude-opus-4-6-thinking', 'high'), minTier: 't4' }] },
      plan: { descriptor: 'Deciding what to build, sequencing work, designing an approach before any edit', chain: [] },
      debug: { descriptor: 'Diagnosing a failure, an error or odd behaviour, and finding its cause', chain: [{ ...t('claude', 'claude-sonnet-4-6', 'high'), minTier: 't2' }] },
      chat: { descriptor: 'Small talk, an acknowledgement, or a request with no real work behind it', chain: [] }
    },
    roleFloor: { code: 't2', review: 't3', debug: 't2' },
    free: { policy: 'fallback' },
    confidenceFloor: 0.4,
    allowTier5: true
  }
})()

const launch = () =>
  electron.launch({
    args: ['.'],
    env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
  })

const shoot = async (win, name, locator) => {
  if (locator) await locator.screenshot({ path: `${out}/${name}.png` })
  else await win.screenshot({ path: `${out}/${name}.png` })
  console.log('shot', name)
}

const accent = (win) => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
const setTheme = async (win, want) => {
  const dark = (await accent(win)) === '#ff8a3d'
  if ((want === 'dark') !== dark) {
    await win.locator('.icon-btn[title="Switch theme"]').first().click()
    await win.waitForTimeout(800)
  }
}

// ---------- seed: one launch writes the database, then the settings go in before the shots ----------
{
  const app = await launch()
  const win = await app.firstWindow()
  await win.waitForSelector('body', { timeout: 60_000 })
  await win.waitForTimeout(4000)
  await app.close()
  const db = new DatabaseSync(`${data}/tucano.db`)
  const put = (k, v) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, JSON.stringify(v))
  put('routing', routing)
  put('language', 'en')
  db.close()
}

// ---------- the settings side ----------
let app = await launch()
let win = await app.firstWindow()
await win.waitForSelector('body', { timeout: 60_000 })
await win.waitForTimeout(4000)
await win.setViewportSize({ width: 1366, height: 900 })
await setTheme(win, 'light')

await win.getByRole('button', { name: /Settings/i }).first().click()
await win.waitForTimeout(800)
await win.getByRole('tab', { name: /^Models$/ }).first().click()
await win.waitForTimeout(700)
const router = win.locator('.card', { hasText: 'Smart model routing' }).first()
await shoot(win, '01-models-switch', (await router.count()) ? router : undefined)
await shoot(win, '02-models-tab')

await win.getByRole('tab', { name: /^Routing$/ }).first().click()
await win.waitForTimeout(900)
await shoot(win, '03-routing-free')
const rail = win.locator('.routing__rail').first()
await shoot(win, '04-rail-free-selected', rail)
await shoot(win, '05-routing-body', win.locator('.routing__body').first())

await win.locator('.routing__pool', { hasText: 'Tier 3' }).first().click()
await win.waitForTimeout(500)
await shoot(win, '06-routing-tier3')
await shoot(win, '07-rail-tier3-selected', rail)
await win.locator('.routing__pool', { hasText: 'Tier 5' }).first().click()
await win.waitForTimeout(500)
await shoot(win, '08-routing-tier5')

await win.locator('.routing__role', { hasText: /^Code$/ }).first().click()
await win.waitForTimeout(500)
await shoot(win, '09-routing-role-code')

// hover must read differently from selection
await win.locator('.routing__pool', { hasText: 'Tier 1' }).first().hover()
await win.waitForTimeout(400)
await shoot(win, '10-rail-hover-vs-selected', rail)

await win.setViewportSize({ width: 900, height: 880 })
await win.waitForTimeout(800)
await shoot(win, '11-routing-narrow')
await shoot(win, '12-rail-narrow', rail)

await win.setViewportSize({ width: 1366, height: 900 })
await win.waitForTimeout(500)
await setTheme(win, 'dark')
await win.locator('.routing__pool', { hasText: 'Free' }).first().click()
await win.waitForTimeout(700)
await shoot(win, '13-routing-dark')
await shoot(win, '14-rail-dark', rail)
await setTheme(win, 'light')
await app.close()

// ---------- the line over a reply: one trace, written where the conversation reads it ----------
{
  const db = new DatabaseSync(`${data}/tucano.db`)
  const conv = db.prepare(`SELECT id, name FROM conversations WHERE kind = 'channel' ORDER BY name LIMIT 1`).get()
  const agent = db.prepare(`SELECT id, name FROM agents LIMIT 1`).get()
  const route = {
    at: Date.now(),
    reading: { role: 'code', confidence: 0.71, probabilities: { code: 0.71, plan: 0.19, review: 0.1 }, complexity: 2, capability: 2, deepReasoning: 0.5, ms: 640 },
    rawDemand: 2, demand: 2, requested: 't3', policy: 't3', effective: 't3', source: 'tier',
    notes: ['code floors at t3'],
    attempts: [
      { id: 'opencode/beam-free#low', engine: 'opencode', model: 'beam-free', effort: 'low', from: { kind: 'free' }, skip: 'the free pool is a fallback, and tier 3 answered first', skipCode: 'ineligible' },
      { id: 'pi/openai-codex/gpt-6.1-sol#high', engine: 'pi', model: 'openai-codex/gpt-6.1-sol', effort: 'high', from: { kind: 'tier', tier: 't3' } }
    ],
    selected: { id: 'pi/openai-codex/gpt-6.1-sol#high', engine: 'pi', model: 'openai-codex/gpt-6.1-sol', effort: 'high' },
    baseline: { id: 'claude/sonnet#medium', engine: 'claude', model: 'sonnet', effort: 'medium' },
    state: 'changed'
  }
  db.prepare(
    `INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run, thread_id) VALUES (?, ?, 'agent', ?, ?, ?, ?, NULL)`
  ).run(
    randomUUID(), conv.id, agent.id,
    'Rewrote the pool walk so a candidate that cannot run is skipped with a reason instead of ending the chain. Tests cover the empty pool and the unsigned-in login.',
    Date.now(), JSON.stringify({ status: 'done', endedAt: Date.now(), depth: 1, steps: [], route })
  )
  db.close()
  console.log('seeded a routed reply in', conv.name)

  app = await launch()
  win = await app.firstWindow()
  await win.waitForSelector('body', { timeout: 60_000 })
  await win.waitForTimeout(4500)
  await win.setViewportSize({ width: 1366, height: 900 })
  await setTheme(win, 'light')
  await win.getByText(conv.name, { exact: true }).first().click()
  await win.waitForTimeout(1500)
  const line = win.locator('.route-line').first()
  console.log('route lines:', await win.locator('.route-line').count())
  if (await line.count()) {
    await shoot(win, '15-line-collapsed', line)
    await shoot(win, '16-conversation')
    await line.locator('.route-line__row').click()
    await win.waitForTimeout(800)
    await shoot(win, '17-line-open', line)
    await shoot(win, '18-line-open-full')
    console.log('the line reads:', (await line.innerText()).replace(/\n+/g, ' | '))
  }
  await app.close()
}
console.log('frames in', out)
