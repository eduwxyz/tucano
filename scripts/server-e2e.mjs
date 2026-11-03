// Runs the built server (out/main/server.js) and talks to it the way a browser, the Mac app and a stranger do.
// The unit tests reach guard.ts and pairing.ts; index.ts starts a server the moment it is imported, so what
// wires them together (the cookies, POST /pair, the 401 that takes a cookie back, the 429, the 403) is only
// ever run here.
//
//   npm run build && npm run test:server
//
// Nothing outside: a data directory of its own in the temp folder, and ports the system gives.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../out/main/server.js', import.meta.url))
const stops = []

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const env = (dir, port) => ({ ...process.env, TUCANO_DATA: dir, TUCANO_PORT: String(port), TUCANO_HOST: '127.0.0.1', TUCANO_TOKEN: '' })

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-e2e-'))
  const port = await freePort()
  const child = spawn(process.execPath, [entry], { env: env(dir, port), stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  let err = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (err += c))
  const server = { dir, port, child, log: () => log, token: '', id: '' }
  stops.push(() => {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  })
  const until = Date.now() + 30_000
  // The last line it prints once it listens (the first ones can arrive in a piece of their own).
  while (!/Listening on this machine only/.test(log)) {
    if (child.exitCode !== null) throw new Error(`the server stopped on its own:\n${err}`)
    if (Date.now() > until) throw new Error(`the server didn't start in 30 s:\n${log}\n${err}`)
    await new Promise((r) => setTimeout(r, 50))
  }
  server.token = readFileSync(join(dir, 'server-token'), 'utf8').trim()
  server.id = readFileSync(join(dir, 'server-id'), 'utf8').trim()
  return server
}

// The server's own commands, run beside it as a person would on the machine.
function command(server, ...args) {
  const r = spawnSync(process.execPath, [entry, ...args], { env: env(server.dir, server.port), encoding: 'utf8' })
  return { status: r.status, out: r.stdout }
}

// node:http, not fetch: the path is sent exactly as given (a broken %, a double dot), and the headers are ours.
function http(server, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const bearer = (t) => ({ authorization: `Bearer ${t}` })
const cookiesOf = (res) => [res.headers['set-cookie'] ?? []].flat()
const cookieValue = (res, name) => cookiesOf(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1)
const codeIn = (text) => /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(text)?.[0]

// A stream the page keeps open: resolves with the connection's id once the server says hello.
function events(server, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path: '/events', headers }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`/events answered ${res.statusCode}`))
      let seen = ''
      const stream = { seen: () => seen, close: () => req.destroy(), id: '' }
      res.on('data', (c) => {
        seen += c
        const hello = /event: hello\ndata: (\S+)/.exec(seen)
        if (hello && !stream.id) resolve(Object.assign(stream, { id: hello[1] }))
      })
    })
    req.on('error', (e) => (req.destroyed ? undefined : reject(e)))
    req.end()
    stops.push(() => req.destroy())
  })
}

