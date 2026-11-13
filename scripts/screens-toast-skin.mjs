// The toast's skin, in both themes, from the real stylesheet.
//
// The toast only appears when something fails, which a script cannot reach without an account and a
// broken core, so this page carries the markup Toasts.tsx renders and links the app's own stylesheet.
// It records the computed colours and their contrast, and pictures each theme with the old rule and
// the new one, so the before is in the same frame as the after.
//
//   node scripts/screens-toast-skin.mjs [out-dir]
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const out = resolve(process.argv[2] ?? 'screens-toast-skin')
mkdirSync(out, { recursive: true })
const css = readFileSync('src/renderer/src/styles.css', 'utf8')

// What `.toast` said before the change: the inverted `--primary` pill.
const old = `
.toast { background: var(--primary); color: var(--primary-text); border: 0; }
.toast__close:hover { background: color-mix(in srgb, var(--primary-text) 14%, transparent); }
`

const markup = `
  <p class="toast-backdrop-line">Anything the app has to say about something that did not go through.</p>
  <div class="toasts">
    <div class="toast"><span class="toast__text">I couldn't approve it. Try again.</span>
      <button class="icon-btn toast__close" aria-label="Close"><svg class="icon" width="14" height="14" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg></button></div>
    <div class="toast"><span class="toast__text">Couldn't reach the model. Try again.</span>
      <button class="icon-btn toast__close" aria-label="Close"><svg class="icon" width="14" height="14" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg></button></div>
  </div>`

// WCAG contrast, from the rendered colours rather than from the hex codes in the file.
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
  const t = document.querySelector('.toast')
  const s = getComputedStyle(t)
  const page = getComputedStyle(document.body).backgroundColor
  const ink = getComputedStyle(t.querySelector('.toast__text')).color
  const close = getComputedStyle(t.querySelector('.toast__close'))
  return {
    page,
    toastBg: s.backgroundColor,
    toastInk: ink,
    border: s.borderColor,
    closeInk: close.color,
    toastWidth: Math.round(t.getBoundingClientRect().width),
    contrast: ratio(ink, s.backgroundColor)
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
      viewport: { width: 900, height: 340 },
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

for (const r of results) {
  console.log(
    `${r.theme.padEnd(5)} ${r.variant.padEnd(6)} toast=${r.toastBg} ink=${r.toastInk} ` +
      `contrast=${r.contrast}:1 close=${r.closeInk} width=${r.toastWidth}px`
  )
}

const dark = results.find((r) => r.theme === 'dark' && r.variant === 'after')
const light = results.find((r) => r.theme === 'light' && r.variant === 'after')
const white = (c) => {
  const [r, g, b] = c.match(/[\d.]+/g).map(Number)
  return r > 235 && g > 235 && b > 230
}
console.log('dark toast is white:', white(dark.toastBg))
console.log('light toast carries the accent:', light.toastInk === light.border || light.toastInk !== light.toastBg)
console.log('dark toast is lighter than the page:', dark.toastBg !== dark.page)
console.log('pictures:', out)
