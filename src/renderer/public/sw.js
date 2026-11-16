// Tucano's service worker, for the app in a browser (src/server): the app's static files with a hash
// in their name are kept here, so it opens fast; nothing else is (/rpc, /events, files, pages: always
// the network, with the person's sign-in). A push from the server (src/server/webpush.ts) becomes a
// notification, and a click on it opens its conversation.
const CACHE = 'tucano-shell-1'
const MAX_FILES = 80
// What Vite builds: assets/<name>-<hash>.<ext>, the same bytes for as long as that name exists.
const SHELL = /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|css|woff2?|png|svg|jpe?g|webp|gif|mp3|wav)$/

self.addEventListener('install', () => {})

// A new version waits until the page says so (it reloads once it's in charge: tucano-pwa.js).
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || !SHELL.test(url.pathname)) return
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok && res.type === 'basic') {
        await cache.put(req, res.clone())
        const keys = await cache.keys()
        for (const old of keys.slice(0, Math.max(0, keys.length - MAX_FILES))) await cache.delete(old)
      }
      return res
    })
  )
})

// Where a notification opens: its conversation, by the address the app reads (src/renderer/src/address.ts).
const hashOf = (n) => (n.conversationId ? '#/c/' + encodeURIComponent(n.conversationId) : n.page === 'skills' ? '#/skills' : '')

self.addEventListener('push', (e) => {
  let n = {}
  try {
    n = e.data ? e.data.json() : {}
  } catch {}
  e.waitUntil(
    (async () => {
      // A page in front shows its own (or the person is reading it there); a test always shows.
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (!n.test && pages.some((p) => p.focused)) return
      await self.registration.showNotification(n.title || 'Tucano', {
        body: n.body || '',
        tag: n.conversationId || 'tucano',
        icon: '/icon-192.png',
        data: { hash: hashOf(n) }
      })
    })()
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const hash = (e.notification.data && e.notification.data.hash) || ''
  e.waitUntil(
    (async () => {
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const page = pages.find((p) => new URL(p.url).origin === self.location.origin)
      if (page) {
        await page.focus()
        if (hash) page.postMessage({ open: hash })
        return
      }
      await self.clients.openWindow('/' + hash)
    })()
  )
})
