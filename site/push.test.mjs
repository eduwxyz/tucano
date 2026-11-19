// The push relay against a fake Apple: nothing leaves the machine.
//   node --test site/
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { forgetBearer, open, payload, register, seal, send } from './push.js'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const env = { PUSH_SEAL: randomBytes(32).toString('base64'), APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM123' }
const TOKEN = 'ab'.repeat(32)
const post = (path, body) => new Request(`https://tucano.sh/api/push/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('a device token comes back sealed, and only this key opens it', async () => {
  const r = await register(post('register', { token: TOKEN.toUpperCase(), env: 'sandbox' }), env)
  const { handle } = await r.json()
  assert.ok(!handle.includes(TOKEN))
  assert.deepEqual(await open(handle, env), { t: TOKEN, e: 'sandbox' })
  assert.equal(await open(handle, { PUSH_SEAL: randomBytes(32).toString('base64') }), undefined)
  assert.equal((await register(post('register', { token: 'not hex' }), env)).status, 400)
})

test('a send goes to Apple with a signed token, the right host and the conversation', async () => {
  forgetBearer()
  const calls = []
  const fake = async (url, init) => (calls.push({ url, init }), new Response('', { status: 200 }))
  const handle = await seal({ t: TOKEN, e: 'production' }, env)
  const r = await send(post('send', { targets: [{ handle, tag: 'server-1' }], title: 'Ana', body: 'Posso enviar?', conversationId: 'c1', kind: 'approval' }), env, fake)
  assert.deepEqual(await r.json(), { sent: 1, gone: [] })
  assert.equal(calls[0].url, `https://api.push.apple.com/3/device/${TOKEN}`)
  assert.equal(calls[0].init.headers['apns-topic'], 'sh.tucano.ios')
  const [head, claims, sig] = calls[0].init.headers.authorization.replace('bearer ', '').split('.')
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'ES256', kid: 'KEY123' })
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TEAM123')
  assert.equal(Buffer.from(sig, 'base64url').length, 64)
  assert.deepEqual(JSON.parse(calls[0].init.body), { aps: { alert: { title: 'Ana', body: 'Posso enviar?' }, sound: 'default', 'thread-id': 'c1' }, conversationId: 'c1', kind: 'approval', tag: 'server-1' })
})

test('a phone Apple no longer knows, or a handle that does not open, comes back as gone', async () => {
  const fake = async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 })
  const handle = await seal({ t: TOKEN, e: 'sandbox' }, env)
  const r = await send(post('send', { targets: [{ handle }, { handle: 'garbage' }], title: 'x', body: 'y' }), env, fake)
  const out = await r.json()
  assert.deepEqual({ ...out, gone: out.gone.sort() }, { sent: 0, gone: [handle, 'garbage'].sort() })
})

test('without the key set, nothing is sent; texts are clipped for Apple', async () => {
  const handle = await seal({ t: TOKEN, e: 'sandbox' }, env)
  assert.equal((await send(post('send', { targets: [{ handle }], title: 'x' }), { PUSH_SEAL: env.PUSH_SEAL })).status, 503)
  assert.equal(payload({ title: 'x'.repeat(500), body: 'y'.repeat(5000) }).aps.alert.body.length, 1000)
})
