// /api/stripe: Stripe's webhook, so a new payment, a failed one or a cancellation reaches the owner
// right away (notify.js: email and phone) instead of waiting for someone to open the dashboard.
// Only events signed with the endpoint's secret count:
//   npx wrangler secret put STRIPE_WEBHOOK_SECRET   (whsec_…, given once when the endpoint is made)
// Nothing is saved here; Stripe keeps the events. Any event this doesn't know gets a 200 and nothing else.
import { tell } from './notify.js'

const TOLERANCE = 5 * 60 // seconds between Stripe signing and this checking
const enc = new TextEncoder()

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

// Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">[,v1=…]
export async function signed(body, header, secret, now = Date.now() / 1000) {
  if (!header || !secret) return false
  const parts = header.split(',').map((p) => p.split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now - t) > TOLERANCE) return false
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const want = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)))
  return sigs.some((s) => s.length === want.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0)
}

const money = (cents, currency) => {
  const c = String(currency || '').toUpperCase()
  const v = (Number(cents) || 0) / 100
  return c === 'BRL' ? `R$ ${v.toFixed(2).replace('.', ',')}` : `${c} ${v.toFixed(2)}`
}
const dashboard = (kind, id, live) => `https://dashboard.stripe.com/${live ? '' : 'test/'}${kind}/${id}`

// What each event says, in Portuguese, for the owner. null: not one we tell.
export function describe(event) {
  const o = event?.data?.object ?? {}
  const live = event?.livemode !== false
  const test = live ? '' : '[teste] '
  switch (event?.type) {
    case 'checkout.session.completed': {
      const who = o.customer_details ?? {}
      const name = who.name || who.email || 'alguém'
      return {
        subject: `${test}Pagamento novo: ${money(o.amount_total, o.currency)} de ${name}`,
        text: [
          `${who.name || '—'} <${who.email || '—'}>`,
          `Valor: ${money(o.amount_total, o.currency)}${o.mode === 'subscription' ? ' (assinatura)' : ''}`,
          `Status: ${o.payment_status || '—'}`,
          `Cliente: ${o.customer || '—'}`,
          `No Stripe: ${o.customer ? dashboard('customers', o.customer, live) : dashboard('payments', o.payment_intent || o.id, live)}`,
          '',
          'Falta: criar o Tucano dele (tucano-ctl create) e mandar as boas-vindas.',
        ].join('\n'),
        replyTo: who.email || undefined,
      }
    }
    case 'invoice.payment_failed':
      return {
        subject: `${test}Pagamento falhou: ${money(o.amount_due, o.currency)} de ${o.customer_name || o.customer_email || o.customer}`,
        text: [
          `${o.customer_name || '—'} <${o.customer_email || '—'}>`,
          `Valor: ${money(o.amount_due, o.currency)} · tentativa ${o.attempt_count ?? '?'}`,
          o.next_payment_attempt ? `Próxima tentativa do Stripe: ${new Date(o.next_payment_attempt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Sem nova tentativa marcada.',
          `No Stripe: ${o.customer ? dashboard('customers', o.customer, live) : '—'}`,
        ].join('\n'),
        replyTo: o.customer_email || undefined,
      }
    case 'customer.subscription.deleted':
      return {
        subject: `${test}Assinatura cancelada: ${o.customer}`,
        text: [
          `Cliente: ${o.customer}`,
          `Motivo: ${o.cancellation_details?.reason || '—'}${o.cancellation_details?.feedback ? ` (${o.cancellation_details.feedback})` : ''}`,
          o.cancellation_details?.comment ? `Comentário: ${o.cancellation_details.comment}` : '',
          `No Stripe: ${dashboard('customers', o.customer, live)}`,
          '',
          'Falta: decidir o que fazer com o Tucano dele (tucano-ctl remove guarda os dados).',
        ].filter(Boolean).join('\n'),
      }
    default:
      return null
  }
}

export async function stripe(request, env) {
  if (request.method !== 'POST') return new Response('POST', { status: 405 })
  const body = await request.text()
  if (body.length > 256 * 1024) return new Response('too large', { status: 413 })
  if (!(await signed(body, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) return new Response('signature', { status: 400 })
  let event
  try {
    event = JSON.parse(body)
  } catch {
    return new Response('json', { status: 400 })
  }
  const note = describe(event)
  if (note) await tell(env, { ...note, uid: `stripe-${event.id}` })
  return new Response('ok')
}