const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
}
const yes = (cond, what) => {
  if (!cond) throw new Error(what)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tests = []
const test = (name, fn) => tests.push([name, fn])
const a = await start()

test('the log shows a pairing code and not the server’s own token', async () => {
  yes(!a.log().includes(a.token), 'the server’s token is in the log')
  yes(!/\?token=/.test(a.log()), 'a ?token= link is in the log')
  yes(codeIn(a.log()), 'no first pairing code in the log')
})

test('a request with nothing is refused, and sets no cookie', async () => {
  const r = await http(a)
  eq(r.status, 401, 'status')
  eq(cookiesOf(r).length, 0, 'cookies')
  eq(r.headers['x-content-type-options'], 'nosniff', 'nosniff')
  eq(r.headers['referrer-policy'], 'no-referrer', 'referrer-policy')
})

test('the first code signs a browser in once, with a cookie named after this server', async () => {
  const code = codeIn(a.log())
  const r = await http(a, { path: `/?pair=${code}` })
  eq(r.status, 302, 'status')
  eq(r.headers.location, '/', 'location')
  const set = cookiesOf(r).find((c) => c.startsWith(`tucano-${a.id}=`))
  yes(set, `no tucano-${a.id} cookie in ${JSON.stringify(cookiesOf(r))}`)
  yes(/HttpOnly/.test(set) && /SameSite=Lax/.test(set), 'the cookie is not HttpOnly and Lax')
  yes(!set.includes(a.token), 'the server’s own token is in the cookie')
  const page = await http(a, { headers: { cookie: `tucano-${a.id}=${cookieValue(r, `tucano-${a.id}`)}` } })
  eq(page.status, 200, 'the page with that cookie')
  yes(page.text.includes('tucano-web.js'), 'the page is not the browser one')
  eq((await http(a, { path: `/?pair=${code}` })).status, 401, 'the same code again')
})

test('the server’s own token signs in too, and is traded for a token of the browser’s own', async () => {
  const r = await http(a, { path: `/?token=${a.token}` })
  eq(r.status, 302, 'status')
  const mine = cookieValue(r, `tucano-${a.id}`)
  yes(mine?.startsWith('tk_') && mine !== a.token, 'the cookie is not a device token')
  yes(cookiesOf(r).some((c) => /^tucano=;.*Max-Age=0/.test(c)), 'the old "tucano" cookie is not taken back')
  eq((await http(a, { headers: bearer(a.token) })).status, 200, 'Bearer with the server’s token')
})

test('POST /pair trades a code for a token, with no cookie, and a code works once', async () => {
  const { out } = command(a, 'pair', '--label', 'Test Mac')
  const code = codeIn(out)
  yes(code, `pair printed no code:\n${out}`)
  const r = await http(a, { method: 'POST', path: '/pair', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, label: 'ignored' }) })
  eq(r.status, 200, 'status')
  eq(cookiesOf(r).length, 0, 'cookies')
  const got = JSON.parse(r.text)
  eq(got.server, a.id, 'server id')
  yes(got.token.startsWith('tk_'), 'token')
  eq(got.device.label, 'Test Mac', 'the owner’s label wins')
  eq((await http(a, { headers: bearer(got.token) })).status, 200, 'the new token')
  eq((await http(a, { method: 'POST', path: '/pair', body: JSON.stringify({ code }) })).status, 401, 'the same code again')
  a.paired = got
})

test('POST /pair: not JSON or no code is a 400, another site’s Origin a 403, a big body a 413', async () => {
  const post = (body, headers = {}) => http(a, { method: 'POST', path: '/pair', headers, body })
  eq((await post('{not json')).status, 400, 'not JSON')
  eq((await post('{}')).status, 400, 'no code')
  eq((await post('[]')).status, 400, 'an array')
  eq((await post(JSON.stringify({ code: 'AAAA-AAAA-AAAA' }), { origin: 'https://evil.example' })).status, 403, 'Origin')
  eq((await post(JSON.stringify({ code: 'x'.repeat(5000) }))).status, 413, 'body over 4 KB')
})

test('the commands see the server’s state at once: a revoked device is refused and its cookie taken back', async () => {
  const { device, token } = a.paired
  eq((await http(a, { headers: bearer(token) })).status, 200, 'before')
  eq(command(a, 'revoke', device.id).status, 0, 'revoke')
  const r = await http(a, { headers: { ...bearer(token), cookie: `tucano-${a.id}=${token}`, 'x-forwarded-for': '198.51.100.1' } })
  eq(r.status, 401, 'after')
  yes(cookiesOf(r).some((c) => c.startsWith(`tucano-${a.id}=;`) && /Max-Age=0/.test(c)), 'the cookie is not taken back')
  // and with no cookie, nothing is sent back to take
  eq(cookiesOf(await http(a, { headers: { ...bearer(token), 'x-forwarded-for': '198.51.100.2' } })).length, 0, 'a cookie taken back that was never sent')
})

test('the page’s stream and its requests reach the core, and what is wrong is answered, not thrown', async () => {
  const s = await events(a, bearer(a.token))
  const rpc = (body, headers = {}, c = s.id) => http(a, { method: 'POST', path: `/rpc?c=${encodeURIComponent(c)}`, headers: { ...bearer(a.token), ...headers }, body })
  eq((await rpc('{not json')).status, 400, 'not JSON')
  eq((await rpc('{}', { origin: 'https://evil.example' })).status, 403, 'another site’s Origin')
  eq((await rpc('{}', { origin: 'null' })).status, 403, 'a sandboxed page’s Origin')
  eq((await rpc('{}', {}, 'no-such-connection')).status, 410, 'a connection that is not there')
  eq((await rpc(JSON.stringify({ id: 7, method: 'snapshot' }), { origin: `http://127.0.0.1:${a.port}` })).status, 204, 'a request from the page itself')
  for (let i = 0; i < 100 && !s.seen().includes('"id":7'); i++) await sleep(50)
  yes(s.seen().includes('"id":7'), 'the core never answered the snapshot')
  s.close()
})

