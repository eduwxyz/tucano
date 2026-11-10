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

// ---------- the line over a reply: three traces, written where the conversation reads them ----------
{
  const db = new DatabaseSync(`${data}/tucano.db`)
  const conv = db.prepare(`SELECT id, name FROM conversations WHERE kind = 'channel' ORDER BY name LIMIT 1`).get()
  const agent = db.prepare(`SELECT id, name FROM agents LIMIT 1`).get()
  const t = (engine, model, effort) => ({ id: `${engine}/${model}#${effort}`, engine, model, effort })
  // Three reads worth photographing: a heavy one that opens a tier, a light one that lands in tier 1,
  // and one where routing agreed with the agent's own model.
  const traces = [
    {
      text: 'Rewrote the pool walk so a candidate that cannot run is skipped with a reason instead of ending the chain. Tests cover the empty pool and the unsigned-in login.',
      route: {
        reading: { role: 'code', confidence: 0.71, probabilities: { code: 0.71, plan: 0.19, review: 0.1 }, complexity: 2.6, capability: 2.2, deepReasoning: 0.8, ms: 640 },
        rawDemand: 2.89, demand: 2.89, requested: 't3', policy: 't3', effective: 't3', source: 'tier',
        notes: ['code floors at t3'],
        attempts: [
          { ...t('opencode', 'beam-free', 'low'), from: { kind: 'free' }, skip: 'the free pool is a fallback, and tier 3 answered first', skipCode: 'ineligible' },
          { ...t('pi', 'openai-codex/gpt-6.1-sol', 'high'), from: { kind: 'tier', tier: 't3' } }
        ],
        selected: t('pi', 'openai-codex/gpt-6.1-sol', 'high'),
        state: 'changed'
      }
    },
    {
      text: 'Added the missing comma and re-ran the formatter. Nothing else changed.',
      route: {
        reading: { role: 'operate', confidence: 0.66, probabilities: { operate: 0.66, code: 0.24, chat: 0.1 }, complexity: 0.4, capability: 0.3, deepReasoning: 0.1, ms: 410 },
        rawDemand: 0.27, demand: 1, requested: 't1', policy: 't1', effective: 't1', source: 'tier',
        notes: ['the read was small enough for tier 1'],
        attempts: [{ ...t('claude', 'claude-haiku-5-5', 'low'), from: { kind: 'tier', tier: 't1' } }],
        selected: t('claude', 'claude-haiku-5-5', 'low'),
        state: 'changed'
      }
    },
    {
      text: 'So the two receipts disagree because the second one was written before the refund cleared. That is the whole story.',
      route: {
        reading: { role: 'explain', confidence: 0.58, probabilities: { explain: 0.58, research: 0.27, chat: 0.15 }, complexity: 1.4, capability: 1.1, deepReasoning: 0.3, ms: 520 },
        rawDemand: 1.27, demand: 2, requested: 't2', policy: 't2', effective: 't2', source: 'role',
        notes: ['the agent already ran on this model, so the read kept it'],
        attempts: [
          { ...t('claude', 'claude-sonnet-4-6', 'medium'), from: { kind: 'role', role: 'explain' } }
        ],
        selected: t('claude', 'claude-sonnet-4-6', 'medium'),
        state: 'kept'
      }
    }
  ]
  const now = Date.now()
  for (const [n, trace] of traces.entries()) {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run, thread_id) VALUES (?, ?, 'agent', ?, ?, ?, ?, NULL)`
    ).run(
      randomUUID(), conv.id, agent.id, trace.text, now + n * 1000,
      JSON.stringify({
        status: 'done', endedAt: now + n * 1000, depth: 1, steps: [],
        route: {
          at: now + n * 1000,
          ...trace.route,
          baseline: t('claude', 'claude-sonnet-4-6', 'medium')
        }
      })
    )
  }
  db.close()
  console.log('seeded three routed replies in', conv.name)

  app = await launch()
  win = await app.firstWindow()
  await win.waitForSelector('body', { timeout: 60_000 })
  await win.waitForTimeout(4500)
  await win.setViewportSize({ width: 1366, height: 900 })
  await setTheme(win, 'light')
  await win.getByText(conv.name, { exact: true }).first().click()
  await win.waitForTimeout(1500)
  const lines = win.locator('.route-line')
  console.log('route lines:', await lines.count())
  for (const [n, name] of [[0, 'heavy'], [1, 'light'], [2, 'kept']]) {
    const line = lines.nth(n)
    if (!(await line.count())) continue
    await shoot(win, `15-line-${name}`, line)
    const m = await line.evaluate((el) => {
      const row = el.querySelector('.route-line__row').getBoundingClientRect()
      const bar = el.querySelector('.route-demand')?.getBoundingClientRect()
      const fill = el.querySelector('.route-demand__fill')?.getBoundingClientRect()
      // one line: every piece sits on the row's own centre line (the bar is 6 px tall inside a 32 px
      // row, so comparing raw tops reads a centred bar as a second line)
      const mid = row.top + row.height / 2
      const kids = [...el.querySelector('.route-line__row').children].map((c) => c.getBoundingClientRect())
      return { rowH: Math.round(row.height), barW: bar && Math.round(bar.width), fillW: fill && Math.round(fill.width), oneRow: kids.every((k) => Math.abs(k.top + k.height / 2 - mid) <= 6) }
    })
    console.log(`  ${name}:`, JSON.stringify(m), (await line.locator('.route-line__row').innerText()).replace(/\s+/g, ' '))
  }
  await shoot(win, '16-conversation')
  const heavy = lines.nth(0)
  await heavy.locator('.route-line__row').click()
  await win.waitForTimeout(800)
  await shoot(win, '17-line-open', heavy)
  await shoot(win, '18-line-open-full')
  console.log('opened line reads:', (await heavy.innerText()).replace(/[\r\n]+/g, ' | '))
  const geom = await heavy.evaluate((el) => {
    const row = el.querySelector('.route-line__row')
    const bar = el.querySelector('.route-demand')
    const fill = el.querySelector('.route-demand__fill')
    const tier = el.querySelector('.route-line__pool')
    const cs = (n) => (n ? getComputedStyle(n) : null)
    const r = (n) => {
      const b = n.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
    }
    return {
      row: r(row),
      bar: { ...r(bar), radius: cs(bar).borderRadius, track: cs(bar).backgroundColor, fillPaint: cs(fill).backgroundColor, fill: r(fill) },
      tier: { text: tier.textContent, ...r(tier), color: cs(tier).color },
      items: [...row.children].map((c) => ({ cls: c.className, text: (c.textContent || '').trim().slice(0, 40), ...r(c) }))
    }
  })
  console.log(JSON.stringify(geom, null, 1))
  await setTheme(win, 'dark')
  await win.waitForTimeout(700)
  await shoot(win, '19-line-open-dark', heavy)
  await heavy.locator('.route-line__row').click()
  await win.waitForTimeout(500)
  await shoot(win, '20-line-dark', heavy)
  console.log('dark bar:', JSON.stringify(await heavy.evaluate((el) => {
    const bar = el.querySelector('.route-demand')
    const fill = el.querySelector('.route-demand__fill')
    return { track: getComputedStyle(bar).backgroundColor, fill: getComputedStyle(fill).backgroundColor, w: Math.round(fill.getBoundingClientRect().width) }
  })))
  await app.close()
}
console.log('frames in', out)
