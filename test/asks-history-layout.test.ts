// The finished ask on the Asks page, drawn as the widgets its card used and measured in Chromium.
// What this holds: the questions of one ask sit on one row when they were asked one after another, the
// option the person took is the negative of the others (the text colour filled, the background's own
// text on it), nothing in the record carries the accent the working card uses, and a long answer wraps
// inside its own card with the agent's tag riding the end of its last line.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

// The probes: what --bg, --text-2, --accent and --border-strong resolve to in this theme, so the
// negative and the pill can be compared with the tokens themselves instead of with a colour twice.
const probes =
  '<div id="pbg" style="background:var(--bg)"></div><div id="ptext" style="background:var(--text-2)"></div><div id="pacc" style="background:var(--accent)"></div><div id="pborder" style="background:var(--border-strong)"></div>'

// A label long enough to need three lines in a 420 px window: the wrap this file measures.
const LONG = 'Sim, publico o post hoje com a foto que a Lia revisou ontem à noite, e o texto corrido que cresce até quebrar de linha'

type Opts = { long?: boolean; short?: boolean; detail?: string }

const option = (n: number, label: string, extra: { taken?: boolean; recommended?: boolean; detail?: string }): string => `
                  <span class="history-question__option${extra.taken ? ' is-answered' : ''}${extra.recommended ? ' is-recommended' : ''}">
                    <span class="history-question__number">${n}</span>
                    <span class="history-question__body"><span class="history-question__label">${label}</span>${
                      extra.detail ? ` <span class="history-question__detail">${extra.detail}</span>` : ''
                    }${extra.recommended ? ' <span class="history-question__pill">Recomendado</span>' : ''}</span>
                  </span>`

const ASK = (opts: Opts = {}): string => {
  const label = opts.long ? LONG : opts.short ? 'Sim' : 'Sim, publico'
  const other = opts.short ? 'Não' : 'Não, espero'
  return `
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
                  ${option(1, label, { recommended: true })}
                  ${option(2, other, { taken: true, detail: opts.detail })}
                </div>
              </div>
              <div class="history-question">
                <p class="history-question__title">Quando reviso o texto?</p>
                <div class="history-question__options">
                  ${option(1, 'Reviso agora', {})}
                  ${option(2, 'Depois', {})}
                </div>
              </div>
            </div>
            <span class="hint">na sua DM com Lia · 19:20</span>
          </div>
        </li>
      </ul>
    </div>
  </div>`
}

const page = (body: string): string => `<style>${css}</style><style>body{margin:0}#pbg,#ptext,#pacc,#pborder{width:10px;height:10px}</style>${probes}<main class="main"><div class="messages" style="width:100%;max-width:640px;padding:12px">${body}</div></main>`

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
    await p.setContent(page(ASK({ short: true })))
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
    await p.setContent(page(ASK({})))
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

it.skipIf(skip)('keeps the accent out of the finished ask, and marks the pick with the record\u2019s grey pill', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await p.setContent(page(ASK({})))
    const seen = await p.evaluate(() => {
      const accent = getComputedStyle(document.getElementById('pacc')!).backgroundColor
      const borderStrong = getComputedStyle(document.getElementById('pborder')!).backgroundColor
      const pill = getComputedStyle(document.querySelector('.history-question__pill')!)
      const number = getComputedStyle(document.querySelector('.history-question__option.is-recommended .history-question__number')!)
      return {
        accent,
        borderStrong,
        pillBorder: pill.borderTopColor,
        pillRadius: pill.borderTopLeftRadius,
        pillColor: pill.color,
        numberBg: number.backgroundColor,
        numberText: number.color,
        stars: document.querySelectorAll('.history-question__star').length
      }
    })
    // The tag is a pill again, drawn in the record's grey: its border is the strong border, its text
    // is never the accent the working card uses, and no star is left anywhere in the record.
    expect(seen.pillRadius).toBe('999px')
    expect(seen.pillBorder).toBe(seen.borderStrong)
    expect(seen.pillColor).not.toBe(seen.accent)
    expect(seen.numberBg).not.toBe(seen.accent)
    expect(seen.numberText).not.toBe(seen.accent)
    expect(seen.stars).toBe(0)
  } finally {
    await browser.close()
  }
})

