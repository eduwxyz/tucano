// The push relay: how a Tucano (on a server or on a computer) reaches the Tucano app on an iPhone that
// is closed. Apple delivers only for whoever holds the app's push key (APNs), and that key stays here:
// no Tucano gets it. So:
//   1. The app gives its device token to /api/push/register and gets back a handle: the token sealed
//      with a key only this worker has (AES-GCM). It hands the handle to its Tucano.
//   2. The Tucano posts the handle and the notification to /api/push/send; this opens the handle and
//      asks Apple to deliver. A Tucano can reach only the phones that gave it a handle.
// Nothing is stored here. The worker's secrets (`npx wrangler secret put <name>`):
//   APNS_KEY      the .p8 key from developer.apple.com (Keys › Apple Push Notifications service), whole
//   APNS_KEY_ID   its Key ID
//   APNS_TEAM_ID  the team's ID
//   PUSH_SEAL     32 random bytes in base64 (`openssl rand -base64 32`): seals the handles; a new
//                 one invalidates every handle (each app registers again on its next start)

const TOPIC = 'sh.tucano.ios' // the app's bundle id
const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' }
const MAX_TARGETS = 20

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))

async function sealKey(env) {
  if (!env.PUSH_SEAL) throw new Error('no PUSH_SEAL')
  return crypto.subtle.importKey('raw', Uint8Array.from(atob(env.PUSH_SEAL), (c) => c.charCodeAt(0)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function seal(target, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(env), new TextEncoder().encode(JSON.stringify(target)))
  return b64url(new Uint8Array([...iv, ...new Uint8Array(box)]))
}

export async function open(handle, env) {
  try {
    const all = unb64url(handle)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await sealKey(env), all.slice(12))
    const t = JSON.parse(new TextDecoder().decode(plain))
    return typeof t?.t === 'string' && (t.e === 'production' || t.e === 'sandbox') ? t : undefined
  } catch {
    return undefined
  }
}

// The token Apple asks for (ES256 JWT), made again every 40 minutes (Apple takes one up to an hour old).
let jwt = { value: '', at: 0 }
async function bearer(env, now = Date.now()) {
  if (jwt.value && now - jwt.at < 40 * 60_000) return jwt.value
  const pem = String(env.APNS_KEY ?? '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const part = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const body = `${part({ alg: 'ES256', kid: env.APNS_KEY_ID })}.${part({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(body))
  jwt = { value: `${body}.${b64url(sig)}`, at: now }
  return jwt.value
}

// What Apple shows: the title and the text, grouped by conversation; the rest is for the app (a tap
// opens that conversation, on that Tucano).
export function payload(n, tag) {
  return {
    aps: { alert: { title: clip(n.title, 120), body: clip(n.body, 1000) }, sound: 'default', ...(n.conversationId ? { 'thread-id': clip(n.conversationId, 100) } : {}) },
    ...(n.conversationId ? { conversationId: clip(n.conversationId, 100) } : {}),
    ...(n.threadId ? { threadId: clip(n.threadId, 100) } : {}),
    ...(n.kind ? { kind: clip(n.kind, 20) } : {}),
    ...(tag ? { tag: clip(tag, 100) } : {})
  }
}

export async function register(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'POST' })
  const b = await request.json().catch(() => null)
  const token = typeof b?.token === 'string' ? b.token.toLowerCase() : ''
  const e = b?.env === 'sandbox' ? 'sandbox' : 'production'
  if (!/^[0-9a-f]{64,200}$/.test(token)) return json(400, { error: 'token' })
  return json(200, { handle: await seal({ t: token, e }, env) })
}

export async function send(request, env, fetcher = fetch) {
  if (request.method !== 'POST') return json(405, { error: 'POST' })
  const text = await request.text()
  if (text.length > 16 * 1024) return json(413, { error: 'too large' })
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return json(400, { error: 'json' })
  }
  const targets = Array.isArray(b?.targets) ? b.targets.slice(0, MAX_TARGETS) : []
  if (!targets.length || typeof b?.title !== 'string') return json(400, { error: 'targets, title' })
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return json(503, { error: 'push is not set up' })
  const auth = await bearer(env)
  let sent = 0
  const gone = []
  await Promise.all(
    targets.map(async (x) => {
      const handle = typeof x?.handle === 'string' ? x.handle : ''
      const t = handle && (await open(handle, env))
      if (!t) return void gone.push(handle)
      // At most so many a minute per phone (a Tucano gone wrong doesn't flood it).
      if (env.PUSH_LIMIT && !(await env.PUSH_LIMIT.limit({ key: handle.slice(0, 64) })).success) return
      const r = await fetcher(`${HOSTS[t.e]}/3/device/${t.t}`, {
        method: 'POST',
        headers: { authorization: `bearer ${auth}`, 'apns-topic': TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json' },
        body: JSON.stringify(payload(b, typeof x?.tag === 'string' ? x.tag : undefined))
      }).catch(() => undefined)
      if (r?.ok) sent++
      else if (r && (r.status === 410 || (r.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(await r.text().catch(() => ''))))) gone.push(handle)
      else if (r) console.error('apns', r.status, (await r.text().catch(() => '')).slice(0, 200))
    })
  )
  return json(200, { sent, gone })
}

// For the tests: the cached Apple token goes.
export const forgetBearer = () => void (jwt = { value: '', at: 0 })
