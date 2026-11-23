import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

// The Quadro's "stopped on" row once used the class `msg`, which is the chat message's: a grid with a 34px
// first column, so the agent's name sat squeezed in it, under "parou em …".
it.skipIf(!existsSync(chromium.executablePath()))('keeps the agent’s name beside "parou em" on the Quadro’s stopped row', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 400 } })
    const board = readFileSync(new URL('../src/renderer/src/components/Board.tsx', import.meta.url), 'utf8')
    const cls = /<span className="([^"]+)"><b>\{a\?\.name\}<\/b>/.exec(board)?.[1]
    expect(cls).toBeTruthy()
    await page.setContent(`
      <style>${readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')}</style>
      <div class="bd"><div class="bd-stuck" style="width: 900px">
        <div class="bd-stuck-row">
          <span class="bd-bang">!</span>
          <span class="${cls}"><b>UI Architect</b> parou em “Revisar o layout” <em>· Parei: repeti a mesma coisa</em></span>
          <span class="bd-grow"></span>
          <button class="bd-btn quiet sm">Ver</button>
        </div>
      </div></div>`)
    const gap = await page.evaluate(() => {
      const b = document.querySelector('.bd-stuck-row b')!
      const box = (n: Node): DOMRect => {
        const range = document.createRange()
        range.selectNodeContents(n)
        return range.getBoundingClientRect()
      }
      return box(b.nextSibling!).left - box(b.firstChild!).right // the name's text, not its box: a squeezed box lets the text spill over
    })
    expect(gap).toBeGreaterThanOrEqual(0)
  } finally {
    await browser.close()
  }
})
