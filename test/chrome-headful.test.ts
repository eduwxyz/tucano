import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChromeBrowsers, hasChrome } from '../src/core/chrome'

// A page that says where its window is, and whether it still has the profile's cookie: a headless
// Chrome (--headless=new) reports screenX 0, and a real window reports a position outside the screen
// for a lane that opened one to get past a wall (chrome.ts). The cookie is what shows the window is
// the same browser, not a new one.
const PAGE = `<!doctype html><title>page</title>
<p>the site</p>
<script>document.title = 'x:' + screenX + '|c:' + document.cookie.includes('seen')</script>`

// A real window needs a screen. On a runner with none (ubuntu-latest, no Xvfb) Chrome exits before its
// first command, so these skip there the way the other Chrome tests skip where there is no Chrome. On a
// person's computer they would put windows in front of what they're doing, so they run in CI, or when
// asked with TUCANO_TEST_WINDOWS=1. test/chrome-wall-window.test.ts covers the lane without a window.
const screen = (): boolean => (process.platform !== 'linux' || !!process.env['DISPLAY']) && !!(process.env['CI'] || process.env['TUCANO_TEST_WINDOWS'])

// A site that only lets a real browser through: the lane goes to a window on the page it is on, once
// per site, and never again for that site — the loop this ends is 143 calls on one host (2026-11-22).
describe.skipIf(!hasChrome() || !screen())('a real window, for a site that only lets a real browser through', () => {
  let server: Server
  let url = ''
  let other = ''
  const shown: string[] = []
  let chrome: ChromeBrowsers

  beforeAll(async () => {
    server = createServer((_req, res) =>
      void res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'seen=1; Path=/' }).end(PAGE)
    )
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    url = base
    // The same server under another name: a site, for the once-per-site rule, is the host.
    other = base.replace('127.0.0.1', 'localhost') + 'other/'
    chrome = new ChromeBrowsers(mkdtempSync(join(tmpdir(), 'tucano-chrome-')), (id, s) => shown.push(`${id}:${s}`), undefined, undefined, false, undefined, undefined, true)
  })

  afterAll(async () => {
    await chrome.run('a', 'close').catch(() => {})
    await chrome.run('b', 'close').catch(() => {})
    await new Promise((r) => server.close(r))
  })

  // Where the window is, as the page sees it: headless is always 0. A real window is asked to sit at
  // -24000,-24000, which Windows clamps to the edge of the desktop and keeps off the screen. macOS
  // opens it on the screen and, moved, stops with 40 px still showing (measured 2026-11-22), so there
  // an agent's window can be in the way, and it is why this is read and not assumed.
  const where = (title: string): number => Number(/^x:(-?\d+)\|/.exec(title)?.[1] ?? '0')
  const outside = (title: string): boolean => where(title) < 0
  const offScreen = process.platform === 'win32'

  it('opens the page it is on in a window, keeps the profile, and says so', async () => {
    const headless = await chrome.run('a', 'open', { url })
    expect(headless.title).toBe('x:0|c:true')
    expect(outside(headless.title)).toBe(false)
    expect(headless.headful).toBeUndefined()

    const w = await chrome.run('a', 'headful')
    expect(w.headful).toBe(true)
    // The same address and the same cookie, now in a real window — off the screen on Windows, so it
    // never takes the focus from what I'm doing.
    const inWindow = await chrome.run('a', 'frame')
    if (offScreen) expect(outside(inWindow.title)).toBe(true)
    expect(inWindow.title).toContain('c:true')
    // Every answer from that lane says it is in a window, not only the one that opened it.
    const driving = await chrome.run('a', 'snapshot')
    expect(driving.headful).toBe(true)
    expect(driving.shown).toBe(false) // nobody took it over: the agent keeps driving

    // Asking to see it brings that same window into view, on the page it is on: an off-screen window
    // is no use, and a challenge half solved on it stays half solved. (The page's screenX does not
    // follow a window moved from outside on Windows, so that it is in view is read from the browser's
    // own window bounds, which the run of 2026-11-22 read back as 60,60 after the same call.)
    expect((await chrome.run('a', 'show')).shown).toBe(true)
    expect(shown).toContain('a:true')
    const took = await chrome.run('a', 'snapshot')
    expect(took.shown).toBe(true)
    expect(took.url).toBe(url)
    expect(took.title).toContain('c:true')
  }, 120_000)

  it('goes back to headless on its own, and does not try that site a second time', async () => {
    await chrome.run('b', 'open', { url })
    expect((await chrome.run('b', 'headful')).headful).toBe(true)

    await chrome.run('b', 'hide')
    const back = await chrome.run('b', 'frame')
    expect(where(back.title)).toBe(0) // headless again, same profile
    expect(back.title).toContain('c:true')
    expect(shown).toContain('b:false')

    // The site that was already tried is not asked about again in this lane: that retry is the loop.
    expect((await chrome.run('b', 'headful')).headful).toBe(false)
    // Another site is its own question: a different host, even on the same server.
    expect((await chrome.run('b', 'open', { url: other })).url).toBe(other)
    expect((await chrome.run('b', 'headful')).headful).toBe(true)
  }, 120_000)

  it('refuses where there is no screen for a window', async () => {
    const windowless = new ChromeBrowsers(mkdtempSync(join(tmpdir(), 'tucano-chrome-')), () => {}, undefined, undefined, true)
    try {
      await windowless.run('c', 'open', { url })
      expect((await windowless.run('c', 'headful')).headful).toBe(false)
      expect((await windowless.run('c', 'snapshot')).shown).toBe(false)
      expect(where((await windowless.run('c', 'frame')).title)).toBe(0)
    } finally {
      await windowless.run('c', 'close').catch(() => {})
    }
  }, 120_000)
})
