// Renderer-only desktop connection UX regression. No real server, SSH or tokens.
// Screenshots are the actual rendered UI with synthetic demo profiles, never a real
// user VPS or proof of a live connection. Label them as demo fixtures in PR/docs.
// CONNECTIONS_SCREENSHOT preserves the offline image path and also writes sibling
// -connected.png and -pairing.png images for the multi-environment and add views.
// Run: npm run build && node scripts/connections-e2e.mjs
// Install a Playwright Chromium first, or set CHROMIUM_PATH to a local executable.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, parse, resolve, sep } from 'node:path'

const root = fileURLToPath(new URL('../out/renderer/', import.meta.url))
await stat(resolve(root, 'index.html'))
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(`${resolve(root)}${sep}`)) { res.writeHead(403).end(); return }
    res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const screenshot = async (view, target = page) => {
    const output = process.env.CONNECTIONS_SCREENSHOT
    if (!output) return
    const { dir, name } = parse(output)
    const path = view === 'offline' ? output : resolve(dir || '.', `${name}-${view}.png`)
    await mkdir(dirname(path), { recursive: true })
    await page.evaluate(async () => { await document.fonts.ready })
    await target.screenshot({ path, animations: 'disabled' })
  }
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    window.mockState = {
      active: 'prod',
      profiles: [
        { id: 'prod', name: 'Pessoal (exemplo)', reach: { via: 'ssh', user: 'me', host: 'example.com', port: 22 }, remotePort: 7337 },
        { id: 'dev', name: 'Trabalho (exemplo)', reach: { via: 'url', url: 'https://dev.example.com' }, remotePort: 7337 }
      ],
      status: 'error', error: 'secret=DO-NOT-ECHO',
      pairLink: 'tucano://pair?v=1&code=K7QM-2XPD-9TWH&ssh=me@example.com&name=NewVPS'
    }
    window.calls = []
    window.handlers = new Set()
    window.tucano = {
      connect() {}, onNavigate() {}, viewing() {},
      remote: {
        state: async () => window.mockState,
        onState: (fn) => { window.handlers.add(fn); return () => window.handlers.delete(fn) },
        pair: (link) => {
          window.calls.push(['pair', link])
          return new Promise((resolve) => {
            window.finishPair = () => {
              window.mockState = { ...window.mockState, status: 'connected', error: undefined, pairLink: undefined }
              resolve()
            }
          })
        },
        select: async (id) => {
          window.calls.push(['select', id])
          window.mockState = { ...window.mockState, active: id, status: id ? 'connected' : 'local', error: undefined, pairLink: undefined }
        },
        forget: async (id) => {
          window.calls.push(['forget', id])
          window.mockState = { ...window.mockState, profiles: window.mockState.profiles.filter((p) => p.id !== id), active: null, status: 'local' }
        },
        rename: async (id, name) => {
          window.calls.push(['rename', id, name])
          window.mockState = { ...window.mockState, profiles: window.mockState.profiles.map((p) => p.id === id ? { ...p, name } : p) }
        }
      }
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.locator('dialog[open]').waitFor()
  assert.equal(await page.evaluate(() => window.calls.length), 0, 'Deep links must never pair automatically')
  assert.equal(await page.locator('[data-connection-id]').count(), 2)
  assert.equal(await page.locator('[data-connection-id="prod"].is-selected').count(), 1)
  assert.ok(!(await page.locator('body').innerText()).includes('DO-NOT-ECHO'), 'Native exceptions must be redacted')
  await screenshot('offline')
  // Specific security failures must retain actionable guidance, not become generic
  // network/expired-code errors just because the native message says "pair again".
  for (const [message, expected] of [
    ['Server identity changed. Verify the VPS and pair again.', 'A identidade deste servidor mudou.'],
    ['Cannot verify this server identity. Update the VPS server.', 'Não foi possível verificar a identidade do servidor.'],
    ['Secure storage is unavailable. Unlock the system keychain and pair again.', 'O armazenamento seguro está indisponível ou bloqueado.'],
    ['This saved server uses plaintext HTTP outside localhost. Configure HTTPS (including Tailscale Serve) and pair again.', 'Esta conexão salva precisa de HTTPS, inclusive no Tailscale.']
  ]) {
    await page.evaluate((message) => {
      window.mockState = { ...window.mockState, error: `${message} secret=DO-NOT-ECHO` }
      for (const handler of window.handlers) handler(window.mockState)
    }, message)
    await page.getByRole('alert').filter({ hasText: expected }).waitFor()
    assert.ok(!(await page.locator('body').innerText()).includes('DO-NOT-ECHO'), 'Security error guidance must never echo native secrets')
  }
  await page.evaluate(() => {
    window.mockState = { ...window.mockState, error: 'Network unavailable' }
    for (const handler of window.handlers) handler(window.mockState)
  })
  await page.getByRole('alert').filter({ hasText: 'Não foi possível conectar.' }).waitFor()
  const form = page.locator('.connection-form')
  const submit = form.locator('button[type=submit]')
  await form.locator('input[type=password]').fill('invalid-link')
  assert.equal(await submit.isDisabled(), true)
  await form.locator('select').selectOption('ssh')
  await form.locator('input').nth(0).fill('me@example.com:2222')
  await form.locator('input[type=password]').fill('K7QM-2XPD-9TWH')
  await form.getByLabel('Nome do ambiente (opcional)', { exact: true }).fill('Staging')
  assert.equal(await submit.isEnabled(), true)
  // Synthetic code remains masked by the real password field; nothing contacts a VPS.
  await screenshot('pairing', form)
  await submit.click()
  await page.keyboard.press('Escape')
  await page.locator('.connection-switch').click()
  assert.equal(await submit.isDisabled(), true, 'Closing and reopening must not permit duplicate pending pairing')
  for (const key of ['Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    assert.equal(await page.getByRole('button', { name: 'Fechar', exact: true }).evaluate((button) => button === document.activeElement), true, 'While busy, traversal must skip disabled controls and stay on Close')
  }
  assert.equal(await page.evaluate(() => window.calls.filter((c) => c[0] === 'pair').length), 1)
  const paired = new URL(await page.evaluate(() => window.calls.find((c) => c[0] === 'pair')[1]))
  assert.equal(paired.searchParams.get('ssh'), 'me@example.com:2222')
  assert.equal(paired.searchParams.get('name'), 'Staging')
  await page.evaluate(() => window.finishPair())
  await page.locator('dialog[open]').waitFor({ state: 'hidden' })
  await page.locator('.connection-switch').click()
  const dev = page.locator('[data-connection-id="dev"]')
  await dev.getByRole('button', { name: 'Conectar', exact: true }).click()
  await page.waitForFunction(() => window.mockState.active === 'dev')
  assert.equal(await dev.locator('.connection-selected').count(), 1)
  // Reset the dialog scroll so both demo environments and the active badge are visible.
  await page.locator('dialog').evaluate((dialog) => { dialog.scrollTop = 0 })
  await screenshot('connected')
  await dev.getByRole('button', { name: 'Renomear', exact: true }).click()
  await dev.getByLabel('Nome do ambiente', { exact: true }).fill('Sandbox')
  await dev.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await page.waitForFunction(() => window.mockState.profiles.find((p) => p.id === 'dev').name === 'Sandbox')
  await page.getByRole('button', { name: 'Usar local', exact: true }).click()
  await page.waitForFunction(() => window.mockState.status === 'local')
  assert.equal(await page.locator('.connection-profile--local.is-selected').count(), 1)
  const prod = page.locator('[data-connection-id="prod"]')
  await prod.getByRole('button', { name: 'Esquecer', exact: true }).click()
  assert.equal(await page.evaluate(() => window.calls.filter((c) => c[0] === 'forget').length), 0)
  await prod.getByRole('button', { name: 'Cancelar', exact: true }).click()
  assert.equal(await prod.locator('.connection-forget').count(), 0)
  for (const id of ['prod', 'dev']) {
    const row = page.locator(`[data-connection-id="${id}"]`)
    await row.getByRole('button', { name: 'Esquecer', exact: true }).click()
    await row.getByRole('button', { name: 'Esquecer conexão', exact: true }).click()
    await row.waitFor({ state: 'hidden' })
  }
  await page.locator('.connection-empty').waitFor()
  await form.locator('select').selectOption('url')
  await form.locator('input').nth(0).fill('http://example.com')
  await form.locator('input[type=password]').fill('K7QM-2XPD-9TWH')
  assert.equal(await submit.isDisabled(), true)
  await form.locator('input').nth(0).fill('http://100.64.1.2:7337')
  assert.equal(await submit.isDisabled(), true, 'Tailscale direct URLs also require HTTPS')
  await form.locator('input').nth(0).fill('https://demo.example.ts.net')
  assert.equal(await submit.isEnabled(), true)
  await form.locator('input').nth(0).fill('http://127.0.0.1:7337')
  assert.equal(await submit.isEnabled(), true, 'Loopback HTTP remains permitted')
  const close = page.getByRole('button', { name: 'Fechar', exact: true })
  await submit.focus()
  await page.keyboard.press('Tab')
  assert.equal(await close.evaluate((button) => button === document.activeElement), true, 'Tab on the final control must wrap to Close')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await submit.evaluate((button) => button === document.activeElement), true, 'Shift+Tab on Close must wrap to the final control')
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(key)
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true, `${key}: focus must stay inside the modal`)
    }
  }
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.connection-switch').evaluate((button) => button === document.activeElement), true, 'Closing must return focus to the connection switch')
  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.className = 'onb'
    document.querySelector('.connection-content').appendChild(overlay)
  })
  await page.locator('.connection-switch').click()
  await page.locator('dialog[open]').waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: boot, explicit deep-link pairing, secret redaction, validation, SSH port, duplicate protection, dismissal, multi-VPS switching, rename, local, forget/cancel, empty state, URL policy, focus trap and onboarding overlay.')
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
