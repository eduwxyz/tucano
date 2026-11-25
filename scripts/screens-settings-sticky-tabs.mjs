// Demo: Settings group tabs and subject jumps stay pinned while scrolling.
// Usage: node scripts/screens-settings-sticky-tabs.mjs <out-dir>
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const out = process.argv[2]
if (!out) throw new Error('usage: node scripts/screens-settings-sticky-tabs.mjs <out-dir>')
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-settings-sticky-'))
const videoDir = join(out, 'video')
mkdirSync(videoDir, { recursive: true })

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' },
  recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 720 })
await win.waitForSelector('.sidebar', { timeout: 60_000 })
await win.waitForTimeout(1200)

// Open Settings through the sidebar gear.
const gear = win.locator('.sidebar__gear, button[aria-label="Settings"], button[aria-label="Configurações"]').first()
await gear.waitFor({ state: 'visible', timeout: 30_000 })
await gear.click()
await win.waitForSelector('.settings-groups', { timeout: 30_000 })
await win.waitForTimeout(900)

// Pick a tab with enough content to scroll - Models has several sections.
const modelsTab = win.locator('.settings-groups__bar button', { hasText: /^Models$|^Modelos$/ }).first()
if (await modelsTab.count()) {
  await modelsTab.click()
  await win.waitForTimeout(700)
}

const scroller = win.locator('.page__scroll').last()
await scroller.waitFor({ state: 'visible', timeout: 10_000 })
await win.screenshot({ path: join(out, 'settings-top.png') })

// Slow scroll down to show both rows staying pinned.
for (let i = 0; i < 6; i++) {
  await scroller.evaluate((el) => { el.scrollBy({ top: 320, behavior: 'smooth' }) })
  await win.waitForTimeout(650)
}
await win.waitForTimeout(800)
await win.screenshot({ path: join(out, 'settings-scrolled.png') })

// Scroll back up a bit.
for (let i = 0; i < 3; i++) {
  await scroller.evaluate((el) => { el.scrollBy({ top: -320, behavior: 'smooth' }) })
  await win.waitForTimeout(550)
}
await win.waitForTimeout(600)

// Jump to a subject via the jumps row to show it still works while sticky.
const jump = win.locator('.settings-jumps a').nth(2)
if (await jump.count()) {
  await jump.click()
  await win.waitForTimeout(1200)
}

await win.waitForTimeout(800)
await app.close()

// Find the recorded video and move it to a stable name.
const videos = readdirSync(videoDir).filter((f) => f.endsWith('.webm') || f.endsWith('.mp4'))
if (videos.length === 0) throw new Error('no video recorded in ' + videoDir)
const src = join(videoDir, videos[videos.length - 1])
const webm = join(out, 'settings-sticky-tabs.webm')
renameSync(src, webm)
console.log('video:', webm)

// Try to make a GIF with ffmpeg if available.
const gif = join(out, 'settings-sticky-tabs.gif')
const palette = join(out, 'palette.png')
const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
if (ff.status === 0) {
  const p1 = spawnSync('ffmpeg', ['-y', '-i', webm, '-vf', 'fps=15,scale=1280:-1:flags=lanczos,palettegen', palette], { encoding: 'utf8' })
  const p2 = spawnSync('ffmpeg', ['-y', '-i', webm, '-i', palette, '-lavfi', 'fps=15,scale=1280:-1:flags=lanczos[x];[x][palette]paletteuse', gif], { encoding: 'utf8' })
  if (p1.status === 0 && p2.status === 0 && existsSync(gif)) console.log('gif:', gif)
  else console.log('gif: failed', p1.stderr?.slice(-200), p2.stderr?.slice(-200))
} else {
  console.log('gif: ffmpeg not found')
}
