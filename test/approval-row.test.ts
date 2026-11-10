// The decisions on an approval card (issue #252, direction A): Approve, "Approve and always allow"
// and Refuse share ONE line at every width the card has. The primary used to hold 244px of its own
// and the long label asked for 196 more, so Refuse fell onto a line below at every width — which is
// what the card's own screenshots showed. Now the primary grows into what the row has left, the long
// label reads on two lines inside its 44px button when one line doesn't fit, and past two lines it
// ends in an ellipsis. Below 560px the three take the card's own line, one above the next.
import { existsSync, readFileSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { afterAll, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

// Playwright's own Chromium when this machine has it, otherwise the Chrome already installed (what
// CI runners have), and in neither case a red suite: the file is skipped rather than failing.
const launch = async (): Promise<Browser | undefined> => {
  const tries: Parameters<typeof chromium.launch>[0][] = [{ headless: true }]
  if (!existsSync(chromium.executablePath())) tries.push({ headless: true, channel: 'chrome' })
  for (const options of tries) {
    try {
      return await chromium.launch(options)
    } catch {
      // Try the next one; nothing to report, a missing browser is not a failure of the CSS.
    }
  }
  return undefined
}
const browser = await launch()
afterAll(async () => {
  await browser?.close()
})

const markup = (label: string, width: number): string => `
  <style>${css}</style>
  <style>body { margin: 0 }</style>
  <div style="width: ${width}px">
    <div class="approval__actions">
      <button class="btn btn--primary approval__approve">Approve</button>
      <button class="btn approval__allow"><span class="approval__allow-label">${label}</span></button>
      <button class="btn approval__refuse-btn">Refuse</button>
    </div>
  </div>`

// What the row does with a given amount of it, at a given window width. Nothing here asserts a
// font's own metrics: the numbers that matter are relations (one line, same height, no overflow).
const room = async (label: string, width: number, viewport: number) => {
  const page = await browser!.newPage({ viewport: { width: viewport, height: 400 } })
  try {
    await page.setContent(markup(label, width))
    return await page.locator('.approval__actions').evaluate((actions) => {
      const buttons = [...actions.querySelectorAll('button')]
      const label = actions.querySelector('.approval__allow-label')!
      const box = (el: Element): DOMRect => el.getBoundingClientRect()
      return {
        rows: new Set(buttons.map((b) => Math.round(box(b).top))).size,
        direction: getComputedStyle(actions).flexDirection,
        width: Math.round(box(actions).width),
        buttons: buttons.map((b) => ({ width: Math.round(box(b).width), height: Math.round(box(b).height) })),
        heights: [...new Set(buttons.map((b) => Math.round(box(b).height)))],
        gaps: [Math.round(box(buttons[1]!).left - box(buttons[0]!).right), Math.round(box(buttons[2]!).left - box(buttons[1]!).right)],
        label: { shown: Math.round(box(label).height), wanted: label.scrollHeight, clamp: getComputedStyle(label).webkitLineClamp },
        overflow: actions.scrollWidth - actions.clientWidth
      }
    })
  } finally {
    await page.close()
  }
}

it.skipIf(!browser)('keeps the three decisions on one line, the long label whole', async () => {
  // 517: the card's row at a 1280px window, where every preview had Refuse on a second line.
  const wide = await room('Approve and always allow', 517, 1280)
  expect(wide.direction).toBe('row')
  expect(wide.rows).toBe(1)
  expect(wide.gaps).toEqual([12, 12])
  expect(wide.heights).toEqual([44])
  // One line of label, nothing cut.
  expect(wide.label).toEqual({ shown: 16, wanted: 16, clamp: '2' })
  expect(wide.overflow).toBe(0)
  // Each of the three still fits in the row they share, the primary not under its 120px floor.
  expect(wide.buttons.reduce((sum, b) => sum + b.width, 0) + 24).toBeLessThanOrEqual(wide.width)
  expect(wide.buttons[0]!.width).toBeGreaterThanOrEqual(120)
  expect(wide.buttons[2]!.width).toBeGreaterThanOrEqual(108)
})

it.skipIf(!browser)('reads the long label on two lines rather than pushing Refuse down', async () => {
  // 389: the card at an 800px window, the narrowest room the row has above the stacking point.
  const tight = await room('Approve and always allow', 389, 1280)
  expect(tight.rows).toBe(1)
  expect(tight.heights).toEqual([44])
  expect(tight.overflow).toBe(0)
  // Two lines of label inside the same 44px button, never a squeezed single one.
  expect(tight.label.shown).toBe(32)
  expect(tight.buttons[0]!.width).toBeGreaterThanOrEqual(120)
  expect(tight.buttons[2]!.width).toBeGreaterThanOrEqual(108)
})

it.skipIf(!browser)('ends a label past two lines in an ellipsis, the row still one line', async () => {
  // A runner's "always allow" lists every tool it covers; two lines are all it gets.
  const long = await room('Approve and always allow read_file, write_file, list_dir, refund through Composio', 517, 1280)
  expect(long.rows).toBe(1)
  expect(long.heights).toEqual([44])
  expect(long.label.shown).toBe(32)
  expect(long.label.wanted).toBeGreaterThan(32)
  expect(long.label.clamp).toBe('2')
  expect(long.overflow).toBe(0)
})

it.skipIf(!browser)('gives each decision the card line when the row cannot hold them', async () => {
  // A 420px window: the card is 275px of row, so the three stack and each takes the full width.
  const narrow = await room('Approve and always allow', 275, 420)
  expect(narrow.direction).toBe('column')
  expect(narrow.rows).toBe(3)
  expect(narrow.buttons.map((b) => b.width)).toEqual([275, 275, 275])
})
