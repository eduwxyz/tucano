// The agent's browser with an ad blocker and two cookie-notice removers in it, so the page it reads is the
// page: a consent wall over an article, or a banner that swallows the first screen, reads to an agent as
// "the site changed its interface", and it clicks the same place again (2026-11-22: one session spent
// 143 of its 248 browser calls on a single host that way).
//
// Each of the three has its own switch (Settings › Agents): on, it is downloaded and loaded into the next
// session's browser; off, its folder leaves the disk, which is how an extension is removed from a build
// that takes them from a folder rather than from the store.
//
// Chrome takes an extension only from a folder (--load-extension), and the branded build has ignored
// that flag since version 158 — measured on this machine: branded Chrome loaded its own three built-ins
// and nothing else, with --disable-features=DisableLoadExtensionCommandLineSwitch or without it, while
// Chrome for Testing 158.0.8127.36, the same version and the same engine, loaded all three add-ons as
// running MV3 service workers and they changed the page (theverge 22 → 2 ad requests, 12 blocked, the
// banner gone from the text). So a lane that carries them runs on Chrome for Testing.
//
// Both arrive from where the browser gets them: the .crx files from the Chrome Web Store's own update
// endpoint, which needs no login, and the browser from Google's Chrome-for-Testing build server. Once,
// into the app's data folder, stamped by what is on disk; nothing here is on the way of a reply, and the
// lane keeps working without any of it while the download runs or if it never lands.
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ADD_ONS, addOnsOf, type AddOnExtension } from '../shared/addons'
import { L } from '../shared/lang'
import type { AddOn, AddOnStep, AddOnsInfo, BrowserAddOns } from '../shared/types'
import { extractZip, zipFromBuffer, zipFromFile } from './zip'

// The three are declared once, in shared/addons.ts, with the name the settings page draws: what is
// installed and what a row says cannot drift apart.
export { ADD_ONS }

// The browser version the store is asked for. It only decides which build of the .crx comes back; an
// extension's own updates are its business, and the folder is fetched once and then left alone.
const STORE_VERSION = '158.0.0.0'
export const crxUrl = (id: string, version: string = STORE_VERSION): string =>
  `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${version}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`

// The stable Chrome for Testing of the day, with every platform's download in one small JSON.
export const CFT_INDEX = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'

// A .crx is the extension's own .zip behind a short header: "Cr24", the format's version (3), how long
// the header is, and the header itself — the signature and the key the store proved it with. The zip
// that matters to Chrome is everything after it.
export function crxZip(crx: Buffer): Buffer {
  const notAddOn = (): Error => new Error(L('O arquivo baixado não é uma extensão do Chrome.', "The downloaded file isn't a Chrome extension."))
  if (crx.length < 16 || crx.toString('latin1', 0, 4) !== 'Cr24') throw notAddOn()
  const version = crx.readUInt32LE(4)
  if (version !== 3) throw new Error(L(`A extensão veio num formato que o Tucano não abre (CRX${version}).`, `The extension came in a format Tucano doesn't open (CRX${version}).`))
  const header = crx.readUInt32LE(8)
  const start = 12 + header
  if (header < 1 || header > 1 << 20 || start >= crx.length) throw notAddOn()
  return crx.subarray(start)
}

// Chrome for Testing's name for this computer's download, as its index spells it.
export const cftPlatform = (os: NodeJS.Platform = process.platform, arch: string = process.arch): string => {
  if (os === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (os === 'win32') return arch === 'ia32' ? 'win32' : 'win64'
  return arch === 'arm64' ? 'linux-arm64' : 'linux64'
}

// Where the browser sits inside that download, after the one folder it unpacks to: chrome.exe on
// Windows, the plain program on Linux, the app bundle's own binary on a Mac.
const CFT_TAIL: Record<string, string[]> = {
  win32: ['chrome.exe'],
  win64: ['chrome.exe'],
  linux64: ['chrome'],
  'linux-arm64': ['chrome'],
  'mac-x64': ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  'mac-arm64': ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
}

const PART_TIMEOUT_MS = 10 * 60_000 // a download that stops moving for this long has failed

// Enough for the browser itself: its biggest file is a ~250 MB library, and the whole unzipped set is
// under 800 MB. The caps are what zip.ts checks before it inflates anything.
const CFT_CAPS = { file: 512 * 1024 * 1024, total: 3 * 1024 * 1024 * 1024 }

async function download(fetcher: typeof fetch, url: string, to: string, signal: AbortSignal, progress: (received: number, total: number) => void): Promise<void> {
  const part = `${to}.part`
  // Its own switch, so a download that stops moving can be given up on without cancelling whatever
  // asked for it: the person's off-switch aborts through the same one.
  const ctrl = new AbortController()
  const stop = (): void => ctrl.abort()
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop() // a switch turned off before this download started
  let stalled: ReturnType<typeof setTimeout> | undefined
  const bump = (): void => {
    clearTimeout(stalled)
    stalled = setTimeout(() => ctrl.abort(), PART_TIMEOUT_MS)
  }
  try {
    const res = await fetcher(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(L(`O download respondeu ${res.status}.`, `The download answered ${res.status}.`))
    const total = Number(res.headers.get('content-length')) || 0
    mkdirSync(dirname(to), { recursive: true })
    const out = createWriteStream(part)
    const reader = res.body.getReader()
    let received = 0
    let last = 0
    try {
      bump()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!out.write(value)) await new Promise((r) => out.once('drain', r))
        received += value.length
        if (Date.now() - last > 500) {
          last = Date.now()
          progress(received, total)
          bump()
        }
      }
      await new Promise<void>((r) => out.end(r))
    } catch (e) {
      out.destroy()
      rmSync(part, { force: true })
      throw signal.aborted ? e : new Error(L('O download parou no meio. Tentar de novo resolve.', 'The download stopped halfway. Trying again fixes it.'))
    }
    if (total && received !== total) {
      rmSync(part, { force: true })
      throw new Error(L('O download veio incompleto. Tentar de novo resolve.', 'The download came incomplete. Trying again fixes it.'))
    }
    renameSync(part, to)
  } finally {
    clearTimeout(stalled)
    signal.removeEventListener('abort', stop)
  }
}

