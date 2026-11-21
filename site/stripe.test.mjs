// /api/stripe against a fake Resend and a fake phone hook: nothing leaves the machine.
//   node --test site/
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { beforeEach, test } from 'node:test'
import worker from './worker.js'
import { describe, signed } from './stripe.js'

const SECRET = 'whsec_test'
const env = { STRIPE_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 're_test', LEADS_TO: 'dono@example.com', PHONE_HOOK: 'https://irm.example/hook', ASSETS: { fetch: async () => new Response('page') } }
let calls
beforeEach(() => {
  calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response('{}', { status: 200 })
  }
})

const sign = (body, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
const hit = (event, header) => {
  const body = JSON.stringify(event)
  return worker.fetch(new Request('https://tucano.sh/api/stripe', { method: 'POST', headers: { 'stripe-signature': header ?? sign(body) }, body }), env)
}
const paid = {
  id: 'evt_1', type: 'checkout.session.completed', livemode: true,
  data: { object: { id: 'cs_1', amount_total: 9900, currency: 'brl', mode: 'subscription', payment_status: 'paid', customer: 'cus_1', customer_details: { name: 'Ana', email: 'ana@example.com' } } },
}

test('a new payment, signed by Stripe, reaches the owner by email and on the phone', async () => {
  const r = await hit(paid)
  assert.equal(r.status, 200)
  const mail = calls.find((c) => c.url.includes('resend'))
  const push = calls.find((c) => c.url === env.PHONE_HOOK)
  assert.equal(mail.body.subject, 'Pagamento novo: R$ 99,00 de Ana')
  assert.deepEqual(mail.body.to, ['dono@example.com'])
  assert.equal(mail.body.reply_to, 'ana@example.com')
  assert.match(mail.body.text, /dashboard\.stripe\.com\/customers\/cus_1/)
  assert.equal(push.body.alert_uid, 'stripe-evt_1')
  assert.equal(push.body.title, mail.body.subject)
})

test('an unsigned, wrongly signed or stale event is refused and tells no one', async () => {
  const body = JSON.stringify(paid)
  for (const header of ['', sign(body, undefined, 'whsec_other'), sign(body, Math.floor(Date.now() / 1000) - 600), 't=1,v1=zz']) {
    const r = await hit(paid, header)
    assert.equal(r.status, 400, header)
  }
  assert.equal(calls.length, 0)
})

test('a failed payment and a cancellation are told; other events only get a 200', async () => {
  await hit({ id: 'evt_2', type: 'invoice.payment_failed', livemode: true, data: { object: { amount_due: 23900, currency: 'brl', customer: 'cus_2', customer_email: 'b@x.com', attempt_count: 1 } } })
  await hit({ id: 'evt_3', type: 'customer.subscription.deleted', livemode: true, data: { object: { customer: 'cus_3', cancellation_details: { reason: 'cancellation_requested' } } } })
  const r = await hit({ id: 'evt_4', type: 'invoice.paid', livemode: true, data: { object: {} } })
  assert.equal(r.status, 200)
  const subjects = calls.filter((c) => c.url.includes('resend')).map((c) => c.body.subject)
  assert.deepEqual(subjects, ['Pagamento falhou: R$ 239,00 de b@x.com', 'Assinatura cancelada: cus_3'])
})

test('a test-mode event says so', () => {
  assert.match(describe({ ...paid, livemode: false }).subject, /^\[teste\] /)
  assert.match(describe({ ...paid, livemode: false }).text, /dashboard\.stripe\.com\/test\//)
})

test('the signature check takes any of several v1 signatures, and needs the secret', async () => {
  const body = '{"a":1}'
  const good = sign(body)
  assert.equal(await signed(body, `${good},v1=${'0'.repeat(64)}`, SECRET), true)
  assert.equal(await signed(body, good, ''), false)
})

test('without the phone hook or the email secrets, nothing is sent and the webhook still answers', async () => {
  const bare = { STRIPE_WEBHOOK_SECRET: SECRET, ASSETS: env.ASSETS }
  const body = JSON.stringify(paid)
  const r = await worker.fetch(new Request('https://tucano.sh/api/stripe', { method: 'POST', headers: { 'stripe-signature': sign(body) }, body }), bare)
  assert.equal(r.status, 200)
  assert.equal(calls.length, 0)
})
