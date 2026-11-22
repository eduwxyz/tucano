// The agent's browser with an ad blocker and two cookie-notice removers in it, so the page it reads is the
// page: a consent wall over an article, or a banner that swallows the first screen, reads to an agent as
// "the site changed its interface", and it clicks the same place again (2026-11-22: one session spent
// 143 of its 248 browser calls on a single host that way).
//
// Each of them has its own switch (Settings › Agents): on, it is downloaded and loaded into the next
// session's browser; off, its folder leaves the disk, which is how an extension is removed from a build
// that takes them from a folder rather than from the store. An extension that arrives switched on is also
// set up the way an agent needs it rather than the way a person's browser is left (shared/addons.ts has
// the edits and why), in the folder itself, so it holds on every start and after any update of the store's
// own build.
//
// Chrome takes an extension only from a folder (--load-extension), and the branded build has ignored
// that flag since version 158 — measured on this machine: branded Chrome loaded its own three built-ins
// and nothing else, with --disable-features=DisableLoadExtensionCommandLineSwitch or without it, while
// Chrome for Testing 158.0.8127.36, the same version and the same engine, loaded all three add-ons as
// running MV3 service workers and they changed the page (theverge 22 → 2 ad requests, 12 blocked, the
// banner gone from the text). So a lane that carries them runs on Chrome for Testing.
//
// Both arrive from where the browser gets them: the .crx files from the Chrome Web Store, which needs no
// login, and the browser from Google's Chrome-for-Testing build server. Each is the exact version and hash
// in chrome-addon-pins.ts, and anything else is refused. Once, into the app's data folder, stamped by the
// pin it was installed for; nothing here is on the way of a reply, and the lane keeps working without any
// of it while the download runs or if it never lands.
import { createHash, createVerify } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ADD_ONS, TUNE, TUNE_REVISION, addOnsOf, type AddOnExtension } from '../shared/addons'
import { L } from '../shared/lang'
import type { AddOn, AddOnStep, AddOnsInfo, BrowserAddOns } from '../shared/types'
import { ADD_ON_PINS, type AddOnPins } from './chrome-addon-pins'
import { extractZip, zipFromBuffer, zipFromFile } from './zip'

// The three are declared once, in shared/addons.ts, with the name the settings page draws: what is
// installed and what a row says cannot drift apart.
export { ADD_ONS }

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

// The one file a folder is stamped with: which pin it was installed for. A folder from another version, or
// from a build that didn't check, has no matching stamp, so it is fetched again and never loaded as it is.
const PIN_FILE = 'tucano-pin.txt'

// Consent-O-Matic reads its rules from its repository's `master` each day, and the list there names more
// files on `master`: rules that change what it clicks, from outside any version. Its one setting for this
// is `ruleLists`, whose default is this address. So its rules are taken once from a fixed commit, merged
// the way the extension merges them, checked against the pin and installed next to it, and that default
// points at the installed file: it never asks GitHub for anything.
const RULES_REPO = 'https://raw.githubusercontent.com/cavi-au/Consent-O-Matic/'
const RULES_LIST = `${RULES_REPO}master/rules-list.json`
const RULES_DEFAULT = /\b[\w$]+\.defaultRuleLists=\["https:\/\/raw\.githubusercontent\.com\/cavi-au\/Consent-O-Matic\/master\/rules-list\.json"\]/g
const RULES_SCRIPTS = ['service.js', 'content.js', 'ui.js']
const RULE_REFERENCE = /^https:\/\/raw\.githubusercontent\.com\/cavi-au\/Consent-O-Matic\/master\/(rules\/[A-Za-z0-9._-]+\.json)$/
const MAX_RULE_BYTES = 2 * 1024 * 1024
const RULE_FETCHES = 8
const rulesName = (commit: string): string => `tucano-rules-${commit.slice(0, 12)}.json`

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

// The fields of a protobuf message, by number. A CRX header has only length-delimited ones, so any other
// kind means it isn't one.
function protoFields(b: Buffer): Map<number, Buffer[]> {
  const out = new Map<number, Buffer[]>()
  let p = 0
  const varint = (): number => {
    let value = 0
    for (let i = 0, unit = 1; i < 5; i++, unit *= 128) {
      if (p >= b.length) throw new Error('truncated')
      const byte = b[p++]!
      value += (byte & 127) * unit
      if (byte < 128) return value
    }
    throw new Error('varint too long')
  }
  while (p < b.length) {
    const key = varint()
    if (key % 8 !== 2) throw new Error('unexpected field')
    const length = varint()
    if (p + length > b.length) throw new Error('truncated')
    const field = Math.floor(key / 8)
    out.set(field, [...(out.get(field) ?? []), b.subarray(p, p + length)])
    p += length
  }
  return out
}

