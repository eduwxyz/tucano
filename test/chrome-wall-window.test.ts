import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROME, ChromeBrowsers, hasChrome } from '../src/core/chrome'
import { readWall, windowGetsPast } from '../src/shared/wall'

// The lane's switch to a window, on a real Chrome that never draws one: this stands in for the browser,
// keeps it headless with a user agent of its own, and writes down each launch. So nothing appears on the
// screen of whoever runs the tests, and nothing is written to their keychain.
const WINDOW_UA = 'a-real-window'
const stand_in = (log: string, refuse: string): string => `#!/bin/sh
echo "$$ $*" >> '${log}'
n=$#; win=0
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  case "$a" in
    --new-window) win=1 ;;
    --window-position=*) ;;
    *) set -- "$@" "$a" ;;
  esac
done
if [ "$win" = 1 ]; then
  [ -e '${refuse}' ] && exit 1
  set -- "$@" --headless=new --user-agent=${WINDOW_UA}
fi
exec '${CHROME}' --use-mock-keychain "$@"
`

const WALL = '<!doctype html><title>Just a moment...</title><p>Performing security verification</p>'
const SITE = '<!doctype html><title>the site</title><p>The whole page, as a real browser gets it.</p>'
const dead = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}
const until = async (ok: () => boolean, ms = 20_000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end && !ok()) await new Promise((r) => setTimeout(r, 50))
  return ok()
}

describe.skipIf(process.platform === 'win32' || !hasChrome())('a lane switching to a window for a wall', () => {
  let server: Server
  let url = ''
  let root = ''
  let log = ''
  let refuse = ''
  let bin = ''
  let realHits = 0
  let cookieInWindow = false
  const shown: string[] = []
  const lanes: ChromeBrowsers[] = []

  const launches = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
  const windows = (lane: string): string[] => launches().filter((l) => l.includes('--new-window') && l.includes(join(root, lane)))
  const pids = (lane: string): number[] => launches().filter((l) => l.includes(join(root, lane))).map((l) => Number(l.split(' ')[0]))
  const browsers = (dir: string, wallWindows = true): ChromeBrowsers => {
    const b = new ChromeBrowsers(join(root, dir), (id, s) => shown.push(`${id}:${s}`), bin, undefined, false, undefined, undefined, undefined, undefined, wallWindows)
    lanes.push(b)
    return b
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'tucano-wall-window-'))
    log = join(root, 'launches.log')
    refuse = join(root, 'refuse-window')
    bin = join(root, 'chrome-stand-in')
    writeFileSync(bin, stand_in(log, refuse))
    chmodSync(bin, 0o755)
    server = createServer((req, res) => {
      if (req.url !== '/') return void res.writeHead(404).end()
      if (req.headers['user-agent']?.includes(WINDOW_UA)) {
        realHits++
        cookieInWindow = cookieInWindow || !!req.headers.cookie?.includes('login=kept')
        return void res.writeHead(200, { 'content-type': 'text/html' }).end(SITE)
      }
      // A cookie that outlives the browser, the way a login does.
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'login=kept; Path=/; Max-Age=3600' }).end(WALL)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })

  afterAll(async () => {
    for (const b of lanes) b.quit()
    await new Promise((r) => server.close(r))
    await new Promise((r) => setTimeout(r, 300))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })


  // On a Mac the window comes to the front and takes the focus, so a wall opens none there by itself.
  it('opens no window for a wall where windows are off, and the lane stays as it was', async () => {
    const lane = browsers('no-wall-windows', false)
    await lane.run('a', 'open', { url })
    expect((await lane.run('a', 'headful')).headful).toBe(false)
    expect(windows('no-wall-windows')).toEqual([])
    expect(lane.running('a')).toBe(true)
    await lane.run('a', 'close')
  }, 120_000)

  it('keeps the agent driving, keeps the login, comes into view without a reload, and never asks twice', async () => {
    const b = browsers('one')
    await b.run('a', 'open', { url })
    const wall = await b.run('a', 'snapshot')
    expect(windowGetsPast(readWall(wall.signs, wall))).toBe(true)

    expect((await b.run('a', 'headful')).headful).toBe(true)
    expect(windows('one/a')).toHaveLength(1)
    expect(windows('one/a')[0]).toContain('--window-position=-24000,-24000')
    const page = await b.run('a', 'snapshot')
    expect(page.title).toBe('the site')
    expect(page.headful).toBe(true)
    expect(cookieInWindow).toBe(true)
    // Not a takeover: told it was shown, the agent would be refused its next action.
    expect(page.shown).toBe(false)
    expect((await b.run('a', 'frame')).shown).toBe(false)
    expect(shown).not.toContain('a:true')

    const hits = realHits
    expect((await b.run('a', 'show')).shown).toBe(true)
    expect(shown).toContain('a:true')
    expect((await b.run('a', 'snapshot')).shown).toBe(true)
    expect(realHits).toBe(hits)
    expect(windows('one/a')).toHaveLength(1)

    await b.run('a', 'hide')
    const back = await b.run('a', 'snapshot')
    expect(back.title).toMatch(/moment/)
    expect(back.headful).toBeUndefined()
    expect((await b.run('a', 'headful')).headful).toBe(false)
    expect(windows('one/a')).toHaveLength(1)
    await b.run('a', 'close')
    expect(await until(() => pids('one/a').every(dead))).toBe(true)
  }, 120_000)

  it('opens one window for calls that meet the wall together, and they all get an answer', async () => {
    const b = browsers('two')
    await b.run('b', 'open', { url })
    const [first, second, page] = await Promise.all([b.run('b', 'headful'), b.run('b', 'headful'), b.run('b', 'snapshot')])
    expect(first.headful).toBe(true)
    expect(second.headful).toBe(true)
    expect(page.title).toBe('the site')
    expect(windows('two/b')).toHaveLength(1)
    expect(pids('two/b').filter((p) => !dead(p))).toHaveLength(1)
    await b.run('b', 'close')
    expect(await until(() => pids('two/b').every(dead))).toBe(true)
  }, 120_000)

  it('leaves no Chrome behind when the lane closes during the switch', async () => {
    const b = browsers('three')
    await b.run('c', 'open', { url })
    const switching = b.run('c', 'headful')
    await b.run('c', 'close')
    await switching
    expect(b.running('c')).toBe(false)
    expect(await until(() => pids('three/c').every(dead))).toBe(true)
  }, 120_000)

  it('leaves no Chrome behind when the app quits during the switch', async () => {
    const b = browsers('four')
    await b.run('d', 'open', { url })
    const switching = b.run('d', 'headful')
    expect(await until(() => windows('four/d').length === 1)).toBe(true)
    b.quit()
    expect((await switching).headful).toBe(false)
    expect(await until(() => pids('four/d').every(dead))).toBe(true)
    expect(launches().filter((l) => l.includes(join(root, 'four/d')))).toHaveLength(2) // nothing opened after it
  }, 120_000)

  it('stays headless on the same page when a window will not open', async () => {
    const b = browsers('five')
    await b.run('e', 'open', { url })
    writeFileSync(refuse, '')
    try {
      expect((await b.run('e', 'headful')).headful).toBe(false)
    } finally {
      rmSync(refuse, { force: true })
    }
    const page = await b.run('e', 'snapshot')
    expect(page.url).toBe(url)
    expect(page.title).toMatch(/moment/)
    expect(page.shown).toBe(false)
    expect((await b.run('e', 'headful')).headful).toBe(false) // already tried: no second go
    await b.run('e', 'close')
    expect(await until(() => pids('five/e').every(dead))).toBe(true)
  }, 120_000)
})
