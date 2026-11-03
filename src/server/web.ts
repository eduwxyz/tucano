// The native renderer keeps its local preview policy. A server page must replace
// the whole directive: the browser's loopback may belong to a different machine.
export function webPage(html: string, frameSrc: string): string {
  return html
    .replace(/frame-src [^";]+/, frameSrc)
    .replace('<title>', '<meta name="viewport" content="width=device-width, initial-scale=1" />\n    <script src="./tucano-web.js"></script>\n    <title>')
}

// window.tucano for a browser: the core's port comes from the event stream and
// the requests go up by POST; what only the desktop does is left out quietly.
export function webBridge(previewHost: string | null): string {
  return `(() => {
  window.__TUCANO_WEB__ = true
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
    // A localhost page may be an SSH tunnel for Tucano alone, not its services.
    servicePreviews: location.protocol === 'http:' && location.hostname === ${JSON.stringify(previewHost)},
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
}
