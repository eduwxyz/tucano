// What a browser keeps from a page that isn't a secure context. Over plain HTTP on a private
// address (Tailscale, a home network) it has no crypto.randomUUID and no navigator.clipboard, which
// only HTTPS and localhost get; the app calls the first as it starts, so without this the page
// stays blank. This is plain JS for the page, run before the app, so it keeps to old syntax.
export const INSECURE_CONTEXT_SHIM = `(() => {
  if (typeof crypto.randomUUID !== 'function') {
    crypto.randomUUID = () => {
      const b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 15) | 64
      b[8] = (b[8] & 63) | 128
      const h = Array.prototype.map.call(b, (x) => (x + 256).toString(16).slice(1)).join('')
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
    }
  }
  if (!navigator.clipboard) {
    const writeText = (text) =>
      new Promise((resolve, reject) => {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        ok ? resolve() : reject(new Error('copy not allowed'))
      })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  }
})();
`
