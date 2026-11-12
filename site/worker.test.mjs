// The waitlist route against a fake Turnstile and a fake Supabase: nothing leaves the machine.
//   node --test site/
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import worker, { lista } from './worker.js'

const env = { SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'sb_secret_test', TURNSTILE_SECRET: 'ts', ASSETS: { fetch: async () => new Response('page') } }
let calls, turnstileOk, supabaseStatus
beforeEach(() => {
  calls = []
  turnstileOk = true
  supabaseStatus = 201
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('turnstile')) return Response.json({ success: turnstileOk })
    return new Response(supabaseStatus < 300 ? '' : 'boom', { status: supabaseStatus })
  }
})

const post = (body, headers = {}) =>
  lista(new Request('https://tucano.sh/api/lista', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://tucano.sh', ...headers }, body: JSON.stringify(body) }), env)
const good = { name: ' Ana ', email: ' Ana@Example.COM ', use_case: 'clientes', has_iphone: 'yes', consent: true, lang: 'pt', source: 'x', turnstile: 'tok' }

test('a sign-up is checked by Turnstile and saved once per email, with the secret key', async () => {
  const r = await post(good)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true })
  const [ts, db] = calls
  assert.match(ts.url, /turnstile/)
  assert.match(String(ts.init.body), /response=tok/)
  assert.equal(db.url, 'https://db.example/rest/v1/waitlist?on_conflict=email')
  assert.equal(db.init.headers.apikey, 'sb_secret_test')
  assert.equal(db.init.headers.authorization, undefined)
  assert.match(db.init.headers.prefer, /resolution=ignore-duplicates/)
  const row = JSON.parse(db.init.body)
  assert.equal(row.email, 'ana@example.com')
  assert.equal(row.name, 'Ana')
  assert.equal(row.has_iphone, true)
  assert.ok(row.consent_at)
})

test('no consent, no name or a bad email: refused in the page’s language, nothing saved', async () => {
  for (const [body, re] of [
    [{ ...good, consent: false }, /aceite os termos/],
    [{ ...good, email: 'nope' }, /e-mail/],
    [{ ...good, email: 'nope', lang: 'en' }, /Check your email/],
  ]) {
    const r = await post(body)
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, re)
  }
  assert.equal(calls.length, 0)
})

test('a robot: Turnstile says no, or it filled the hidden field', async () => {
  turnstileOk = false
  assert.equal((await post(good)).status, 400)
  assert.equal(calls.filter((c) => c.url.includes('db.example')).length, 0)
  turnstileOk = true
  calls = []
  const r = await post({ ...good, website: 'http://spam' })
  assert.equal(r.status, 200) // the same answer a person gets
  assert.equal(calls.length, 0)
})

test('another site’s page, a GET, a huge body: refused', async () => {
  assert.equal((await post(good, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await lista(new Request('https://tucano.sh/api/lista'), env)).status, 405)
  assert.equal((await post({ ...good, use_case: 'x'.repeat(9000) })).status, 413)
})

test('Supabase down: a message to try again, never a crash', async () => {
  supabaseStatus = 503
  const r = await post(good)
  assert.equal(r.status, 502)
  assert.match((await r.json()).error, /Tente de novo/)
})

test('only the email is needed', async () => {
  const r = await post({ email: 'bia@example.com', consent: true, turnstile: 'tok' })
  assert.equal(r.status, 200)
  const row = JSON.parse(calls.at(-1).init.body)
  assert.deepEqual([row.email, row.name, row.use_case, row.has_iphone, row.lang], ['bia@example.com', null, null, null, 'pt'])
})

test('everything but /api/lista is the static site', async () => {
  const r = await worker.fetch(new Request('https://tucano.sh/pro/'), env)
  assert.equal(await r.text(), 'page')
})
