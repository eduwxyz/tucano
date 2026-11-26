// What the Tucano app sends from "Enviar feedback", and the small surveys it shows in the sidebar's
// foot (supabase/migrations/0003_feedback_and_surveys.sql). The app's core calls these, never a
// page: there is no form on the site and no CORS. Only this worker holds Supabase's secret key.
//   POST /api/feedback          { kind, message, image?, version, os, lang }
//   GET  /api/surveys           ?version=&first=&os=&lang=   the survey for this install, or null
//   POST /api/surveys/answer    { survey, install, choice, comment?, version, first, os, lang }
// The window's picture goes to the private "feedback" bucket and is deleted after 90 days (sweep,
// from the worker's daily cron). Nothing here keeps an IP address.

const FEEDBACK_BODY = 4_600_000 // a 3 MB picture in base64, plus the text
const ANSWER_BODY = 8 * 1024
const IMAGE_MAX = 3 * 1024 * 1024
const KEEP_IMAGES_DAYS = 90

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const clip = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '')
const one = (v, allowed) => (allowed.includes(v) ? v : null)
const VERSION = /^\d+\.\d+\.\d+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SURVEY_ID = /^[a-z0-9-]{1,60}$/
const version = (v) => (typeof v === 'string' && VERSION.test(v) ? v : null)
const lang = (v) => (v === 'en' ? 'en' : 'pt')

// -1, 0 or 1, comparing "1.2.3" with "1.10.0" by numbers.
export function compare(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

function headers(env, extra = {}) {
  const key = env.SUPABASE_SECRET_KEY
  if (!key || !env.SUPABASE_URL) throw new Error('no SUPABASE_SECRET_KEY or SUPABASE_URL')
  // A legacy service_role key (a JWT) goes as a Bearer too; a new secret key (sb_secret_…) doesn't need it.
  return { apikey: key, ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}), ...extra }
}

// Too many from one address in a minute: the binding says no (wrangler.jsonc). Without the binding (tests), no limit.
async function allowed(limiter, request) {
  if (!limiter) return true
  const ip = request.headers.get('cf-connecting-ip') || 'none'
  return (await limiter.limit({ key: ip })).success
}

async function body(request, max) {
  const length = Number(request.headers.get('content-length') || 0)
  if (length > max) return { status: 413 }
  const text = await request.text()
  if (text.length > max) return { status: 413 }
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { status: 400 }
  }
}

// A PNG or a JPEG, by its first bytes, not by what the sender says it is.
export function picture(base64) {
  if (typeof base64 !== 'string' || !base64) return null
  if (base64.length > Math.ceil((IMAGE_MAX * 4) / 3) + 4) return { error: 'image too large' }
  let bytes
  try {
    const raw = atob(base64)
    bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  } catch {
    return { error: 'image' }
  }
  if (bytes.length > IMAGE_MAX) return { error: 'image too large' }
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (!png && !jpg) return { error: 'image' }
  return { bytes, ext: png ? 'png' : 'jpg', type: png ? 'image/png' : 'image/jpeg' }
}

export async function feedback(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'POST' })
  if (!(await allowed(env.FEEDBACK_LIMIT, request))) return json(429, { error: 'too many' })
  const b = await body(request, FEEDBACK_BODY)
  if (b.status) return json(b.status, { error: b.status === 413 ? 'too large' : 'json' })
  const x = b.value
  const kind = one(x?.kind, ['bug', 'idea', 'other'])
  const message = clip(x?.message, 5000)
  if (!kind || !message) return json(400, { error: 'kind and message' })
  const pic = x?.image ? picture(x.image) : null
  if (pic?.error) return json(400, { error: pic.error })
  try {
    let image_path = null
    if (pic) {
      // The picture first: if it fails, the text still goes in, without it.
      const name = `${crypto.randomUUID()}.${pic.ext}`
      const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/feedback/${name}`, {
        method: 'POST',
        headers: headers(env, { 'content-type': pic.type, 'x-upsert': 'false' }),
        body: pic.bytes,
      })
      if (r.ok) image_path = name
      else console.error('feedback image:', r.status, (await r.text()).slice(0, 200))
    }
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/feedback`, {
      method: 'POST',
      headers: headers(env, { 'content-type': 'application/json', prefer: 'return=minimal' }),
      body: JSON.stringify({ kind, message, image_path, app_version: version(x?.version), os: one(x?.os, ['mac', 'windows', 'linux']), lang: lang(x?.lang) }),
    })
    if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
  } catch (e) {
    console.error('feedback:', e instanceof Error ? e.message : e)
    return json(502, { error: 'save' })
  }
  return json(200, { ok: true })
}

