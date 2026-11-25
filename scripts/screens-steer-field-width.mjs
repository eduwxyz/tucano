// The four frames the PR carries: the steer's field open, at 1280 and 420, before and after the fix.
// Laid out from the repo's own styles.css in Chromium — the same markup the layout test measures —
// not from a packaged build.
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const current = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const before = execSync('git show HEAD:src/renderer/src/styles.css', {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
})

const CHAIN = `
  <article class="msg msg--agent is-left-stack"><div class="msg__gutter"></div><div class="msg__body">
    <div class="steps is-open is-working steps--all">
      <button type="button" class="steps__toggle" aria-expanded="true">
        <span class="steps__chev">›</span><span class="steps__pulse"></span>
        <span class="steps__summary">Working · 2 steps</span>
        <span class="steps__elapsed">4s</span>
      </button>
      <ol class="steps__list">
        <li class="step step--tool step--done"><span class="step__icon"></span><span class="step__label">Read steer-demo</span></li>
        <li class="step step--tool step--running"><span class="step__icon"></span><span class="step__label">Reading the two last commits</span></li>
      </ol>
    </div>
    <div class="steps__steer">
      <button type="button" class="steps__steer-pill" aria-expanded="true">Orientar</button>
      <div class="steps__steer-note">
        <textarea rows="2" aria-label="A steer for the reply running now" placeholder="Como ele deve seguir?"></textarea>
        <div class="steps__steer-row">
          <button type="button" class="btn btn--primary btn--xs">Orientar</button>
          <button type="button" class="link">Cancelar</button>
          <span class="muted small">Ctrl+Enter envia</span>
        </div>
      </div>
    </div>
  </div></article>`

const out = new URL('../frames/steer-field-width/', import.meta.url)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  for (const [tag, css] of [
    ['before', before],
    ['after', current]
  ]) {
    for (const width of [1280, 420]) {
      const page = await browser.newPage({ viewport: { width, height: 520 } })
      await page.setContent(`<style>${css}</style><main class="main"><div class="messages">${CHAIN}</div></main>`)
      const page_ = page
      const box = await page_.locator('.steps').first().evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top - 16) }
      })
      const height = await page_.locator('.steps__steer').first().evaluate((el) => el.getBoundingClientRect().bottom + 16)
      await page_.screenshot({
        path: new URL(`${width}-${tag}.png`, out).pathname.slice(1),
        clip: { x: box.x, y: box.y, width: Math.min(width - box.x, width), height: Math.round(height - box.y) }
      })
      const field = await page_.locator('.steps__steer-note textarea').first().evaluate((el) => {
        const r = el.getBoundingClientRect()
        return Math.round(r.width)
      })
      console.log(`${width} ${tag}: field ${field}px`)
      await page.close()
    }
  }
} finally {
  await browser.close()
}
