import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

// The toast is the app's quiet failure note. It used to take `--primary`, which is ink in the light
// theme and cream in the dark one, so the dark app showed a white pill. It carries the signature
// orange instead, as text on a surface that lifts off the page: white in the light, a step above the
// panel in the dark.
const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `${selector} is missing from styles.css`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

it('gives the toast the signature orange instead of the inverting primary', () => {
  const toast = rule('.toast')
  expect(toast).toContain('background: var(--toast-bg)')
  expect(toast).toContain('color: var(--toast-ink)')
  // The declarations, with the comment above them stripped: it names `--primary` to explain the bug.
  expect(toast.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('--primary')
})

it('declares the toast surfaces in every theme, so the dark one cannot fall back to white', () => {
  for (const token of ['--toast-bg', '--toast-ink']) {
    expect(css.match(new RegExp(`${token}:`, 'g'))?.length, `${token} is not in all three theme blocks`).toBe(3)
  }
})

const launch = async () => {
  try {
    return await chromium.launch({ headless: true })
  } catch {
    // No browser of playwright's own: use the Chrome on the machine, and skip where there is none.
    return await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => null)
  }
}

const colors = `(() => {
  const parse = (c) => c.match(/[\\d.]+/g).map(Number).slice(0, 3)
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
  const toast = document.querySelector('.toast')
  const style = getComputedStyle(toast)
  const ink = getComputedStyle(toast.querySelector('.toast__text')).color
  return {
    toast: parse(style.backgroundColor),
    page: parse(getComputedStyle(document.body).backgroundColor),
    ink: parse(ink),
    contrast: ratio(parse(ink), parse(style.backgroundColor))
  }
})()`

type Rgb = [number, number, number]
type Read = { toast: Rgb; page: Rgb; ink: Rgb; contrast: number }

it('draws a white toast in the light theme and a raised dark one in the dark theme', async () => {
  const browser = await launch()
  if (!browser) return
  try {
    const page = await browser.newPage()
    await page.setContent(
      `<style>${css}</style><div class="toasts"><div class="toast"><span class="toast__text">Try again.</span></div></div>`
    )
    const read = async (theme: string): Promise<Read> => {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      return (await page.evaluate(colors)) as Read
    }

    const dark = await read('dark')
    expect(dark.toast.join(), 'the dark toast is white again').not.toBe('241,236,228')
    expect(dark.toast[0], 'the dark toast should lift off the page').toBeGreaterThan(dark.page[0])
    expect(dark.contrast).toBeGreaterThanOrEqual(4.5)

    const light = await read('light')
    expect(light.toast.length).toBe(3)
    expect(light.toast[0], 'the light toast should read as white').toBeGreaterThan(240)
    expect(light.ink[0], 'the light toast ink should be the accent family').toBeGreaterThan(light.ink[2] + 80)
    expect(light.contrast).toBeGreaterThanOrEqual(4.5)
  } finally {
    await browser.close()
  }
})
