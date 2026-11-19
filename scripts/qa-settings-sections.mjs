// The settings tab rows must never scroll: no horizontal scrollbar, no vertical one, and every
// section reachable without one. Run after `npm run build`:
//   node scripts/qa-settings-sections.mjs
// Before the wrap fix this failed at 1280 px: .settings-sections had scrollWidth 1039 against a
// clientWidth of 940, so the rail hid the last sections behind a scrollbar.
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WIDTHS = [1280, 1024, 900, 760]
const data = mkdtempSync(join(tmpdir(), 'tucano-qa-settings-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.waitForSelector('.sidebar')
await win.locator('.sidebar [aria-label="Settings"]').click()
await win.waitForSelector('.settings-layout', { timeout: 20000 })
await win.waitForTimeout(600)

let failures = 0
for (const width of WIDTHS) {
  await win.setViewportSize({ width, height: 900 })
  await win.waitForTimeout(400)
  const rows = await win.evaluate(() => {
    const read = (el) => {
      const style = getComputedStyle(el)
      return {
        cls: el.className,
        clientW: el.clientWidth, scrollW: el.scrollWidth,
        clientH: el.clientHeight, scrollH: el.scrollHeight,
        overflowX: style.overflowX, overflowY: style.overflowY,
        children: el.children.length,
        hidden: [...el.children].filter((c) => c.offsetParent === null).length,
      }
    }
    return [...document.querySelectorAll('.tabs, .settings-sections')].map(read)
  })
  for (const row of rows) {
    const problems = []
    if (row.scrollW > row.clientW) problems.push(`scrollWidth ${row.scrollW} > clientWidth ${row.clientW}`)
    if (row.scrollH > row.clientH + 1) problems.push(`scrollHeight ${row.scrollH} > clientHeight ${row.clientH}`)
    if (['auto', 'scroll'].includes(row.overflowX)) problems.push(`overflow-x is ${row.overflowX}`)
    if (['auto', 'scroll'].includes(row.overflowY)) problems.push(`overflow-y is ${row.overflowY}`)
    if (row.hidden) problems.push(`${row.hidden} of ${row.children} items not painted`)
    const label = `${width}px .${String(row.cls).split(' ')[0]}`
    if (problems.length) {
      failures += 1
      console.log(`FAIL ${label}: ${problems.join('; ')}`)
    } else {
      console.log(`ok   ${label}: ${row.scrollW}/${row.clientW} wide, ${row.scrollH}/${row.clientH} tall, ${row.children} items`)
    }
  }
}

await app.close()
console.log(failures ? `\n${failures} tab row(s) scroll` : '\nno tab row scrolls at any tested width')
process.exit(failures ? 1 : 0)
