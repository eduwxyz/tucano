// Opt-in Linux CI smoke: real private desktop + built server + authenticated Apps RPC.
// Requires preinstalled launcher prerequisites; does not install or change system settings.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const launcher = fileURLToPath(new URL('./server-desktop.sh', import.meta.url))
const entry = fileURLToPath(new URL('../out/main/server.js', import.meta.url))
assert.equal(process.platform, 'linux', 'This smoke test requires Linux')
assert.notEqual(process.getuid?.(), 0, 'Run as a non-root CI/service user')
assert.equal(spawnSync(launcher, ['--check'], { stdio: 'inherit' }).status, 0, 'Desktop prerequisites missing')
const home = mkdtempSync(join(tmpdir(), 'tucano-desktop-live-'))
const socket = createServer()
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const token = randomBytes(24).toString('hex')
const child = spawn(launcher, [process.execPath, entry], { env: { ...process.env, HOME: home, TUCANO_DATA: join(home, 'data'), TUCANO_HOST: '127.0.0.1', TUCANO_PORT: String(port), TUCANO_TOKEN: token, TUCANO_SEED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', (chunk) => { log += chunk })
child.stderr.on('data', (chunk) => { log += chunk })
const base = `http://127.0.0.1:${port}`
const headers = { authorization: `Bearer ${token}` }
const controller = new AbortController()
let reader
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  const deadline = Date.now() + 60000
  while (true) {
    if (child.exitCode !== null) throw new Error(`Desktop server exited early: ${log}`)
    if (Date.now() > deadline) throw new Error(`Desktop server startup timed out: ${log}`)
    try { if ((await fetch(base, { headers, signal: AbortSignal.timeout(1000) })).ok) break } catch {}
    await sleep(200)
  }
  const stream = await fetch(`${base}/events`, { headers, signal: controller.signal })
  assert.equal(stream.status, 200)
  reader = stream.body.getReader()
  let buffer = '', client = '', id = 0
  const replies = new Map()
  const reading = (async () => {
    const decoder = new TextDecoder()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let end
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const data = /^data: (.*)$/m.exec(frame)?.[1]
        if (!data) continue
        if (frame.startsWith('event: hello')) client = data
        else { try { const msg = JSON.parse(data); if (msg.id) replies.set(msg.id, msg) } catch {} }
      }
    }
  })().catch(() => {})
  async function until(fn, label) {
    const end = Date.now() + 45000
    while (!fn()) { if (Date.now() > end) throw new Error(`${label} timed out: ${log}`); await sleep(50) }
  }
  await until(() => client, 'SSE hello')
  async function rpc(method) {
    const n = ++id
    const res = await fetch(`${base}/rpc?c=${encodeURIComponent(client)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: n, method }), signal: AbortSignal.timeout(10000) })
    assert.equal(res.status, 204)
    await until(() => replies.has(n), method)
    const msg = replies.get(n); assert.equal(msg.error, undefined)
    return msg.result
  }
  const status = await rpc('desktopStatus')
  assert.equal(status.server, true)
  assert.equal(status.desktopEnabled, true)
  assert.equal(status.installed, true, JSON.stringify(status))
  assert.equal(status.desktopReady, true, JSON.stringify(status))
  assert.ok(Array.isArray(await rpc('installedApps')))
  assert.ok(Array.isArray(await rpc('openApps')))
  console.log('PASS: private Linux desktop, agent-desktop accessibility and authenticated Apps RPC')
  controller.abort(); await reading
} finally {
  controller.abort()
  await reader?.cancel().catch(() => {})
  child.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve)), sleep(10000).then(() => { if (child.exitCode === null) child.kill('SIGKILL') })])
  rmSync(home, { recursive: true, force: true })
}
