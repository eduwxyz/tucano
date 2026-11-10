// The Follow Up pill lives on the reply's own footer line — the one under a finished answer that fades
// in when you hover it — first in that line, before the receipt. Layout needs a browser: whether two
// things share a row is a measurement, not a reading of the CSS.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

// The footer as the app draws it (src/renderer/src/components/Conversation.tsx, MessageRow).
const REPLY = (wide: boolean): string => `
  <article class="msg msg--agent"><div class="msg__gutter"></div><div class="msg__body">
    <div class="md"><p>${wide ? 'A resposta que terminou, com o texto que ela deixou na conversa.' : 'Resposta.'}</p></div>
    <div class="msg__meta">
      <div class="steps__ask steps__ask--down steps__ask--reply">
        <button class="steps__ask-pill" aria-expanded="false">Follow Up</button>
      </div>
      <div class="receipt"><button class="receipt__line">Sonnet · 6.4k tokens · 5s</button></div>
      <span class="wiki-keep"><button class="link">Keep in the wiki</button></span>
    </div>
  </div></article>`

it.skipIf(!existsSync(chromium.executablePath()))('puts the Follow Up pill on the footer line, before the receipt, and fades it in with that line', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(`<style>${css}</style><main>${REPLY(true)}</main>`)

    const box = (sel: string) => page.locator(sel).evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height, mid: r.top + r.height / 2 }
    })

    // One row: the pill and the receipt line share their vertical band, the pill on its left.
    const pill = await box('.steps__ask-pill')
    const receipt = await box('.receipt__line')
    const keep = await box('.msg__meta .wiki-keep')
    expect(Math.abs(pill.mid - receipt.mid)).toBeLessThan(6)
    expect(Math.abs(pill.mid - keep.mid)).toBeLessThan(8)
    expect(pill.right).toBeLessThan(receipt.left)
    expect(receipt.right).toBeLessThanOrEqual(keep.left + 1)
    // And first in the line, not somewhere after the numbers.
    const order = await page.locator('.msg__meta > *').evaluateAll((els) => els.map((el) => el.className.split(' ')[0]))
    expect(order).toEqual(['steps__ask', 'receipt', 'wiki-keep'])

    // It comes in with the line it sits on: gone until the reply is hovered, there while hovered.
    expect(await page.locator('.steps__ask--reply').evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
    await page.locator('.msg').hover()
    await expect.poll(() => page.locator('.steps__ask--reply').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    await page.locator('.md').hover()
    expect(await page.locator('.steps__ask--reply').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')

    // Open, it stays seen even with the pointer away, and the field it opens sits under the pill.
    await page.locator('.steps__ask-pill').evaluate((el) => el.setAttribute('aria-expanded', 'true'))
    await page.locator('.steps__ask--reply').evaluate((el) => {
      const note = document.createElement('div')
      note.className = 'steps__ask-note'
      note.innerHTML = '<textarea placeholder="What next?"></textarea>'
      el.append(note)
    })
    await page.mouse.move(5, 5)
    await expect.poll(() => page.locator('.steps__ask--reply').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    const field = await box('.steps__ask-note textarea')
    const opened = await box('.steps__ask--reply')
    expect(field.top).toBeGreaterThan(pill.bottom)
    expect(opened.left).toBeCloseTo(pill.left, 0)
    expect(field.w).toBeLessThanOrEqual(520.5)
  } finally {
    await browser.close()
  }
})

it.skipIf(!existsSync(chromium.executablePath()))('keeps the open field inside a 420 px window without a sideways scroll', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 800 } })
    await page.setContent(`<style>${css}</style>${REPLY(false)}`)
    await page.locator('.steps__ask-pill').evaluate((el) => el.setAttribute('aria-expanded', 'true'))
    await page.locator('.steps__ask--reply').evaluate((el) => {
      const note = document.createElement('div')
      note.className = 'steps__ask-note'
      note.innerHTML = '<textarea placeholder="What next?"></textarea>'
      el.append(note)
    })
    const measured = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      window: window.innerWidth,
      field: document.querySelector('.steps__ask-note textarea')!.getBoundingClientRect().width
    }))
    expect(measured.page).toBeLessThanOrEqual(measured.window)
    expect(measured.field).toBeGreaterThan(200)
    expect(measured.field).toBeLessThanOrEqual(measured.window)
  } finally {
    await browser.close()
  }
})
