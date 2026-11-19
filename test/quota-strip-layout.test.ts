// The widths of the bars in a session's header. That rule is one about layout, so it is measured in a
// browser against the checkout's own stylesheet: linkedom has no layout, and a DOM test cannot tell a
// bar as wide as its own name from a bar as wide as the longest name beside it.
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const pill = (name: string, tone = ''): string =>
  `<span class="quota-strip__pill${tone ? ` ${tone}` : ''}"><span class="quota-strip__name">${name}</span><span class="quota-strip__track"><i style="width:40%"></i></span></span>`
const strip = (markup: string): string =>
  `<style>${css}</style><div class="topbar__actions"><button type="button" class="quota-strip">${markup}</button></div>`

// A bar, and its name's two widths: the box the label sits in, and the width the letters themselves
// take, which is the width a pill sized by its own label would have had.
const measure = (): { bar: number; box: number; text: number; clipped: number }[] =>
  [...document.querySelectorAll<HTMLElement>('.quota-strip__pill')]
    .filter((el) => getComputedStyle(el).display !== 'none')
    .map((el) => {
      const name = el.querySelector<HTMLElement>('.quota-strip__name')!
      const track = el.querySelector<HTMLElement>('.quota-strip__track')!
      const range = document.createRange()
      range.selectNodeContents(name)
      return {
        bar: Math.round(track.getBoundingClientRect().width),
        box: Math.round(name.getBoundingClientRect().width),
        text: Math.round(range.getBoundingClientRect().width),
        clipped: name.scrollWidth - name.clientWidth
      }
    })

it.skipIf(!existsSync(chromium.executablePath()))('gives every bar the width of the longest name in the strip', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 400 } })
    // The two pills a conversation draws at most, with names of very different lengths.
    await page.setContent(strip(pill('OpenAI Codex') + pill('Z.ai', 'is-warn')))
    const [long, short] = await page.evaluate(measure)
    expect(long!.text).toBeGreaterThan(short!.text + 20)
    // Both bars take the longest name's width, and the short name sits inside its column uncut.
    expect(short!.bar).toBe(long!.bar)
    expect(short!.box).toBe(long!.bar)
    expect(Math.abs(long!.bar - long!.text)).toBeLessThanOrEqual(1)
    expect([long!.clipped, short!.clipped]).toEqual([0, 0])
  } finally {
    await browser.close()
  }
})

it.skipIf(!existsSync(chromium.executablePath()))('sizes the one bar a narrow header keeps to itself', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 400 } })
    await page.setContent(strip(pill('OpenAI Codex') + pill('Z.ai', 'is-warn')))
    // Below 900 px only the bar that is running low stays, and the provider that is hidden sets no
    // width: the one left is as wide as its own name.
    const shown = await page.evaluate(measure)
    expect(shown).toHaveLength(1)
    expect(Math.abs(shown[0]!.bar - shown[0]!.text)).toBeLessThanOrEqual(1)
    expect(shown[0]!.clipped).toBe(0)
  } finally {
    await browser.close()
  }
})
