import { generateKeyPairSync, createHash, createSign } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { ADD_ONS, AddOns, CFT_INDEX, crxUrl, crxZip, cftPlatform, verifiedCrxZip } from '../src/core/chrome-addons'
import { extractZip, zipFromBuffer } from '../src/core/zip'
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
  routes[CFT_INDEX] = JSON.stringify({ channels: { Stable: { version: '158.0.8127.36', downloads: { chrome: [{ platform, url: `https://storage.googleapis.com/chrome-for-testing-public/${platform}.zip` }] } } } })
  routes[`https://storage.googleapis.com/chrome-for-testing-public/${platform}.zip`] = await zipOf(Object.fromEntries(browser.map((f) => [f, 'MZ not really a browser'])))
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

// A real CRX3, signed the way the store's are: the id is the key's, and the proof covers the zip.
const varint = (n: number): Buffer => {
  const out: number[] = []
  while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128) }
  out.push(n)
  return Buffer.from(out)
}
const field = (no: number, body: Buffer): Buffer => Buffer.concat([varint(no * 8 + 2), varint(body.length), body])
const signedCrx = (zip: Buffer, claimedId?: Buffer): { crx: Buffer; id: string } => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const key = publicKey.export({ type: 'spki', format: 'der' })
  const raw = createHash('sha256').update(key).digest().subarray(0, 16)
  const id = [...raw].map((x) => String.fromCharCode(97 + (x >> 4), 97 + (x & 15))).join('')
  const signedData = field(1, claimedId ?? raw)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedData.length)
  const signature = createSign('sha256').update('CRX3 SignedData\0').update(size).update(signedData).update(zip).sign(privateKey)
  const header = Buffer.concat([field(2, Buffer.concat([field(1, key), field(2, signature)])), field(10000, signedData)])
  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'latin1')
  head.writeUInt32LE(3, 4)
  head.writeUInt32LE(header.length, 8)
  return { crx: Buffer.concat([head, header, zip]), id }
}

