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

// A page whose access ended (its person removed, its key no longer opening anything): the server
// answers 401. The page then says so, plainly, in place of everything, and the bridge stops
// reconnecting, so nothing seems to work while it silently doesn't. Defines `access` for the bridge:
// `answer(status)` with a server's answer (true: access is gone), `check()` after the line dropped
// for good (asks the server once; a network error is not a refusal).
export const ACCESS_SHIM = `const access = (() => {
  let gone = false
  const show = () => {
    if (gone) return
    gone = true
    const pt = document.documentElement.lang !== 'en'
    const main = document.createElement('main')
    main.style.cssText = 'font:15px system-ui;max-width:460px;margin:20vh auto 0;padding:24px;line-height:1.5'
    const title = document.createElement('h1')
    title.style.cssText = 'font-size:20px;margin:0 0 8px'
    title.textContent = pt ? 'Você não tem mais acesso a este Tucano.' : 'You no longer have access to this Tucano.'
    const why = document.createElement('p')
    why.style.cssText = 'opacity:.8;margin:0'
    why.textContent = pt ? 'Se foi engano, peça um novo convite a quem cuida dele.' : 'If that’s a mistake, ask whoever runs it for a new invite.'
    main.append(title, why)
    document.body.replaceChildren(main)
    document.title = 'Tucano'
  }
  const answer = (status) => {
    if (status === 401) show()
    return gone
  }
  return {
    get gone() {
      return gone
    },
    answer,
    check: () => fetch('./tucano-web.js', { method: 'HEAD', cache: 'no-store' }).then((r) => answer(r.status), () => gone)
  }
})()
`
