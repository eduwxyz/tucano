// My own prompt's pencil and trash sit beside the bubble, on its left, not above it. The row has
// its own padding and the bubble can be short, so a row-anchored glyph lands over the pill.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const markup = `
  <article class="msg msg--me" style="opacity:1"><div class="msg__gutter"></div>
    <div class="msg__body">
      <button class="icon-btn icon-btn--sm msg__edit" style="opacity:1"><svg width="13" height="13"></svg></button>
      <button class="icon-btn icon-btn--sm msg__delete msg__delete--prompt" style="opacity:1"><svg width="13" height="13"></svg></button>
      <div class="md">guarda o plano de hoje</div>
    </div>
  </article>`

it.skipIf(!existsSync(chromium.executablePath()))('keeps the prompt pencil and trash to the left of the bubble', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const width of [900, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 600 } })
      await page.setContent(`<style>${css}</style><main style="width:${width}px">${markup}</main>`)
      const box = (sel: string) => page.locator(sel).evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, mid: r.top + r.height / 2 }
      })
      const bubble = await box('.msg__body .md')
      const pencil = await box('.msg__edit')
      const trash = await box('.msg__delete--prompt')
      expect(pencil.right).toBeLessThanOrEqual(bubble.left)
      expect(trash.right).toBeLessThanOrEqual(bubble.left)
      expect(Math.abs(pencil.mid - bubble.mid)).toBeLessThan(14)
      expect(Math.abs(trash.mid - bubble.mid)).toBeLessThan(14)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