async function activeSurveys(env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/surveys?active=is.true&select=*&order=created_at.desc`, { headers: headers(env) })
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const now = Date.now()
  return (await r.json()).filter((s) => !s.ends_at || Date.parse(s.ends_at) > now)
}

// Does this survey go to this install? Every audience column that's set must match.
export function fits(s, who) {
  if (s.min_version && (!who.version || compare(who.version, s.min_version) < 0)) return false
  if (s.first_version_before && (!who.first || compare(who.first, s.first_version_before) >= 0)) return false
  if (s.platforms?.length && !s.platforms.includes(who.os)) return false
  if (s.langs?.length && !s.langs.includes(who.lang)) return false
  return true
}

const localized = (s, l) => ({
  id: s.id,
  question: l === 'en' ? s.question_en : s.question_pt,
  options: s.options.map((o) => ({ id: String(o.id), label: String((l === 'en' ? o.en : o.pt) ?? o.id) })),
  ...((l === 'en' ? s.follow_up_en : s.follow_up_pt) ? { followUp: l === 'en' ? s.follow_up_en : s.follow_up_pt } : {}),
})

export async function surveys(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'GET' })
  const q = new URL(request.url).searchParams
  const who = { version: version(q.get('version')), first: version(q.get('first')), os: q.get('os'), lang: lang(q.get('lang')) }
  try {
    const s = (await activeSurveys(env)).find((s) => fits(s, who))
    return json(200, { survey: s ? localized(s, who.lang) : null })
  } catch (e) {
    console.error('surveys:', e instanceof Error ? e.message : e)
    return json(200, { survey: null }) // the app shows nothing; no error to anyone
  }
}

export async function answer(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'POST' })
  if (!(await allowed(env.SURVEY_LIMIT, request))) return json(429, { error: 'too many' })
  const b = await body(request, ANSWER_BODY)
  if (b.status) return json(b.status, { error: b.status === 413 ? 'too large' : 'json' })
  const x = b.value
  const survey = typeof x?.survey === 'string' && SURVEY_ID.test(x.survey) ? x.survey : null
  const install = typeof x?.install === 'string' && UUID.test(x.install.toLowerCase()) ? x.install.toLowerCase() : null
  const choice = clip(x?.choice, 60)
  if (!survey || !install || !choice) return json(400, { error: 'survey, install and choice' })
  const comment = clip(x?.comment, 2000)
  try {
    // Only a survey that's running takes answers.
    if (!(await activeSurveys(env)).some((s) => s.id === survey)) return json(404, { error: 'survey' })
    const row = {
      survey_id: survey,
      install_id: install,
      choice,
      app_version: version(x?.version),
      first_version: version(x?.first),
      os: one(x?.os, ['mac', 'windows', 'linux']),
      lang: lang(x?.lang),
      ...(comment ? { comment } : {}), // no comment: an earlier one stays
    }
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/survey_answers?on_conflict=survey_id,install_id`, {
      method: 'POST',
      headers: headers(env, { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(row),
    })
    // The database refuses a choice that isn't one of the survey's options.
    if (r.status === 400) return json(400, { error: 'choice' })
    if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`)
  } catch (e) {
    console.error('survey answer:', e instanceof Error ? e.message : e)
    return json(502, { error: 'save' })
  }
  return json(200, { ok: true })
}

// Daily: pictures older than 90 days leave the bucket, and their rows forget the path.
export async function sweep(env, now = Date.now()) {
  const cutoff = new Date(now - KEEP_IMAGES_DAYS * 86_400_000).toISOString()
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/feedback`, {
    method: 'POST',
    headers: headers(env, { 'content-type': 'application/json' }),
    body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'created_at', order: 'asc' } }),
  })
  if (!r.ok) throw new Error(`storage list ${r.status}`)
  const old = (await r.json()).filter((o) => o.name && o.created_at && o.created_at < cutoff).map((o) => o.name)
  if (old.length) {
    const d = await fetch(`${env.SUPABASE_URL}/storage/v1/object/feedback`, {
      method: 'DELETE',
      headers: headers(env, { 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: old }),
    })
    if (!d.ok) throw new Error(`storage delete ${d.status}`)
  }
  const p = await fetch(`${env.SUPABASE_URL}/rest/v1/feedback?created_at=lt.${encodeURIComponent(cutoff)}&image_path=not.is.null`, {
    method: 'PATCH',
    headers: headers(env, { 'content-type': 'application/json', prefer: 'return=minimal' }),
    body: JSON.stringify({ image_path: null }),
  })
  if (!p.ok) throw new Error(`feedback rows ${p.status}`)
  return old.length
}