test('bad paths are 400 or 404, and none reaches outside the page’s folder', async () => {
  const get = (path) => http(a, { path, headers: bearer(a.token) }).then((r) => r.status)
  eq(await get('/%E0%A4%A'), 400, 'a broken %')
  eq(await get('/assets'), 404, 'a folder')
  eq(await get('/../../../etc/passwd'), 404, 'dot dot')
  eq(await get('/%2e%2e/%2e%2e/etc/passwd'), 404, 'encoded dot dot')
  eq(await get('/artifact/00000000-0000-0000-0000-000000000000/..%2f..%2fserver-token'), 404, 'out of an artifact')
  eq(await get('/artifact/00000000-0000-0000-0000-000000000000/%E0%A4%A'), 400, 'a broken % in an artifact')
})

test('wrong tokens are counted by who sent them, then refused, and the right one is refused too until the wait is over', async () => {
  const from = (ip) => ({ 'x-forwarded-for': ip })
  for (let i = 0; i < 10; i++) eq((await http(a, { headers: { ...bearer('wrong'), ...from('203.0.113.9') } })).status, 401, `wrong token ${i + 1}`)
  const r = await http(a, { headers: { ...bearer('wrong'), ...from('203.0.113.9') } })
  eq(r.status, 429, 'the 11th')
  yes(Number(r.headers['retry-after']) > 0, 'no Retry-After')
  eq((await http(a, { headers: { ...bearer(a.token), ...from('203.0.113.9') } })).status, 429, 'the right token during the wait')
  eq((await http(a, { headers: { ...bearer(a.token), ...from('203.0.113.10') } })).status, 200, 'someone else')
  // what the proxy claims at the start of the header is whatever the client wrote: the last entry counts
  eq((await http(a, { headers: { ...bearer(a.token), ...from('203.0.113.9, 203.0.113.11') } })).status, 200, 'a forged first entry')
})

test('after all that, the server is still up', async () => {
  eq((await http(a, { headers: { ...bearer(a.token), 'x-forwarded-for': '192.0.2.1' } })).status, 200, 'status')
})

test('two servers on one host: each names its own cookie, and one’s doesn’t open the other', async () => {
  const b = await start()
  yes(a.id !== b.id, 'the same server id')
  const [ra, rb] = [await http(a, { path: `/?token=${a.token}`, headers: { 'x-forwarded-for': '192.0.2.50' } }), await http(b, { path: `/?token=${b.token}` })]
  const [ca, cb] = [cookieValue(ra, `tucano-${a.id}`), cookieValue(rb, `tucano-${b.id}`)]
  yes(ca && cb, 'a cookie is missing')
  // a browser keeps both: cookies belong to a host, not to a port
  const jar = `tucano-${a.id}=${ca}; tucano-${b.id}=${cb}`
  eq((await http(a, { headers: { cookie: jar, 'x-forwarded-for': '192.0.2.50' } })).status, 200, 'A with both cookies')
  eq((await http(b, { headers: { cookie: jar } })).status, 200, 'B with both cookies')
  // a token is only good where it was made
  eq((await http(b, { headers: { ...bearer(ca), 'x-forwarded-for': '192.0.2.51' } })).status, 401, 'A’s token on B')
  eq((await http(b, { headers: { cookie: `tucano-${a.id}=${ca}`, 'x-forwarded-for': '192.0.2.52' } })).status, 401, 'A’s cookie on B')
  // revoking on one leaves the other
  eq(command(a, 'revoke', '--all').status, 0, 'revoke --all on A')
  eq((await http(a, { headers: { cookie: jar, 'x-forwarded-for': '192.0.2.53' } })).status, 401, 'A after revoking')
  eq((await http(b, { headers: { cookie: jar } })).status, 200, 'B after A revoked')
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    failed++
    console.log(`not ok - ${name}\n    ${e instanceof Error ? e.message : e}`)
  }
}
for (const stop of stops) stop()
console.log(failed ? `\n${failed} of ${tests.length} failed.\n${a.log()}` : `\nAll ${tests.length} passed.`)
process.exit(failed ? 1 : 0)
