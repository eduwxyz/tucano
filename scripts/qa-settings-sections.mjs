// The settings section strip, measured in the built app: every tab's strip wraps instead of
// scrolling, every section it names has a card on the page, and a click parks that card 16 px under
// the strip with the section itself focused. Run after `npm run build`:
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
await win.waitForSelector('.settings-layout', { timeout: 20000 })
await win.waitForTimeout(600)

const failures = []
const measurements = []
const tabs = async () => win.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
  .filter(tab => tab.closest('.tabs') && !tab.closest('.tabs--sections'))
  .map(tab => tab.textContent.trim()))

for (const width of WIDTHS) {
  await win.setViewportSize({ width, height: 900 })
  await win.waitForTimeout(300)
  for (const name of await tabs()) {
    await win.getByRole('tab', { name, exact: true }).click()
    await win.waitForTimeout(250)
    const row = await win.evaluate(() => {
      const strip = document.querySelector('.settings-sections')
      const style = getComputedStyle(strip)
      return {
        links: [...strip.querySelectorAll('a')].map(link => link.getAttribute('href').replace('#settings-', '')),
        anchors: [...document.querySelectorAll('[data-settings-section]')].map(card => card.dataset.settingsSection),
        clientW: strip.clientWidth,
        scrollW: strip.scrollWidth,
        clientH: strip.clientHeight,
        scrollH: strip.scrollHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        position: style.position,
        hidden: [...strip.children].filter(child => child.offsetParent === null).length
      }
    })
    measurements.push({ width, tab: name, ...row, links: row.links.length, anchors: row.anchors.length })
    const label = `${width}px ${name}`
    if (row.scrollW > row.clientW) failures.push(`${label}: strip scrolls sideways (${row.scrollW} > ${row.clientW})`)
    if (row.scrollH > row.clientH + 1) failures.push(`${label}: strip scrolls down (${row.scrollH} > ${row.clientH})`)
    if (['auto', 'scroll'].includes(row.overflowX) || ['auto', 'scroll'].includes(row.overflowY)) failures.push(`${label}: overflow is ${row.overflowX}/${row.overflowY}`)
    if (row.position !== 'sticky') failures.push(`${label}: the strip is ${row.position}, not sticky`)
    if (row.hidden) failures.push(`${label}: ${row.hidden} of ${row.links.length} links are not painted`)
    if (row.links.join('|') !== row.anchors.join('|')) failures.push(`${label}: links ${row.links.join(',')} do not match the ${row.anchors.join(',')} cards`)
    if (await win.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) failures.push(`${label}: the page overflows sideways`)
    if (width === 1280 || width === 900) {
      await win.screenshot({ path: join(output, `${width}-${name.toLowerCase().replace(/[^a-z]+/g, '-')}.png`) })
    }
    if (width !== 1280) continue
    // Every link on every tab, at the width the app opens in: the card lands under the strip, or as
    // far as the pane goes when the card is the last one it can reach.
    for (const id of row.links) {
      await win.locator(`.settings-sections a[href="#settings-${id}"]`).click()
      await win.waitForFunction(target => {
        const card = document.getElementById(`settings-${target}`)
        const strip = document.querySelector('.settings-sections')
        if (!card || !strip) return false
        if (document.querySelector('.settings-layout')?.hasAttribute('data-settings-scrolling')) return false
        const scroller = document.querySelector('.page__scroll')
        const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2
        const offset = card.getBoundingClientRect().top - strip.getBoundingClientRect().bottom
        return Math.abs(offset - 16) < 3 || (atEnd && offset > 0)
      }, id, { timeout: 5000 })
      const state = await win.evaluate(target => ({
        active: document.activeElement.id,
        current: document.querySelector('.settings-sections [aria-current="location"]')?.getAttribute('href')?.replace('#settings-', ''),
        stripTop: document.querySelector('.settings-sections').getBoundingClientRect().top,
        tabsBottom: document.querySelector('.tabs:not(.tabs--sections)').getBoundingClientRect().bottom,
        target
      }), id)
      if (state.active !== `settings-${id}`) failures.push(`${name}: ${id} is not the focused section after its link (${state.active})`)
      if (state.current !== id) failures.push(`${name}: the strip names ${state.current} after ${id}`)
      if (Math.abs(state.stripTop - state.tabsBottom) > 2) failures.push(`${name}: the strip sits at ${state.stripTop.toFixed(1)} under tabs ending at ${state.tabsBottom.toFixed(1)}`)
    }
  }
}

await app.close()
console.log(JSON.stringify({ failures, measurements }, null, 2))
console.log(failures.length ? `\n${failures.length} settings strip problem(s)` : '\nthe settings strip holds at every tested width')
process.exit(failures.length ? 1 : 0)
