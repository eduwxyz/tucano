// window.tucano for a browser: the core's port comes from the event stream and
// the requests go up by POST; what only the desktop does is left out quietly.
export const WEB = `(() => {
  window.__TUCANO_WEB__ = true
  // Browsers only give crypto.randomUUID to secure contexts, so over plain http on a
  // Tailscale or LAN address it is missing and the screens never start.
  if (!crypto.randomUUID) crypto.randomUUID = () => '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16))
  let client = null
  const connect = () => {
    const ch = new MessageChannel()
    const es = new EventSource('./events')
    let opened = false
    es.addEventListener('hello', (e) => {
      if (opened) return location.reload() // a new connection after a drop: start fresh
      opened = true
      client = e.data
      window.postMessage('core:port', '*', [ch.port1])
    })
    es.onmessage = (e) => ch.port2.postMessage(JSON.parse(e.data))
    ch.port2.onmessage = (m) => {
      fetch('./rpc?c=' + encodeURIComponent(client), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m.data) }).then((r) => {
        if (r.status === 410) location.reload()
      })
    }
  }
  window.tucano = {
    connect,
    pickFolder: async () => {
      const p = prompt('Pasta no servidor (caminho completo) / Folder on the server (full path):')
      return p && p.trim() ? p.trim() : null
    },
    onNavigate: () => {},
    viewing: () => {},
    updateState: async () => ({ version: '', status: 'off' }),
    onUpdate: () => {},
    checkUpdates: () => {},
    installUpdate: () => {}
  }
})()
`
