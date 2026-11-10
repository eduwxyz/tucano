// Screenshots of the providers panel in Usage and limits: one column per provider, three quota
// rows, the numbers and bars from each provider's own answer, a column near the limit, one that
// couldn't be read, the same panel at 420 px, and what it says when nobody is signed in.
//
// No real login is used: the auth files and the providers' answers are fixtures in a temp folder,
// so the frames are the same every time and nothing is spent.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens-quotas'
mkdirSync(out, { recursive: true })

// The route each provider is asked on, as the app turns it into a fixture file name.
const name = (url) => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').toLowerCase()
const ROUTES = {
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  opencode: 'https://opencode.ai/zen/go/v1/usage',
  zai: 'https://api.z.ai/api/monitor/usage/quota/limit',
  grokUser: 'https://cli-chat-proxy.grok.com/v1/user',
  grokBilling: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  deepseek: 'https://api.deepseek.com/user/balance',
  claude: 'https://api.anthropic.com/api/oauth/usage'
}

// A home with five logins in it, laid out as each tool writes them, and the answers they get.
function setup({ withClaude = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tucano-quota-home-'))
  const fixtures = join(home, 'answers')
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Local', 'hermes'), { recursive: true })
  mkdirSync(fixtures, { recursive: true })
  const write = (path, body) => writeFileSync(join(home, path), JSON.stringify(body, null, 2))

  write('.codex/auth.json', { tokens: { access_token: 'demo-codex', account_id: 'acct-demo' } })
  write('.local/share/opencode/auth.json', { 'opencode-go': { type: 'api', key: 'demo-opencode' } })
  write('.pi/agent/auth.json', { zai: { type: 'api', key: 'demo-zai' }, deepseek: { type: 'api', key: 'demo-deepseek' } })
  write('AppData/Local/hermes/auth.json', { providers: { 'xai-oauth': { tokens: { access_token: 'demo-grok' } } } })
  if (withClaude) write('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'demo-claude', subscriptionType: 'max' } })

  const answer = (url, body) => writeFileSync(join(fixtures, `${name(url)}.json`), JSON.stringify(body, null, 2))
  answer(ROUTES.codex, {
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      primary_window: { limit_window_seconds: 18000, used_percent: 42, reset_at: new Date(Date.now() + 3.4 * 3600_000).toISOString() },
      secondary_window: { limit_window_seconds: 604800, used_percent: 10, reset_at: new Date(Date.now() + 4.2 * 86400_000).toISOString() }
    }
  })
  answer(ROUTES.opencode, {
    usage: {
      rolling: { percent: 21, status: 'ok', resetsAt: new Date(Date.now() + 2.1 * 3600_000).toISOString() },
      weekly: { percent: 32, status: 'ok', resetsAt: new Date(Date.now() + 5.5 * 86400_000).toISOString() },
      monthly: { percent: 50, status: 'ok', resetsAt: new Date(Date.now() + 20 * 86400_000).toISOString() }
    }
  })
  // Near the end of the short window, so the panel shows what a quota about to run out looks like.
  answer(ROUTES.zai, { data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 96, unit: 3, nextResetTime: new Date(Date.now() + 42 * 60_000).toISOString() }] } })
  answer(ROUTES.grokUser, { userId: 'demo-user' })
  answer(ROUTES.grokBilling, {
    config: {
      creditUsagePercent: 62,
      isUnifiedBillingUser: true,
      currentPeriod: { type: 'WEEKLY', start: new Date(Date.now() - 2 * 86400_000).toISOString(), end: new Date(Date.now() + 5 * 86400_000).toISOString() }
    }
  })
  answer(ROUTES.deepseek, { balance_infos: [{ currency: 'USD', total_balance: '3.42' }] })
  if (withClaude) writeFileSync(join(fixtures, `${name(ROUTES.claude)}.json`), JSON.stringify({ __status: 401 }))
  return { home, fixtures }
}

async function open({ withClaude = false } = {}) {
  const { home, fixtures } = setup({ withClaude })
  const data = mkdtempSync(join(tmpdir(), 'tucano-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US', TUCANO_QUOTA_HOME: home, TUCANO_QUOTA_FIXTURES: fixtures }
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 900 })
  await win.waitForSelector('.sidebar')
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.click('.nav-item:has-text("Usage and limits")')
  await win.waitForSelector('.usage-quotas__grid, .usage-card', { timeout: 20_000 })
  await win.waitForTimeout(600)
  return { app, win, errors }
}

const shot = (win, f) => win.screenshot({ path: `${out}/${f}.png` })
const heads = (win) => win.locator('.usage-quota__head').allInnerTexts()
const cells = (win) => win.locator('.usage-quota__cell').allInnerTexts()

