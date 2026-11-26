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

test('the limit per phone counts the phone, however its handle is spelled or sealed', async () => {
  const counts = new Map()
  const limited = { ...env, PUSH_LIMIT: { limit: async ({ key }) => (counts.set(key, (counts.get(key) ?? 0) + 1), { success: counts.get(key) <= 60 }) } }
  let delivered = 0
  const fake = async () => (delivered++, new Response('', { status: 200 }))
  const handle = await seal({ t: TOKEN, e: 'production' }, env)
  // Spellings atob would read as the same bytes: spaces put in, + and / for - and _.
  const spaced = (i) => `${handle.slice(0, 1 + (i % 10))}    ${handle.slice(1 + (i % 10))}` // four keep the padding atob expects
  const std = handle.replace(/-/g, '+').replace(/_/g, '/')
  for (const h of [spaced(0), std === handle ? `${handle}+` : std]) {
    const r = await send(post('send', { targets: [{ handle: h }], title: 'x' }), limited, fake)
    assert.deepEqual(await r.json(), { sent: 0, gone: [h] }) // refused as not a handle
  }
  // And handles sealed anew for the same phone, each a different text.
  for (let i = 0; i < 100; i++) {
    const h = i % 2 ? handle : await seal({ t: TOKEN, e: 'production' }, env)
    await send(post('send', { targets: [{ handle: h }], title: 'x' }), limited, fake)
  }
  assert.equal(delivered, 60)
})

test('100 sends of one handle with spaces or + and / put in deliver at most 60', async () => {
  const counts = new Map()
  const limited = { ...env, PUSH_LIMIT: { limit: async ({ key }) => (counts.set(key, (counts.get(key) ?? 0) + 1), { success: counts.get(key) <= 60 }) } }
  let delivered = 0
  const fake = async () => (delivered++, new Response('', { status: 200 }))
  const handle = await seal({ t: TOKEN, e: 'sandbox' }, env)
  for (let i = 0; i < 100; i++) {
    const at = 1 + (i % 60) // inside the first 64 characters, which were the old key
    const h = i % 3 === 0 ? handle : i % 3 === 1 ? `${handle.slice(0, at)}    ${handle.slice(at)}` : `${handle.slice(0, at)}\n\n\n\n${handle.slice(at)}`.replace(/-/g, '+').replace(/_/g, '/')
    await send(post('send', { targets: [{ handle: h }], title: 'x' }), limited, fake)
  }
  assert.ok(delivered <= 60)
  assert.equal(await open(`${handle.slice(0, 5)}    ${handle.slice(5)}`, env), undefined)
  assert.equal(await open(`${handle}+`, env), undefined)
})
