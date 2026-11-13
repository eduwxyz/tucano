// The form under a pool's chain: the model picked in it must be the model that lands in the chain, on
// the first add and on every add after it. Run against the built app on a throwaway folder.
//
//   npm run build && node scripts/e2e-routing-add-model.mjs
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const data = mkdtempSync(join(tmpdir(), 'tucano-routing-add-'))
mkdirSync(data, { recursive: true })

const t = (engine, model, effort) => ({ id: `${engine}/${model}#${effort}`, engine, model, effort })
const routing = {
  enabled: true,
  pools: {
    free: { descriptor: 'free', chain: [t('opencode', 'beam-free', 'low')] },
    t1: { descriptor: 't1', chain: [] },
    t2: { descriptor: 't2', chain: [t('pi', 'openai-codex/gpt-5.6-sol', 'medium')] },
    t3: { descriptor: 't3', chain: [] },
    t4: { descriptor: 't4', chain: [] },
    t5: { descriptor: 't5', chain: [] }
  },
  roles: { code: { descriptor: 'code', chain: [] }, chat: { descriptor: 'chat', chain: [] } },
  roleFloor: {},
  free: { policy: 'fallback' },
  confidenceFloor: 0.4,
  allowTier5: false
}

const launch = () =>
  electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' } })

// ---------- one launch writes the database, the settings go in, the next one reads them ----------
{
  const app = await launch()
  const win = await app.firstWindow()
  await win.waitForSelector('body', { timeout: 60_000 })
  await win.waitForTimeout(3500)
  await app.close()
  const db = new DatabaseSync(`${data}/tucano.db`)
  const put = (k, v) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, JSON.stringify(v))
  put('routing', routing)
  put('language', 'en')
  db.close()
}

const app = await launch()
const win = await app.firstWindow()
await win.waitForSelector('body', { timeout: 60_000 })
await win.waitForTimeout(4000)
await win.setViewportSize({ width: 1366, height: 950 })
await win.getByRole('button', { name: /Settings/i }).first().click()
await win.waitForTimeout(800)
await win.getByRole('tab', { name: /^Models$/ }).first().click()
await win.waitForTimeout(600)
await win.getByRole('tab', { name: /^Routing$/ }).first().click()
await win.waitForTimeout(900)
await win.locator('.routing__pool', { hasText: 'Tier 2' }).first().click()
await win.waitForTimeout(600)

// The add form's second field is the model: the first is the harness.
const formModel = () =>
  win.evaluate(() => document.querySelectorAll('.route-add__fields .select__trigger__value')[1]?.textContent?.replace(/\s+/g, ' ').trim() ?? null)
const rowModels = () =>
  win.evaluate(() => [...document.querySelectorAll('.route-row__fields .route-row__model .select__trigger__value')].map((n) => n.textContent?.replace(/\s+/g, ' ').trim()))

// Pick a model in the add form by opening its menu and clicking its option at `index`. Returns the
// label of what was picked, so the check compares the pick with the row rather than a guessed name.
const pick = async (index) => {
  const modelSelect = win.locator('.route-add__fields .select').nth(1)
  await modelSelect.locator('.select__trigger').click()
  await win.waitForTimeout(250)
  const options = win.locator('.select__option')
  const count = await options.count()
  if (!count) throw new Error('the model menu is empty')
  const label = (await options.nth(Math.min(index, count - 1)).innerText()).split('\n')[0]?.trim() ?? ''
  await options.nth(Math.min(index, count - 1)).click()
  await win.waitForTimeout(250)
  return label
}

const add = async () => {
  await win.locator('.route-add button.btn').first().click()
  await win.waitForTimeout(400)
}

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const addDisabled = () => win.locator('.route-add button.btn').first().isDisabled()
const hintText = () => win.evaluate(() => document.querySelector('.route-add .hint')?.textContent?.trim() ?? null)

const firstOption = await formModel()
check('the pool starts with one model', (await rowModels()).length === 1, JSON.stringify(await rowModels()))

// ---------- the first add ----------
const pickedFirstLabel = await pick(1)
const pickedFirst = await formModel()
await add()
const afterFirst = await rowModels()
check('the first add lands the model that was picked', afterFirst.length === 2 && afterFirst[1] === pickedFirst, `${pickedFirstLabel} → ${JSON.stringify(afterFirst)}`)
check('the form keeps the model it just added', (await formModel()) === pickedFirst, String(await formModel()))

// ---------- the second add, with the form no longer resetting to the default ----------
const pickedSecondLabel = await pick(2)
const pickedSecond = await formModel()
await add()
const afterSecond = await rowModels()
check('the second add lands the model that was picked', afterSecond.length === 3 && afterSecond[2] === pickedSecond, `${pickedSecondLabel} → ${JSON.stringify(afterSecond)}`)
check('the form keeps the second pick as well', (await formModel()) === pickedSecond, String(await formModel()))

// ---------- a model already in the chain says so instead of taking the click ----------
const beforeDupe = (await rowModels()).length
await pick(1) // the model the first add put in the chain
check('a model already in the chain leaves Add disabled', await addDisabled(), `rows=${beforeDupe}`)
check('and the form says why', /Already in the chain/.test(String(await hintText())), String(await hintText()))

// ---------- changing the thinking makes the same model a different step ----------
const effortSelect = win.locator('.route-add__fields .select').nth(2)
await effortSelect.locator('.select__trigger').click()
await win.waitForTimeout(250)
await win.locator('.select__option').nth(2).click()
await win.waitForTimeout(250)
check('a different thinking makes it addable again', !(await addDisabled()), String(await hintText()))
await add()
const afterThird = await rowModels()
check('and the third add lands it', afterThird.length === beforeDupe + 1, JSON.stringify(afterThird))
check('the first model added is still the first one in the chain', afterThird[1] === pickedFirst, `${afterThird[1]} vs ${pickedFirst}`)
check('the default model was never added by accident', !afterThird.slice(1).includes(firstOption), `first option ${firstOption}`)

await win.screenshot({ path: join(data, 'after-adds.png') })
await app.close()

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks pass`)
process.exit(failed.length ? 1 : 0)
