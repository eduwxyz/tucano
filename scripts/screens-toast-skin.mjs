// The toast's skin, in both themes, from the real stylesheet.
//
// The toast only appears when something fails, which a script cannot reach without an account and a
// broken core, so this page carries the markup Toasts.tsx renders and links the app's own stylesheet.
// It records the computed colours, their contrast and how far each line of text sits from the middle
// of its toast, and pictures each theme with the old rule and the new one, so the before is in the
// same frame as the after.
//
//   node scripts/screens-toast-skin.mjs [out-dir]
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const out = resolve(process.argv[2] ?? 'screens-toast-skin')
mkdirSync(out, { recursive: true })
const css = readFileSync('src/renderer/src/styles.css', 'utf8')

// What `.toast` said before the change: the inverted `--primary` pill, text nudged down from the top
// by a 2px padding, which is what made it read high.
const old = `
.toast { background: var(--primary); color: var(--primary-text); border: 0; align-items: flex-start; }
.toast__text { padding-top: 2px; }
.toast__close:hover { background: color-mix(in srgb, var(--primary-text) 14%, transparent); }
`

const close =
  '<button class="icon-btn toast__close" aria-label="Close"><svg class="icon" width="14" height="14" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>'
const toast = (text) => `<div class="toast"><span class="toast__text">${text}</span>${close}</div>`

const markup = `
  <p class="toast-backdrop-line">Anything the app has to say about something that did not go through.</p>
  <div class="toasts">
    ${toast("I couldn't approve it. Try again.")}
    ${toast("Couldn't reach the model. Try again.")}
    ${toast("I couldn't open the authorization. The provider answered with something this version does not read, so nothing was sent.")}
  </div>`

// Contrast from the rendered colours rather than the hex codes in the file, and the distance from
// each text block's middle to its toast's middle: positive means the text sits low.
const read = `(() => {
  const parse = (c) => {
    const m = c.match(/[\\d.]+/g).map(Number)
    return m.slice(0, 3)
  }
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => { const [x, y] = [lum(parse(a)), lum(parse(b))].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(2) }
  const first = document.querySelector('.toast')
  const style = getComputedStyle(first)
  const ink = getComputedStyle(first.querySelector('.toast__text')).color
  const middle = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }
  const toasts = [...document.querySelectorAll('.toast')]
  return {
    page: parse(getComputedStyle(document.body).backgroundColor),
    toast: parse(style.backgroundColor),
    ink: parse(ink),
    contrast: ratio(ink, style.backgroundColor),
    borderWidth: style.borderTopWidth,
    offCentre: toasts.map((t) => +(middle(t.querySelector('.toast__text')) - middle(t)).toFixed(2)),
    closeOffCentre: toasts.map((t) => +(middle(t.querySelector('.toast__close')) - middle(t)).toFixed(2)),
    heights: toasts.map((t) => Math.round(t.getBoundingClientRect().height))
  }
})()`

const browser = await chromium.launch().catch(async () => {
  // No browser of playwright's own on this machine: use the Chrome or Edge that is installed.
  return await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ channel: 'msedge' }))
})
const results = []
for (const theme of ['light', 'dark']) {
  for (const variant of ['before', 'after']) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 430 },
      colorScheme: theme,
      deviceScaleFactor: 2
    })
    const html = `<!doctype html><html${theme === 'dark' ? ' data-theme="dark"' : ''}><head><meta charset="utf-8">
      <style>${css}</style>
      <style>body { margin: 0; padding: 28px; background: var(--bg); color: var(--text); font: 13px/1.5 var(--font); }
      .toast-backdrop-line { max-width: 520px; color: var(--text-2); }</style>
      ${variant === 'before' ? `<style>${old}</style>` : ''}
      </head><body>${markup}</body></html>`
    await page.setContent(html)
    await page.waitForTimeout(350) // let the entry animation finish
    const state = await page.evaluate(read)
    const file = join(out, `${theme}-${variant}.png`)
    await page.screenshot({ path: file })
    results.push({ theme, variant, ...state, file })
    await page.close()
  }
}
await browser.close()

const rgb = (c) => `rgb(${c.join(', ')})`
for (const r of results) {
  console.log(
    `${r.theme.padEnd(5)} ${r.variant.padEnd(6)} toast=${rgb(r.toast)} ink=${rgb(r.ink)} ` +
      `contrast=${r.contrast}:1 border=${r.borderWidth} text off centre=${r.offCentre.join(' / ')}px ` +
      `close=${r.closeOffCentre.join(' / ')}px heights=${r.heights.join(' / ')}`
  )
}

const light = results.find((r) => r.theme === 'light' && r.variant === 'after')
const dark = results.find((r) => r.theme === 'dark' && r.variant === 'after')
const white = (c) => c[0] > 235 && c[1] > 235 && c[2] > 230
console.log('dark toast is white:', white(dark.toast))
console.log('dark toast is lighter than the page:', dark.toast[0] > dark.page[0])
console.log('no border on the toast:', light.borderWidth === '0px' && dark.borderWidth === '0px')
console.log(
  'text and close sit in the middle:',
  [...light.offCentre, ...dark.offCentre, ...light.closeOffCentre, ...dark.closeOffCentre].every((n) => Math.abs(n) <= 0.5)
)
console.log('pictures:', out)
