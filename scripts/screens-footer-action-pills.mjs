// Footer action pills: Continue / Try again in the post footer row.
// Stub-rendered from the repo's styles.css in Chromium.
import { mkdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const icon = (d) => `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const play = icon('<polygon points="6 4 20 12 6 20 6 4"/>')
const back = icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>')

const MSG = (state) => `
<div class="msg msg--agent ${state}" style="position:relative; padding:12px 16px; max-width:720px;">
  <div class="msg__body" style="width:100%;">
    <div class="md" style="font-size:14px; line-height:1.6; color:var(--text); margin-bottom:8px;">
      I checked the deployment logs and the failing job is the nightly sync. The credentials rotated yesterday, so the job exits before it writes anything.
    </div>
    <div class="note note--error" style="margin:8px 0; font-size:13px;">Interrupted: the app closed in the middle of the reply.</div>
    <div class="msg__meta">
      <button class="steps__ask-pill retry msg__hire" aria-label="Continue" type="button">${play}<span class="steps__ask-pill__word">Continue</span></button>
      <button class="steps__ask-pill retry msg__hire" aria-label="Try again" type="button">${back}<span class="steps__ask-pill__word">Try again</span></button>
      <span class="receipt" style="font-size:12px; color:var(--text-3);">2m 14s · 12.4k tokens</span>
    </div>
  </div>
</div>`

const out = new URL('../frames/footer-action-pills/', import.meta.url)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  for (const [name, html, hoverSel] of [
    ['hidden', MSG(''), null],
    ['hovered-row', MSG('is-hovered'), null],
    ['hovered-pill', MSG('is-hovered'), '.steps__ask-pill:first-child'],
  ]) {
    const page = await browser.newPage({ viewport: { width: 860, height: 320 }, deviceScaleFactor: 2 })
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;padding:28px;background:var(--bg);font-family:var(--font-sans,system-ui,sans-serif);}
.is-hovered .msg__hire { opacity: 1 !important; }
</style></head><body>${html}</body></html>`, { waitUntil: 'load' })
    await page.waitForTimeout(200)
    if (hoverSel) await page.locator(hoverSel).hover().catch(() => {})
    await page.waitForTimeout(150)
    const box = await page.locator('.msg').boundingBox()
    if (box) {
      await page.screenshot({
        path: new URL(`${name}.png`, out).pathname.replace(/^\/([A-Z]:)/, '$1'),
        clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: box.height + 24 }
      })
    }
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('ok')
