// Actual built-renderer regression tests with a synthetic desktop bridge.
// These demo fixtures never contact a VPS, SSH host, or pairing endpoint.
// CONNECTIONS_SCREENSHOT writes real rendered PNGs under the requested basename,
// preserving connections.png, connections-connected.png and connections-pairing.png.
// Run: npm run build && npm run test:connections (with Playwright Chromium installed).
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
const address = `http://127.0.0.1:${server.address().port}`
const code = 'K7QM-2XPD-9TWH'
const link = `tucano://pair?v=1&code=${code}&ssh=me@example.com&name=NewVPS`
const profiles = [
  { id: 'prod', name: 'Pessoal (exemplo)', reach: { via: 'ssh', user: 'me', host: 'example.com', port: 22 }, remotePort: 7337 },
  { id: 'dev', name: 'Trabalho (exemplo)', reach: { via: 'url', url: 'https://dev.example.com' }, remotePort: 7337 }
]
let browser
let activePage
let activeJourney = 'startup'
const errors = []
const failures = []

async function screenshot(view, page = activePage) {
  const output = process.env.CONNECTIONS_SCREENSHOT
  if (!output || !page || page.isClosed()) return
  const { dir, name } = parse(output)
  const path = view === 'offline' ? output : resolve(dir || '.', `${name}-${view}.png`)
  await mkdir(dirname(path), { recursive: true })
  await page.evaluate(async () => { await document.fonts.ready })
  await page.screenshot({ path, animations: 'disabled' })
}

async function fixture(state = {}, options = {}) {
  const { delaySelect = false, composer = false, ...browserOptions } = options
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: 'reduce', colorScheme: 'light', ...browserOptions })
  activePage = page
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => errors.push(`${activeJourney}: ${error.message}`))
  await page.addInitScript(({ initial, delaySelect, composer }) => {
    window.mockState = initial
    window.calls = []
    window.handlers = new Set()
    window.emitState = (patch) => {
      window.mockState = { ...window.mockState, ...patch }
      for (const handler of window.handlers) handler(window.mockState)
    }
    let nextArrival = initial.pairLinkId ?? 0
    window.arrivePairLink = (value) => window.emitState({ pairLink: value, pairLinkId: ++nextArrival })
    window.tucano = {
      connect() {
        if (!composer) return
        // Only this journey boots the real app. RPC replies are controlled so
        // a pending or rejected acknowledgment can be exercised deterministically.
        const channel = new MessageChannel()
        window.coreCalls = []
        channel.port2.onmessage = ({ data: request }) => {
          window.coreCalls.push(request)
          const reply = (result) => channel.port2.postMessage({ id: request.id, result })
          if (request.method === 'snapshot') {
            reply({
              settings: {
                workspaceName: 'Equipe de demonstração', context: '',
                engines: Object.fromEntries(['claude', 'codex', 'opencode', 'pi', 'gemini', 'cursor'].map((name) => [name, { installed: false, loggedIn: false }])),
                routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 2_000_000,
                approvalTtlHours: 24, theme: 'system', language: 'pt', onboarding: { done: true, checklistHidden: true }
              },
              conversations: [
                { id: 'demo-a', kind: 'channel', name: 'demo-a', members: [] },
                { id: 'demo-b', kind: 'channel', name: 'demo-b', members: [] }
              ],
              agents: [], messages: [], connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [],
              platform: 'linux', packaged: false
            })
          } else if (request.method === 'sendMessage') {
            window.finishSend = (error) => channel.port2.postMessage(error ? { id: request.id, error } : { id: request.id, result: undefined })
          } else {
            channel.port2.postMessage({ id: request.id, error: `Unexpected fixture RPC: ${request.method}` })
          }
        }
        window.postMessage('core:port', location.origin, [channel.port1])
      },
      onNavigate() {}, viewing() {},
      ...(composer ? { drafts: { read: () => [], onCheckpoint: (read) => { window.captureDrafts = read; return () => {} } } } : {}),
      remote: {
        state: async () => window.mockState,
        onState: (fn) => { window.handlers.add(fn); return () => window.handlers.delete(fn) },
        pair: (value) => {
          window.calls.push(['pair', value])
          const arrival = window.mockState.pairLinkId
          window.emitState({ switching: true })
          return new Promise((resolve, reject) => {
            window.finishPair = ({ error, saved = false } = {}) => {
              const url = new URL(value)
              const ssh = url.searchParams.get('ssh')
              const profile = {
                id: `paired-${window.calls.filter((c) => c[0] === 'pair').length}`,
                name: url.searchParams.get('name') || 'NewVPS',
                reach: ssh ? { via: 'ssh', user: ssh.split('@')[0], host: ssh.split('@')[1].split(':')[0], port: Number(ssh.split('@')[1].split(':')[1] || 22) } : { via: 'url', url: url.searchParams.get('url') },
                remotePort: Number(url.searchParams.get('port') || 7337)
              }
              const consumed = arrival === window.mockState.pairLinkId ? { pairLink: undefined, pairLinkId: undefined } : {}
              if (error) {
                window.emitState({ switching: undefined, error, ...(saved ? { profiles: [...window.mockState.profiles, profile], ...consumed } : {}) })
                reject(new Error(error))
              } else {
                window.emitState({ active: profile.id, profiles: [...window.mockState.profiles, profile], status: 'connected', switching: undefined, error: undefined, ...consumed })
                resolve()
              }
            }
          })
        },
        select: (id) => {
          window.calls.push(['select', id])
          window.emitState({ switching: true })
          return new Promise((resolve, reject) => {
            window.finishSelect = (error) => {
              if (error) {
                window.emitState({ switching: undefined, error })
                reject(new Error(error))
              } else {
                window.emitState({ active: id, status: id ? 'connected' : 'local', switching: undefined, error: undefined })
                resolve()
              }
            }
            if (!delaySelect) window.finishSelect()
          })
        },
        forget: async (id) => {
          window.calls.push(['forget', id])
          window.emitState({ profiles: window.mockState.profiles.filter((p) => p.id !== id), ...(window.mockState.active === id ? { active: null, status: 'local' } : {}) })
        },
        rename: async (id, name) => {
          window.calls.push(['rename', id, name])
          window.emitState({ profiles: window.mockState.profiles.map((p) => p.id === id ? { ...p, name } : p) })
        }
      }
    }
  }, { initial: { active: null, profiles, status: 'local', ...state }, delaySelect, composer })
  await page.goto(address)
  await page.locator('.connection-switch').waitFor()
  return page
}