// Each of the three in its own folder under extensions/, fetched from the store once and then left as it
// is: the stamp is the unpacked manifest itself, so a folder someone deleted comes back and one that is
// there is never asked for twice. The folder's presence is also the switch's answer: off means it leaves
// the disk, and a lane started afterwards does not carry it.
export class AddOns {
  bin = '' // Chrome for Testing, when it's here: the build that still takes a folder of extensions
  dirs: string[] = [] // the folders of the ones switched on and downloaded, in the store's own order
  private want: readonly AddOn[] = []
  private failed = new Map<AddOn, string>()
  private browserError = ''
  private progress?: { received: number; total: number }
  private running?: Promise<void>
  private abort?: AbortController
  private again = false

  constructor(
    private dir: string, // <dataDir>/navegador-extra
    private changed: () => void, // re-read the settings snapshot: each row shows where its own download is
    private fetcher: typeof fetch = fetch,
    private os: NodeJS.Platform = process.platform,
    private arch: string = process.arch
  ) {
    // What a previous run left is ready before anyone asks: no download on this start.
    this.bin = this.stamp()
  }

  // The switches as the settings say: what is on is downloaded, what is off leaves the disk (and so does a
  // half-written folder of it). A run already downloading for another set is given up on, and the set
  // that holds starts its own, so a switch turned on mid-download is not left waiting for the old one.
  set(next: BrowserAddOns | boolean | null | undefined): Promise<void> {
    const wanted = addOnsOf(next)
    const want = ADD_ONS.map((e) => e.key).filter((k) => !!wanted[k])
    const same = want.length === this.want.length && want.every((k) => this.want.includes(k))
    this.want = want
    for (const e of ADD_ONS) {
      if (want.includes(e.key)) continue
      rmSync(this.folder(e.id), { recursive: true, force: true })
      rmSync(`${this.folder(e.id)}.part`, { recursive: true, force: true })
      this.failed.delete(e.key)
    }
    this.pick()
    this.changed()
    if (this.running) {
      if (!same) {
        this.cancel()
        this.again = true
      }
      return this.running
    }
    return this.begin()
  }

  // Everything that is switched on is here, next to the browser that can load it.
  get ready(): boolean {
    return this.want.length > 0 && this.dirs.length === this.want.length && !!this.bin
  }

  // A switch went off while it was downloading: what landed stays on disk (it is the next switch-on's head
  // start), and a half-written file does not.
  cancel(): void {
    this.abort?.abort()
  }

  // What the settings page draws: nothing while all three are off (no switch was touched, so there is no
  // download to speak of), otherwise the browser the three share and each extension that is on.
  get info(): AddOnsInfo | undefined {
    if (!this.want.length) return undefined
    const extensions: Partial<Record<AddOn, AddOnStep>> = {}
    for (const e of ADD_ONS) {
      if (!this.want.includes(e.key)) continue
      const here = existsSync(join(this.folder(e.id), 'manifest.json'))
      const error = this.failed.get(e.key)
      extensions[e.key] = here ? { state: 'ready' } : error ? { state: 'failed', error } : { state: this.running ? 'preparing' : 'waiting' }
    }
    const browser: AddOnStep & { progress?: { received: number; total: number } } = this.bin
      ? { state: 'ready' }
      : this.browserError
        ? { state: 'failed', error: this.browserError }
        : { state: this.running ? 'preparing' : 'waiting', ...(this.running && this.progress ? { progress: this.progress } : {}) }
    return { browser, extensions }
  }

  private begin(): Promise<void> {
    if (this.running) return this.running
    if (!this.missing().length && (!this.want.length || this.bin)) return Promise.resolve()
    const run = this.downloadAll().finally(() => {
      this.running = undefined
      this.abort = undefined
      this.progress = undefined
      this.changed()
      if (this.again) {
        this.again = false
        void this.begin()
      }
    })
    this.running = run
    return run
  }

  private missing(): AddOnExtension[] {
    return ADD_ONS.filter((e) => this.want.includes(e.key) && !existsSync(join(this.folder(e.id), 'manifest.json')))
  }

