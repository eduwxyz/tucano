// Frames and measurements for the workspace-picture polish, shot in the built app with a throwaway
// data directory and fake engines. The noisy PNG is under the raw 4 MiB guard but too long as a
// 96 px data URL, so the picker has to retry smaller ceilings before it stores a picture.
//
//   npm run build && node scripts/screens-workspace-picture.mjs frames/avatar-polish
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const out = process.argv[2] ?? 'frames/avatar-polish'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-avatar-'))

// A deterministic noisy RGBA PNG. Random pixels do not compress at 96 px either, which is the point.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, body) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, tail])
}
const noisyPng = (width, height) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let seed = 0x2f6e2b1
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    for (let x = 0; x < width * 4; x++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      raw[row + 1 + x] = seed & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const bitmap = join(data, 'noisy.png')
writeFileSync(bitmap, noisyPng(512, 512))

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
})
const report = { data, bitmapBytes: readFileSync(bitmap).length, sizes: {} }
let win
try {
  win = await app.firstWindow()
  await win.waitForSelector('.sidebar', { timeout: 30_000 })
  report.window = await win.evaluate(() => ({ title: document.title, visibility: document.visibilityState, sidebar: !!document.querySelector('.sidebar'), width: innerWidth, height: innerHeight }))
  report.window.visible = await win.locator('.sidebar').isVisible()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  const shot = async (name) => {
    await win.waitForTimeout(250)
    await win.screenshot({ path: `${out}/${name}.png` })
  }
  const header = () => win.evaluate(() => {
    const button = document.querySelector('.workspace-picker__button')
    const logo = button?.querySelector('.workspace__logo')
    const name = button?.querySelector('.workspace__name')
    const img = logo?.querySelector('img')
    const box = logo?.getBoundingClientRect()
    return {
      exists: !!logo,
      box: box ? { width: Math.round(box.width), height: Math.round(box.height) } : null,
      beforeName: button && logo && name ? [...button.children].indexOf(logo) < [...button.children].indexOf(name) : null,
      img: !!img,
      naturalWidth: img?.naturalWidth ?? 0,
      naturalHeight: img?.naturalHeight ?? 0,
      srcChars: img?.getAttribute('src')?.length ?? 0,
      initial: img ? null : logo?.textContent ?? null
    }
  })
  const managerThumb = () => win.evaluate(() => {
    const tile = document.querySelector('.workspace-manager__pic')
    const img = tile?.querySelector('img')
    const box = tile?.getBoundingClientRect()
    return { exists: !!tile, box: box ? { width: Math.round(box.width), height: Math.round(box.height) } : null, img: !!img, naturalWidth: img?.naturalWidth ?? 0, srcChars: img?.getAttribute('src')?.length ?? 0 }
  })
  const modalPicture = () => win.evaluate(() => {
    const img = document.querySelector('.workspace-picture__placeholder img')
    return { img: !!img, naturalWidth: img?.naturalWidth ?? 0, srcChars: img?.getAttribute('src')?.length ?? 0, toasts: document.querySelectorAll('.toast').length }
  })
  const ensureNav = async () => {
    const nav = win.locator('.mobile-nav')
    if (await nav.count() && await nav.isVisible() && !(await win.locator('.app').getAttribute('class'))?.includes('is-nav-open')) {
      await nav.click()
      await win.waitForTimeout(400)
    }
  }
  const openManager = async () => {
    await ensureNav()
    await win.click('.workspace-picker__button')
    await win.locator('[role="menuitem"]', { hasText: 'Manage workspaces' }).click()
    await win.waitForSelector('.workspace-manager__list', { timeout: 10_000 })
    await win.waitForSelector('.workspace-manager__pic', { timeout: 10_000 })
  }
  const openPicture = async () => {
    await win.locator('.workspace-manager__pic').first().click()
    await win.waitForSelector('.modal__card.workspace-picture', { timeout: 10_000 })
  }
  const clearPicture = async () => {
    await openManager()
    await openPicture()
    const reset = win.locator('.workspace-picture__actions button', { hasText: 'Use the default' })
    if (await reset.count()) await reset.click()
    await win.locator('.modal__card.workspace-picture .modal__head button').click()
    await win.locator('.modal__card.workspace-manager .modal__head button.icon-btn').click()
    await win.waitForFunction(() => document.querySelectorAll('.toast').length === 0, undefined, { timeout: 20_000 })
  }

  for (const size of [{ width: 1440, height: 900 }, { width: 420, height: 900 }]) {
    const key = `${size.width}x${size.height}`
    await win.setViewportSize(size)
    await win.waitForTimeout(400)
    // Below 760 px the sidebar is a drawer; open it so the header is actually on screen.
    if (size.width <= 760) {
      await win.click('.mobile-nav')
      await win.waitForTimeout(400)
    }
    const shots = {}
    shots.viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await clearPicture()
    await ensureNav()
    shots.initial = await header()
    await shot(`01-initial-${key}`)

    await openManager()
    shots.managerEmpty = await managerThumb()
    await shot(`02-manager-empty-${key}`)

    await openPicture()
    await win.setInputFiles('.workspace-picture__file', bitmap)
    await win.waitForSelector('.workspace-picture__placeholder img', { timeout: 15_000 })
    await win.waitForTimeout(500)
    shots.resized = await modalPicture()
    await shot(`03-resized-${key}`)

    await win.locator('.modal__card.workspace-picture .modal__head button').click()
    await win.waitForSelector('.workspace-manager__pic img', { timeout: 10_000 })
    shots.managerPicture = await managerThumb()
    await shot(`04-manager-thumb-${key}`)

    await win.locator('.modal__card.workspace-manager .modal__head button.icon-btn').click()
    await ensureNav()
    await win.waitForTimeout(300)
    shots.headerPicture = await header()
    await shot(`05-header-thumb-${key}`)

    await openManager()
    await openPicture()
    await win.fill('.workspace-picture__url', 'http://127.0.0.1/mark.png')
    await win.locator('.workspace-picture__url-row button').click()
    await win.waitForSelector('.toast', { timeout: 10_000 })
    shots.rejected = await win.evaluate(() => ({ toasts: [...document.querySelectorAll('.toast__text')].map((t) => t.textContent), pictureStill: !!document.querySelector('.workspace-picture__placeholder img') }))
    await shot(`06-rejected-toast-${key}`)
    await win.locator('.modal__card.workspace-picture .modal__head button').click()
    await win.locator('.modal__card.workspace-manager .modal__head button.icon-btn').click()
    await win.waitForFunction(() => document.querySelectorAll('.toast').length === 0, undefined, { timeout: 20_000 })

    report.sizes[key] = shots
  }

  const saved = JSON.parse(readFileSync(join(data, 'workspaces.json'), 'utf8'))
  report.stored = { pictureChars: saved.workspaces[0]?.picture?.length ?? 0, prefix: saved.workspaces[0]?.picture?.slice(0, 22) ?? null }
  report.errors = errors
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app.close()
}
