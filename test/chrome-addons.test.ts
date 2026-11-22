import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { ADD_ONS, AddOns, CFT_INDEX, crxUrl, crxZip, cftPlatform } from '../src/core/chrome-addons'
import { addOnOn, addOnsOf } from '../src/shared/addons'

// The extension as a .zip, which is what the store hands out behind a .crx header.
const zipOf = async (files: Record<string, string>): Promise<Buffer> => {
  const z = new JSZip()
  for (const [name, body] of Object.entries(files)) z.file(name, body)
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer' }))
}

const manifest = (name: string, version = '1.2.3'): string => JSON.stringify({ manifest_version: 3, name, version })

// A .crx: "Cr24", the format's version, how long the header is, the header, then the .zip.
const crxOf = (zip: Buffer, version = 3, header = 16): Buffer => {
  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'latin1')
  head.writeUInt32LE(version, 4)
  head.writeUInt32LE(header, 8)
  return Buffer.concat([head, Buffer.alloc(header, 7), zip])
}

type Route = Buffer | string | Response | (() => Response)
const serve =
  (routes: Record<string, Route>) =>
  (async (url: string | URL | Request) => {
    const hit = routes[String(url)]
    if (hit === undefined) return new Response('not found', { status: 404 })
    if (hit instanceof Response) return hit
    if (typeof hit === 'function') return hit()
    return new Response(hit as string)
  }) as unknown as typeof fetch

// The three extensions from the store, and one browser zip, on a made-up address: the whole chain runs
// offline, in the same order the real one does.
const shelf = async (browser: string[] = ['chrome-win64/chrome.exe']): Promise<Record<string, Route>> => {
  const routes: Record<string, Route> = {}
  for (const e of ADD_ONS) routes[crxUrl(e.id)] = crxOf(await zipOf({ 'manifest.json': manifest(e.name), 'sw.js': '// nothing' }))
  const platform = 'win64'
  routes[CFT_INDEX] = JSON.stringify({ channels: { Stable: { version: '158.0.8127.36', downloads: { chrome: [{ platform, url: `https://example.test/${platform}.zip` }] } } } })
  routes[`https://example.test/${platform}.zip`] = await zipOf(Object.fromEntries(browser.map((f) => [f, 'MZ not really a browser'])))
  return routes
}

const index = (extra: Record<string, Route>): Record<string, Route> => extra

// Every message here is written in both languages; the English side is the one asserted, and asserting
// it is also what keeps it in the file.
beforeEach(() => setLang('en'))