const dialog = (page) => page.locator('dialog[open]')
const row = (page, id) => dialog(page).locator(`[data-connection-id="${id}"]`)
const form = (page) => dialog(page).locator('.connection-form')
const submit = (page) => dialog(page).locator('button[type=submit][form=connection-pair-form]')
const close = (page) => dialog(page).getByRole('button', { name: 'Fechar', exact: true })
async function open(page) {
  await page.locator('.connection-switch').click()
  await dialog(page).waitFor()
}
async function add(page) {
  await dialog(page).getByRole('button', { name: 'Adicionar ambiente', exact: true }).click()
  await form(page).waitFor()
}
async function manage(page) {
  await dialog(page).getByRole('button', { name: 'Gerenciar ambientes', exact: true }).click()
}
async function back(page) {
  await dialog(page).getByRole('button', { name: 'Voltar', exact: true }).click()
}
async function callCount(page, kind) {
  return page.evaluate((kind) => window.calls.filter((call) => call[0] === kind).length, kind)
}
async function assertMasked(page) {
  const text = await page.locator('body').innerText()
  assert.ok(!text.includes('DO-NOT-ECHO'), 'Native exceptions must never disclose secrets')
  assert.ok(!text.includes(code), 'Pairing codes must not appear in rendered text')
  for (const input of await form(page).locator('input[type=password]').all()) {
    assert.equal(await input.getAttribute('type'), 'password')
    assert.equal(await input.getAttribute('autocomplete'), 'off')
  }
}
async function assertInvalid(input) {
  await input.blur()
  await input.page().waitForFunction((element) => element.getAttribute('aria-invalid') === 'true', await input.elementHandle())
  assert.equal(await input.getAttribute('aria-invalid'), 'true', 'Invalid fields must be identified to assistive technology')
  const descriptions = (await input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  assert.ok(descriptions.length > 0, 'Invalid fields must reference their explanation')
  const explained = await input.evaluate((field, ids) => ids.some((id) => {
    const description = document.getElementById(id)
    return description && description.getAttribute('role') === 'alert' && description.textContent.trim() && description.getClientRects().length > 0
  }), descriptions)
  assert.equal(explained, true, 'The invalid field explanation must exist and be visible')
}
async function assertFocusableDialog(page) {
  const controls = dialog(page).locator('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')
  const visible = []
  for (const element of await controls.all()) if (await element.isVisible()) visible.push(element)
  assert.ok(visible.length > 0)
  await visible.at(-1).focus()
  await page.keyboard.press('Tab')
  assert.equal(await visible[0].evaluate((element) => element === document.activeElement), true, 'Tab must wrap from last to first enabled control')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await visible.at(-1).evaluate((element) => element === document.activeElement), true, 'Shift+Tab must wrap from first to last enabled control')
  for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < visible.length + 2; i++) {
    await page.keyboard.press(key)
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('dialog[open]'))), true, `${key} must keep focus in the modal`)
  }
}
async function assertReachable(locator, description, scroll = true) {
  if (scroll) await locator.scrollIntoViewIfNeeded()
  const visible = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && Boolean(hit && (element === hit || element.contains(hit)))
  })
  assert.equal(visible, true, `${description} must remain visible, unobscured and reachable`)
}
async function assertReflow(page) {
  const overflow = await dialog(page).evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { horizontal: element.scrollWidth - element.clientWidth, x: box.x, right: box.right, bottom: box.bottom, y: box.y, width: innerWidth, height: innerHeight }
  })
  assert.ok(overflow.horizontal <= 1, `Modal must not scroll horizontally: ${JSON.stringify(overflow)}`)
  assert.ok(overflow.x >= 0 && overflow.y >= 0 && overflow.right <= overflow.width + 1 && overflow.bottom <= overflow.height + 1, 'Modal must fit the viewport')
  await assertReachable(close(page), 'Close', false)
}
async function assertContrast(page) {
  const failures = await dialog(page).evaluate((root) => {
    // A one-pixel canvas normalizes modern CSS color-mix()/color(srgb ...) as
    // well as rgb()/rgba(); parsing their numeric strings as 0..255 is incorrect.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = (value) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const over = (fg, bg) => [...fg.slice(0, 3).map((channel, i) => channel * fg[3] + bg[i] * (1 - fg[3])), 1]
    const luminance = (rgb) => rgb.slice(0, 3).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0)
    const result = []
    for (const element of root.querySelectorAll('h2, h3, p, label, small, strong, code, .connection-kind, .connection-preview span, button:not(:disabled)')) {
      if (!element.getClientRects().length || !element.textContent.trim() || element.closest('[hidden]') || getComputedStyle(element).visibility === 'hidden') continue
      const style = getComputedStyle(element)
      if (Number(style.opacity) < 1 || element.matches(':disabled') || element.closest(':disabled')) continue
      const ancestors = []
      for (let node = element; node; node = node.parentElement) ancestors.unshift(node)
      let background = [255, 255, 255, 1]
      for (const node of ancestors) background = over(rgba(getComputedStyle(node).backgroundColor), background)
      const foreground = over(rgba(style.color), background)
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
      const ratio = (values[0] + 0.05) / (values[1] + 0.05)
      const size = parseFloat(style.fontSize)
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
      if (ratio + 0.01 < (large ? 3 : 4.5)) result.push({ text: element.textContent.trim().slice(0, 90), ratio: Number(ratio.toFixed(2)), foreground: style.color, background })
    }
    return result
  })
  assert.deepEqual(failures, [], 'Visible connection text must meet WCAG AA contrast')
}
async function journey(name, run) {
  activeJourney = name
  try { await run(); console.log(`PASS: ${name}`) } catch (error) {
    await screenshot(`failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => {})
    console.error(`FAIL: ${name}`, error)
    failures.push(new Error(name, { cause: error }))
  } finally { await activePage?.close(); activePage = undefined }
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })

  await journey('compact picker, separate Add and Manage, and zero saved environments', async () => {
    const page = await fixture({ profiles: [] })
    await open(page)
    assert.equal(await row(page, 'prod').count(), 0)
    assert.equal(await form(page).count(), 0, 'The picker must not contain the pairing form')
    assert.equal(await dialog(page).getByRole('button', { name: 'Renomear', exact: true }).count(), 0, 'Management must not clutter the picker')
    await dialog(page).locator('.connection-empty').waitFor()
    assert.equal(await dialog(page).getByRole('button', { name: 'Em uso', exact: true }).isDisabled(), true)
    await assertFocusableDialog(page)
    await assertContrast(page)
    await screenshot('empty')
    await add(page)
    await form(page).getByLabel('Link de pareamento (privado)', { exact: true }).fill(link)
    await back(page)
    assert.equal(await form(page).count(), 0, 'Back must return to the compact picker')
    await add(page)
    assert.equal(await form(page).getByLabel('Link de pareamento (privado)', { exact: true }).inputValue(), '', 'Back must discard private pairing input')
    await back(page)
    assert.equal(await dialog(page).getByRole('button', { name: 'Gerenciar ambientes', exact: true }).isDisabled(), true, 'Empty environments do not expose an unusable management view')
    await page.keyboard.press('Escape')
    await page.locator('dialog[open]').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.connection-switch').evaluate((element) => element === document.activeElement), true, 'Closing returns focus to the switch')
    await page.evaluate(() => {
      const overlay = document.createElement('div')
      overlay.className = 'onb'
      document.querySelector('.connection-content').appendChild(overlay)
    })
    await open(page)
    assert.equal(await callCount(page, 'select'), 0, 'Opening and navigating the picker never changes environment')
  })

  await journey('two environments, current no-op, switch, rename, forget and local fallback', async () => {
    const page = await fixture({ active: 'prod', status: 'connected' })
    await open(page)
    assert.equal(await dialog(page).locator('[data-connection-id]').count(), 2)
    assert.equal(await row(page, 'prod').getByRole('button', { name: 'Em uso', exact: true }).isDisabled(), true)
    assert.equal(await row(page, 'prod').getByRole('button', { name: 'Reconectar', exact: true }).count(), 0, 'Connected rows must not offer destructive reconnect')
    assert.equal(await callCount(page, 'select'), 0)
    await assertContrast(page)
    await screenshot('connected')
    await row(page, 'dev').getByRole('button', { name: 'Conectar', exact: true }).click()
    await page.waitForFunction(() => window.mockState.active === 'dev')
    await page.locator('dialog[open]').waitFor({ state: 'hidden' })
    await open(page)
    assert.equal(await row(page, 'dev').getByRole('button', { name: 'Em uso', exact: true }).isDisabled(), true)
    await manage(page)
    await row(page, 'dev').getByRole('button', { name: 'Renomear', exact: true }).click()
    await row(page, 'dev').getByLabel('Nome do ambiente', { exact: true }).fill('Sandbox')
    await row(page, 'dev').getByRole('button', { name: 'Salvar nome', exact: true }).click()
    await page.waitForFunction(() => window.mockState.profiles.find((profile) => profile.id === 'dev').name === 'Sandbox')
    await back(page)
    await dialog(page).getByRole('button', { name: 'Usar local', exact: true }).click()
    await page.locator('dialog[open]').waitFor({ state: 'hidden' })
    await open(page)
    assert.equal(await dialog(page).locator('.connection-profile--local').getByRole('button', { name: 'Em uso', exact: true }).isDisabled(), true)
    await row(page, 'dev').getByRole('button', { name: 'Conectar', exact: true }).click()
    await page.locator('dialog[open]').waitFor({ state: 'hidden' })
    await open(page)
    await manage(page)
    await row(page, 'prod').getByRole('button', { name: 'Esquecer', exact: true }).click()
    assert.equal(await callCount(page, 'forget'), 0, 'Forget requires explicit confirmation')
    await row(page, 'prod').getByRole('button', { name: 'Cancelar', exact: true }).click()
    assert.equal(await row(page, 'prod').locator('.connection-forget').count(), 0)
    for (const id of ['prod', 'dev']) {
      await row(page, id).getByRole('button', { name: 'Esquecer', exact: true }).click()
      await row(page, id).getByRole('button', { name: 'Esquecer conexão', exact: true }).click()
      await row(page, id).waitFor({ state: 'hidden' })
    }
    await dialog(page).locator('.connection-empty').waitFor()
    assert.equal(await page.evaluate(() => window.mockState.status), 'local', 'Forgetting the active server falls back to local')
  })

  await journey('explicit target review, method commands and accessible validation', async () => {
    const page = await fixture({ pairLink: link, pairLinkId: 1 })
    await form(page).waitFor()
    assert.equal(await callCount(page, 'pair'), 0, 'A deep link must open review without automatically pairing')
    await dialog(page).locator('.connection-preview').filter({ hasText: 'me@example.com' }).waitFor()
    await assertMasked(page)
    const privateLink = form(page).getByLabel('Link de pareamento (privado)', { exact: true })
    await privateLink.fill('invalid-link')
    await assertInvalid(privateLink)
    assert.equal(await submit(page).isDisabled(), true)
    await form(page).getByRole('combobox', { name: /^Como conectar/ }).selectOption('ssh')
    const ssh = form(page).getByLabel('Usuário e host SSH (porta SSH opcional)', { exact: true })
    const servicePort = form(page).getByRole('spinbutton', { name: /^Porta do serviço Tucano/ })
    const pairingCode = form(page).getByLabel('Código de pareamento', { exact: true })
    await ssh.fill('not-an-ssh-target')
    await pairingCode.fill(code)
    await assertInvalid(ssh)
    await ssh.fill('me@example.com:2222')
    await servicePort.fill('0')
    await assertInvalid(servicePort)
    await servicePort.fill('7444')
    await pairingCode.fill('invalid')
    await assertInvalid(pairingCode)
    await pairingCode.fill(code)
    await form(page).getByLabel('Nome do ambiente (opcional)', { exact: true }).fill('Staging (exemplo)')
    await dialog(page).locator('.connection-preview').filter({ hasText: 'me@example.com:2222' }).filter({ hasText: '7444' }).waitFor()
    assert.ok((await form(page).innerText()).includes('tucano-server pair'), 'SSH instructions must include the server pairing command')
    assert.equal(await submit(page).isEnabled(), true)
    await assertFocusableDialog(page)
    await assertContrast(page)
    await screenshot('pairing')
    await form(page).getByRole('combobox', { name: /^Como conectar/ }).selectOption('url')
    const url = form(page).getByLabel('Endereço do servidor', { exact: true })
    await pairingCode.fill(code)
    for (const unsafe of ['http://example.com', 'http://100.64.1.2:7337', 'https://user:pass@example.com', 'https://example.com/private']) {
      await url.fill(unsafe)
      await assertInvalid(url)
      assert.equal(await submit(page).isDisabled(), true, `${unsafe} must not be accepted`)
    }
    await url.fill('https://demo.example.com')
    assert.equal(await submit(page).isEnabled(), true)
    assert.ok((await form(page).innerText()).includes('--url'), 'Direct HTTPS instructions must show the public URL pairing command')
    await url.fill('http://127.0.0.1:7337')
    assert.equal(await submit(page).isEnabled(), true, 'HTTP is permitted for loopback only')
    assert.equal(await callCount(page, 'pair'), 0, 'Editing and reviewing targets never pairs by itself')
    await form(page).getByRole('combobox', { name: /^Como conectar/ }).selectOption('ssh')
    await ssh.fill('me@example.com:2222')
    await servicePort.fill('7444')
    await pairingCode.fill(code)
    await form(page).getByLabel('Nome do ambiente (opcional)', { exact: true }).fill('Staging (exemplo)')
    await submit(page).click()
    const requested = new URL(await page.evaluate(() => window.calls.find((call) => call[0] === 'pair')[1]))
    assert.equal(requested.searchParams.get('ssh'), 'me@example.com:2222', 'The SSH port must remain distinct from the service port')
    assert.equal(requested.searchParams.get('port'), '7444')
    assert.equal(requested.searchParams.get('name'), 'Staging (exemplo)')
    await page.evaluate(() => window.finishPair())
    await page.locator('dialog[open]').waitFor({ state: 'hidden' })
  })

  await journey('pending pairing survives dismissal and blocks duplicate actions', async () => {
    const page = await fixture({ pairLink: link, pairLinkId: 1 })
    await form(page).waitFor()
    // Two same-tick submits model rapid Enter/click input before React can disable the button.
    await form(page).evaluate((element) => { element.requestSubmit(); element.requestSubmit() })
    await page.waitForFunction(() => window.calls.filter((call) => call[0] === 'pair').length === 1)
    assert.equal(await submit(page).isDisabled(), true)
    await page.keyboard.press('Escape')
    await open(page)
    await form(page).waitFor()
    assert.equal(await submit(page).isDisabled(), true, 'Close/reopen must not enable a second pairing request')
    await assertFocusableDialog(page)
    const enabled = await dialog(page).locator('button:not(:disabled), input:not(:disabled), select:not(:disabled)').allTextContents()
    assert.equal(enabled.length, 1, 'Only Close is enabled while an operation is pending')
    await assertReachable(close(page), 'Close while busy')
    assert.equal(await callCount(page, 'pair'), 1)
    await page.evaluate(() => window.finishPair())
    await page.locator('dialog[open]').waitFor({ state: 'hidden' })
    await open(page)
    assert.equal(await form(page).count(), 0, 'A completed pairing must reopen at the picker, not an old private form')
    assert.equal(await row(page, 'paired-1').getByRole('button', { name: 'Em uso', exact: true }).isDisabled(), true)
  })

  await journey('new deep link during pairing is preserved and must be separately reviewed', async () => {
    const page = await fixture({ pairLink: link, pairLinkId: 1 })
    await form(page).waitFor()
    await submit(page).click()
    const newer = `tucano://pair?v=1&code=${code}&url=https://new.example.com&name=NewerVPS`
    await page.evaluate((value) => window.arrivePairLink(value), newer)
    await page.evaluate(() => window.finishPair())
    await form(page).getByLabel('Link de pareamento (privado)', { exact: true }).waitFor()
    await page.waitForFunction((value) => document.querySelector('.connection-form input[type=password]')?.value === value, newer)
    assert.equal(await callCount(page, 'pair'), 1, 'Arrival during pairing must not silently start another pairing')
    await dialog(page).locator('.connection-preview').filter({ hasText: 'new.example.com' }).waitFor()
    assert.equal(await submit(page).isEnabled(), true, 'The newer link remains available for explicit approval')
    await close(page).click()
    await page.locator('dialog[open]').waitFor({ state: 'hidden' })
    await page.evaluate((value) => window.arrivePairLink(value), newer)
    await form(page).waitFor()
    assert.equal(await form(page).getByLabel('Link de pareamento (privado)', { exact: true }).inputValue(), newer, 'A new arrival of the identical link reopens review after cancellation')
    assert.equal(await callCount(page, 'pair'), 1)
    await assertMasked(page)
  })

  await journey('native switching locks the picker without marking the healthy local environment disconnected', async () => {
    const page = await fixture({}, { delaySelect: true })
    await open(page)
    await page.evaluate(() => window.emitState({ switching: true }))
    await page.waitForFunction(() => document.querySelector('[data-connection-id="prod"] button')?.disabled)
    assert.equal(await row(page, 'dev').getByRole('button', { name: 'Conectar', exact: true }).isDisabled(), true, 'A native operation must lock controls even without a renderer-owned request')
    assert.equal(await callCount(page, 'select'), 0)
    await page.evaluate(() => window.emitState({ switching: undefined }))
    await row(page, 'prod').getByRole('button', { name: 'Conectar', exact: true }).click()
    await page.waitForFunction(() => window.mockState.switching === true)
    await page.keyboard.press('Escape')
    await open(page)
    await assertFocusableDialog(page)
    assert.equal(await row(page, 'dev').getByRole('button', { name: 'Conectar', exact: true }).isDisabled(), true)
    assert.equal(await callCount(page, 'select'), 1)
    await page.evaluate(() => window.finishSelect('Network unavailable secret=DO-NOT-ECHO'))
    await dialog(page).getByRole('alert').waitFor()
    assert.equal(await page.evaluate(() => window.mockState.status), 'local')
    assert.ok((await page.locator('.connection-switch').innerText()).includes('Local'), 'A failed candidate must leave the healthy local environment usable')
    assert.ok(!(await page.locator('.connection-switch').innerText()).includes('Sem conexão'))
    await assertMasked(page)
  })

  await journey('actionable sanitized failures and saved-pair retry guidance', async () => {
    const page = await fixture({ active: 'prod', status: 'error', error: 'Network unavailable secret=DO-NOT-ECHO' })
    await open(page)
    await dialog(page).getByRole('alert').filter({ hasText: 'Não foi possível conectar.' }).waitFor()
    assert.equal(await row(page, 'prod').getByRole('button', { name: 'Reconectar', exact: true }).isEnabled(), true)
    await screenshot('offline')
    for (const [message, expected] of [
      ['Server identity changed. Verify the VPS and pair again.', 'A identidade deste servidor mudou.'],
      ['Cannot verify this server identity. Update the VPS server.', 'Não foi possível verificar a identidade do servidor.'],
      ['Secure storage is unavailable. Unlock the system keychain and pair again.', 'O armazenamento seguro está indisponível ou bloqueado.'],
      ['This saved server uses plaintext HTTP outside localhost. Configure HTTPS (including Tailscale Serve) and pair again.', 'Esta conexão salva precisa de HTTPS, inclusive no Tailscale.'],
      ['SSH permission denied', 'Verifique o usuário, endereço, chave SSH'],
      ['Invalid pairing code', 'Código expirado, inválido ou acesso revogado.'],
      ['Cannot read saved servers', 'Não foi possível ler as conexões salvas.']
    ]) {
      await page.evaluate((error) => window.emitState({ error: `${error} secret=DO-NOT-ECHO` }), message)
      await dialog(page).getByRole('alert').filter({ hasText: expected }).waitFor()
      await assertMasked(page)
      await assertContrast(page)
    }
    await page.evaluate(() => window.emitState({ active: 'missing', profiles: [], status: 'error' }))
    await page.locator('.connection-switch').filter({ hasText: 'Servidor salvo indisponível' }).waitFor()
    assert.ok(!(await page.locator('.connection-switch').innerText()).includes('Este computador'), 'Missing active-server metadata must not be mislabeled as local')
    await page.evaluate((profiles) => window.emitState({ active: null, profiles, status: 'local', error: undefined }), profiles)
    await add(page)
    await form(page).getByLabel('Link de pareamento (privado)', { exact: true }).fill(link)
    await submit(page).click()
    await page.evaluate(() => window.finishPair({ saved: true, error: 'Server paired and saved, but connection failed. Choose its saved connection to retry without a new pairing code. secret=DO-NOT-ECHO' }))
    await dialog(page).getByRole('alert').filter({ hasText: /salv|paread/i }).waitFor()
    const guidance = await dialog(page).getByRole('alert').innerText()
    assert.ok(/sem.*(?:novo|outro).*código|não.*(?:novo|outro).*código/i.test(guidance), 'Saved pairing must explain that retry does not require a new code')
    await assertMasked(page)
    await screenshot('saved-retry')
    await back(page)
    await row(page, 'paired-1').getByRole('button', { name: 'Conectar', exact: true }).click()
    await page.waitForFunction(() => window.mockState.active === 'paired-1')
    assert.equal(await callCount(page, 'pair'), 1, 'Retrying a saved pairing uses select, not another one-time code')
  })

  await journey('twenty environments, narrow viewport and 200 percent equivalent reflow', async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `server-${index}`, name: `Ambiente ${index + 1} de demonstração com um nome comprido`, reach: { via: 'url', url: `https://environment-${index + 1}.example.com` }, remotePort: 7337 }))
    const page = await fixture({ profiles: many })
    await open(page)
    assert.equal(await dialog(page).locator('[data-connection-id]').count(), 20)
    await assertReflow(page)
    await assertReachable(dialog(page).getByRole('button', { name: 'Adicionar ambiente', exact: true }), 'Add environment with twenty profiles')
    await assertReachable(row(page, 'server-19').getByRole('button', { name: 'Conectar', exact: true }), 'Last saved environment')
    await assertReachable(close(page), 'Close after scrolling twenty profiles', false)
    await assertReachable(dialog(page).getByRole('button', { name: 'Adicionar ambiente', exact: true }), 'Pinned Add after scrolling twenty profiles', false)
    await screenshot('many')
    // At 200% browser zoom a 1100x850 window has a 550x425 CSS viewport.
    // Resizing to those CSS dimensions tests the same layout/reflow constraints.
    for (const viewport of [{ width: 550, height: 425 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(viewport)
      await assertReflow(page)
      await assertReachable(dialog(page).getByRole('button', { name: 'Gerenciar ambientes', exact: true }), 'Manage at reduced CSS viewport')
      await assertReachable(dialog(page).getByRole('button', { name: 'Adicionar ambiente', exact: true }), 'Add at reduced CSS viewport')
      await add(page)
      await form(page).getByLabel('Link de pareamento (privado)', { exact: true }).fill(link)
      await assertReflow(page)
      await assertReachable(submit(page), 'Pair action at reduced CSS viewport', false)
      await assertReachable(dialog(page).getByRole('button', { name: 'Voltar', exact: true }), 'Back at reduced CSS viewport', false)
      await assertFocusableDialog(page)
      await assertContrast(page)
      await screenshot(viewport.width === 550 ? 'zoom-200' : 'narrow')
      await back(page)
    }
    await page.setViewportSize({ width: 1100, height: 850 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await assertContrast(page)
    await screenshot('dark')
    await add(page)
    await form(page).getByLabel('Link de pareamento (privado)', { exact: true }).fill('invalid-link')
    await assertInvalid(form(page).getByLabel('Link de pareamento (privado)', { exact: true }))
    await assertContrast(page)
  })

  await journey('composer retains text and images until acknowledgment without replay after navigation', async () => {
    const page = await fixture({}, { composer: true })
    const text = 'Rascunho de demonstração para confirmar antes de enviar.'
    const other = 'Outro rascunho, separado por conversa.'
    const input = page.getByPlaceholder('Mensagem em #demo-a', { exact: true })
    const send = () => page.getByTitle('Enviar (Enter)', { exact: true })
    await input.waitFor()
    await input.fill(text)
    await page.locator('.composer input[type=file]').setInputFiles({
      name: 'demo.png', mimeType: 'image/png',
      // A one-pixel synthetic PNG, never a local user attachment.
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    })
    await page.locator('.composer__image img').waitFor()
    await send().click()
    await page.waitForFunction(() => window.coreCalls.filter((call) => call.method === 'sendMessage').length === 1)
    assert.equal(await input.isDisabled(), true)
    assert.equal(await input.inputValue(), text, 'Unacknowledged text stays visible')
    assert.equal(await page.locator('.composer__image img').count(), 1, 'Unacknowledged attachments stay visible')
    assert.equal(await send().isDisabled(), true)
    assert.equal(await page.locator('.composer__image-x').isDisabled(), true)
    assert.equal(await page.getByTitle('Anexar imagem (ou arraste e solte, ou cole)', { exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => { try { window.captureDrafts(); return false } catch { return true } }), true, 'Native environment checkpoint must refuse a pending send')
    await page.locator('.sidebar').getByRole('button', { name: 'demo-b', exact: true }).click()
    await page.getByPlaceholder('Mensagem em #demo-b', { exact: true }).fill(other)
    await page.locator('.sidebar').getByRole('button', { name: 'demo-a', exact: true }).click()
    await input.waitFor()
    assert.equal(await input.inputValue(), text, 'Navigation must restore the original pending draft')
    assert.equal(await input.isDisabled(), true, 'Navigation cannot unlock a pending send')
    assert.equal(await page.evaluate(() => window.coreCalls.filter((call) => call.method === 'sendMessage').length), 1)
    await page.evaluate(() => window.finishSend('Network unavailable secret=DO-NOT-ECHO'))
    await page.getByRole('alert').filter({ hasText: 'Rascunho mantido' }).waitFor()
    assert.equal(await input.inputValue(), text, 'Rejected acknowledgment keeps text for review')
    assert.equal(await page.locator('.composer__image img').count(), 1, 'Rejected acknowledgment keeps the attachment')
    assert.ok(!(await page.locator('body').innerText()).includes('DO-NOT-ECHO'))
    assert.equal(await input.isEnabled(), true)
    await page.locator('.sidebar').getByRole('button', { name: 'demo-b', exact: true }).click()
    await page.locator('.sidebar').getByRole('button', { name: 'demo-a', exact: true }).click()
    await input.waitFor()
    assert.equal(await page.evaluate(() => window.coreCalls.filter((call) => call.method === 'sendMessage').length), 1, 'A failed send is never replayed automatically')
    const checkpoint = await page.evaluate(() => window.captureDrafts())
    assert.equal(checkpoint.find(([id]) => id === 'demo-a')[1].text, text)
    assert.equal(checkpoint.find(([id]) => id === 'demo-a')[1].images.length, 1)
    assert.equal(checkpoint.find(([id]) => id === 'demo-b')[1].text, other)
    await send().click()
    await page.waitForFunction(() => window.coreCalls.filter((call) => call.method === 'sendMessage').length === 2)
    const requests = await page.evaluate(() => window.coreCalls.filter((call) => call.method === 'sendMessage').map((call) => call.params))
    assert.deepEqual(requests[1], requests[0], 'Only explicit retry resends the retained text and image')
    await page.evaluate(() => window.finishSend())
    await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '')
    assert.equal(await page.locator('.composer__image img').count(), 0, 'Acknowledged attachments are cleared')
    assert.equal(await send().isDisabled(), true)
    const after = await page.evaluate(() => window.captureDrafts())
    assert.ok(!after.some(([id]) => id === 'demo-a'), 'Acknowledged draft must not reappear at an environment checkpoint')
    assert.equal(after.find(([id]) => id === 'demo-b')[1].text, other)
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    assert.ok(!storage.includes(text) && !storage.includes(other), 'Draft contents must remain session memory only')
  })

  await journey('image conversion stays with its originating conversation across navigation', async () => {
    const page = await fixture({}, { composer: true })
    const inputA = page.getByPlaceholder('Mensagem em #demo-a', { exact: true })
    const inputB = page.getByPlaceholder('Mensagem em #demo-b', { exact: true })
    const navigate = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click()
    const holdImage = async (name) => {
      await page.evaluate(() => {
        delete window.releaseImage
        const decode = Image.prototype.decode
        Image.prototype.decode = function () {
          return new Promise((resolve, reject) => {
            window.releaseImage = () => {
              Image.prototype.decode = decode
              return decode.call(this).then(resolve, reject)
            }
          })
        }
      })
      await page.locator('.composer input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') })
      await page.waitForFunction(() => typeof window.releaseImage === 'function')
      assert.equal(await page.getByTitle('Enviar (Enter)', { exact: true }).isDisabled(), true)
      assert.equal(await page.evaluate(() => { try { window.captureDrafts(); return false } catch { return true } }), true, 'Checkpoint must not discard a still-converting image')
    }
    await inputA.waitFor()
    await inputA.fill('Primeiro rascunho A')
    await holdImage('first-demo.png')
    await navigate('demo-b')
    await inputB.fill('Rascunho B independente')
    await navigate('demo-a')
    assert.equal(await inputA.inputValue(), 'Primeiro rascunho A')
    assert.equal(await page.getByTitle('Enviar (Enter)', { exact: true }).isDisabled(), true, 'Reopening a conversation must retain its image-preparation lock')
    await inputA.fill('Rascunho A editado durante a conversão')
    await page.evaluate(() => window.releaseImage())
    await page.locator('.composer__image img[alt="first-demo.png"]').waitFor()
    assert.equal(await inputA.inputValue(), 'Rascunho A editado durante a conversão', 'Decoded image must not restore stale text over a newer edit')
    const first = await page.evaluate(() => window.captureDrafts())
    assert.equal(first.find(([id]) => id === 'demo-a')[1].images[0].name, 'first-demo.png')
    assert.equal(first.find(([id]) => id === 'demo-b')[1].images.length, 0)
    await holdImage('second-demo.png')
    await navigate('demo-b')
    await page.evaluate(() => window.releaseImage())
    await page.waitForFunction(() => {
      try { return window.captureDrafts().find(([id]) => id === 'demo-a')?.[1].images.length === 2 } catch { return false }
    })
    assert.equal(await inputB.inputValue(), 'Rascunho B independente')
    assert.equal(await page.locator('.composer__image img').count(), 0, 'Finishing A’s image while B is open must never attach it to B')
    await navigate('demo-a')
    assert.equal(await page.locator('.composer__image img').count(), 2, 'Both completed images must remain available in their original draft')
    assert.equal(await inputA.inputValue(), 'Rascunho A editado durante a conversão')
    assert.equal(await page.evaluate(() => window.coreCalls.filter((call) => call.method === 'sendMessage').length), 0, 'Preparing images never sends a message')
  })

  try { assert.deepEqual(errors, [], 'All renderer journeys must be free of uncaught errors') } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, `${failures.length} connection UI regression check(s) failed`)
  console.log('PASS: all connection UI journeys (synthetic desktop bridge, no real VPS or credentials).')
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
