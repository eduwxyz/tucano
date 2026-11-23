// Footer action pills: Continue / Try again / Try with instructions in the post footer row.
// Stub-rendered from the repo's styles.css in Chromium. Desktop-size full screenshots, then cropped.
import { mkdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const icon = (d, size = 11) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const play = icon('<polygon points="6 4 20 12 6 20 6 4"/>')
const back = icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>')
const edit = icon('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>')
const avatar = `<div class="msg__gutter"><span class="msg__face"><span class="avatar" style="width:34px;height:34px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;">T</span></span></div>`

const MSG = (hovered, openNote) => `
<div class="conversation" style="max-width:var(--chat-w);margin:0 auto;padding:32px 24px;">
  <article class="msg msg--agent ${hovered ? 'is-hovered' : ''}" style="position:relative;display:flex;gap:12px;">
    ${avatar}
    <div class="msg__body" style="flex:1;min-width:0;">
      <div class="msg__head" style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span class="msg__author" style="font-weight:600;font-size:13px;color:var(--text);">Tucano</span>
        <span class="msg__time" style="font-size:12px;color:var(--text-3);">2:14 PM</span>
      </div>
      <div class="md" style="font-size:14px;line-height:1.6;color:var(--text);">
        <p style="margin:0 0 8px;">I checked the deployment logs and the failing job is the nightly sync. The credentials rotated yesterday, so the job exits before it writes anything.</p>
      </div>
      <div class="note note--error" style="margin:8px 0;font-size:13px;color:var(--danger);">Interrupted: the app closed in the middle of the reply.</div>
      <div class="msg__meta">
        <button class="steps__ask-pill retry msg__hire" aria-label="Continue" type="button">${play}<span class="steps__ask-pill__word">Continue</span></button>
        <button class="steps__ask-pill retry msg__hire" aria-label="Try again" type="button">${back}<span class="steps__ask-pill__word">Try again</span></button>
        <button class="steps__ask-pill retry msg__hire" aria-expanded="${openNote ? 'true' : 'false'}" aria-label="Try with instructions" type="button">${edit}<span class="steps__ask-pill__word">Try with instructions</span></button>
        ${openNote ? `<div class="steps__ask-note" style="flex-basis:100%;width:100%;">
          <textarea aria-label="Instructions for the new try" placeholder="What should be different this time?" rows="2">Check the rotated credential name before retrying the sync.</textarea>
          <div class="steps__ask-row">
            <button class="btn btn--primary btn--xs" type="button">Try again with this</button>
            <button class="link" type="button">Cancel</button>
            <span class="muted small">Ctrl+Enter sends</span>
          </div>
        </div>` : ''}
        <span class="receipt" style="font-size:12px;color:var(--text-3);">2m 14s · 12.4k tokens</span>
      </div>
    </div>
  </article>
</div>`

const out = new URL('../frames/footer-action-pills/', import.meta.url)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  for (const [name, html, hoverSel] of [
    ['hidden', MSG(false, false), null],
    ['hovered-row', MSG(true, false), null],
    ['hovered-pill', MSG(true, false), '.steps__ask-pill:nth-child(3)'],
    ['try-with-instructions', MSG(true, true), null],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;background:var(--bg);font-family:var(--font-sans,system-ui,sans-serif);}
.is-hovered .msg__hire{opacity:1 !important;}
.is-hovered .msg__meta .steps__ask--reply{opacity:1 !important;}
</style></head><body>${html}</body></html>`, { waitUntil: 'load' })
    await page.waitForTimeout(250)
    if (hoverSel) await page.locator(hoverSel).hover().catch(() => {})
    await page.waitForTimeout(200)
    await page.screenshot({ path: new URL(`${name}-full.png`, out).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true })
    const box = await page.locator('.msg').boundingBox()
    if (box) {
      const pad = 24
      const clip = {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(1440 - Math.max(0, box.x - pad), box.width + pad * 2),
        height: box.height + pad * 2,
      }
      await page.screenshot({ path: new URL(`${name}.png`, out).pathname.replace(/^\/([A-Z]:)/, '$1'), clip })
    }
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('ok')
