import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

// Reserve both ports together; let the app bind immediately after releasing them.
const reserve = async () => {
  const server = createServer()
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  return { server, port: server.address().port }
}
const output = resolve(process.argv[2] ?? '.tucano-local/audit/background-qa')
mkdirSync(output, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-background-qa-'))
const reservations = await Promise.all([reserve(), reserve()])
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US', TUCANO_WEBHOOK_PORT: String(reservations[0].port), TUCANO_GIT_PORT: String(reservations[1].port) }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), data, ports: reservations.map((r) => r.port), checks: [], errors: [], passed: false }
let app
try {
  await Promise.all(reservations.map(({ server }) => new Promise((yes, no) => server.close((error) => error ? no(error) : yes()))))
  app = await electron.launch({ args: [...(env.TUCANO_ELECTRON ? [] : ['.']), '--qa-background'], ...(env.TUCANO_ELECTRON ? { executablePath: env.TUCANO_ELECTRON } : {}), env })
  report.runtime = await app.evaluate(({ app, BrowserWindow }) => {
    globalThis.__qaExposure = []
    const watch = (window) => {
      for (const event of ['show', 'focus']) window.on(event, () => globalThis.__qaExposure.push({ id: window.id, event }))
    }
    BrowserWindow.getAllWindows().forEach(watch)
    app.on('browser-window-created', (_event, window) => watch(window))
    return { version: app.getVersion(), electron: process.versions.electron, executable: process.execPath, data: app.getPath('userData') }
  })
  const window = await app.firstWindow()
  window.setDefaultTimeout(15_000)
  await window.context().tracing.start({ screenshots: true, snapshots: true })
  window.on('pageerror', (error) => report.errors.push(String(error)))
  const guard = async () => {
    const state = await app.evaluate(({ BrowserWindow }) => ({ events: globalThis.__qaExposure, windows: BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused(), focusable: w.isFocusable() })) }))
    assert.deepEqual(state.events, [], 'QA exposed or focused a window')
    assert.ok(state.windows.length && state.windows.every((w) => !w.visible && !w.focused && !w.focusable), 'QA window must stay hidden and unfocusable')
  }
  const capture = async (name) => {
    await guard()
    await window.screenshot({ path: join(output, `${name}.png`) })
    await guard()
    report.checks.push(name)
  }
  await window.waitForSelector('.sidebar')
  await capture('01-workspace')
  const agents = window.locator('.nav-item', { has: window.locator('.nav-item__role') })
  assert.ok(await agents.count() >= 2, 'Seeded agents must load')
  await agents.filter({ hasText: 'Lia' }).first().click()
  await window.waitForSelector('.agent-form')
  await capture('02-agent-profile')
  await window.getByRole('button', { name: 'Open DM', exact: true }).click()
  await window.locator('.topbar__name').filter({ hasText: 'Lia' }).waitFor()
  await capture('02-agent-dm')
  await window.locator('.sidebar .nav-item').filter({ hasText: 'Settings' }).first().click()
  await window.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  await capture('03-settings')
  await window.locator('.sidebar .nav-item').filter({ hasText: 'Team' }).first().click()
  await window.waitForSelector('.orgb')
  await capture('04-team')
  await window.locator('.sidebar .nav-item').filter({ hasText: 'Usage and limits' }).first().click()
  await window.getByRole('heading', { name: 'Usage and limits', exact: true }).waitFor()
  await capture('05-usage')
  assert.deepEqual(report.errors, [])
  report.passed = true
} catch (error) {
  report.failure = String(error.stack ?? error)
  if (app) {
    const window = app.windows()[0]
    if (window) {
      report.visibleText = await window.locator('body').innerText().catch(() => '')
      await window.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
    }
  }
  process.exitCode = 1
} finally {
  if (app) {
    const window = app.windows()[0]
    if (window) await window.context().tracing.stop({ path: join(output, 'trace.zip') }).catch(() => {})
    await app.close()
  }
  for (const { server } of reservations) if (server.listening) server.close()
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}