// An extension's id is the first 16 bytes of its key's SHA-256, written with the letters a to p.
const idOfBytes = (bytes: Buffer): string => [...bytes.subarray(0, 16)].map((x) => String.fromCharCode(97 + (x >> 4), 97 + (x & 15))).join('')

// The zip, once the .crx proves it is this extension: signed over its contents by the key the id is
// derived from. Chrome makes this check for a store install and skips it for a folder, so a file
// changed on the way would otherwise run with every permission its manifest asks for.
export function verifiedCrxZip(crx: Buffer, id: string): Buffer {
  const zip = crxZip(crx)
  const refused = (): Error => new Error(L('A assinatura da extensão não confere: o arquivo foi recusado.', "The extension's signature doesn't match: the file was refused."))
  try {
    const header = protoFields(crx.subarray(12, crx.length - zip.length))
    const signed = header.get(10000)?.[0]
    const crxId = signed && protoFields(signed).get(1)?.[0]
    if (!signed || !crxId || crxId.length !== 16 || idOfBytes(crxId) !== id) throw refused()
    const size = Buffer.alloc(4)
    size.writeUInt32LE(signed.length)
    const proofs = [...(header.get(2) ?? []), ...(header.get(3) ?? [])] // RSA, then ECDSA
    const proven = proofs.some((proof) => {
      const fields = protoFields(proof)
      const key = fields.get(1)?.[0]
      const signature = fields.get(2)?.[0]
      if (!key || !signature || idOfBytes(createHash('sha256').update(key).digest()) !== id) return false
      return createVerify('sha256').update('CRX3 SignedData\0').update(size).update(signed).update(zip).verify({ key, format: 'der', type: 'spki' }, signature)
    })
    if (!proven) throw refused()
    return zip
  } catch {
    throw refused()
  }
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
const SMALL_FETCH_MS = 2 * 60_000 // an extension or the index: small files, on a connection that may hang
const MAX_CRX_BYTES = 64 * 1024 * 1024
// The one place the browser's zip comes from, at the pinned version: what it holds is a program this app runs.
const CFT_DOWNLOADS = 'https://storage.googleapis.com/chrome-for-testing-public/'
export const cftUrl = (version: string, platform: string): string => `${CFT_DOWNLOADS}${version}/${platform}/chrome-${platform}.zip`
const tookTooLong = (e: unknown): unknown => (e instanceof Error && e.name === 'TimeoutError' ? new Error(L('O download demorou demais. Tentar de novo resolve.', 'The download took too long. Trying again fixes it.')) : e)

// Enough for the browser itself: its biggest file is a ~250 MB library, and the whole unzipped set is
// under 800 MB. The caps are what zip.ts checks before it inflates anything.
const CFT_CAPS = { file: 512 * 1024 * 1024, total: 3 * 1024 * 1024 * 1024 }

async function download(fetcher: typeof fetch, url: string, to: string, want: string, signal: AbortSignal, progress: (received: number, total: number) => void): Promise<void> {
  const part = `${to}.part`
  const hash = createHash('sha256')
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
    bump() // a server that never answers has stopped moving too
    const res = await fetcher(url, { signal: ctrl.signal, redirect: 'error' })
    if (!res.ok || !res.body) throw new Error(L(`O download respondeu ${res.status}.`, `The download answered ${res.status}.`))
    const total = Number(res.headers.get('content-length')) || 0
    mkdirSync(dirname(to), { recursive: true })
    const out = createWriteStream(part)
    // A full disk is reported here: with no listener it would bring the whole app down.
    let writeError: Error | undefined
    out.on('error', (e) => {
      writeError = e
      ctrl.abort()
    })
    const drained = (): Promise<void> =>
      new Promise((r) => {
        const go = (): void => {
          out.off('drain', go)
          out.off('close', go)
          r()
        }
        out.on('drain', go)
        out.on('close', go)
      })
    const reader = res.body.getReader()
    let received = 0
    let last = 0
    try {
      bump()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!out.write(value)) await drained()
        if (writeError) throw writeError
        hash.update(value)
        received += value.length
        if (Date.now() - last > 500) {
          last = Date.now()
          progress(received, total)
          bump()
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.once('error', reject)
        out.end(resolve)
      })
    } catch (e) {
      out.destroy()
      rmSync(part, { force: true })
      if (writeError) throw new Error(L(`Não deu pra gravar no disco: ${writeError.message}`, `Couldn't write it to disk: ${writeError.message}`))
      throw signal.aborted ? e : new Error(L('O download parou no meio. Tentar de novo resolve.', 'The download stopped halfway. Trying again fixes it.'))
    }
    if (total && received !== total) {
      rmSync(part, { force: true })
      throw new Error(L('O download veio incompleto. Tentar de novo resolve.', 'The download came incomplete. Trying again fixes it.'))
    }
    if (hash.digest('hex') !== want) {
      rmSync(part, { force: true })
      throw new Error(L('O arquivo baixado não é o da versão fixada: foi recusado.', "The downloaded file isn't the pinned version: it was refused."))
    }
    renameSync(part, to)
  } finally {
    clearTimeout(stalled)
    signal.removeEventListener('abort', stop)
  }
}

