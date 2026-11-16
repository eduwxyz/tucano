// Tucano in a browser, as an app (src/server adds this page after tucano-web.js): the service worker
// (sw.js), and this browser's push subscription (src/server/webpush.ts) as window.tucano.webPush, for
// Settings › General › Notifications. Not in the desktop app, which shows its own notifications.
;(() => {
  if (!window.tucano || window.tucanoDesktop || !('serviceWorker' in navigator)) return
  const sw = navigator.serviceWorker
  // A new version of sw.js takes over at once, and the page reloads once (a draft kept first, as
  // tucano-web.js does). The first install reloads nothing: there was no worker before.
  const hadOne = !!sw.controller
  let reloading = false
  sw.addEventListener('controllerchange', () => {
    if (!hadOne || reloading) return
    reloading = true
    window.dispatchEvent(new Event('tucano:reloading'))
    location.reload()
  })
  // A notification clicked while this page is open: its conversation, by the address.
  sw.addEventListener('message', (e) => {
    if (e.data && typeof e.data.open === 'string' && e.data.open.startsWith('#/')) location.hash = e.data.open
  })
  const ready = window.isSecureContext
    ? sw.register('./sw.js', { scope: './' }).then((reg) => {
        const take = (w) => w && sw.controller && w.postMessage('skip-waiting')
        take(reg.waiting)
        reg.addEventListener('updatefound', () => {
          const w = reg.installing
          if (w) w.addEventListener('statechange', () => w.state === 'installed' && take(w))
        })
        setInterval(() => reg.update().catch(() => {}), 3600_000)
        return reg
      })
    : Promise.reject(new Error('insecure'))
  ready.catch(() => {})

  // A request to the server; when it fails, why, for Settings to say: an Error with a `code`
  // ('network', 'signin', 'denied', 'nosub', 'push', 'http'), the HTTP status and the server's reason.
  const failed = (code, status, detail) => Object.assign(new Error(code), { code, status, detail })
  const post = async (path, data) => {
    let r
    try {
      // A sign-in proxy in front of the server answers an expired session with a redirect: never followed.
      r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), redirect: 'manual' })
    } catch (e) {
      throw failed('network', 0, String((e && e.message) || e))
    }
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw failed('signin', r.status)
    if (r.ok) return r
    const why = await r.json().then((j) => (j && j.error) || '', () => '')
    const code = r.status === 401 || r.status === 403 ? 'denied' : r.status === 404 && why === 'no subscription' ? 'nosub' : r.status === 502 ? 'push' : 'http'
    throw failed(code, r.status, why)
  }
  const key = () => fetch('./webpush/key').then((r) => (r.ok ? r.json().then((j) => j.key) : null))
  const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const current = () => ready.then((reg) => reg.pushManager.getSubscription())
  // A subscription made with another server key (the data folder was reset) gets nothing: made again.
  const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const sameKey = (sub, k) => !sub.options || !sub.options.applicationServerKey || toB64u(sub.options.applicationServerKey) === k

  // 'on' (this browser gets them), 'ask' (it could), 'blocked' (by the person), 'insecure' (no
  // HTTPS), 'unsupported' (no push here), 'off' (TUCANO_WEBPUSH=off on the server).
  const state = async () => {
    if (!window.isSecureContext) return 'insecure'
    if (!('PushManager' in window) || !('Notification' in window)) return 'unsupported'
    if (Notification.permission === 'denied') return 'blocked'
    const k = await key().catch(() => null)
    if (!k) return 'off'
    const sub = await current().catch(() => null)
    return sub && Notification.permission === 'granted' && sameKey(sub, k) ? 'on' : 'ask'
  }
  // Asks for permission (on the click that called it), subscribes, and tells the server whose it is.
  const enable = async () => {
    const k = await key()
    if (!k) return state()
    if ((await Notification.requestPermission()) !== 'granted') return state()
    const reg = await ready
    let sub = await reg.pushManager.getSubscription()
    if (sub && !sameKey(sub, k)) sub = await sub.unsubscribe().then(() => null, () => null)
    sub = sub || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(k) }))
    await post('./webpush/subscribe', sub.toJSON())
    return state()
  }
  const disable = async () => {
    const sub = await current().catch(() => null)
    if (sub) {
      await post('./webpush/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
      await sub.unsubscribe().catch(() => {})
    }
    return state()
  }
  // This browser's subscription as it is now goes along: the server keeps it again before the test.
  const test = async () => {
    const sub = await current()
    if (!sub) throw failed('nosub', 0, 'no subscription in this browser')
    await post('./webpush/test', { ...sub.toJSON(), lang: document.documentElement.lang })
    return true
  }
  // Each time the page opens, the subscription is said again: a server that lost it (a restore), or a
  // browser that signed in as someone else, is up to date.
  current()
    .then((sub) => sub && Notification.permission === 'granted' && key().then((k) => k && sameKey(sub, k) && post('./webpush/subscribe', sub.toJSON()).catch((e) => console.warn('[webpush] subscribe', e.code, e.status, e.detail))))
    .catch(() => {})
  window.tucano.webPush = { state, enable, disable, test }
})()
