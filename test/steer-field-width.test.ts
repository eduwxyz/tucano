// The steer's field, open: it takes the width of the reply's chain, not a column narrower than it.
// Laid out as the app draws it (Conversation.tsx: the steer pill in the row under the chain, the
// field under that row), it runs from where the steps' text starts to where the chain stops. Left
// to itself the note stopped at 520 px in a 583 px chain, and its box ran on to the message body's
// edge instead of the chain's, which is what this pins.
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

const CHAIN = (open: boolean, summary = 'Working · 2 steps'): string => `
  <article class="msg msg--agent is-left-stack"><div class="msg__gutter"></div><div class="msg__body">
    <div class="steps is-open is-working steps--all">
      <button type="button" class="steps__toggle" aria-expanded="true">
        <span class="steps__chev">›</span>
        <span class="steps__pulse"></span>
        <span class="steps__summary">${summary}</span>
        <span class="steps__elapsed">4s</span>
        <span class="btn btn--xs btn--ghost steps__stop">Stop</span>
      </button>
      <div class="steps__pills"><span class="steps__steer-pill" role="button" aria-expanded="${open}">Steer</span></div>
      <ol class="steps__list">
        <li class="step step--tool step--done"><span class="step__icon"></span><span class="step__label">Read steer-demo</span></li>
        <li class="step step--tool step--running"><span class="step__icon"></span><span class="step__label">Reading the two last commits</span></li>
      </ol>
    </div>
    ${open ? `<div class="steps__steer">
      <div class="steps__steer-note">
        <textarea rows="2" aria-label="A steer for the reply running now" placeholder="How should it go on?"></textarea>
        <div class="steps__steer-row">
          <button type="button" class="btn btn--primary btn--xs" disabled>Steer</button>
          <button type="button" class="link">Cancel</button>
          <span class="muted small">Ctrl+Enter sends</span>
        </div>
      </div>
    </div>` : ''}
  </div></article>`

const box = (page: import('playwright').Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }
  })

it.skipIf(!existsSync(chromium.executablePath()))('gives the open steer field the chain’s whole width, not a column inside it', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 880 } })
    await page.setContent(`<style>${css}</style><main class="main"><div class="messages">${CHAIN(true)}</div></main>`)

    const chain = await box(page, '.steps')
    const steer = await box(page, '.steps__steer')
    const note = await box(page, '.steps__steer-note')
    const field = await box(page, '.steps__steer-note textarea')

    // The indent the steer puts between the chain's edge and the steps' own text: its rail.
    const contentLeft = chain.left + 17
    expect(chain.w).toBeCloseTo(600, 0)
    // Full width: the field ends where the chain ends and starts where the steps' text starts.
    expect(field.right).toBeCloseTo(chain.right, 0)
    expect(field.left).toBeCloseTo(contentLeft, 0)
    expect(field.w).toBeCloseTo(chain.w - 17, 0)
    expect(note.w).toBeCloseTo(chain.w - 17, 0)
    // And its own box stops with the chain, instead of running on to the message body's edge.
    expect(steer.right).toBeCloseTo(chain.right, 0)
    expect(steer.w).toBeCloseTo(chain.w, 0)

    // Under the pill, not beside it: the pill keeps the row it was on.
    const pill = await box(page, '.steps__steer-pill')
    expect(pill.bottom).toBeLessThanOrEqual(note.top + 1)
    expect(pill.right).toBeLessThan(note.right)

    // No sideways scroll while the field is open at either width.
    for (const width of [1280, 420]) {
      await page.setViewportSize({ width, height: 880 })
      const scroll = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }))
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth)
      const narrowChain = await box(page, '.steps')
      const narrowField = await box(page, '.steps__steer-note textarea')
      expect(narrowField.right).toBeCloseTo(narrowChain.right, 0)
      expect(narrowField.left).toBeCloseTo(narrowChain.left + 17, 0)
    }
  } finally {
    await browser.close()
  }
})

it.skipIf(!existsSync(chromium.executablePath()))('keeps the compact steer in the row under the chain while the field is closed', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 880 } })
    await page.setContent(`<style>${css}</style><main class="main"><div class="messages">${CHAIN(false)}</div></main>`)
    const chain = await box(page, '.steps')
    const pill = await box(page, '.steps__steer-pill')
    // The steer is a pill in the row under the chain, lined up with the steps' own text, and the
    // header keeps Stop alone so the pill cannot also fire the header's toggle.
    expect(pill.left).toBeCloseTo(chain.left + 17, 0)
    expect(pill.right).toBeLessThanOrEqual(chain.right)
    expect(pill.h).toBeLessThan(21)
    expect(await page.locator('.steps__toggle .steps__steer-pill').count()).toBe(0)
    expect(await page.locator('.steps__steer').count()).toBe(0)
  } finally {
    await browser.close()
  }
})