// A stamp inside the folder saying which revision of the edits above it already carries. Its absence is
// an older build's download: that one is set up in place, with no second download.
const TUNE_STAMP = '.tucano-tuned'

// The vendor's default, changed to what an agent needs, in the unpacked folder. Each edit has to find its
// own line exactly once: an extension the store has moved on is left as its vendor ships it and says so in
// its row, because an extension that does half of this is worse than one that does its own default — it
// looks set up and is not. Returns the reason to show when something could not be written.
export function tune(dir: string, key: AddOn): string | undefined {
  try {
    if (readFileSync(join(dir, TUNE_STAMP), 'utf8').trim() === String(TUNE_REVISION)) return undefined
  } catch {
    // unpacked by a build that wrote no stamp, or never set up at all: below is what it needs
  }
  const edits = TUNE[key] ?? []
  if (!edits.length) {
    writeFileSync(join(dir, TUNE_STAMP), String(TUNE_REVISION))
    return undefined
  }
  for (const edit of edits) {
    const file = join(dir, edit.file)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return L(`Ficou como veio da loja: ${edit.file} não está nesta versão.`, `Left as the store ships it: ${edit.file} isn’t in this version.`)
    }
    const hits = text.split(edit.from).length - 1
    // An edit an earlier revision of this app already wrote: the folder is being set up again after the
    // list changed (revision 2 emptied the ad blocker's optimal list), and what this edit wants is there.
    if (hits === 0 && text.split(edit.to).length - 1 === 1) continue
    if (hits !== 1) {
      return L(
        `Ficou como veio da loja: a linha de ${edit.file} não é mais a mesma (${hits} iguais).`,
        `Left as the store ships it: the line in ${edit.file} has moved (${hits} matches).`
      )
    }
    writeFileSync(file, text.replace(edit.from, edit.to))
  }
  writeFileSync(join(dir, TUNE_STAMP), String(TUNE_REVISION))
  return undefined
}

// Each of them in its own folder under extensions/, fetched from the store once and then left as it is
// (set up by tune above): the stamp in it names the pin it was installed for, so a folder someone deleted,
// or one of another version, comes back, and one that matches is never asked for twice. The folder is also
// the switch's answer: off means it leaves the disk, and a lane started afterwards does not carry it.
export class AddOns {
  bin = '' // Chrome for Testing, when it's here: the build that still takes a folder of extensions
  dirs: string[] = [] // the folders of the ones switched on and downloaded, in the store's own order
  private want: readonly AddOn[] = []
  private failed = new Map<AddOn, string>()
  private notes = new Map<AddOn, string>() // landed, but set up as its vendor ships it: why, for the row
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
    private arch: string = process.arch,
    private openCrx: (crx: Buffer, id: string) => Buffer = verifiedCrxZip, // tests hand it files no store signed
    private pins: AddOnPins = ADD_ON_PINS // tests pin what their made-up store serves
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
      this.notes.delete(e.key)
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

  // The browser arrived but won't start on this computer (a library or a sandbox it needs): the lane goes
  // on in the browser it had, and the settings say why the extensions aren't in it.
  launchFailed(why: string): void {
    this.browserError = L(`não abriu neste computador (${why})`, `it didn't open on this computer (${why})`)
    this.changed()
  }

  // What the settings page draws: nothing while all three are off (no switch was touched, so there is no
  // download to speak of), otherwise the browser the three share and each extension that is on.
  get info(): AddOnsInfo | undefined {
    if (!this.want.length) return undefined
    const extensions: Partial<Record<AddOn, AddOnStep>> = {}
    for (const e of ADD_ONS) {
      if (!this.want.includes(e.key)) continue
      const here = this.installed(e)
      const error = this.failed.get(e.key)
      const note = this.notes.get(e.key)
      extensions[e.key] = here
        ? { state: 'ready', ...(note ? { note } : {}) }
        : error
          ? { state: 'failed', error }
          : { state: this.running ? 'preparing' : 'waiting' }
    }
    const browser: AddOnStep & { progress?: { received: number; total: number } } = this.browserError
      ? { state: 'failed', error: this.browserError }
      : this.bin
        ? { state: 'ready' }
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
    return ADD_ONS.filter((e) => this.want.includes(e.key) && !this.installed(e))
  }