// ---------- the panel as it is ----------
{
  const { app, win, errors } = await open()
  const names = await heads(win)
  console.log(`providers: ${names.length} ${JSON.stringify(names)}`)
  const rows = await win.locator('.usage-quotas__row').allInnerTexts()
  console.log(`rows: ${JSON.stringify(rows)}`)
  const grid = await win.locator('.usage-quota__cell').evaluateAll((els) => els.map((e) => [e.dataset.provider, e.dataset.row, e.innerText.split(String.fromCharCode(10))[0], !!e.querySelector('.usage-quota__track')]))
  console.log(`cells: ${grid.length}`)
  for (const id of [...new Set(grid.map((g) => g[0]))]) console.log(`  ${id}: ${JSON.stringify(grid.filter((g) => g[0] === id).map((g) => `${g[1]}=${g[2]}${g[3] ? ' [bar]' : ''}`))}`)
  console.log(`bars: ${await win.locator('.usage-quota__track').count()} (a balance has none)`)
  console.log(`warnings: ${await win.locator('.usage-quota__cell.is-warn').count()}, dangers: ${await win.locator('.usage-quota__cell.is-danger').count()}`)
  const danger = win.locator('.usage-quota__cell.is-danger').first()
  console.log(`the danger cell: ${JSON.stringify(await danger.innerText())}, bar ${await danger.locator('.usage-quota__track i').getAttribute('style')}`)
  // Each column's header sits over its own cells, and the row labels line up with their row.
  const align = await win.evaluate(() => {
    const out = []
    for (const head of document.querySelectorAll('.usage-quota__head')) {
      const id = [...document.querySelectorAll('.usage-quota__head')].indexOf(head)
      const cell = document.querySelectorAll(`.usage-quota__cell[data-row="session"]`)[id]
      out.push(Math.round(head.getBoundingClientRect().x - cell.getBoundingClientRect().x))
    }
    const first = document.querySelector('.usage-quotas__row')
    const label = document.querySelector('.usage-quota__cell')
    return { offsets: out, labelToCell: Math.round(label.getBoundingClientRect().x - first.getBoundingClientRect().right) }
  })
  console.log(`head over its own cells, px off: ${JSON.stringify(align.offsets)}; row label to first cell: ${align.labelToCell} px`)
  console.log(`value size ${await win.locator('.usage-quota__cell strong').first().evaluate((e) => getComputedStyle(e).fontSize)}, bar height ${await win.locator('.usage-quota__track').first().evaluate((e) => getComputedStyle(e).height)}`)
  await shot(win, '01-panel')
  // The whole page, to show where the panel sits above the month.
  const sheet = win.locator('.sheet')
  console.log(`panel top at ${Math.round((await win.locator('.usage-quotas').boundingBox()).y)} px, month below at ${Math.round((await win.locator('.usage-month').boundingBox()).y)} px`)
  console.log(`sideways scroll at 1280: ${await win.locator('.usage-quotas').evaluate((el) => el.scrollWidth - el.clientWidth)} px`)
  await win.setViewportSize({ width: 420, height: 900 })
  await win.waitForTimeout(400)
  await shot(win, '02-narrow')
  console.log(`at 420: providers ${await win.locator('.usage-quota__head').count()}, sideways ${await win.locator('.usage-quotas').evaluate((el) => el.scrollWidth - el.clientWidth)} px (it scrolls, the columns never wrap)`)
  const widths = await win.locator('.usage-quota__head').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)))
  console.log(`column widths at 420: ${JSON.stringify(widths)}`)
  await app.close()
  ok(errors)
  void sheet
}

// ---------- a provider it couldn't read ----------
{
  const { app, win, errors } = await open({ withClaude: true })
  const names = await heads(win)
  console.log(`with an expired login: ${names.length} providers, ${JSON.stringify(names.map((n) => n.split('\n')[0]))}`)
  const off = win.locator('.usage-quota__head.is-off')
  console.log(`the one that's off: ${JSON.stringify(await off.innerText())}`)
  console.log(`its cells: ${JSON.stringify(await off.evaluate((el) => [...el.parentElement.querySelectorAll('.usage-quota__cell')].length))}`)
  console.log(`dashes: ${await win.locator('.usage-quota__cell.is-empty').count()}`)
  await shot(win, '04-expired')
  await app.close()
  ok(errors)
}

// ---------- nobody signed in ----------
{
  const home = mkdtempSync(join(tmpdir(), 'tucano-quota-empty-'))
  const data = mkdtempSync(join(tmpdir(), 'tucano-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US', TUCANO_QUOTA_HOME: home, TUCANO_QUOTA_FIXTURES: join(home, 'answers') }
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 900 })
  await win.waitForSelector('.sidebar')
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.click('.nav-item:has-text("Usage and limits")')
  await win.waitForSelector('.usage-card', { timeout: 20_000 })
  await win.waitForTimeout(500)
  console.log(`empty: providers ${await win.locator('.usage-quota__head').count()}, says ${JSON.stringify((await win.locator('.usage-card').first().innerText()).split('\n').slice(0, 3))}`)
  await shot(win, '05-no-login')
  await app.close()
  ok(errors)
}

function ok(errors) {
  console.log(`page errors: ${errors.length}${errors.length ? ` ${JSON.stringify(errors.slice(0, 3))}` : ''}`)
}
