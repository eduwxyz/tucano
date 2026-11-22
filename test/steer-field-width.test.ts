// The pill's field, open, on the reply's own line under the answer: it takes the width of that line,
// not a column narrower than it, and it sits under the pill rather than beside it.
// Laid out as the app draws it (Conversation.tsx: `ReplyPill` inside `.msg__meta`, the field as the
// line's last item with `flex: 1 1 100%`). Left to itself the note stopped at 520 px in a 583 px
// chain, and its box ran on to the message body's edge instead of the line's, which is what this pins.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

const REPLY = (open: boolean): string => `
  <article class="msg msg--agent is-left-stack"><div class="msg__gutter"></div><div class="msg__body">
    <div class="msg__head"><span class="msg__author">Lia</span></div>
    <div class="md"><p>Resposta de teste, com as duas correções de hoje nas suas próprias entradas.</p></div>
    <div class="msg__meta">
      <span class="steps__steer-pill" role="button" aria-expanded="${open}">Orientar</span>
      <span class="receipt"><span class="receipt__line">Sonnet · 2.1k tokens · 782 ms</span></span>
      <button class="wiki-keep">Guardar na wiki</button>
      ${open ? `<div class="steps__steer steps__steer--reply">
        <div class="steps__steer-note">
          <textarea rows="2" aria-label="Orientação para a resposta em curso" placeholder="Como ele deve seguir?"></textarea>
          <div class="steps__steer-row">
            <button type="button" class="btn btn--primary btn--xs" disabled>Orientar</button>
            <button type="button" class="link">Cancelar</button>
            <span class="muted small">Ctrl+Enter envia</span>
          </div>
        </div>
      </div>` : ''}
    </div>
  </div></article>`

const box = (page: import('playwright').Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }
  })

it.skipIf(!existsSync(chromium.executablePath()))('gives the open field the reply line’s whole width, under the pill', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 880 } })
    await page.setContent(`<style>${css}</style><main class="main"><div class="messages">${REPLY(true)}</div></main>`)

    const line = await box(page, '.msg__meta')
    const body = await box(page, '.msg__body')
    const steer = await box(page, '.steps__steer')
    const note = await box(page, '.steps__steer-note')
    const field = await box(page, '.steps__steer-note textarea')
    const pill = await box(page, '.steps__steer-pill')

    // Full width of the line: it starts at the line's own left edge and ends where the line ends.
    expect(field.left).toBeCloseTo(line.left, 0)
    expect(field.right).toBeCloseTo(line.right, 0)
    expect(note.w).toBeCloseTo(line.w, 0)
    expect(steer.w).toBeCloseTo(line.w, 0)
    // Under the pill, on its own line, instead of pushed beside it.
    expect(pill.bottom).toBeLessThanOrEqual(note.top + 1)
    expect(pill.left).toBeCloseTo(line.left, 0)
    // The line belongs to the reply, not to the page: it stops with the body's text.
    expect(line.right).toBeLessThanOrEqual(body.right + 1)

    // No sideways scroll while the field is open at either width.
    for (const width of [1280, 420]) {
      await page.setViewportSize({ width, height: 880 })
      const scroll = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }))
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth)
      const narrowLine = await box(page, '.msg__meta')
      const narrowField = await box(page, '.steps__steer-note textarea')
      expect(narrowField.right).toBeCloseTo(narrowLine.right, 0)
      expect(narrowField.left).toBeCloseTo(narrowLine.left, 0)
    }
  } finally {
    await browser.close()
  }
})

it.skipIf(!existsSync(chromium.executablePath()))('keeps the pill compact and first on that line while the field is closed', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 880 } })
    await page.setContent(`<style>${css}</style><main class="main"><div class="messages">${REPLY(false)}</div></main>`)
    const line = await box(page, '.msg__meta')
    const pill = await box(page, '.steps__steer-pill')
    const receipt = await box(page, '.receipt')
    // The pill is first on the line, the receipt follows it, and the pill keeps its own size.
    expect(pill.left).toBeCloseTo(line.left, 0)
    expect(receipt.left).toBeGreaterThan(pill.right)
    expect(pill.h).toBeLessThan(21)
    expect(await page.locator('.steps__toggle .steps__steer-pill').count()).toBe(0)
    expect(await page.locator('.steps__steer').count()).toBe(0)
  } finally {
    await browser.close()
  }
})