  private pick(): void {
    for (const e of ADD_ONS) {
      if (!this.want.includes(e.key)) continue
      const folder = this.folder(e.id)
      if (!this.installed(e)) continue // only what was checked against its pin is ever set up or loaded
      // A folder an older build unpacked carries no stamp (or an older one): the edits go in now, on the
      // files that are already here, and nothing is asked of the store.
      let stamp = ''
      try {
        stamp = readFileSync(join(folder, TUNE_STAMP), 'utf8').trim()
      } catch {
        // unpacked before there were edits to write
      }
      if (stamp === String(TUNE_REVISION)) continue
      const note = tune(folder, e.key)
      if (note) this.notes.set(e.key, note)
      else this.notes.delete(e.key)
    }
    this.dirs = ADD_ONS.filter((e) => this.want.includes(e.key) && this.installed(e)).map((e) => this.folder(e.id))
    if (!this.bin) this.bin = this.stamp()
  }

  private async downloadAll(): Promise<void> {
    const abort = new AbortController()
    this.abort = abort
    this.browserError = ''
    for (const e of ADD_ONS) {
      if (!this.want.includes(e.key)) continue
      const folder = this.folder(e.id)
      if (this.installed(e)) {
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

  // What this extension's folder is stamped with: its .crx and, for the one that reads rules, those too.
  private pinOf(e: AddOnExtension): string {
    const crx = this.pins.extensions[e.key].sha256
    return e.key === 'consent' ? `${crx} ${this.pins.consentRules.sha256}` : crx
  }

  private installed(e: AddOnExtension): boolean {
    try {
      return readFileSync(join(this.folder(e.id), PIN_FILE), 'utf8') === this.pinOf(e) && existsSync(join(this.folder(e.id), 'manifest.json'))
    } catch {
      return false
    }
  }

  // Consent-O-Matic's rules at the pinned commit, as the one file it will read: every file its list names,
  // merged in the list's order, the way the extension merges them. Nothing is kept unless the result is
  // byte for byte the pinned one.
  private async fetchConsentRules(name: string, signal: AbortSignal): Promise<Buffer> {
    const { commit, sha256: want } = this.pins.consentRules
    const base = `${RULES_REPO}${commit}/`
    const json = async (url: string): Promise<Record<string, unknown>> => {
      const res = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(SMALL_FETCH_MS)]), redirect: 'error' })
      if (!res.ok) throw new Error(L(`O GitHub respondeu ${res.status} para as regras de ${name}.`, `GitHub answered ${res.status} for ${name}'s rules.`))
      const body = Buffer.from(await res.arrayBuffer())
      if (body.length > MAX_RULE_BYTES) throw new Error(L(`As regras de ${name} vieram grandes demais.`, `${name}'s rules came too big.`))
      return JSON.parse(body.toString('utf8')) as Record<string, unknown>
    }
    const refused = (): Error => new Error(L(`As regras de ${name} não são as da versão fixada: foram recusadas.`, `${name}'s rules aren't the pinned version: they were refused.`))
    try {
      const references = (await json(`${base}rules-list.json`))['references']
      if (!Array.isArray(references)) throw refused()
      const paths = references.map((r) => RULE_REFERENCE.exec(String(r))?.[1])
      if (paths.some((p) => !p)) throw refused()
      const files = new Array<Record<string, unknown>>(paths.length)
      let next = 0
      await Promise.all(
        Array.from({ length: RULE_FETCHES }, async () => {
          for (let i = next++; i < paths.length; i = next++) files[i] = await json(`${base}${paths[i]!}`)
        })
      )
      const bundle = Buffer.from(JSON.stringify(Object.assign({}, ...files)))
      if (sha256(bundle) !== want) throw refused()
      return bundle
    } catch (err) {
      throw tookTooLong(err)
    }
  }

  private async fetchExtension(e: AddOnExtension, folder: string, signal: AbortSignal): Promise<void> {
    const pin = this.pins.extensions[e.key]
    const tooBig = (): Error => new Error(L(`${e.name} veio grande demais.`, `${e.name} came too big.`))
    let crx: Buffer
    try {
      const res = await this.fetcher(pin.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(SMALL_FETCH_MS)]), redirect: 'error' })
      if (!res.ok) throw new Error(L(`A Chrome Web Store respondeu ${res.status} para ${e.name}.`, `The Chrome Web Store answered ${res.status} for ${e.name}.`))
      if (Number(res.headers.get('content-length')) > MAX_CRX_BYTES) throw tooBig()
      crx = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      throw tookTooLong(err)
    }
    if (crx.length > MAX_CRX_BYTES) throw tooBig()
    if (sha256(crx) !== pin.sha256) throw new Error(L(`${e.name} não é a versão fixada (${pin.version}): o arquivo foi recusado.`, `${e.name} isn't the pinned version (${pin.version}): the file was refused.`))
    const opened = this.openCrx(crx, e.id)
    const rules = e.key === 'consent' ? await this.fetchConsentRules(e.name, signal) : undefined
    const zip = zipFromBuffer(opened)
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
      // Set up before it is moved into place: a folder that appears without its stamp is one the next
      // start would edit again, and a half-written one is never what a lane loads.
      const note = tune(staging, e.key)
      if (note) this.notes.set(e.key, note)
      else this.notes.delete(e.key)
      if (rules) this.installConsentRules(staging, rules, e.name)
      writeFileSync(join(staging, PIN_FILE), this.pinOf(e))
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err
    }
    rmSync(folder, { recursive: true, force: true })
    renameSync(staging, folder)
  }

  // The rules next to the extension, and its default list pointing at them. Each script must hold that
  // default exactly once: the .crx is pinned, so anything else means this code no longer fits the file,
  // and an extension still reading `master` is not one to install.
  private installConsentRules(folder: string, rules: Buffer, name: string): void {
    const file = rulesName(this.pins.consentRules.commit)
    for (const script of RULES_SCRIPTS) {
      const path = join(folder, script)
      const source = existsSync(path) ? readFileSync(path, 'utf8') : ''
      if ((source.match(RULES_DEFAULT) ?? []).length !== 1) throw new Error(L(`Não deu pra fixar as regras de ${name}: o arquivo foi recusado.`, `Couldn't pin ${name}'s rules: the file was refused.`))
      // Every mention, not only the default: its upgrade from an older list writes this address back.
      writeFileSync(path, source.replaceAll(`"${RULES_LIST}"`, `chrome.runtime.getURL("${file}")`))
    }
    writeFileSync(join(folder, file), rules)
  }

  // The pinned Chrome for Testing in the data folder, if that is the one there.
  private stamp(): string {
    try {
      const s = JSON.parse(readFileSync(join(this.dir, 'chrome-for-testing.json'), 'utf8')) as { bin?: string; sha256?: string }
      if (s.bin && s.sha256 && s.sha256 === this.pins.browser.sha256[cftPlatform(this.os, this.arch)] && existsSync(s.bin)) return s.bin
    } catch {
      // no stamp, or one from a folder that's gone: the next download writes a new one
    }
    return ''
  }
  private async fetchBrowser(signal: AbortSignal): Promise<string> {
    const { version, sha256: hashes } = this.pins.browser
    const platform = cftPlatform(this.os, this.arch)
    const want = hashes[platform]
    if (!want) throw new Error(L(`Não há Chrome for Testing fixado para ${platform}.`, `There's no pinned Chrome for Testing for ${platform}.`))
    const zipPath = join(this.dir, 'chrome-for-testing.zip')
    mkdirSync(this.dir, { recursive: true })
    await download(this.fetcher, cftUrl(version, platform), zipPath, want, signal, (received, total) => {
      this.progress = { received, total }
      this.changed()
    })
    const into = join(this.dir, 'chrome-for-testing')
    rmSync(into, { recursive: true, force: true })
    mkdirSync(into, { recursive: true })
    const zip = zipFromFile(zipPath)
    let root = into
    try {
      root = extractZip(zip, into, CFT_CAPS, { unix: this.os !== 'win32' })
    } catch (err) {
      rmSync(into, { recursive: true, force: true }) // half a browser is hundreds of MB nobody can run
      throw err
    } finally {
      zip.close()
      rmSync(zipPath, { force: true })
    }
    const tail = CFT_TAIL[platform] ?? []
    const found = [join(root, ...tail), join(into, ...tail)].find((p) => existsSync(p))
    if (!found) {
      rmSync(into, { recursive: true, force: true })
      throw new Error(L('O Chrome baixado veio sem o programa dentro.', 'The Chrome downloaded came without the program inside.'))
    }
    if (this.os !== 'win32') chmodSync(found, 0o755) // a .zip keeps no permission bits: on a Mac and on Linux it must be runnable
    writeFileSync(join(this.dir, 'chrome-for-testing.json'), JSON.stringify({ version, sha256: want, bin: found, at: Date.now() }))
    return found
  }
}
