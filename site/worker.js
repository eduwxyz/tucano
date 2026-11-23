// tucano.sh: the static pages (dist/, served as assets), the push relay for the iPhone app (push.js,
// /api/push/*), the app's feedback and surveys (feedback.js, /api/feedback and /api/surveys*) and
// /api/empresa (the company form, below), /api/stripe (payments, to the owner: stripe.js) and /api/lista, where
// the Tucano Pro beta's waitlist form (pro.html) lands. It checks the anti-robot token (Cloudflare
// Turnstile), then saves the sign-up in Supabase (supabase/migrations/0001_waitlist.sql) with the
// project's secret key, which only this worker holds:
//   npx wrangler secret put SUPABASE_SECRET_KEY
//   npx wrangler secret put TURNSTILE_SECRET
// The same email twice is saved once, and both answers are the same "you're on the list": the
// form never tells anyone whether an address was already there.

import { answer as surveyAnswer, feedback, surveys, sweep } from './feedback.js'
import { register as pushRegister, send as pushSend } from './push.js'
import { tell } from './notify.js'
import { stripe } from './stripe.js'

const MAX_BODY = 8 * 1024
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const words = (lang, pt, en) => (lang === 'en' ? en : pt)
const clip = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')

// The anti-robot check, with Cloudflare: the token the widget gave this visitor.
async function human(token, ip, env) {
  if (!env.TURNSTILE_SECRET) return false
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token ?? ''), ...(ip ? { remoteip: ip } : {}) }),
  })
  const out = await r.json().catch(() => ({}))
  return out.success === true
}

// One row in public.waitlist; a second sign-up with the same email changes nothing.
async function save(row, env) {
  const key = env.SUPABASE_SECRET_KEY
  if (!key || !env.SUPABASE_URL) throw new Error('no SUPABASE_SECRET_KEY or SUPABASE_URL')
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/waitlist?on_conflict=email`, {
    method: 'POST',
    headers: {
      apikey: key,
      // A legacy service_role key (a JWT) goes as a Bearer too; a new secret key (sb_secret_…) doesn't need it.
      ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
      prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  })
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
}

export async function lista(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'POST' })
  // Only from the site's own pages.
  const origin = request.headers.get('origin')
  if (origin && new URL(origin).host !== new URL(request.url).host) return json(403, { error: 'origin' })
  const text = await request.text()
  if (text.length > MAX_BODY) return json(413, { error: 'too large' })
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return json(400, { error: 'json' })
  }
  const lang = b?.lang === 'en' ? 'en' : 'pt'
  // A robot fills the hidden field: it gets the same answer as a person, and nothing is saved.
  if (clip(b?.website, 200)) return json(200, { ok: true })
  const name = clip(b?.name, 120) // optional: the form asks only for the email
  const email = clip(b?.email, 254).toLowerCase()
  if (!EMAIL.test(email)) return json(400, { error: words(lang, 'Confira o seu e-mail.', 'Check your email.') })
  if (b?.consent !== true) return json(400, { error: words(lang, 'Pra entrar na lista, aceite os termos do beta e a política de privacidade.', 'To join, accept the beta terms and the privacy policy.') })
  if (!(await human(b?.turnstile, request.headers.get('cf-connecting-ip'), env)))
    return json(400, { error: words(lang, 'Não conseguimos confirmar que você não é um robô. Recarregue a página e tente de novo.', "We couldn't confirm you're not a robot. Reload the page and try again.") })
  try {
    await save(
      {
        email,
        name: name || null,
        use_case: clip(b?.use_case, 1000) || null,
        has_iphone: b?.has_iphone === 'yes' ? true : b?.has_iphone === 'no' ? false : null,
        lang,
        source: clip(b?.source, 200) || null,
        consent_at: new Date().toISOString(),
      },
      env
    )
  } catch (e) {
    console.error('waitlist:', e instanceof Error ? e.message : e)
    return json(502, { error: words(lang, 'Não deu pra salvar agora. Tente de novo em um minuto.', "Couldn't save it right now. Try again in a minute.") })
  }
  return json(200, { ok: true })
}

// ---------- /api/empresa: the company form ("Fale com a gente") ----------
// Checked like the waitlist (same origin, hidden field, Turnstile), saved in public.company_leads
// (supabase/migrations/0004_company_leads.sql), and, when the two optional secrets are set, mailed
// to whoever answers them:
//   npx wrangler secret put RESEND_API_KEY
//   npx wrangler secret put LEADS_TO
// (and PHONE_HOOK, for a push on the phone too: notify.js)
const SIZES = ['2-15', '16-25', '26-50', '51+']

async function saveLead(row, env) {
  const key = env.SUPABASE_SECRET_KEY
  if (!key || !env.SUPABASE_URL) throw new Error('no SUPABASE_SECRET_KEY or SUPABASE_URL')
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/company_leads`, {
    method: 'POST',
    headers: { apikey: key, ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(row),
  })
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
}