describe('a .crx is the extension’s zip behind a header', () => {
  it('gives back the zip the header hides, and nothing else', async () => {
    const inner = await zipOf({ 'manifest.json': manifest('uBlock Origin Lite') })
    expect(crxZip(crxOf(inner)).equals(inner)).toBe(true)
    // Header lengths are read, not assumed: a 1 KB header still ends where it says.
    expect(crxZip(crxOf(inner, 3, 1024)).equals(inner)).toBe(true)
  })

  it('refuses a file that is not a .crx, and the old format', async () => {
    const inner = await zipOf({ 'manifest.json': manifest('x') })
    expect(() => crxZip(inner)).toThrow(/isn't a Chrome extension/)
    expect(() => crxZip(crxOf(inner, 2))).toThrow(/doesn't open \(CRX2\)/)
    expect(() => crxZip(Buffer.alloc(4))).toThrow(/isn't a Chrome extension/)
    // A header that claims to be longer than the file it is in: the zip can't start past the end.
    const lying = crxOf(inner)
    lying.writeUInt32LE(1000, 8)
    expect(() => crxZip(lying)).toThrow(/isn't a Chrome extension/)
  })
})

describe('which Chrome for Testing a computer takes', () => {
  it('names every system’s download', () => {
    expect(cftPlatform('win32', 'x64')).toBe('win64')
    expect(cftPlatform('win32', 'ia32')).toBe('win32')
    expect(cftPlatform('darwin', 'arm64')).toBe('mac-arm64')
    expect(cftPlatform('darwin', 'x64')).toBe('mac-x64')
    expect(cftPlatform('linux', 'x64')).toBe('linux64')
    expect(cftPlatform('linux', 'arm64')).toBe('linux-arm64')
  })
})

describe('installing them, one switch each', () => {
  const all = { ads: true, cookies: true, consent: true }

  it('unpacks the three extensions and the browser, and the second call fetches nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    const asked: string[] = []
    const counting = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return (serve(routes) as unknown as (u: string) => Promise<Response>)(String(url))
    }) as unknown as typeof fetch
    let changes = 0
    const addOns = new AddOns(dir, () => changes++, counting, 'win32', 'x64')
    // Nothing is switched on: no download is anybody's idea of a good time, and no row to speak of.
    expect(addOns.ready).toBe(false)
    expect(addOns.info).toBeUndefined()
    await addOns.set(all)
    expect(addOns.ready).toBe(true)
    expect(addOns.info?.extensions.ads?.state).toBe('ready')
    expect(addOns.info?.extensions.cookies?.state).toBe('ready')
    expect(addOns.info?.extensions.consent?.state).toBe('ready')
    expect(addOns.info?.browser.state).toBe('ready')
    // Three .crx from the store, the index, and the browser's own zip.
    expect(asked).toEqual([...ADD_ONS.map((e) => crxUrl(e.id)), CFT_INDEX, 'https://example.test/win64.zip'])
    expect(changes).toBeGreaterThan(1)
    // Each one in its own folder, with the file Chrome reads at the top of it.
    expect(addOns.dirs).toHaveLength(3)
    for (const e of ADD_ONS) expect(existsSync(join(dir, 'extensions', e.id, 'manifest.json'))).toBe(true)
    const read = JSON.parse(readFileSync(join(dir, 'extensions', ADD_ONS[0]!.id, 'manifest.json'), 'utf8')) as { name: string }
    expect(read.name).toBe(ADD_ONS[0]!.name)
    // The browser: the program inside the one folder it unpacks to, and the stamp that says so.
    expect(existsSync(addOns.bin)).toBe(true)
    expect(addOns.bin.endsWith(join('chrome-win64', 'chrome.exe'))).toBe(true)
    const stamp = JSON.parse(readFileSync(join(dir, 'chrome-for-testing.json'), 'utf8')) as { version: string; bin: string }
    expect(stamp.version).toBe('158.0.8127.36')
    expect(stamp.bin).toBe(addOns.bin)
    // Nothing of the download is left lying around.
    expect(readdirSync(dir).filter((f) => f.endsWith('.zip') || f.endsWith('.part'))).toEqual([])

    // A later start reads what is on disk and asks the network for nothing.
    const offline = new AddOns(dir, () => {}, (async () => {
      throw new Error('the network must not be asked')
    }) as unknown as typeof fetch, 'win32', 'x64')
    await offline.set(all)
    expect(offline.ready).toBe(true)
    expect(offline.dirs).toEqual(addOns.dirs)
    expect(offline.info?.browser.state).toBe('ready')
  })

  it('is the install: switching one on downloads that one alone, switching it off takes its folder away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const asked: string[] = []
    const counting = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return (serve(await shelf()) as unknown as (u: string) => Promise<Response>)(String(url))
    }) as unknown as typeof fetch
    const addOns = new AddOns(dir, () => {}, counting, 'win32', 'x64')
    const ads = ADD_ONS[0]!
    const consent = ADD_ONS[2]!

    // One switch on: the ad blocker and the browser it needs, and nothing of the other two.
    await addOns.set({ ads: true })
    expect(addOns.dirs).toEqual([join(dir, 'extensions', ads.id)])
    expect(asked).toEqual([crxUrl(ads.id), CFT_INDEX, 'https://example.test/win64.zip'])
    expect(existsSync(join(dir, 'extensions', consent.id))).toBe(false)

    // A second one on: only its own folder is fetched.
    asked.length = 0
    await addOns.set({ ads: true, consent: true })
    expect(asked).toEqual([crxUrl(consent.id)])
    expect(addOns.dirs).toHaveLength(2)

    // Off takes the folder away, and the lane stops carrying it: the switch is the removal.
    asked.length = 0
    await addOns.set({ consent: true })
    expect(existsSync(join(dir, 'extensions', ads.id))).toBe(false)
    expect(addOns.dirs).toEqual([join(dir, 'extensions', consent.id)])
    expect(asked).toEqual([])
    expect(addOns.info?.extensions.ads).toBeUndefined()

    // Off, a half-written folder of one that never finished leaves with it.
    const staging = join(dir, 'extensions', `${ads.id}.part`)
    await addOns.set({ ads: true, consent: true })
    mkdirSync(staging, { recursive: true })
    await addOns.set({ consent: true })
    expect(existsSync(staging)).toBe(false)

    // All of them off: nothing to download, nothing to carry, and no line to show.
    await addOns.set({})
    expect(addOns.dirs).toEqual([])
    expect(addOns.info).toBeUndefined()
    // The browser stays where it is: it is the base the three share, not one of them.
    expect(existsSync(addOns.bin)).toBe(true)
  })

  it('still reads an older build’s single switch, where true meant all three', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    expect(addOnsOf(true)).toEqual({ ads: true, cookies: true, consent: true })
    expect(addOnsOf(false)).toEqual({})
    expect(addOnsOf(undefined)).toEqual({})
    expect(addOnsOf({ cookies: true })).toEqual({ cookies: true })
    expect(addOnOn(true, 'consent')).toBe(true)
    expect(addOnOn({ ads: true }, 'consent')).toBe(false)
    const addOns = new AddOns(dir, () => {}, serve(await shelf()), 'win32', 'x64')
    await addOns.set(true)
    expect(addOns.dirs).toHaveLength(3)
  })

  it('says which one failed, and keeps the ones that landed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    // The last extension's id is missing from the shelf: the store answers 404.
    delete routes[crxUrl(ADD_ONS[2]!.id)]
    const addOns = new AddOns(dir, () => {}, serve(routes), 'win32', 'x64')
    await addOns.set(all)
    expect(addOns.info?.extensions.consent?.state).toBe('failed')
    expect(addOns.info?.extensions.consent?.error).toMatch(/404/)
    expect(addOns.info?.extensions.ads?.state).toBe('ready')
    expect(addOns.ready).toBe(false)
    // The two that did arrive stay, and the browser still comes: the lane carries what it has.
    expect(existsSync(join(dir, 'extensions', ADD_ONS[0]!.id, 'manifest.json'))).toBe(true)
    expect(existsSync(addOns.bin)).toBe(true)

    // With the missing one back, the retry lands, and asks for it only.
    const asked: string[] = []
    const retry = new AddOns(dir, () => {}, (async (url: string | URL | Request) => {
      asked.push(String(url))
      return (serve(await shelf()) as unknown as (u: string) => Promise<Response>)(String(url))
    }) as unknown as typeof fetch, 'win32', 'x64')
    await retry.set(all)
    expect(retry.ready).toBe(true)
    expect(asked).toEqual([crxUrl(ADD_ONS[2]!.id)])
  })

  it('refuses a store file with no manifest in it, instead of leaving a folder Chrome can’t read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = index(await shelf())
    routes[crxUrl(ADD_ONS[1]!.id)] = crxOf(await zipOf({ 'readme.txt': 'not an extension' }))
    const addOns = new AddOns(dir, () => {}, serve(routes), 'win32', 'x64')
    await addOns.set(all)
    expect(addOns.info?.extensions.cookies?.state).toBe('failed')
    expect(addOns.info?.extensions.cookies?.error).toMatch(/without the file Chrome reads/)
    expect(existsSync(join(dir, 'extensions', ADD_ONS[1]!.id))).toBe(false)
    expect(existsSync(join(dir, 'extensions', `${ADD_ONS[1]!.id}.part`))).toBe(false)
    expect(addOns.dirs).toHaveLength(2)
  })

  it('refuses a browser download with no program inside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const addOns = new AddOns(dir, () => {}, serve(await shelf(['chrome-win64/README.txt'])), 'win32', 'x64')
    await addOns.set(all)
    expect(addOns.info?.browser.state).toBe('failed')
    expect(addOns.info?.browser.error).toMatch(/without the program inside/)
    expect(addOns.bin).toBe('')
    // The extensions landed and are ready: what is missing is the browser that could carry them.
    expect(addOns.dirs).toHaveLength(3)
    expect(addOns.ready).toBe(false)
  })

  it('leaves nothing half-written when the person switches it off mid-download', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    // The browser's zip arrives a byte at a time and never finishes on its own.
    const fast = serve(routes) as unknown as (u: string, init?: RequestInit) => Promise<Response>
    const slow = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== 'https://example.test/win64.zip') return fast(String(url), init)
      const signal = init?.signal
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(64))
          signal?.addEventListener('abort', () => c.error(new Error('aborted')))
        }
      })
      return new Response(body)
    }) as unknown as typeof fetch
    const addOns = new AddOns(dir, () => {}, slow, 'win32', 'x64')
    const p = addOns.set(all)
    await new Promise((r) => setTimeout(r, 150))
    expect(addOns.info?.browser.state).toBe('preparing')
    addOns.cancel()
    await p
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
    // What already arrived stays, so switching it on again is not from zero.
    expect(addOns.dirs).toHaveLength(3)
    expect(existsSync(join(dir, 'extensions', ADD_ONS[0]!.id, 'manifest.json'))).toBe(true)
  })
})
