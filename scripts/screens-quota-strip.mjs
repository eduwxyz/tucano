// Frames for the little quota bars in a session's header: one bar per provider, and only the window
// that lasts longest — the month where there is a month, the week where there isn't, the short window
// for a provider that reports nothing longer — and a wallet (no cap) with no bar at all. Measured
// rather than asserted, and shot from the built app with the providers' answers as fixtures, so
// nothing is spent.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/quota-strip'
mkdirSync(out, { recursive: true })

const key = (url) => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').toLowerCase()
const R = {
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  opencode: 'https://opencode.ai/zen/go/v1/usage',
  zai: 'https://api.z.ai/api/monitor/usage/quota/limit',
  grokUser: 'https://cli-chat-proxy.grok.com/v1/user',
  grokBilling: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  deepseek: 'https://api.deepseek.com/user/balance'
}

// A home with the logins in it, and the answers each route gives. Codex reports a 5-hour window and a
// week; OpenCode Go reports all three; Z.ai only its short one and nearly spent; Grok a week; DeepSeek
// a balance with no cap, which is the one provider that must draw no bar.
function fixturesHome() {
  const home = mkdtempSync(join(tmpdir(), 'tucano-strip-home-'))
  const answers = join(home, 'answers')
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Local', 'hermes'), { recursive: true })
  mkdirSync(answers, { recursive: true })
  const write = (p, body) => writeFileSync(join(home, p), JSON.stringify(body, null, 2))
  const answer = (url, body) => writeFileSync(join(answers, `${key(url)}.json`), JSON.stringify(body, null, 2))

  write('.codex/auth.json', { tokens: { access_token: 'demo-codex', account_id: 'acct-demo' } })
  write('.local/share/opencode/auth.json', { 'opencode-go': { type: 'api', key: 'demo-opencode' } })
  write('.pi/agent/auth.json', { zai: { type: 'api', key: 'demo-zai' }, deepseek: { type: 'api', key: 'demo-deepseek' } })
  write('AppData/Local/hermes/auth.json', { providers: { 'xai-oauth': { tokens: { access_token: 'demo-grok' } } } })

  answer(R.codex, {
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      primary_window: { limit_window_seconds: 18000, used_percent: 42, reset_at: new Date(Date.now() + 3.4 * 3600_000).toISOString() },
      secondary_window: { limit_window_seconds: 604800, used_percent: 10, reset_at: new Date(Date.now() + 4.2 * 86400_000).toISOString() }
    }
  })
  answer(R.opencode, {
    usage: {
      rolling: { percent: 21, status: 'ok', resetsAt: new Date(Date.now() + 2.1 * 3600_000).toISOString() },
      weekly: { percent: 32, status: 'ok', resetsAt: new Date(Date.now() + 5.5 * 86400_000).toISOString() },
      monthly: { percent: 50, status: 'ok', resetsAt: new Date(Date.now() + 20 * 86400_000).toISOString() }
    }
  })
  answer(R.zai, { data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 96, unit: 3, nextResetTime: new Date(Date.now() + 42 * 60_000).toISOString() }] } })
  answer(R.grokUser, { userId: 'demo-user' })
  answer(R.grokBilling, {
    config: {
      creditUsagePercent: 62,
      isUnifiedBillingUser: true,
      currentPeriod: { type: 'WEEKLY', start: new Date(Date.now() - 2 * 86400_000).toISOString(), end: new Date(Date.now() + 5 * 86400_000).toISOString() }
    }
  })
  answer(R.deepseek, { balance_infos: [{ currency: 'USD', total_balance: '3.42' }] })
  return { home, answers }
}

const { home, answers } = fixturesHome()
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US', TUCANO_QUOTA_HOME: home, TUCANO_QUOTA_FIXTURES: answers }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 880 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

// Everything the header's strip is, measured.
const look = () =>
  win.evaluate(() => {
    const strip = document.querySelector('.quota-strip')
    const topbar = document.querySelector('.topbar')
    const actions = document.querySelector('.topbar__actions')
    const pills = [...document.querySelectorAll('.quota-strip__pill')]
    const r = (el) => (el ? el.getBoundingClientRect() : null)
    return {
      strip: strip
        ? {
            width: Math.round(r(strip).width),
            height: Math.round(r(strip).height),
            title: strip.getAttribute('title'),
            cursor: getComputedStyle(strip).cursor
          }
        : null,
      pills: pills.map((p) => {
        const box = r(p)
        const fill = p.querySelector('i')
        return {
          provider: p.dataset.provider,
          span: p.dataset.span,
          tone: p.className.replace('quota-strip__pill', '').trim() || '-',
          width: Math.round(box.width),
          height: Math.round(box.height),
          fill: fill ? Math.round(r(fill).width) : null,
          title: p.getAttribute('title')
        }
      }),
      topbar: topbar ? { height: Math.round(r(topbar).height), sideways: topbar.scrollWidth - topbar.clientWidth } : null,
      actionsSideways: actions ? actions.scrollWidth - actions.clientWidth : null,
      pageSideways: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth
    }
  })

// The session header of the conversation the app opens on (#engineering).
await win.waitForSelector('.composer textarea')
await win.waitForTimeout(1600) // the strip reads the providers once, on the header's first draw
console.log('1280:', JSON.stringify(await look(), null, 1))
await win.screenshot({ path: `${out}/01-header.png`, clip: { x: 0, y: 0, width: 1280, height: 120 } })

// The whole window, so the strip is seen where it lives.
await win.screenshot({ path: `${out}/02-window.png` })

// A click on the strip opens Usage and limits.
await win.click('.quota-strip')
await win.waitForSelector('.usage-quotas__grid', { timeout: 20_000 })
await win.waitForTimeout(400)
console.log(`after the click: usage page, ${await win.locator('.usage-quota__head').count()} provider columns, the strip ${(await win.locator('.quota-strip').count()) ? 'still there' : 'gone with the conversation'}`)
await win.screenshot({ path: `${out}/03-opens-usage.png` })

// Back to the conversation, and narrow: only the bars that are actually running low stay.
await win.locator('.nav-item', { hasText: 'engineering' }).first().click()
await win.waitForSelector('.composer textarea')
await win.waitForTimeout(1200)
await win.setViewportSize({ width: 420, height: 880 })
await win.waitForTimeout(600)
console.log('420:', JSON.stringify(await look(), null, 1))
await win.screenshot({ path: `${out}/04-420.png`, clip: { x: 0, y: 0, width: 420, height: 120 } })

console.log(`page errors: ${errors.length}${errors.length ? ` ${JSON.stringify(errors.slice(0, 3))}` : ''}`)
await app.close()