// A short note to the team (notify.js: email, and a push on the owner's phone); the lead is already
// saved, so a failed note only gets logged.
async function tellTeam(row, env) {
  const text = [`${row.name} <${row.email}>`, `Empresa: ${row.company}`, `Pessoas: ${row.size}`, `Pra quê: ${row.use_case || '—'}`, `Página: ${row.source || '—'} (${row.lang})`].join('\n')
  await tell(env, { uid: `lead-${row.email}-${Date.now()}`, subject: `Empresa: ${row.company} (${row.size} pessoas)`, text, replyTo: row.email })
}

export async function empresa(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'POST' })
  const origin = request.headers.get('origin')
  if (origin && new URL(origin).host !== new URL(request.url).host) return json(403, { error: 'origin' })
  if (env.COMPANY_LIMIT && !(await env.COMPANY_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || 'none' })).success) return json(429, { error: 'too many' })
  const text = await request.text()
  if (text.length > MAX_BODY) return json(413, { error: 'too large' })
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return json(400, { error: 'json' })
  }
  const lang = b?.lang === 'en' ? 'en' : 'pt'
  if (clip(b?.website, 200)) return json(200, { ok: true })
  const name = clip(b?.name, 120)
  const email = clip(b?.email, 254).toLowerCase()
  const company = clip(b?.company, 120)
  const size = SIZES.includes(b?.size) ? b.size : null
  if (!name) return json(400, { error: words(lang, 'Diga o seu nome.', 'Tell us your name.') })
  if (!EMAIL.test(email)) return json(400, { error: words(lang, 'Confira o seu e-mail.', 'Check your email.') })
  if (!company) return json(400, { error: words(lang, 'Diga o nome da empresa.', 'Tell us the company’s name.') })
  if (!size) return json(400, { error: words(lang, 'Diga quantas pessoas vão usar.', 'Tell us how many people will use it.') })
  if (!(await human(b?.turnstile, request.headers.get('cf-connecting-ip'), env)))
    return json(400, { error: words(lang, 'Não conseguimos confirmar que você não é um robô. Recarregue a página e tente de novo.', "We couldn't confirm you're not a robot. Reload the page and try again.") })
  const row = { name, email, company, size, use_case: clip(b?.use_case, 1000) || null, lang, source: clip(b?.source, 200) || null }
  try {
    await saveLead(row, env)
  } catch (e) {
    console.error('company lead:', e instanceof Error ? e.message : e)
    return json(502, { error: words(lang, 'Não deu pra enviar agora. Tente de novo, ou escreva pra contato@tucano.sh.', 'Couldn’t send it just now. Try again, or write to contato@tucano.sh.') })
  }
  await tellTeam(row, env)
  return json(200, { ok: true })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/lista') return lista(request, env)
    if (url.pathname === '/api/empresa') return empresa(request, env)
    // Stripe's webhook: new payments, failed ones and cancellations, to the owner (stripe.js).
    if (url.pathname === '/api/stripe') return stripe(request, env)
    // The push relay for the iPhone app (push.js).
    if (url.pathname === '/api/push/register') return pushRegister(request, env)
    if (url.pathname === '/api/push/send') return pushSend(request, env)
    // What the app sends from "Enviar feedback", and its surveys (feedback.js).
    if (url.pathname === '/api/feedback') return feedback(request, env)
    if (url.pathname === '/api/surveys') return surveys(request, env)
    if (url.pathname === '/api/surveys/answer') return surveyAnswer(request, env)
    return env.ASSETS.fetch(request)
  },
  // The daily cron (wrangler.jsonc): feedback pictures older than 90 days are deleted.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep(env).then((n) => console.log('feedback sweep:', n), (e) => console.error('feedback sweep:', e instanceof Error ? e.message : e)))
  },
}
