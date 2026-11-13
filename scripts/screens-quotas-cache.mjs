// The providers panel, opened twice: the first time it draws from the read the core already holds, and
// the read behind it moves the numbers into place. A provider answered slowly is stood in for by
// `TUCANO_QUOTA_FIXTURE_DELAY`, so the panel's first paint can be shown to happen before the answer.
//
//   npm run build && node scripts/screens-quotas-cache.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/quotas-cache'
mkdirSync(out, { recursive: true })

const name = (url) => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').toLowerCase()
const ZAI = 'https://api.z.ai/api/monitor/usage/quota/limit'

const home = mkdtempSync(join(tmpdir(), 'tucano-quota-cache-home-'))
const data = mkdtempSync(join(tmpdir(), 'tucano-quota-cache-data-'))
const fixtures = join(home, 'answers')
mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
mkdirSync(fixtures, { recursive: true })
writeFileSync(join(home, '.pi/agent/auth.json'), JSON.stringify({ zai: { type: 'api', key: 'demo-zai' } }, null, 2))

// What Z.ai says is left of the session: 50% used to start with, then 90% once the answer changes.
const zai = (usedPercent) =>
  writeFileSync(
    join(fixtures, `${name(ZAI)}.json`),
    JSON.stringify(
      {
        code: 200,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: usedPercent, nextResetTime: new Date(Date.now() + 3 * 3600_000).toISOString() },
            { type: 'TIME_LIMIT', unit: 6, number: 1, percentage: 10, nextResetTime: new Date(Date.now() + 4 * 86400_000).toISOString() }
          ]
        }
      },
      null,
      2
    )
  )

const start = async (delayMs) =>
  electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TUCANO_DATA: data,
      TUCANO_SEED: '1',
      TUCANO_FAKE_ENGINES: '1',
      TUCANO_LOCALE: 'en-US',
      TUCANO_QUOTA_HOME: home,
      TUCANO_QUOTA_FIXTURES: fixtures,
      TUCANO_QUOTA_FIXTURE_DELAY: String(delayMs)
    }
  })

zai(50)
// The first launch only writes the database and reads the quotas once, so the cache starts warm.
{
  const app = await start(1200)
  const win = await app.firstWindow()
  await win.waitForSelector('body', { timeout: 60_000 })
  await win.waitForTimeout(5000) // longer than the slow provider's answer
  await app.close()
}

const app = await start(1200)
const win = await app.firstWindow()
await win.waitForSelector('body', { timeout: 60_000 })
await win.waitForTimeout(4000)
await win.setViewportSize({ width: 1280, height: 900 })

const panel = '.usage-quotas'
const textOf = () =>
  win.evaluate(() => {
    const cell = document.querySelector('.usage-quotas .usage-quota__cell:not(.is-empty)')
    const bar = document.querySelector('.usage-quotas .usage-quota__track i')
    return {
      cell: cell?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      width: bar ? Math.round(bar.getBoundingClientRect().width) : null,
      painted: !!document.querySelector('.usage-quotas')
    }
  })

// ---------- opening the page ----------
const opened = await win.evaluate(async () => {
  const nav = [...document.querySelectorAll('.nav-item')].find((n) => /Usage|Uso/.test(n.textContent ?? ''))
  nav?.click()
  const at = performance.now()
  for (let i = 0; i < 600; i++) {
    if (document.querySelector('.usage-quotas')) return { ms: Math.round(performance.now() - at) }
    await new Promise((r) => setTimeout(r, 10))
  }
  return { ms: -1 }
})
const first = await textOf()
console.log('the panel on opening:', JSON.stringify({ ...opened, ...first }))
await win.screenshot({ path: `${out}/01-opened.png` })

// The provider's answer changes while the page is open: 50% left becomes 10% left.
zai(90)

// ---------- the read behind it, which is what the page used to wait for ----------
// The button forces a read on the slow provider: the time until the figure first moves is the wait the
// page used to pay before drawing anything at all.
const before = first.cell
const moved = await win.evaluate(async (was) => {
  const b = [...document.querySelectorAll('button')].find((x) => /Read again|Ler de novo/.test(x.textContent ?? ''))
  const at = performance.now()
  b?.click()
  const cell = () => document.querySelector('.usage-quotas .usage-quota__cell:not(.is-empty)')?.textContent?.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 400; i++) {
    if (cell() !== was) return { ms: Math.round(performance.now() - at), shown: cell() }
    await new Promise((r) => setTimeout(r, 25))
  }
  return { ms: -1, shown: cell() }
}, before)
await win.screenshot({ path: `${out}/02-while-counting.png` })
await win.waitForTimeout(1200)
const settled = await textOf()
await win.screenshot({ path: `${out}/03-after-the-read.png` })
console.log('the read behind the panel:', JSON.stringify({ before, ...moved, settled: settled.cell }))

// ---------- the numbers arrived, and the next open draws them at once ----------
await win.evaluate(() => {
  const nav = [...document.querySelectorAll('.nav-item')].find((n) => /Asks|Perguntas/.test(n.textContent ?? ''))
  nav?.click()
})
await win.waitForTimeout(700)
const again = await win.evaluate(async () => {
  const nav = [...document.querySelectorAll('.nav-item')].find((n) => /Usage|Uso/.test(n.textContent ?? ''))
  nav?.click()
  const at = performance.now()
  for (let i = 0; i < 600; i++) {
    if (document.querySelector('.usage-quotas')) return Math.round(performance.now() - at)
    await new Promise((r) => setTimeout(r, 5))
  }
  return -1
})
const second = await textOf()
console.log('the second open:', JSON.stringify({ ms: again, ...second }))
await win.screenshot({ path: `${out}/04-second-open.png` })

await app.close()
console.log('frames in', out)
