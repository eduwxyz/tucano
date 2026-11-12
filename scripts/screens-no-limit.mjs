// Frames for "0 means no limit" on the screens. Run after `npm run build`:
//   node scripts/screens-no-limit.mjs seed <data-dir>      makes the workspace (once)
//   node scripts/screens-no-limit.mjs shoot <data-dir> <out-dir>
// The data dir can then be shot from a second checkout, for a before/after pair.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [mode, data, outArg] = process.argv.slice(2)
if (!mode || !data) throw new Error('usage: node scripts/screens-no-limit.mjs seed|shoot <data-dir> [out-dir]')
const out = outArg ?? 'screens/no-limit'

const launch = (extra = {}) =>
  electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US', ...extra } })

if (mode === 'seed') {
  const first = await launch({ TUCANO_SEED: '1' })
  const w = await first.firstWindow()
  await w.waitForSelector('.sidebar', { timeout: 60_000 })
  await w.waitForTimeout(2000)
  await first.close()
  console.log(execFileSync(process.execPath, ['scripts/seed-no-limit.mjs', data], { encoding: 'utf8' }))
} else {
  mkdirSync(out, { recursive: true })
  const app = await launch()
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  // Tall enough for the whole team to be on screen at once: a frame that hides half the dots proves half.
  await win.setViewportSize({ width: 1280, height: 1080 })
  await win.waitForSelector('.sidebar')
  await win.waitForTimeout(1200)
  // The agents' rows are their own list; the channels are above them.
  const rows = await win.evaluate(() => {
    const agentRows = [...document.querySelectorAll('.sidebar .nav-item')].filter((r) => r.querySelector('.nav-item__label') && r.querySelector('[class*="avatar"]'))
    return agentRows.map((r) => ({ name: r.querySelector('.nav-item__label')?.textContent ?? '', dot: r.querySelector('.dot')?.className ?? null, title: r.querySelector('.dot')?.getAttribute('title') ?? null }))
  })
  console.log('agent rows:', JSON.stringify(rows))
  console.log('dots:', rows.filter((r) => r.dot).length, 'of', rows.length)
  const allVisible = await win.evaluate(() => {
    const list = document.querySelector('.sidebar')
    const box = list.getBoundingClientRect()
    const seen = [...document.querySelectorAll('.sidebar .nav-item')].filter((r) => {
      const b = r.getBoundingClientRect()
      return b.height > 0 && b.top >= box.top - 1 && b.bottom <= box.bottom + 1
    })
    return { rows: document.querySelectorAll('.sidebar .nav-item').length, visible: seen.length }
  })
  console.log('sidebar rows visible:', JSON.stringify(allVisible))
  await win.screenshot({ path: join(out, '01-sidebar.png') })

  // One agent's page: the budget line under the profile, and the limit field beside it.
  // Nina sits at 0 with a lot spent: the agent whose page says "of 0 tokens" on the old reading.
  // Clicked inside its own section: the DM row carries the agent's name too.
  const openIn = (section, name) => win.evaluate(([sec, who]) => {
    const head = [...document.querySelectorAll('.sidebar .section')].find((s) => new RegExp(sec, 'i').test(s.textContent ?? ''))
    const row = [...(head?.querySelectorAll('.nav-item') ?? [])].find((r) => (r.textContent ?? '').includes(who))
    row?.click()
    return !!row
  }, [section, name])
  console.log('agents row clicked:', await openIn('agents', 'Nina'))
  await win.waitForTimeout(900)
  const page = await win.evaluate(() => ({
    budget: document.querySelector('.profile-card__budget')?.textContent ?? null,
    field: [...document.querySelectorAll('label, .field')].map((f) => f.textContent ?? '').find((t) => /monthly limit/i.test(t))?.slice(0, 200) ?? null
  }))
  console.log('profile budget:', page.budget)
  console.log('limit field:', page.field)
  await win.screenshot({ path: join(out, '02-agent-page.png') })

  // The DM with Nina: a reply that stopped at the limit, and the buttons it offers.
  console.log('dm row clicked:', await openIn('direct messages|mensagens diretas', 'Nina'))
  await win.waitForTimeout(1200)
  const reply = await win.evaluate(() => {
    const last = [...document.querySelectorAll('.msg')].at(-1)
    return last ? { text: (last.textContent ?? '').slice(0, 160), buttons: [...last.querySelectorAll('button')].map((b) => b.textContent ?? b.getAttribute('title') ?? '') } : null
  })
  console.log('reply:', JSON.stringify(reply))
  await win.screenshot({ path: join(out, '03-limit-reply.png') })

  await app.close()
  console.log('page errors:', errors)
}
