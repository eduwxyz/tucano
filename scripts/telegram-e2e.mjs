// Actual Electron UI + utility-process core, with isolated data and a local Bot
// API stand-in. AI uses the app's deterministic test engine. No real bot/token.
// Run: npm run build && node scripts/telegram-e2e.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const root = resolve(import.meta.dirname, '..')
mkdirSync('/tmp/opencode', { recursive: true })
const dir = mkdtempSync('/tmp/opencode/tucano-telegram-')
const appDir = join(dir, 'app')
mkdirSync(appDir)
cpSync(join(root, 'out'), join(appDir, 'out'), { recursive: true })
symlinkSync(join(root, 'node_modules'), join(appDir, 'node_modules'))
symlinkSync(join(root, 'build'), join(appDir, 'build'))
writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'tucano', version: '0.2.8', type: 'module', main: 'out/main/index.js' }))

let updateId = 0
let messageId = 100
const queue = []
const sent = []
let poll
const push = (message) => {
  queue.push({ update_id: ++updateId, message: { message_id: ++messageId, chat: { id: 42, first_name: 'Test user' }, ...message } })
  if (poll) { const res = poll; poll = undefined; res.end(JSON.stringify({ ok: true, result: queue.splice(0) })) }
}
const api = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const method = /\/bot[^/]+\/(\w+)/.exec(req.url)?.[1]
  if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { username: 'tucano_test_bot' } }))
  if (method === 'getUpdates') {
    if (queue.length) return res.end(JSON.stringify({ ok: true, result: queue.splice(0) }))
    poll = res
    res.on('close', () => { if (poll === res) poll = undefined })
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  const record = { method, body: JSON.parse(body || '{}'), id: ++messageId }
  sent.push(record)
  res.end(JSON.stringify({ ok: true, result: { message_id: record.id } }))
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const address = `http://127.0.0.1:${api.address().port}`
// Instrument only the disposable build copy, never production source/output.
const coreFile = join(appDir, 'out/main/core.js')
writeFileSync(coreFile, `const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => realFetch(String(url).replace('https://api.telegram.org', ${JSON.stringify(address)}), init);\n${readFileSync(coreFile, 'utf8')}\nvoid ready.then(() => telegram?.start());\n`)

let app
let win
const errors = []
async function launch() {
  app = await electron.launch({ args: [appDir], cwd: root, env: { ...process.env, TUCANO_DATA: join(dir, 'data'), TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en' } })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 900 })
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.waitForSelector('.sidebar')
  // A second normal core port, independent of the renderer store's port.
  await win.evaluate(() => new Promise((resolve) => {
    const receive = (event) => {
      if (event.data !== 'core:port' || !event.ports[0]) return
      window.removeEventListener('message', receive)
      const port = event.ports[0]
      let seq = 0
      const pending = new Map()
      port.onmessage = ({ data }) => {
        const p = pending.get(data.id)
        if (!p) return
        pending.delete(data.id)
        data.error ? p.reject(new Error(data.error)) : p.resolve(data.result)
      }
      window.e2eCall = (method, params) => new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        port.postMessage({ id, method, params })
      })
      resolve()
    }
    window.addEventListener('message', receive)
    window.tucano.connect()
  }))
}
const rpc = (method, params) => win.evaluate(([m, p]) => window.e2eCall(m, p), [method, params])
const snapshot = () => rpc('snapshot')
async function until(test, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await test()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out: ${label}`)
}
async function phoneCard() {
  await win.locator('.nav-item').filter({ hasText: 'Settings' }).click()
  await win.getByRole('tab', { name: 'Phone and GitHub' }).click()
  return win.locator('.card').filter({ has: win.getByText('Phone (Telegram)', { exact: true }) })
}
try {
  await launch()
  const initial = await snapshot()
  assert.notEqual(initial.settings.telegramFinishedMessages, true)
  const general = await rpc('createChannel', { name: 'general' })
  const company = await rpc('createChannel', { name: 'company-x' })
  const [calendar, coder] = initial.agents
  await rpc('setChannelMembers', { id: general, agentIds: [coder.id] })
  await rpc('setChannelMembers', { id: company, agentIds: [calendar.id, coder.id] })
  for (const c of initial.conversations) if (c.kind === 'channel') await rpc('deleteConversation', { id: c.id })

  const card = await phoneCard()
  const incomingSwitch = card.getByRole('switch', { name: 'Send messages to agents', exact: true })
  const finishedSwitch = card.getByRole('switch', { name: 'Receive all finished replies', exact: true })
  assert.equal(await incomingSwitch.getAttribute('aria-checked'), 'false')
  assert.equal(await finishedSwitch.getAttribute('aria-checked'), 'false')
  await card.locator('input[type=password]').fill('TEST_TOKEN')
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await until(async () => (await snapshot()).settings.telegram?.code, 'pairing code')
  push({ text: `/start ${(await snapshot()).settings.telegram.code}` })
  await until(async () => (await snapshot()).settings.telegram?.chat, 'pairing')

  push({ text: 'This task must not be posted' })
  await until(() => sent.some((s) => s.body.text?.includes('To send new tasks, enable')), 'incoming tasks disabled')
  assert.equal((await snapshot()).messages.some((m) => m.text === 'This task must not be posted'), false)
  await incomingSwitch.click()
  await until(async () => (await snapshot()).settings.telegramIncomingMessages === true, 'incoming switch saved')
  assert.equal((await snapshot()).settings.telegramFinishedMessages, false)

  push({ text: 'on company X, check the dates of next 3 meetings' })
  await until(async () => (await snapshot()).messages.some((m) => m.conversationId === company && m.author.kind === 'agent' && m.run?.status === 'done'), 'routed completion')
  let state = await snapshot()
  assert.equal(state.messages.filter((m) => m.conversationId === general).length, 0)
  assert.equal(state.messages.find((m) => m.conversationId === company && m.author.kind === 'agent').author.id, calendar.id)
  assert.equal(sent.some((s) => s.body.text?.includes('Test reply') || s.body.text?.includes('Resposta de teste')), false)
  console.log('✓ incoming message triaged before posting; one correct agent; finished notifications off by default')

  await finishedSwitch.click()
  await until(async () => (await snapshot()).settings.telegramFinishedMessages === true, 'switch saved')
  push({ text: 'on company X, check next week too' })
  await until(() => sent.some((s) => s.body.text?.startsWith(`${calendar.name} (#company-x):`)), 'finished Telegram reply')
  const completed = sent.find((s) => s.body.text?.startsWith(`${calendar.name} (#company-x):`))
  await win.screenshot({ path: join(dir, 'telegram-settings.png') })

  await app.close()
  await launch()
  assert.equal((await snapshot()).settings.telegramFinishedMessages, true)
  assert.equal((await snapshot()).settings.telegramIncomingMessages, true)
  // Receiving results/replying must not depend on allowing new tasks.
  const restartedCard = await phoneCard()
  await restartedCard.getByRole('switch', { name: 'Send messages to agents', exact: true }).click()
  await until(async () => (await snapshot()).settings.telegramIncomingMessages === false, 'incoming switch off')
  assert.equal((await snapshot()).settings.telegramFinishedMessages, true)
  push({ text: 'check those dates again', reply_to_message: { message_id: completed.id } })
  await until(async () => (await snapshot()).messages.some((m) => m.conversationId === company && m.author.kind === 'me' && m.text === 'check those dates again'), 'reply after restart')
  await until(async () => (await snapshot()).messages.filter((m) => m.conversationId === company && m.author.kind === 'agent' && m.run?.status === 'done').length >= 3, 'reply completed')
  assert.equal((await snapshot()).messages.filter((m) => m.conversationId === general).length, 0)
  console.log('✓ shared switch persists; completion delivered; reply after app restart returns to original channel/agent')

  const card2 = await phoneCard()
  await card2.getByRole('switch', { name: 'Send messages to agents', exact: true }).click()
  await until(async () => (await snapshot()).settings.telegramIncomingMessages === true, 'incoming switch back on')
  await card2.getByRole('switch', { name: 'Receive all finished replies', exact: true }).click()
  await until(async () => (await snapshot()).settings.telegramFinishedMessages === false, 'switch off')
  push({ text: 'company X: pergunte o prazo' })
  await until(() => sent.some((s) => s.body.reply_markup?.force_reply), 'question still forwarded while switch off')
  const question = sent.find((s) => s.body.reply_markup?.force_reply)
  await card2.getByRole('switch', { name: 'Send messages to agents', exact: true }).click()
  await until(async () => (await snapshot()).settings.telegramIncomingMessages === false, 'both switches off')
  push({ text: 'Friday', reply_to_message: { message_id: question.id } })
  await until(async () => (await snapshot()).messages.some((m) => m.text === 'Friday' && m.conversationId === company), 'question answered')
  console.log('✓ existing questions still replyable with both switches off')

  const connector = await rpc('addConnector', { input: { name: 'Test tasks', kind: 'stdio', command: process.execPath, args: [join(root, 'scripts/demo-mcp-server.mjs')], env: { DEMO_TASKS_FILE: join(dir, 'tasks.json') } } })
  await until(async () => (await snapshot()).connectors.find((c) => c.id === connector)?.status === 'connected', 'demo connector')
  const currentAgent = (await snapshot()).agents.find((a) => a.id === calendar.id)
  await rpc('saveAgent', { agent: { ...currentAgent, grants: { [connector]: 'read_write' } }, channelIds: [company] })
  await card2.getByRole('switch', { name: 'Send messages to agents', exact: true }).click()
  await until(async () => (await snapshot()).settings.telegramIncomingMessages === true, 'enable approval task')
  push({ text: 'company X: apague a tarefa 1' })
  await until(() => sent.some((s) => s.body.reply_markup?.inline_keyboard), 'approval with completion switch off')
  const approval = sent.find((s) => s.body.reply_markup?.inline_keyboard)
  assert.match(JSON.stringify(approval.body.reply_markup), /ap:.*:ok/)
  const pendingApproval = (await snapshot()).approvals.find((a) => a.state === 'pending')
  assert.ok(pendingApproval)
  await card2.getByRole('switch', { name: 'Send messages to agents', exact: true }).click()
  await until(async () => (await snapshot()).settings.telegramIncomingMessages === false, 'disable new tasks during approval')
  // Refuse through Telegram's real callback path; nothing destructive executes.
  queue.push({ update_id: ++updateId, callback_query: { id: 'refuse-test', data: `ap:${pendingApproval.id}:no`, message: { message_id: approval.id, chat: { id: 42 } } } })
  if (poll) { const res = poll; poll = undefined; res.end(JSON.stringify({ ok: true, result: queue.splice(0) })) }
  await until(async () => (await snapshot()).approvals.find((a) => a.id === pendingApproval.id)?.state === 'refused', 'Telegram refusal')
  console.log('✓ approvals still delivered; Telegram decision reaches app with both switches off')

  await card2.getByRole('switch', { name: 'Send messages to agents', exact: true }).click()
  await until(async () => (await snapshot()).settings.telegramIncomingMessages === true, 'enable fallback tasks')

  push({ text: 'A task with no channel specified' })
  await until(async () => (await snapshot()).messages.some((m) => m.conversationId === general && m.text === 'A task with no channel specified'), 'default channel fallback')
  await rpc('deleteConversation', { id: company })
  push({ text: 'Only one channel remains' })
  await until(async () => (await snapshot()).messages.some((m) => m.conversationId === general && m.text === 'Only one channel remains'), 'single channel direct delivery')
  assert.deepEqual(errors, [])
  console.log(`✓ default fallback and sole channel delivery; no renderer errors\nArtifacts: ${dir}`)
} finally {
  await app?.close()
  api.closeAllConnections()
  await new Promise((r) => api.close(r))
}