  private pick(): void {
    this.dirs = ADD_ONS.filter((e) => this.want.includes(e.key)).map((e) => this.folder(e.id)).filter((d) => existsSync(join(d, 'manifest.json')))
    if (!this.bin) this.bin = this.stamp()
  }

  private async downloadAll(): Promise<void> {
    const abort = new AbortController()
    this.abort = abort
    this.browserError = ''
    for (const e of ADD_ONS) {
      if (!this.want.includes(e.key)) continue
      const folder = this.folder(e.id)
      if (existsSync(join(folder, 'manifest.json'))) {
        this.failed.delete(e.key)
        continue
      }
      try {
        await this.fetchExtension(e, folder, abort.signal)
        this.failed.delete(e.key)
        this.pick()
        this.changed()
      } catch (err) {
        // One of them failing is not the other two: each row carries its own reason, and the lane keeps
        // whatever arrived (wall.ts still names a bot check, and a missing extension is never a reason to
        // lose the browser an agent is using).
        if (abort.signal.aborted) return
        this.failed.set(e.key, err instanceof Error ? err.message : String(err))
        this.changed()
      }
    }
    if (this.want.length && !this.bin) {
      try {
        this.bin = await this.fetchBrowser(abort.signal)
      } catch (err) {
        if (!abort.signal.aborted) this.browserError = err instanceof Error ? err.message : String(err)
      }
    }
    this.pick()
  }

  private folder(id: string): string {
    return join(this.dir, 'extensions', id)
  }

  private async fetchExtension(e: AddOnExtension, folder: string, signal: AbortSignal): Promise<void> {
    const res = await this.fetcher(crxUrl(e.id), { signal, redirect: 'follow' })
    if (!res.ok) throw new Error(L(`A Chrome Web Store respondeu ${res.status} para ${e.name}.`, `The Chrome Web Store answered ${res.status} for ${e.name}.`))
    const zip = zipFromBuffer(crxZip(Buffer.from(await res.arrayBuffer())))
    const staging = `${folder}.part`
    rmSync(staging, { recursive: true, force: true })
    try {
      mkdirSync(staging, { recursive: true })
      try {
        extractZip(zip, staging, { file: 64 * 1024 * 1024, total: 256 * 1024 * 1024 })
      } finally {
        zip.close()
      }
      if (!existsSync(join(staging, 'manifest.json'))) throw new Error(L(`${e.name} veio sem o arquivo que o Chrome lê.`, `${e.name} came without the file Chrome reads.`))
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err
    }
    rmSync(folder, { recursive: true, force: true })
    renameSync(staging, folder)
  }
  // The browser Chrome for Testing last left in the data folder, if it is still there.
  private stamp(): string {
    try {
      const s = JSON.parse(readFileSync(join(this.dir, 'chrome-for-testing.json'), 'utf8')) as { bin?: string }
      if (s.bin && existsSync(s.bin)) return s.bin
    } catch {
      // no stamp, or one from a folder that's gone: the next download writes a new one
    }
    return ''
  }
  private async fetchBrowser(signal: AbortSignal): Promise<string> {
    const index = await this.fetcher(CFT_INDEX, { signal, redirect: 'follow' })
    if (!index.ok) throw new Error(L(`A lista do Chrome for Testing respondeu ${index.status}.`, `The Chrome for Testing list answered ${index.status}.`))
    const data = (await index.json()) as { channels?: Record<string, { version?: string; downloads?: Record<string, { platform: string; url: string }[]> }> }
    const stable = data.channels?.['Stable']
    const platform = cftPlatform(this.os, this.arch)
    const url = stable?.downloads?.['chrome']?.find((d) => d.platform === platform)?.url
    if (!url) throw new Error(L(`Não achei o Chrome for Testing para ${platform}.`, `I didn't find Chrome for Testing for ${platform}.`))
    const zipPath = join(this.dir, 'chrome-for-testing.zip')
    mkdirSync(this.dir, { recursive: true })
    await download(this.fetcher, url, zipPath, signal, (received, total) => {
      this.progress = { received, total }
      this.changed()
    })
    const into = join(this.dir, 'chrome-for-testing')
    rmSync(into, { recursive: true, force: true })
    mkdirSync(into, { recursive: true })
    const zip = zipFromFile(zipPath)
    let root = into
    try {
      root = extractZip(zip, into, CFT_CAPS)
    } finally {
      zip.close()
    }
    rmSync(zipPath, { force: true })
    const tail = CFT_TAIL[platform] ?? []
    const found = [join(root, ...tail), join(into, ...tail)].find((p) => existsSync(p))
    if (!found) throw new Error(L('O Chrome baixado veio sem o programa dentro.', 'The Chrome downloaded came without the program inside.'))
    if (this.os !== 'win32') chmodSync(found, 0o755) // a .zip keeps no permission bits: on a Mac and on Linux it must be runnable
    writeFileSync(join(this.dir, 'chrome-for-testing.json'), JSON.stringify({ version: stable?.version ?? '', bin: found, at: Date.now() }))
    return found
  }
}
