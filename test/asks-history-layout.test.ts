// The finished ask on the Asks page, drawn as the widgets its card used and measured in Chromium.
// What this holds: the questions of one ask sit on one row when they were asked one after another, the
// option the person took is the negative of the others (the text colour filled, the background's own
// text on it), and nothing in the record carries the accent the working card uses.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

// The two probes: what --bg and --text-2 resolve to in this theme, so the negative can be compared
// with the tokens themselves instead of with a colour written twice.
const probes = '<div id="pbg" style="background:var(--bg)"></div><div id="ptext" style="background:var(--text-2)"></div><div id="pacc" style="background:var(--accent)"></div>'

const ASK = (answered: boolean): string => `
  <div class="approvals-history">
    <div class="history-row history-row--approved is-open">
      <button type="button" class="history-row__line"><span class="history-row__what"><span class="grow truncate">Publico o post hoje? · Quando reviso o texto?</span><span class="history-row__who">Lia</span></span><span class="history-row__at">19:20</span><span class="history-row__state">por você</span></button>
      <ul class="history-row__more">
        <li>
          <div class="grow">
            <div class="history-questions">
              <div class="history-question">
                <p class="history-question__title">Publico o post hoje?</p>
                <div class="history-question__options">
                  <span class="history-question__option${answered ? '' : ' is-recommended'}">
                    <span class="history-question__number">1</span>
                    <span class="history-question__label">Sim, publico</span>
                    ${answered ? '' : '<span class="history-question__star"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.4l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.8l6-.9L12 3.4Z"/></svg></span>'}
                  </span>
                  <span class="history-question__option${answered ? ' is-answered' : ''}">
                    <span class="history-question__number">2</span>
                    <span class="history-question__label">Não, espero</span>
                    <span class="history-question__detail">fica para amanhã</span>
                  </span>
                </div>
              </div>
              <div class="history-question">
                <p class="history-question__title">Quando reviso o texto?</p>
                <div class="history-question__options">
                  <span class="history-question__option"><span class="history-question__number">1</span><span class="history-question__label">Reviso agora</span></span>
                  <span class="history-question__option"><span class="history-question__number">2</span><span class="history-question__label">Depois</span></span>
                </div>
              </div>
            </div>
            <span class="hint">na sua DM com Lia · 19:20</span>
          </div>
        </li>
      </ul>
    </div>
  </div>`

const page = (body: string): string => `<style>${css}</style><style>body{margin:0}#pbg,#ptext,#pacc{width:10px;height:10px}</style>${probes}<main class="main"><div class="messages" style="width:100%;max-width:640px;padding:12px">${body}</div></main>`

const box = (p: import('playwright').Page, sel: string, n = 0) =>
  p.locator(sel).nth(n).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }
  })

const band = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)

const skip = !existsSync(chromium.executablePath())

it.skipIf(skip)('puts the questions of one ask on a single row of widgets', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await p.setContent(page(ASK(true)))
    const first = await box(p, '.history-question', 0)
    const second = await box(p, '.history-question', 1)
    // The same line: they share most of their height, and the second starts past the first's end.
    expect(band(first, second)).toBeGreaterThan(Math.min(first.h, second.h) * 0.5)
    expect(second.left).toBeGreaterThanOrEqual(first.right)
    expect(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0)
  } finally {
    await browser.close()
  }
})

it.skipIf(skip)('draws the option the person took as the negative of the others', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await p.setContent(page(ASK(true)))
    const seen = await p.evaluate(() => {
      const bg = getComputedStyle(document.getElementById('pbg')!).backgroundColor
      const text = getComputedStyle(document.getElementById('ptext')!).backgroundColor
      const plain = getComputedStyle(document.querySelector('.history-question__option')!).backgroundColor
      const taken = document.querySelector('.history-question__option.is-answered')!
      const takenStyle = getComputedStyle(taken)
      return { bg, text, plain, takenBg: takenStyle.backgroundColor, takenText: takenStyle.color }
    })
    // The untouched option sits on the background; the taken one is filled with the text colour and
    // carries the background's own text — black on grey in the dark theme, white on grey in the light.
    expect(seen.plain).toBe(seen.bg)
    expect(seen.takenBg).toBe(seen.text)
    expect(seen.takenText).toBe(seen.bg)
  } finally {
    await browser.close()
  }
})

it.skipIf(skip)('keeps the accent out of the finished ask', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await p.setContent(page(ASK(false)))
    const seen = await p.evaluate(() => {
      const accent = getComputedStyle(document.getElementById('pacc')!).backgroundColor
      const star = getComputedStyle(document.querySelector('.history-question__star')!)
      const number = getComputedStyle(document.querySelector('.history-question__option.is-recommended .history-question__number')!)
      return { accent, starBorder: star.borderTopWidth, starColor: star.color, numberBg: number.backgroundColor, numberText: number.color }
    })
    // The mark carries no pill around it any more, and its grey is the record's, never the accent.
    expect(seen.starBorder).toBe('0px')
    expect(seen.starColor).not.toBe(seen.accent)
    expect(seen.numberBg).not.toBe(seen.accent)
    expect(seen.numberText).not.toBe(seen.accent)
  } finally {
    await browser.close()
  }
})

it.skipIf(skip)('wraps the widgets one under the other in a 420 px window, with nothing running sideways', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage({ viewport: { width: 420, height: 900 } })
    await p.setContent(page(ASK(true)))
    const first = await box(p, '.history-question', 0)
    const second = await box(p, '.history-question', 1)
    expect(second.top).toBeGreaterThanOrEqual(first.bottom - 1)
    const measured = await p.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }))
    expect(measured.page).toBeLessThanOrEqual(measured.window)
  } finally {
    await browser.close()
  }
})
