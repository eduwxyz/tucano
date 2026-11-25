// The settings groups and jump row, measured in the built app: at every width the groups bar and the
// jump row fit without scrolling sideways, every subject the row names is on the page, and a click on
// a jump parks that subject 16 px under the groups bar with the subject itself focused. Run after
// `npm run build`:
//   node scripts/qa-settings-sections.mjs [output dir]
// A scratch data directory, seeded content and the fake engines keep the daily instance untouched.
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WIDTHS = [1280, 1024, 900, 760]
const output = process.argv[2] || join(tmpdir(), 'tucano-settings-sections')
mkdirSync(output, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-qa-settings-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
await win.waitForSelector('.sidebar')
await win.locator('.sidebar [aria-label="Settings"]').click()
await win.waitForSelector('.settings-groups__bar', { timeout: 20000 })
await win.waitForTimeout(600)

const failures = []
const measurements = []
const groups = await win.locator('.settings-groups__bar [role="tab"]').allTextContents()

for (const width of WIDTHS) {
  await win.setViewportSize({ width, height: 900 })
  for (const group of groups) {
    await win.locator('.settings-groups__bar [role="tab"]', { hasText: group }).click()
    await win.waitForTimeout(350)
    const state = await win.evaluate(() => {
      const scroller = document.querySelector('.page__scroll')
      const bar = document.querySelector('.settings-groups__bar')
      const jumps = document.querySelector('.settings-jumps')
      const links = [...document.querySelectorAll('.settings-jumps a')].map(link => link.getAttribute('href').slice(1))
      return {
        pageSideways: scroller.scrollWidth > scroller.clientWidth + 1,
        barSideways: bar.scrollWidth > bar.clientWidth + 1,
        jumpsSideways: jumps ? jumps.scrollWidth > jumps.clientWidth + 1 : false,
        links,
        missing: links.filter(id => !document.getElementById(id))
      }
    })
    if (state.pageSideways) failures.push(`${width} ${group}: the page scrolls sideways`)
    if (state.barSideways) failures.push(`${width} ${group}: the groups bar scrolls sideways`)
    if (state.jumpsSideways) failures.push(`${width} ${group}: the jump row scrolls sideways`)
    for (const id of state.missing) failures.push(`${width} ${group}: ${id} is named but not on the page`)
    if (width === WIDTHS[0]) {
      for (const id of state.links) {
        await win.locator(`.settings-jumps a[href="#${id}"]`).press('Enter')
        await win.waitForTimeout(120)
        const landed = await win.evaluate((target) => {
          const scroller = document.querySelector('.page__scroll')
          const subject = document.getElementById(target)
          const bar = document.querySelector('.settings-groups').getBoundingClientRect()
          const gap = subject.getBoundingClientRect().top - bar.bottom
          const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
          return { gap: Math.round(gap), atEnd, focused: document.activeElement === subject }
        }, id)
        if (!landed.focused) failures.push(`${group}: ${id} did not take the focus`)
        if (!landed.atEnd && Math.abs(landed.gap - 16) > 2) failures.push(`${group}: ${id} parked ${landed.gap}px under the groups, not 16`)
      }
    }
    measurements.push({ width, group, links: state.links.length })
    await win.screenshot({ path: join(output, `${width}-${group.toLowerCase()}.png`) })
  }
}

console.log(JSON.stringify({ measurements, failures }, null, 2))
await app.close()
if (failures.length) process.exitCode = 1
