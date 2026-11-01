import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

// Layout needs a browser: DOM-only tests cannot detect a name squeezed out by flex.
it.skipIf(!existsSync(chromium.executablePath()))('keeps the agent name visible when the sidebar role is long', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <style>${readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')}</style>
      <aside style="width: 220px">
        <button class="nav-item">
          <span style="width:18px;flex-shrink:0">A</span>
          <span class="nav-item__label">Mariana</span>
          <span class="nav-item__meta nav-item__role"></span>
          <span class="dot dot--warn"></span>
        </button>
      </aside>`)
    for (const role of ['Research and development of complex projects '.repeat(20), 'Research'.repeat(100)]) {
      await page.locator('.nav-item__role').evaluate((el, text) => { el.textContent = text }, role)
      const layout = await page.locator('.nav-item').evaluate((item) => {
        const name = item.querySelector<HTMLElement>('.nav-item__label')!
        const role = item.querySelector<HTMLElement>('.nav-item__role')!
        return {
          nameVisible: name.clientWidth >= name.scrollWidth && name.clientWidth > 0,
          roleTruncated: role.scrollWidth > role.clientWidth,
          ellipsis: getComputedStyle(role).textOverflow,
          fits: item.scrollWidth <= item.clientWidth,
          singleLine: role.getBoundingClientRect().top < name.getBoundingClientRect().bottom
        }
      })
      expect(layout).toEqual({ nameVisible: true, roleTruncated: true, ellipsis: 'ellipsis', fits: true, singleLine: true })
    }
  } finally {
    await browser.close()
  }
})