it.skipIf(skip)('wraps the widgets one under the other in a 420 px window, with nothing running sideways', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage({ viewport: { width: 420, height: 900 } })
    await p.setContent(page(ASK({ detail: 'fica para amanhã' })))
    const first = await box(p, '.history-question', 0)
    const second = await box(p, '.history-question', 1)
    expect(second.top).toBeGreaterThanOrEqual(first.bottom - 1)
    const measured = await p.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }))
    expect(measured.page).toBeLessThanOrEqual(measured.window)
  } finally {
    await browser.close()
  }
})

it.skipIf(skip)('wraps a long answer inside its card, with the tag at the end of its last line', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage({ viewport: { width: 420, height: 900 } })
    await p.setContent(page(ASK({ long: true, detail: 'fica para amanhã' })))
    const read = await p.evaluate(() => {
      const card = document.querySelector('.history-question') as HTMLElement
      const option = card.querySelector('.history-question__option') as HTMLElement
      const body = option.querySelector('.history-question__body') as HTMLElement
      const label = option.querySelector('.history-question__label') as HTMLElement
      const pill = option.querySelector('.history-question__pill') as HTMLElement
      const r = (b: DOMRect | { left: number; right: number; top: number; bottom: number }) => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom })
      // The label's own line boxes: the last one is where its text actually ends, which a union box
      // spanning three lines cannot tell.
      const range = document.createRange()
      range.selectNodeContents(label)
      const lines = Array.from(range.getClientRects()).map(r)
      return {
        card: r(card.getBoundingClientRect()),
        option: r(option.getBoundingClientRect()),
        label: r(label.getBoundingClientRect()),
        pill: r(pill.getBoundingClientRect()),
        last: lines[lines.length - 1]!,
        lines: lines.length,
        line: parseFloat(getComputedStyle(label).lineHeight),
        cardPadRight: parseFloat(getComputedStyle(card).paddingRight),
        cardBorder: parseFloat(getComputedStyle(card).borderRightWidth),
        optionPadRight: parseFloat(getComputedStyle(option).paddingRight),
        optionBorder: parseFloat(getComputedStyle(option).borderRightWidth),
        whiteSpace: getComputedStyle(label).whiteSpace,
        spill: [card, option, body].map((el) => el.scrollWidth - el.clientWidth),
        page: document.documentElement.scrollWidth,
        window: window.innerWidth
      }
    })
    // The answer is text again: the record's row no longer forces it onto one line, so a long label
    // needs several, and the tag is on the last of them instead of on the first.
    expect(read.whiteSpace).toBe('normal')
    expect(read.lines).toBeGreaterThan(1)
    expect(read.label.bottom - read.label.top).toBeGreaterThan(read.line * 2)
    expect(read.last.top).toBeGreaterThan(read.label.top + read.line * 0.9)
    // It follows the text's own end rather than sitting in a column at the row's right edge.
    expect(read.pill.left).toBeGreaterThanOrEqual(read.last.right - 1)
    expect(read.pill.bottom).toBeGreaterThan(read.last.top)
    expect(read.pill.top).toBeLessThan(read.last.bottom)
    // And nothing paints past a border: no widget, option or answer box scrolls sideways, the pill
    // stays inside the option's padding box, and that box stays inside the card's frame.
    expect(read.spill).toEqual([0, 0, 0])
    expect(read.pill.right).toBeLessThanOrEqual(read.option.right - read.optionPadRight - read.optionBorder + 0.5)
    expect(read.option.right).toBeLessThanOrEqual(read.card.right - read.cardPadRight - read.cardBorder + 0.5)
    expect(read.page).toBeLessThanOrEqual(read.window)
  } finally {
    await browser.close()
  }
})