describe('an extension is the one its id names', () => {
  it('takes a file signed by the key its id comes from', async () => {
    const inner = await zipOf({ 'manifest.json': manifest('x') })
    const { crx, id } = signedCrx(inner)
    expect(verifiedCrxZip(crx, id).equals(inner)).toBe(true)
  })

  it('refuses a changed file, another extension, a borrowed id and an unsigned file', async () => {
    const inner = await zipOf({ 'manifest.json': manifest('x') })
    const { crx, id } = signedCrx(inner)
    const tampered = Buffer.from(crx)
    tampered[tampered.length - 30] = tampered[tampered.length - 30]! ^ 0xff
    expect(() => verifiedCrxZip(tampered, id)).toThrow(/signature doesn't match/)
    expect(() => verifiedCrxZip(crx, 'a'.repeat(32))).toThrow(/signature doesn't match/)
    const victim = Buffer.alloc(16, 3)
    const borrowed = signedCrx(inner, victim)
    expect(() => verifiedCrxZip(borrowed.crx, 'd'.repeat(32))).toThrow(/signature doesn't match/)
    expect(() => verifiedCrxZip(crxOf(inner), id)).toThrow(/signature doesn't match/)
  })

  it('leaves nothing on disk when the store hands over a file that fails the check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    const addOns = new AddOns(dir, () => {}, serve(routes), 'win32', 'x64') // the real check
    await addOns.set({ ads: true })
    expect(addOns.info?.extensions.ads?.state).toBe('failed')
    expect(addOns.info?.extensions.ads?.error).toMatch(/signature doesn't match/)
    expect(addOns.dirs).toEqual([])
    expect(existsSync(join(dir, 'extensions', ADD_ONS[0]!.id))).toBe(false)
  })
})

describe('where the browser may come from', () => {
  it('refuses an index that points anywhere but Google’s Chrome for Testing downloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    routes[CFT_INDEX] = JSON.stringify({ channels: { Stable: { version: '1', downloads: { chrome: [{ platform: 'win64', url: 'https://evil.example/chrome-win64.zip' }] } } } })
    const asked: string[] = []
    const counting = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return (serve(routes) as unknown as (u: string) => Promise<Response>)(String(url))
    }) as unknown as typeof fetch
    const addOns = new AddOns(dir, () => {}, counting, 'win32', 'x64', crxZip)
    await addOns.set({ ads: true })
    expect(addOns.bin).toBe('')
    expect(addOns.info?.browser.error).toMatch(/isn't Google's/)
    expect(asked.some((u) => u.includes('evil.example'))).toBe(false)
  })
})

// A zip entry as a Unix tool writes it: the mode in the high half of the external attributes.
const unixZip = async (files: { name: string; body: string; mode: number }[]): Promise<Buffer> => {
  const z = new JSZip()
  for (const f of files) z.file(f.name, f.body, { unixPermissions: f.mode })
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
}

describe.skipIf(process.platform === 'win32')('a browser unpacked on Mac and Linux', () => {
  const caps = { file: 1024 * 1024, total: 1024 * 1024 }

  it('keeps its helpers runnable and its framework links as links', async () => {
    const to = mkdtempSync(join(tmpdir(), 'unzip-'))
    const buf = await unixZip([
      { name: 'App/Versions/1/Helper', body: '#!/bin/sh', mode: 0o100755 },
      { name: 'App/Versions/1/data.pak', body: 'data', mode: 0o100644 },
      { name: 'App/Versions/Current', body: '1', mode: 0o120755 }
    ])
    extractZip(zipFromBuffer(buf), to, caps, { unix: true })
    expect(statSync(join(to, 'App/Versions/1/Helper')).mode & 0o111).not.toBe(0)
    expect(statSync(join(to, 'App/Versions/1/data.pak')).mode & 0o111).toBe(0)
    expect(lstatSync(join(to, 'App/Versions/Current')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(to, 'App/Versions/Current'))).toBe('1')
  })

  it('refuses a link out of the folder, and a file written through a link', async () => {
    for (const target of ['/etc', '../../outside', 'a/../../..']) {
      const to = mkdtempSync(join(tmpdir(), 'unzip-'))
      const buf = await unixZip([{ name: 'App/link', body: target, mode: 0o120755 }])
      expect(() => extractZip(zipFromBuffer(buf), to, caps, { unix: true }), target).toThrow(/link out of its folder/)
    }
    const to = mkdtempSync(join(tmpdir(), 'unzip-'))
    const through = await unixZip([
      { name: 'App/a/link', body: '..', mode: 0o120755 },
      { name: 'App/a/link/evil', body: 'x', mode: 0o100644 }
    ])
    expect(() => extractZip(zipFromBuffer(through), to, caps, { unix: true })).toThrow(/through a link/)
  })

  it('writes a link as a plain file everywhere else, so an imported vault gains no links', async () => {
    const to = mkdtempSync(join(tmpdir(), 'unzip-'))
    const buf = await unixZip([{ name: 'vault/note', body: '/etc/passwd', mode: 0o120755 }])
    extractZip(zipFromBuffer(buf), to, caps)
    expect(lstatSync(join(to, 'vault/note')).isSymbolicLink()).toBe(false)
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
  const all = { ads: true, cookies: true, consent: true, popups: true, clutter: true }

  it('unpacks the five extensions and the browser, and the second call fetches nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    const asked: string[] = []
    const counting = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return (serve(routes) as unknown as (u: string) => Promise<Response>)(String(url))
    }) as unknown as typeof fetch
    let changes = 0
    const addOns = new AddOns(dir, () => changes++, counting, 'win32', 'x64', crxZip)
    // Nothing is switched on: no download is anybody's idea of a good time, and no row to speak of.
    expect(addOns.ready).toBe(false)
    expect(addOns.info).toBeUndefined()
    await addOns.set(all)
    expect(addOns.ready).toBe(true)
    expect(addOns.info?.extensions.ads?.state).toBe('ready')
    expect(addOns.info?.extensions.cookies?.state).toBe('ready')
    expect(addOns.info?.extensions.consent?.state).toBe('ready')
    expect(addOns.info?.extensions.popups?.state).toBe('ready')
    expect(addOns.info?.extensions.clutter?.state).toBe('ready')
    expect(addOns.info?.browser.state).toBe('ready')
    // Five .crx from the store, the index, and the browser's own zip.
    expect(asked).toEqual([...ADD_ONS.map((e) => crxUrl(e.id)), CFT_INDEX, 'https://storage.googleapis.com/chrome-for-testing-public/win64.zip'])
    expect(changes).toBeGreaterThan(1)
    // Each one in its own folder, with the file Chrome reads at the top of it.
    expect(addOns.dirs).toHaveLength(5)
    for (const e of ADD_ONS) expect(existsSync(join(dir, 'extensions', e.id, 'manifest.json'))).toBe(true)
    // These fixtures are zip files with nothing of the vendor's code in them, so the set-up edits find no
    // file to change: each row says so, and the extension still arrives and still works as its store build.
    expect(addOns.info?.extensions.popups).toEqual({ state: 'ready', note: expect.stringContaining('background/background.js') })
    expect(addOns.info?.extensions.cookies).toEqual({ state: 'ready' }) // the one with no edits: no note
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
    }) as unknown as typeof fetch, 'win32', 'x64', crxZip)
    await offline.set(all)
    expect(offline.ready).toBe(true)
    expect(offline.dirs).toEqual(addOns.dirs)
    expect(offline.info?.browser.state).toBe('ready')
  })

  it('sets up a folder an older build unpacked, without asking the store for it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    const asked: string[] = []
    const counting = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return (serve(routes) as unknown as (u: string) => Promise<Response>)(String(url))
    }) as unknown as typeof fetch
    const addOns = new AddOns(dir, () => {}, counting, 'win32', 'x64', crxZip)
    await addOns.set({ cookies: true })
    const extension = ADD_ONS[1]!
    const folder = join(dir, 'extensions', extension.id)
    // What the build before this one left: the folder, no stamp, and the vendor's own line in it.
    rmSync(join(folder, '.tucano-tuned'), { force: true })
    asked.length = 0
    const next = new AddOns(dir, () => {}, counting, 'win32', 'x64', crxZip)
    await next.set({ cookies: true })
    expect(asked).toEqual([]) // no download: the files are already here
    expect(existsSync(join(folder, '.tucano-tuned'))).toBe(true)
    expect(next.ready).toBe(true)
  })

  it('is the install: switching one on downloads that one alone, switching it off takes its folder away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const asked: string[] = []
    const counting = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return (serve(await shelf()) as unknown as (u: string) => Promise<Response>)(String(url))
    }) as unknown as typeof fetch
    const addOns = new AddOns(dir, () => {}, counting, 'win32', 'x64', crxZip)
    const ads = ADD_ONS[0]!
    const consent = ADD_ONS[2]!

    // One switch on: the ad blocker and the browser it needs, and nothing of the other two.
    await addOns.set({ ads: true })
    expect(addOns.dirs).toEqual([join(dir, 'extensions', ads.id)])
    expect(asked).toEqual([crxUrl(ads.id), CFT_INDEX, 'https://storage.googleapis.com/chrome-for-testing-public/win64.zip'])
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
    const addOns = new AddOns(dir, () => {}, serve(await shelf()), 'win32', 'x64', crxZip)
    await addOns.set(true)
    expect(addOns.dirs).toHaveLength(3)
  })

  it('says which one failed, and keeps the ones that landed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    // The last extension's id is missing from the shelf: the store answers 404.
    delete routes[crxUrl(ADD_ONS[2]!.id)]
    const addOns = new AddOns(dir, () => {}, serve(routes), 'win32', 'x64', crxZip)
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
    }) as unknown as typeof fetch, 'win32', 'x64', crxZip)
    await retry.set(all)
    expect(retry.ready).toBe(true)
    expect(asked).toEqual([crxUrl(ADD_ONS[2]!.id)])
  })

  it('refuses a store file with no manifest in it, instead of leaving a folder Chrome can’t read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = index(await shelf())
    routes[crxUrl(ADD_ONS[1]!.id)] = crxOf(await zipOf({ 'readme.txt': 'not an extension' }))
    const addOns = new AddOns(dir, () => {}, serve(routes), 'win32', 'x64', crxZip)
    await addOns.set(all)
    expect(addOns.info?.extensions.cookies?.state).toBe('failed')
    expect(addOns.info?.extensions.cookies?.error).toMatch(/without the file Chrome reads/)
    expect(existsSync(join(dir, 'extensions', ADD_ONS[1]!.id))).toBe(false)
    expect(existsSync(join(dir, 'extensions', `${ADD_ONS[1]!.id}.part`))).toBe(false)
    expect(addOns.dirs).toHaveLength(4)
  })

  it('refuses a browser download with no program inside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const addOns = new AddOns(dir, () => {}, serve(await shelf(['chrome-win64/README.txt'])), 'win32', 'x64', crxZip)
    await addOns.set(all)
    expect(addOns.info?.browser.state).toBe('failed')
    expect(addOns.info?.browser.error).toMatch(/without the program inside/)
    expect(addOns.bin).toBe('')
    // The extensions landed and are ready: what is missing is the browser that could carry them.
    expect(addOns.dirs).toHaveLength(5)
    expect(addOns.ready).toBe(false)
  })

  it('leaves nothing half-written when the person switches it off mid-download', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'addons-'))
    const routes = await shelf()
    // The browser's zip arrives a byte at a time and never finishes on its own.
    const fast = serve(routes) as unknown as (u: string, init?: RequestInit) => Promise<Response>
    const slow = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== 'https://storage.googleapis.com/chrome-for-testing-public/win64.zip') return fast(String(url), init)
      const signal = init?.signal
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(64))
          signal?.addEventListener('abort', () => c.error(new Error('aborted')))
        }
      })
      return new Response(body)
    }) as unknown as typeof fetch
    const addOns = new AddOns(dir, () => {}, slow, 'win32', 'x64', crxZip)
    const p = addOns.set(all)
    await new Promise((r) => setTimeout(r, 150))
    expect(addOns.info?.browser.state).toBe('preparing')
    addOns.cancel()
    await p
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
    // What already arrived stays, so switching it on again is not from zero.
    expect(addOns.dirs).toHaveLength(5)
    expect(existsSync(join(dir, 'extensions', ADD_ONS[0]!.id, 'manifest.json'))).toBe(true)
  })
})
