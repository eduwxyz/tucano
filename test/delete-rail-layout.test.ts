// The session trash rides the same sticky rail as the thread button, one row under it, so a long
// reply never loses either glyph.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const markup = `
  <article class="msg msg--agent"><div class="msg__gutter"></div>
    <div class="msg__body"><div class="msg__anchor"><div class="msg__anchor-pin">
      <button class="icon-btn icon-btn--sm msg__reply">thread</button>
      <button class="icon-btn icon-btn--sm msg__delete">trash</button>
      <button class="icon-btn icon-btn--sm msg__reply msg__reply--up">up</button>
    </div><div class="steps__list" style="height:180px"></div></div></div>
  </article>`

it.skipIf(!existsSync(chromium.executablePath()))('keeps thread, trash and way back in one rail column', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const width of [900, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } })
      await page.setContent(`<style>${css}</style><main style="width:${width}px">${markup}</main>`)
      const box = (sel: string) => page.locator(sel).evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: Math.round(r.left), top: Math.round(r.top) }
      })
      const thread = await box('.msg__reply:not(.msg__reply--up)')
      const trash = await box('.msg__delete')
      const up = await box('.msg__reply--up')
      expect(trash.top).toBeGreaterThan(thread.top)
      expect(up.top).toBeGreaterThan(trash.top)
      expect(trash.left).toBe(thread.left)
      expect(up.left).toBe(thread.left)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
