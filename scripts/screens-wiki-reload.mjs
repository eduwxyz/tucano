// The wiki map after a reload of the renderer, and after the window takes a size other than the one
// it mounted at. Both used to be able to leave the map undrawn: the first frames had no camera at
// all, and a camera fitted for the old box was never fitted again, so the whole wiki sat small in a
// corner. Prints the frames from the click and the camera before and after a resize, with pictures.
//
//   node scripts/screens-wiki-reload.mjs <out dir> [a wiki folder to read]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2]
const wiki = process.argv[3]
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, ...(wiki ? { TUCANO_WIKI: wiki } : {}), TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
})
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
await win.waitForSelector('.sidebar')

const read = () =>
  win.evaluate(() => {
    const cv = document.querySelector('.wk-canvas')
    const svg = cv?.querySelector(':scope > svg')
    const r = cv?.getBoundingClientRect()
    const dots = [...(cv?.querySelectorAll('.wk-node') ?? [])]
    const inside = dots.filter((n) => {
      const b = n.getBoundingClientRect()
      return r && b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom
    }).length
    return {
      canvas: r ? [Math.round(r.width), Math.round(r.height)] : null,
      svg: svg ? [svg.getAttribute('width'), svg.getAttribute('height')] : null,
      nodes: dots.length,
      inside,
      animatedNodes: dots.filter((n) => getComputedStyle(n).animationName !== 'none').length,
      mapFade: svg ? getComputedStyle(svg).animationName : null,
      k: cv?.style.backgroundSize ?? null
    }
  })

// The map mounted at one size, then the window handed a different one, the way a restart restores
// its bounds after the screen has already drawn.
await win.setViewportSize({ width: 1100, height: 700 })
await win.waitForTimeout(400)
await win.click('.nav-item:has-text("Wiki")')
await win.waitForTimeout(1200)
console.log('mounted at 1100x700:', JSON.stringify(await read()))
await win.screenshot({ path: join(out, '01-mount.png') })

await win.setViewportSize({ width: 2560, height: 1400 })
await win.waitForTimeout(1200)
console.log('grown to 2560x1400:', JSON.stringify(await read()))
await win.screenshot({ path: join(out, '02-grown.png') })

// The map's first frames after a reload: the canvas and its nodes have to arrive together.
await win.reload()
await win.waitForSelector('.sidebar')
await win.setViewportSize({ width: 1440, height: 900 })
const frames = await win.evaluate(async () => {
  const nav = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent?.trim() === 'Wiki')
  const seen = []
  nav?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const cv = document.querySelector('.wk-canvas')
    const svg = cv?.querySelector(':scope > svg')
    seen.push({
      t: Math.round(performance.now()),
      canvas: cv ? [Math.round(cv.getBoundingClientRect().width), Math.round(cv.getBoundingClientRect().height)] : null,
      svg: svg ? [svg.getAttribute('width'), svg.getAttribute('height')] : null,
      nodes: cv?.querySelectorAll('.wk-node').length ?? 0
    })
  }
  return seen
})
console.log('frames from the click after a reload:')
for (const f of frames) console.log(` ${f.t}ms  canvas=${JSON.stringify(f.canvas)} svg=${JSON.stringify(f.svg)} nodes=${f.nodes}`)
await win.screenshot({ path: join(out, '03-after-reload.png') })

// A page open: the map follows it, and the panel reads.
await win.locator('.wk-node:not([data-missing])').first().click({ force: true })
await win.waitForTimeout(900)
console.log('a page open:', JSON.stringify({ ...(await read()), page: await win.locator('.wk-page__title').textContent().catch(() => null) }))
await win.screenshot({ path: join(out, '04-a-page-open.png') })

console.log('page errors:', errors.slice(0, 5))
await app.close()
