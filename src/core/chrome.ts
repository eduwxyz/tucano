// An agent's browser as a real Google Chrome (spec §24), when the Mac has one.
// Google refuses logins in embedded browsers (Electron's included) and binds
// its sessions to the Chrome that made them, so the agent's browser is Chrome
// itself, with a profile of its own: headless while the agent drives it,
// a normal window when I take over ("Assumir"). Driven over the DevTools
// protocol; the page scripts are the same as in the Electron fallback. The
// screen streams to the app while it changes, so the panel is a live view.
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { L } from '../shared/lang'
import { chromeKeyringFlags, findChrome, userAgentPlatform } from './platform'
import { fillRefused, FILL, HIDE_SECRETS, POINT, PICK, SNAPSHOT, TEXT } from '../shared/page'
import { MAX_FILE_BYTES, type BrowserInput, type BrowserOp, type BrowserReply } from '../shared/types'
import { land, partialFolder, refuse } from './downloads'

// Google Chrome on this computer, where it usually is on each system (see platform.ts).
export const CHROME = findChrome()

const W = 1280
const H = 800
// How long a first open gets before it's called failed. Generous on purpose: a cold Chrome
// on a slow or loaded machine (a server, CI) is the slowest thing here, and a person only
// ever waits on a Chrome that is never going to answer.
const OPEN_TIMEOUT_MS = 90_000
const COMMAND_MS = 30_000 // for the work of the day: a page that isn't coming back, said soon
// How long the next command gets. The handshake may be slow to start — a cold Chrome on a loaded
// machine — and everything after it isn't, so only the handshake borrows the open deadline.
export const commandDeadline = (starting: boolean): number => (starting ? OPEN_TIMEOUT_MS : COMMAND_MS)
const FRAME_MS = 150 // at most ~6 frames a second while someone watches
const IDLE_MS = 2000 // and one every 2 s otherwise: an animated page left open costs little
// Where a window for a wall is sent, and where it comes back to when I take it over. macOS does not
// honour the far corner: Chrome opened there lands at 0,30, and moved there it stops with 40 px still on
// the screen (measured 2026-11-22). Windows keeps it out of sight.
const OFF_SCREEN = -24000
const IN_VIEW = 60
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
// The site of an address, for "this one was already tried": '' when there isn't one yet.
const siteOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const exited = (proc: ChildProcess, ms: number): Promise<unknown> =>
  Promise.race([proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r)), wait(ms)])

// Chrome takes a moment to let go of its profile; a new one started before that just hands over to it.
async function gone(proc: ChildProcess, ms = 10_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill()
  await exited(proc, ms)
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
}

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 }
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
// A new frame of the screen; says whether the app wants frames at full speed now.
export type OnFrame = (agentId: string, jpeg: string) => boolean

// One Chrome process and its DevTools connection, following one tab. The connection is a
// pipe to that process (--remote-debugging-pipe): no port another program on the computer
// (a command an agent runs) could find and drive this profile through.
class Tab {
  private closed = false
  private n = 0
  private pending = new Map<number, Pending>()
  session = '' // the tab we drive
  target = ''
  url = ''
  private world: number | undefined // our isolated world in the tab's main frame
  closedAll?: () => void // every tab is gone (I closed the window)
  onDownload?: (method: string, params: Record<string, unknown>) => void // a download began or moved on
  remote = false // I'm driving it from the panel (no window: Tucano as a server)
  offscreen = false // a real window opened for a wall, which nobody has taken over: the agent still drives it
  // True from the first byte of the handshake to the last: Chrome answering its first command on a
  // loaded machine is the slow part, and it gets the same generous deadline as the open itself.
  private starting = false

  constructor(
    readonly proc: ChildProcess,
    readonly headed: boolean,
    private onFrame?: (jpeg: string) => boolean,
    readonly carriesExtensions = false // fixed for this process's life: what fill() refuses on
  ) {}

  // Whether a person has this lane: a window opened only to get past a wall doesn't count, or the agent
  // would be told I'm using its browser and refused its next action.
  get inView(): boolean {
    return (this.headed && !this.offscreen) || this.remote
  }

  // Chrome reads commands on its fd 3 and writes on fd 4, each message ending in a NUL.
  private get input(): Writable {
    return this.proc.stdio[3] as Writable
  }

  async connect(): Promise<void> {
    this.starting = true
    const output = this.proc.stdio[4] as Readable
    let buffered = ''
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      const parts = (buffered + chunk).split('\0')
      buffered = parts.pop() ?? ''
      for (const m of parts) if (m) this.onMessage(JSON.parse(m) as Record<string, unknown>)
    })
    const gone = (): void => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error(L('o Chrome fechou', 'Chrome closed')))
      this.pending.clear()
    }
    output.on('close', gone)
    output.on('error', gone)
    this.input.on('error', gone)
    try {
      await this.send('Target.setDiscoverTargets', { discover: true })
      const { targetInfos } = (await this.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string; url: string }[] }
      const page = targetInfos.find((t) => t.type === 'page')
      await this.follow(page ? page.targetId : ((await this.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }).targetId)
    } finally {
      this.starting = false
    }
  }

  send(method: string, params: Record<string, unknown> = {}, session = ''): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.n
      if (this.closed) return reject(new Error(L('o Chrome fechou', 'Chrome closed')))
      this.pending.set(id, { resolve, reject })
      this.input.write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0')
      // 30 s for the work of the day; the handshake gets the open deadline instead, because a cold
      // Chrome on a loaded runner answered its first command after the 30 s it used to be given
      // (GitHub's ubuntu-latest, chrome-close and chrome-windowless, four runs out of six), while the
      // very next command on the same machine came back in milliseconds.
      const deadline = commandDeadline(this.starting)
      setTimeout(
        () => this.pending.get(id) && (this.pending.delete(id), reject(new Error(L(`o Chrome não respondeu (${method}) em ${deadline / 1000} s`, `Chrome didn't answer (${method}) within ${deadline / 1000} s`)))),
        deadline
      ).unref()
    })
  }

  // In the tab we drive.
  cmd(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.send(method, params, this.session)
  }

  private onMessage(m: Record<string, unknown>): void {
    if (typeof m['id'] === 'number') {
      const p = this.pending.get(m['id'])
      this.pending.delete(m['id'])
      if (m['error']) p?.reject(new Error(String((m['error'] as { message?: string }).message ?? L('erro do Chrome', 'Chrome error'))))
      else p?.resolve((m['result'] as Record<string, unknown>) ?? {})
      return
    }
    const params = (m['params'] ?? {}) as Record<string, unknown>
    if (typeof m['method'] === 'string' && m['method'].startsWith('Browser.download')) return this.onDownload?.(m['method'], params)
    const info = params['targetInfo'] as { targetId: string; type: string; url: string; openerId?: string } | undefined
    if (m['method'] === 'Target.targetCreated' && info?.type === 'page' && info.openerId === this.target) void this.follow(info.targetId).catch(() => {}) // a link that opens a new tab: go with it
    else if (m['method'] === 'Target.targetInfoChanged' && info?.targetId === this.target) this.url = info.url
    else if (m['method'] === 'Target.targetDestroyed') void this.checkClosed(String(params['targetId']))
    else if (m['method'] === 'Page.screencastFrame' && m['sessionId'] === this.session) {
      // Chrome sends the next frame only after this one is acknowledged: the ack sets the pace.
      const session = m['sessionId']
      const fast = this.onFrame?.(String(params['data'])) ?? false
      setTimeout(() => void this.send('Page.screencastFrameAck', { sessionId: params['sessionId'] }, String(session)).catch(() => {}), fast ? FRAME_MS : IDLE_MS).unref()
    } else if ((m['method'] === 'Runtime.executionContextsCleared' || m['method'] === 'Page.frameNavigated') && m['sessionId'] === this.session) this.world = undefined
  }

  private async checkClosed(targetId: string): Promise<void> {
    const { targetInfos } = (await this.send('Target.getTargets').catch(() => ({ targetInfos: [] }))) as { targetInfos: { targetId: string; type: string }[] }
    const pages = targetInfos.filter((t) => t.type === 'page')
    if (pages.length === 0) return this.closedAll?.()
    if (targetId === this.target) await this.follow(pages[0]!.targetId).catch(() => {})
  }

  private async follow(targetId: string): Promise<void> {
    if (this.session && this.onFrame) void this.cmd('Page.stopScreencast').catch(() => {})
    const { sessionId } = (await this.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    this.session = sessionId
    this.target = targetId
    this.world = undefined
    await this.cmd('Page.enable')
    await this.cmd('Runtime.enable')
    if (!this.headed) {
      // Headless Chrome says so in its user agent; sites see a plain Chrome.
      const { userAgent } = (await this.send('Browser.getVersion')) as { userAgent: string }
      const version = /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? '0'
      await this.cmd('Network.setUserAgentOverride', {
        userAgent: userAgent.replace('HeadlessChrome', 'Chrome'),
        userAgentMetadata: {
          brands: [{ brand: 'Google Chrome', version }, { brand: 'Chromium', version }, { brand: 'Not(A:Brand', version: '24' }],
          fullVersion: /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? version,
          ...userAgentPlatform(),
          model: '',
          mobile: false
        }
      })
    }
    const { targetInfo } = (await this.send('Target.getTargetInfo', { targetId })) as { targetInfo: { url: string } }
    this.url = targetInfo.url
    if (this.onFrame) await this.cmd('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: W, maxHeight: H, everyNthFrame: 1 }).catch(() => {})
  }

  // Runs one of the page scripts in our isolated world: the page can't see or change it.
  async run<T>(code: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.world === undefined) {
        const { frameTree } = (await this.cmd('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }
        const { executionContextId } = (await this.cmd('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'tucano' })) as { executionContextId: number }
        this.world = executionContextId
      }
      try {
        const r = (await this.cmd('Runtime.evaluate', { expression: code, contextId: this.world, returnByValue: true, awaitPromise: true })) as { result: { value?: unknown }; exceptionDetails?: { text?: string } }
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? L('erro na página', 'error on the page'))
        return r.result.value as T
      } catch (e) {
        if (attempt === 0 && /context|Cannot find/i.test(String(e))) {
          this.world = undefined // the page navigated under us
          continue
        }
        throw e
      }
    }
    throw new Error(L('a página não respondeu', "the page didn't answer"))
  }

  close(): void {
    this.closed = true
    try {
      this.input.end()
    } catch {}
  }
}

// Settings › Agents › Additional accessibility: two of Chrome's own switches, so there is no script in the
// page. One asks every page for less motion, which is what stops a carousel sliding the element the agent
// was about to click; the other makes a video wait for a press, so a page cannot start talking over the
// reply being written. Measured on this build (Chrome for Testing 158.0.8127.36, 2026-11-22): with the
// first, prefers-reduced-motion matches "reduce" in the page. The second is Chrome's documented switch;
// its own navigator.getAutoplayPolicy is missing from this build, so it is not proved from inside a page.
export const assistFlags = (on: boolean | undefined): string[] =>
  on ? ['--force-prefers-reduced-motion', '--autoplay-policy=user-gesture-required'] : []

// Left in an agent's own profile by its first Cofre login. An extension reads every page it is on, what is
// typed there included, so from then on that agent's browser runs without them, on the profile that holds
// the sessions those logins opened. Clearing the browser removes it with the profile.
const VAULT_LOGIN_MARK = 'tucano-vault-login'

export class ChromeBrowsers {
  private tabs = new Map<string, Tab>()
  // What each lane was started with (browser and extension folders), so a switch turned on under an open
  // lane is not waited for until the app restarts: the next op gets a lane with what the switches say.
  private launchedWith = new Map<string, string>()
  private brokenWith = '' // the set that wouldn't start on this computer: the lane stays on its own browser
  private starting = new Map<string, Promise<Tab>>()
  private handingBack = new Set<string>()
  private used = new Map<string, number>() // when each agent last asked its Chrome for something
  private busy = new Map<string, number>() // what it's doing right now
  private resumeAt = new Map<string, string>() // the page a Chrome closed for idling was on
  private closing = new Map<string, Promise<void>>() // a Chrome closed for idling, still writing its cookies
  // Sites that only let a real browser through: which one each agent's lane is drawn in a window for
  // right now, and which ones it was already tried on. The second set is what ends the loop: a wall a
  // window doesn't get past is never asked for again in that lane.
  private wallHeaded = new Set<string>()
  private wallTried = new Map<string, Set<string>>()
  private relaunching = new Map<string, Promise<BrowserReply>>() // one switch to a window at a time, shared
  private procs = new Set<ChildProcess>() // every Chrome started, including one still opening when the app quits
  private quits = 0 // a switch to a window under way when the app quits opens nothing more

  constructor(
    private dir: string, // profiles live in <dir>/<agentId>
    private onShown: (agentId: string, shown: boolean) => void,
    private bin: string = CHROME ?? '',
    private onFrame?: OnFrame,
    // No screen to open a window on (Tucano as a server): taking over keeps it
    // headless and I drive it from the panel, through 'input'.
    private windowless = false,
    // A Chrome nobody asked anything of for this long is closed (cookies kept) and reopens on the
    // same page when next needed: on a server several people share, each costs hundreds of MB.
    private idleMs?: number,
    // Where each agent's downloads land (core/downloads.ts); without it, nothing downloads.
    private downloads?: (agentId: string) => string,
    // The browser's own extensions, when they're here (core/chrome-addons.ts): Chrome for Testing, the
    // only build that still takes a folder of them, and where they are. Read at every launch, so one
    // that lands while a lane is running is in the next lane, without closing the page an agent is on.
    private addOns?: { bin: string; dirs: string[]; launchFailed?: (why: string) => void },
    // Chrome switches that are the person's own choice (Settings › Agents › Additional accessibility),
    // read at every launch like the extensions above, so a change reaches the next lane and not this one.
    private flags?: () => string[],
    // Whether a wall may open a real window by itself. Not on a Mac for now: Chrome started this way
    // comes to the front and takes the focus from what the person is doing (measured 2026-11-22, about
    // 8 s across a run), and macOS won't keep the window off the screen either. There the wall's note
    // stands: wait, use another source, or ask the person to take the browser over.
    private wallWindows = process.platform !== 'darwin'
  ) {
    process.on('exit', () => this.quit())
    if (idleMs) setInterval(() => void this.closeIdle(), Math.min(60_000, Math.max(100, idleMs / 2))).unref()
  }

  running(agentId: string): boolean {
    return this.tabs.has(agentId)
  }

  // Not one taken over (the person is on it), nor one handing back or in the middle of something.
  private async closeIdle(): Promise<void> {
    const now = Date.now()
    for (const [agentId, t] of this.tabs) {
      if (t.headed || this.handingBack.has(agentId) || this.starting.has(agentId) || (this.busy.get(agentId) ?? 0) > 0) continue
      if (now - (this.used.get(agentId) ?? now) < this.idleMs!) continue
      this.tabs.delete(agentId)
      if (/^https?:/.test(t.url)) this.resumeAt.set(agentId, t.url)
      // Until it's gone, a new one for this agent waits: started on the same profile, it would
      // take it over from the one still writing its cookies, and the login would be lost.
      const done = this.shutDown(t)
        .catch(() => {})
        .finally(() => this.closing.get(agentId) === done && this.closing.delete(agentId))
      this.closing.set(agentId, done)
      await done
    }
  }

  quit(): void {
    this.quits++
    for (const proc of this.procs) proc.kill()
    this.procs.clear()
    this.tabs.clear()
    this.launchedWith.clear()
  }

  // A lane with extensions has a profile of its own. Chrome for Testing can't decrypt the cookies the
  // branded build saved, and it deletes what it can't read: sharing the folder would sign the agent out
  // of every site for good, even after the extensions are turned off again.
  private profile(agentId: string, carried = false): string {
    return join(this.dir, carried ? `${agentId}.extensions` : agentId)
  }

  // The browser and the extension folders a lane runs with now, or '' for the browser the app found. It
  // changes only when Chrome for Testing and something to carry are both here: each extension landing
  // during the download is not a reason to restart the page an agent is on.
  private wanted(agentId: string): string {
    const a = this.addOns
    // Never in a throwaway screenshot ('.shot-'): that one draws the person's own page as the page is.
    if (!a?.bin || !a.dirs.length || agentId.startsWith('.shot-') || this.usesVaultLogins(agentId)) return ''
    const set = `${a.bin}|${a.dirs.join('|')}`
    return set === this.brokenWith ? '' : set
  }

  // Everything a lane is started with that a switch can change: what it carries and how its Chrome
  // behaves. Kept apart from wanted() above, which also decides the profile: a switch that changes how a
  // page behaves must not send the lane to the other profile and sign the agent out of every site.
  private fingerprint(agentId: string): string {
    return `${this.wanted(agentId)}|${(this.flags?.() ?? []).join(' ')}`
  }

  private usesVaultLogins(agentId: string): boolean {
    return existsSync(join(this.profile(agentId), VAULT_LOGIN_MARK))
  }

  // Before a Cofre login is read: this agent's browser stops carrying extensions, for good, and a lane open
  // with them closes (cookies written) and comes back without them on the same address. The page is a new
  // one, so the caller has the agent read it again; the second call finds a clean lane and goes through,
  // which is why this can't loop. A window the person is using is never closed under them: that one refuses.
  private async withoutExtensions(agentId: string): Promise<BrowserReply> {
    const before = this.tabs.get(agentId) ?? (await this.starting.get(agentId)?.catch(() => undefined))
    if (before?.carriesExtensions && (before.headed || before.remote)) throw new Error(extensionsRefusal())
    mkdirSync(this.profile(agentId), { recursive: true })
    writeFileSync(join(this.profile(agentId), VAULT_LOGIN_MARK), '')
    let tab = await this.tab(agentId)
    if (tab.carriesExtensions) tab = await this.tab(agentId) // a launch already under way when the mark went in
    if (tab.carriesExtensions) throw new Error(extensionsRefusal())
    return { url: tab.url, title: '', ...(before?.carriesExtensions ? { reopened: true } : {}) }
  }

  private async launch(agentId: string, headed: boolean, url?: string, offscreen = false): Promise<Tab> {
    const carried = this.wanted(agentId)
    const startedWith = this.fingerprint(agentId) // as it is now: what lands during the start is the next lane's
    const profile = this.profile(agentId, !!carried)
    mkdirSync(profile, { recursive: true })
    const downloads = agentId.startsWith('.shot-') ? undefined : this.downloads?.(agentId)
    if (downloads) pdfsDownload(profile)
    // A Chrome left behind (the app crashed) still holds the profile: a new one would just hand over to it.
    try {
      const pid = Number(readlinkSync(join(profile, 'SingletonLock')).split('-').pop())
      if (pid && alive(pid)) {
        process.kill(pid)
        for (let i = 0; i < 50 && alive(pid); i++) await wait(200)
      }
    } catch {}
    const load = carried ? this.addOns!.dirs : []
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-pipe',
      '--disable-blink-features=AutomationControlled', // navigator.webdriver stays false, as in any Chrome
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--deny-permission-prompts',
      ...chromeKeyringFlags(),
      `--window-size=${W},${H}`,
      // The ad blocker and the two cookie-notice removers, as folders.
      ...(load.length ? [`--load-extension=${load.join(',')}`] : []),
      // A page that stops moving on its own, and a video that waits for a click: the agent's click lands
      // where the element was, and nothing starts talking over it. Both are Chrome's own switches, so
      // there is no script in the page for a site to notice or for us to keep up to date.
      ...(this.flags?.() ?? []),
      // A window opened to get past a bot check is off the screen: it is a real window, drawn by the
      // real renderer, which is what these walls let through (measured 2026-11-22: at -24000,-24000
      // Cloudflare, idealo's 403 and google all cleared exactly as in the middle of the screen), but
      // it stays out of my way. Taking the lane over opens it in front of me instead, at a fixed place:
      // left to itself Chrome would reopen where the last window of this profile was, off the screen.
      ...(headed ? ['--new-window', `--window-position=${offscreen ? `${OFF_SCREEN},${OFF_SCREEN}` : `${IN_VIEW},${IN_VIEW}`}`] : ['--headless=new', '--mute-audio']),
      // Never a page on this line: Chrome can drop what it's handed at startup, and a blank page is what an
      // agent then reads. A caller that names a page gets it from navigate() below, once the lane is answering.
      'about:blank'
    ]
    const proc = spawn(carried ? this.addOns!.bin : this.bin, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    this.procs.add(proc)
    proc.once('exit', () => this.procs.delete(proc))
    const onFrame = this.onFrame
    const tab = new Tab(proc, headed, onFrame && ((jpeg) => onFrame(agentId, jpeg)), load.length > 0)
    tab.offscreen = offscreen
    let timer: ReturnType<typeof setTimeout> | undefined
    const failed = new Promise<never>((_, reject) => {
      proc.once('error', reject) // the program isn't there, or can't be run
      proc.once('exit', () => reject(new Error(L('o Chrome fechou logo ao abrir', 'Chrome closed right after opening'))))
      // The first open on a computer can be slow, with nothing of Chrome in memory yet. As long as any other answer gets (see send).
      // 90 s, not 30: a cold Chrome with a brand-new profile took 22 s on GitHub's Windows runner and
      // more than 30 s on its Ubuntu one, while the very next open on the same machine took 6 s.
      // Nothing is waited on here that a person sees: the first answer returns the moment Chrome speaks.
      timer = setTimeout(() => reject(new Error(L('o Chrome não abriu em 90 s', "Chrome didn't open in 90 s"))), OPEN_TIMEOUT_MS)
    })
    try {
      await Promise.race([tab.connect(), failed])
      await this.watchDownloads(tab, downloads)
      if (offscreen) await this.placeWindow(tab, OFF_SCREEN) // the flag alone doesn't hold on macOS
      // A caller that names a page (a wall's own window, a lane coming back) gets it here, after the
      // handshake: Chrome can drop a page handed to it on the command line while it starts.
      if (url && /^https?:/.test(url)) await this.navigate(tab, url)
    } catch (e) {
      proc.kill()
      if (carried) {
        // A browser that won't start here is no reason to lose the one that did.
        clearTimeout(timer)
        await exited(proc, 3000)
        this.brokenWith = carried
        this.addOns?.launchFailed?.(e instanceof Error ? e.message : String(e))
        return this.launch(agentId, headed)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
    proc.once('exit', () => {
      if (this.tabs.get(agentId) !== tab) return
      this.tabs.delete(agentId)
      tab.close()
      if (headed) this.handBack(agentId, tab.url)
    })
    if (headed) tab.closedAll = () => this.handBack(agentId, tab.url)
    this.tabs.set(agentId, tab)
    this.launchedWith.set(agentId, startedWith)
    return tab
  }

  // Moved through the browser's own window bounds, which is what's true on every system (the page's
  // screenX doesn't follow on Windows), and never a restart: what's on the page stays as it was.
  private async placeWindow(tab: Tab, at: number): Promise<void> {
    const { windowId } = await tab.send('Browser.getWindowForTarget', { targetId: tab.target }).catch(() => ({ windowId: undefined }))
    if (typeof windowId === 'number') await tab.send('Browser.setWindowBounds', { windowId, bounds: { left: at, top: at, width: W, height: H } }).catch(() => {})
  }

  // Downloads go to the agent's own folder, through .partial (core/downloads.ts), never past the size
  // limit: one that grows past it is cancelled and the agent told. With no folder, nothing downloads.
  private async watchDownloads(tab: Tab, folder?: string): Promise<void> {
    if (!folder) {
      await tab.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})
      return
    }
    const partial = partialFolder(folder)
    rmSync(partial, { recursive: true, force: true }) // what a Chrome closed mid-download left: never coming
    mkdirSync(partial, { recursive: true })
    const going = new Map<string, { name: string; url: string; refused?: boolean }>()
    tab.onDownload = (method, p) => {
      const guid = String(p['guid'] ?? '')
      if (method === 'Browser.downloadWillBegin') return void going.set(guid, { name: String(p['suggestedFilename'] ?? ''), url: String(p['url'] ?? '') })
      const d = going.get(guid)
      if (method !== 'Browser.downloadProgress' || !d) return
      // allowAndName: Chrome writes the file under its guid; it gets its own name once whole.
      const file = join(partial, guid)
      const size = Math.max(Number(p['totalBytes']) || 0, Number(p['receivedBytes']) || 0)
      if (p['state'] === 'inProgress' && size > MAX_FILE_BYTES && !d.refused) {
        d.refused = true
        refuse(folder, d.name, size)
        void tab.send('Browser.cancelDownload', { guid }).catch(() => {})
      } else if (p['state'] === 'completed' || p['state'] === 'canceled') {
        going.delete(guid)
        if (p['state'] === 'canceled' || d.refused) rmSync(file, { force: true })
        else {
          try {
            land(folder, file, d.name, d.url)
          } catch {
            rmSync(file, { force: true })
          }
        }
      }
    }
    await tab.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: partial, eventsEnabled: true }).catch(() => {})
  }

  // Asked to close, Chrome writes its cookies first. Killed, it loses what the last 30 s or so
  // held: a login just made wouldn't be there when this profile opens again.
  private async shutDown(t: Tab): Promise<void> {
    t.closedAll = undefined // this is the app closing it, not the person handing it back
    await Promise.race([t.send('Browser.close').catch(() => {}), wait(2000)])
    // Usually under a second; a loaded machine (a server, CI) can take several to write them.
    await exited(t.proc, 15_000)
    t.close()
    await gone(t.proc)
  }

  // The agent's Chrome, headless, started when first needed.
  private async tab(agentId: string): Promise<Tab> {
    const t = this.tabs.get(agentId)
    if (t) {
      // A window the person took over is theirs until they hand it back: nothing restarts under it.
      if (t.headed || agentId.startsWith('.shot-') || this.launchedWith.get(agentId) === this.fingerprint(agentId)) return t
      // This one was started with a different set of extensions: a switch was turned on (or off) while it
      // was open, or the download landed. Without this it keeps the old set for as long as it lives — on a
      // Mac with no idle close, for the whole session. It closes the way an idle one does (cookies are
      // written first) and the page it was on comes back in the next browser, so nothing is lost but the
      // seconds of the relaunch.
      this.tabs.delete(agentId)
      this.launchedWith.delete(agentId)
      if (/^https?:/.test(t.url)) this.resumeAt.set(agentId, t.url)
      const restarted = this.shutDown(t)
        .catch(() => {})
        .finally(() => this.closing.get(agentId) === restarted && this.closing.delete(agentId))
      this.closing.set(agentId, restarted)
    }
    const going = this.starting.get(agentId)
    if (going) return going
    const back = this.resumeAt.get(agentId)
    this.resumeAt.delete(agentId)
    const closing = this.closing.get(agentId)
    const p = (closing ? closing.then(() => this.launch(agentId, false)) : this.launch(agentId, false))
      .then(async (tab) => {
        if (back) await this.navigate(tab, back)
        return tab
      })
      .finally(() => this.starting.delete(agentId))
    this.starting.set(agentId, p)
    return p
  }

  // I'm done with the window: back to headless, on the page I left.
  private handBack(agentId: string, url: string): void {
    if (this.handingBack.has(agentId)) return
    this.handingBack.add(agentId)
    const t = this.tabs.get(agentId)
    if (t?.headed) this.tabs.delete(agentId)
    this.wallHeaded.delete(agentId) // back to a headless lane: a wall can ask for a window again
    const p = (t?.headed ? this.shutDown(t) : Promise.resolve())
      .then(() => this.launch(agentId, false))
      .then(async (tab) => {
        if (/^https?:/.test(url)) await this.navigate(tab, url)
        return tab
      })
      .finally(() => {
        this.starting.delete(agentId)
        this.handingBack.delete(agentId)
      })
    this.starting.set(agentId, p)
    // Only now: hearing it's back, the app asks for a frame, which must wait for this Chrome, not start a blank one.
    this.onShown(agentId, false)
  }

  // The page is a bot check the headless lane can't pass: the same profile, in a real window, off the
  // screen. Once per site in a lane, and never a retry of one that didn't work: an agent that met a
  // wall it couldn't read spent 143 of its 248 browser calls on that host (measured 2026-11-22), and
  // the point of this is the page, not another thing to try.
  private async headful(agentId: string): Promise<BrowserReply> {
    const t = this.tabs.get(agentId)
    const here = { url: t?.url ?? '', title: '' }
    // A window needs a screen, and nothing here may race a lane that is starting, closing or being
    // handed back: the answer is no, and the page's own note still says what to do.
    if (this.windowless || !this.wallWindows || !this.bin) return { ...here, headful: false }
    const going = this.relaunching.get(agentId)
    if (going) return going // two calls that met the same wall get the same window
    if (!t || this.starting.has(agentId) || this.handingBack.has(agentId) || this.closing.has(agentId)) return { ...here, headful: false }
    if (t.headed) return { ...here, headful: this.wallHeaded.has(agentId), shown: t.inView }
    const site = siteOf(t.url)
    const tried = this.wallTried.get(agentId) ?? new Set<string>()
    if (!site || tried.has(site)) return { ...here, headful: false }
    tried.add(site)
    this.wallTried.set(agentId, tried)
    // In `starting` from this very line, so whatever the agent asks during the switch waits for this
    // Chrome instead of opening a second one on the same profile.
    this.tabs.delete(agentId)
    const url = t.url
    const quits = this.quits
    const open = (headed: boolean): Promise<Tab> => {
      if (this.quits !== quits) throw new Error(L('o app fechou', 'the app quit'))
      return this.launch(agentId, headed, url, headed)
    }
    const p = this.shutDown(t)
      .then(() => open(true))
      .then(async (tab) => {
        await this.settle(tab)
        this.wallHeaded.add(agentId)
        return tab
      })
      // A window that won't open is no reason to lose the page: back to headless where it was.
      .catch(async () => {
        const back = await open(false)
        await this.settle(back)
        return back
      })
      .catch((e: unknown) => {
        this.resumeAt.set(agentId, url)
        throw e
      })
      .finally(() => this.starting.delete(agentId))
    this.starting.set(agentId, p)
    const reply = p
      .then((tab): BrowserReply => ({ url: tab.url, title: '', headful: tab.headed }), (): BrowserReply => ({ ...here, headful: false }))
      .finally(() => this.relaunching.delete(agentId))
    this.relaunching.set(agentId, reply)
    return reply
  }

  async run(agentId: string, op: BrowserOp, args: Record<string, unknown> = {}): Promise<BrowserReply> {
    this.used.set(agentId, Date.now())
    this.busy.set(agentId, (this.busy.get(agentId) ?? 0) + 1)
    try {
      const reply = await this.runOp(agentId, op, args)
      // Every answer from a lane that is in a window for a wall says so, so the note the agent reads
      // (shared/wall.ts) stops advising a wait or a takeover that can't help.
      return this.tabs.get(agentId)?.headed && this.wallHeaded.has(agentId) ? { ...reply, headful: true } : reply
    } finally {
      this.busy.set(agentId, (this.busy.get(agentId) ?? 1) - 1)
      this.used.set(agentId, Date.now())
    }
  }

  private async runOp(agentId: string, op: BrowserOp, args: Record<string, unknown>): Promise<BrowserReply> {
    if (op === 'close' || op === 'clear') {
      // A Chrome still opening (a switch to a window, a first page) would land after this and stay.
      await this.starting.get(agentId)?.catch(() => {})
      this.resumeAt.delete(agentId)
      this.wallHeaded.delete(agentId)
      this.wallTried.delete(agentId)
      const t = this.tabs.get(agentId)
      this.tabs.delete(agentId)
      this.launchedWith.delete(agentId)
      if (t && op === 'close') await this.shutDown(t)
      else if (t) {
        t.close()
        await gone(t.proc)
      }
      if (op === 'clear') {
        rmSync(this.profile(agentId), { recursive: true, force: true })
        rmSync(this.profile(agentId, true), { recursive: true, force: true })
      }
      return { url: '', title: '' }
    }
    if (op === 'prepare_login') return this.withoutExtensions(agentId)
    if (op === 'show' && this.windowless) {
      const tab = await this.tab(agentId)
      tab.remote = true
      this.onShown(agentId, true)
      return { url: tab.url, title: '', shown: true }
    }
    if (op === 'hide' && this.windowless) {
      const t = this.tabs.get(agentId)
      if (t?.remote) {
        t.remote = false
        this.onShown(agentId, false)
      }
      return { url: t?.url ?? '', title: '', shown: false }
    }
    if (op === 'input') {
      const t = this.tabs.get(agentId)
      if (!t?.remote) throw new Error(L('Assuma o navegador antes de usar.', 'Take the browser over before using it.'))
      await this.input(t, args as BrowserInput)
      return { url: t.url, title: '', shown: true }
    }
    if (op === 'headful') return this.headful(agentId)
    if (op === 'show') {
      const current = this.tabs.get(agentId) ?? (await this.starting.get(agentId))
      // A window opened to get past a wall: asked to take the lane over, it comes into view on the page
      // it is on. Moved, not restarted: a challenge half solved on it stays half solved, which is the
      // one thing I asked to see it for.
      if (current?.offscreen) {
        current.offscreen = false
        await this.placeWindow(current, IN_VIEW)
        await current.cmd('Page.bringToFront').catch(() => {})
        this.onShown(agentId, true)
        return { url: current.url, title: '', shown: true }
      }
      if (current?.headed) return { url: current.url, title: '', shown: true }
      const url = current?.url
      if (current) {
        this.tabs.delete(agentId)
        await this.shutDown(current)
      }
      const tab = await this.launch(agentId, true)
      if (url && /^https?:/.test(url)) await this.navigate(tab, url)
      this.onShown(agentId, true)
      return { url: tab.url, title: '', shown: true }
    }
    if (op === 'hide') {
      const t = this.tabs.get(agentId)
      if (t?.headed) this.handBack(agentId, t.url)
      return { url: t?.url ?? '', title: '', shown: false }
    }

    const tab = await this.tab(agentId)
    const here = async (frame: boolean, at?: { x: number; y: number }): Promise<BrowserReply> => {
      const { w, h, ...info } = await tab
        .run<{ url: string; title: string; w: number; h: number }>('({ url: location.href, title: document.title, w: innerWidth, h: innerHeight })')
        .catch(() => ({ url: tab.url, title: '', w: 0, h: 0 }))
      const point = at && w && h ? { x: at.x / w, y: at.y / h } : undefined
      return { ...info, shown: tab.inView, ...(point ? { point } : {}), ...(frame ? { frame: await this.frame(tab) } : {}) }
    }

    switch (op) {
      case 'open': {
        const url = String(args['url'] ?? '')
        if (!/^https?:\/\//.test(url)) throw new Error(L('Só endereços http e https.', 'Only http and https addresses.'))
        await this.navigate(tab, url)
        return here(true)
      }
      case 'snapshot':
        return { ...(await tab.run<BrowserReply>(SNAPSHOT)), shown: tab.inView }
      case 'click': {
        const at = typeof args['ref'] === 'number' ? await tab.run<{ x: number; y: number } | null>(POINT(args['ref'], false)) : { x: Number(args['x']), y: Number(args['y']) }
        if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error(L('Esse elemento não está mais na página. Leia a página de novo.', 'That element is no longer on the page. Read the page again.'))
        await wait(80)
        await this.click(tab, at.x, at.y)
        await this.settle(tab)
        return here(true, at)
      }
      case 'type': {
        const ref = Number(args['ref'])
        const text = String(args['text'] ?? '')
        const at = await tab.run<{ x: number; y: number; select: boolean } | null>(POINT(ref, false))
        if (!at) throw new Error(L('Esse campo não está mais na página. Leia a página de novo.', 'That field is no longer on the page. Read the page again.'))
        if (at.select) {
          const r = await tab.run<true | string[]>(PICK(ref, text))
          if (r !== true) throw new Error(L(`Essa lista não tem "${text}". As opções são: ${r.join(', ')}.`, `That list doesn't have "${text}". The options are: ${r.join(', ')}.`))
        } else {
          await wait(80)
          await this.click(tab, at.x, at.y)
          await wait(120)
          await tab.run(POINT(ref, true)) // focus, and select what's there so the text replaces it
          await tab.cmd('Input.insertText', { text })
          await wait(150)
        }
        if (args['enter'] === true) await this.key(tab, 'enter')
        await this.settle(tab)
        return here(true, at)
      }
      case 'fill': {
        // A saved login (navegador_login): checked in the page right before typing, on that exact origin
        // and, for a password, in a password field. Errors never carry the text: it may be the password.
        // The last word on extensions, whatever led here: this process has none, or nothing is typed.
        if (tab.carriesExtensions) throw new Error(extensionsRefusal())
        const ref = Number(args['ref'])
        const text = String(args['text'] ?? '')
        const password = args['password'] === true
        const check = (focus: boolean): string => FILL(ref, String(args['origin'] ?? ''), password, focus, password && focus ? text : '')
        const at = await tab.run<{ x: number; y: number } | string>(check(false))
        if (typeof at === 'string') throw new Error(fillRefused(at))
        await wait(80)
        await this.click(tab, at.x, at.y)
        await wait(120)
        const again = await tab.run<{ x: number; y: number } | string>(check(true))
        if (typeof again === 'string') throw new Error(fillRefused(again))
        await tab.cmd('Input.insertText', { text })
        await wait(150)
        await this.settle(tab)
        return here(true, at)
      }
      case 'key': {
        const key = String(args['key'] ?? '').toLowerCase().replace(/[^a-z]/g, '')
        if (!KEYS[key]) throw new Error(L(`Tecla desconhecida. Use uma destas: ${Object.keys(KEYS).join(', ')}.`, `Unknown key. Use one of these: ${Object.keys(KEYS).join(', ')}.`))
        await this.key(tab, key)
        await this.settle(tab)
        return here(true)
      }
      case 'scroll':
        await tab.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: 0, deltaY: Number(args['dy'] ?? 600) })
        await wait(500)
        return here(true)
      case 'back': {
        const h = (await tab.cmd('Page.getNavigationHistory')) as { currentIndex: number; entries: { id: number }[] }
        const prev = h.entries[h.currentIndex - 1]
        if (prev) await tab.cmd('Page.navigateToHistoryEntry', { entryId: prev.id })
        await this.settle(tab)
        return here(true)
      }
      case 'text':
        return { ...(await here(false)), text: await tab.run<string>(TEXT).catch(() => '') }
      case 'frame':
        return here(true)
    }
    throw new Error(L(`operação desconhecida: ${op}`, `unknown operation: ${op}`))
  }

  // A page opened, with one retry behind it. Chrome can cancel the very first navigation a fresh lane is
  // handed by its own startup: the provisional load stops, no page is committed, and the agent is given
  // about:blank as if the site had nothing on it — it reads nothing, clicks nothing, and the session is
  // spent finding out the page was never there. Measured on this computer, 2026-11-22, over a page served
  // from this machine: on Chrome for Testing 158.0.8127.36 — the browser a lane with the add-ons runs as —
  // 5 first opens of 6 landed on about:blank and 0 of 6 did with this second go, while the branded Chrome
  // of a lane with nothing switched on missed none. The retry asks for the same address, and only while
  // the browser is still on about:blank: a site that redirected somewhere of its own is left alone.
  private async navigate(tab: Tab, url: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const r = (await tab.cmd('Page.navigate', { url })) as { errorText?: string }
      if (r.errorText && !/ERR_ABORTED/.test(r.errorText)) throw new Error(L(`não abriu: ${r.errorText}`, `didn't open: ${r.errorText}`))
      await this.settle(tab)
      const at = await tab.run<string>('location.href').catch(() => '')
      if (at !== 'about:blank' || attempt > 0) return
    }
  }

  private async click(tab: Tab, x: number, y: number): Promise<void> {
    const p = { x: Math.round(x), y: Math.round(y) }
    await tab.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    await tab.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
    await tab.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 })
  }

  // A picture of a page (a service an agent started), where there's no Electron
  // to take it (Tucano as a server): a throwaway headless Chrome of its own, no
  // cookies from anything else, sized as asked, the whole page when asked.
  async shot(o: { url: string; width: number; height: number; fullPage: boolean }): Promise<Buffer> {
    if (!/^https?:\/\//.test(o.url)) throw new Error(L('só http e https', 'only http and https'))
    const id = `.shot-${process.pid}-${Date.now()}`
    const tab = await this.launch(id, false)
    try {
      const size = (height: number): Promise<unknown> => tab.cmd('Emulation.setDeviceMetricsOverride', { width: o.width, height, deviceScaleFactor: 1, mobile: false })
      await size(o.height)
      await Promise.race([this.navigate(tab, o.url), wait(30_000).then(() => Promise.reject(new Error(L('a página não carregou em 30 s', "the page didn't load in 30 s"))))])
      await wait(800) // fonts, charts and client-side rendering
      if (o.fullPage) {
        const h = await tab.run<number>('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)').catch(() => 0)
        if (h > o.height) {
          await size(Math.min(h, 6000))
          await wait(600)
        }
      }
      const r = (await tab.cmd('Page.captureScreenshot', { format: 'png' })) as { data?: string }
      if (!r.data) throw new Error(L('o Chrome não devolveu a imagem', "Chrome returned no image"))
      return Buffer.from(r.data, 'base64')
    } finally {
      tab.close()
      await gone(tab.proc)
      // Windows lets go of a closed Chrome's files a moment late; a leftover is only a temp folder.
      try {
        rmSync(this.profile(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch {}
    }
  }

  // What I do from the panel: a click where I clicked on the picture, what I
  // typed, a key, the wheel.
  private async input(tab: Tab, i: BrowserInput): Promise<void> {
    if (i.kind === 'click') {
      const { w, h } = await tab.run<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })')
      const x = Math.min(Math.max(Number(i.x), 0), 1)
      const y = Math.min(Math.max(Number(i.y), 0), 1)
      return this.click(tab, x * w, y * h)
    }
    if (i.kind === 'text') {
      if (i.text) await tab.cmd('Input.insertText', { text: String(i.text).slice(0, 10_000) })
      return
    }
    if (i.kind === 'key') {
      const name = String(i.key).toLowerCase()
      if (KEYS[name]) await this.key(tab, name)
      return
    }
    if (i.kind === 'scroll') {
      const { w, h } = await tab.run<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })').catch(() => ({ w: W, h: H }))
      await tab.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: w / 2, y: h / 2, deltaX: 0, deltaY: Math.max(-3000, Math.min(3000, Number(i.dy) || 0)) })
    }
  }

  private async key(tab: Tab, name: string): Promise<void> {
    const k = KEYS[name]!
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk }
    await tab.cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text ? { text: k.text } : {}) })
    await tab.cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  // Lets what an action started finish: a navigation, a request, a re-render.
  private async settle(tab: Tab): Promise<void> {
    await wait(300)
    for (let i = 0; i < 30; i++) {
      const state = await tab.run<string>('document.readyState').catch(() => 'loading')
      if (state === 'complete') break
      await wait(500)
    }
    await wait(400)
  }

  // Never waits more than 5 s: a page that can't be painted gives no frame, not a stuck agent.
  private async frame(tab: Tab): Promise<string | undefined> {
    await tab.run(HIDE_SECRETS).catch(() => {}) // a saved password shown ("show password") goes back to dots first
    const r = (await Promise.race([tab.cmd('Page.captureScreenshot', { format: 'jpeg', quality: 70 }).catch(() => null), wait(5000).then(() => null)])) as { data?: string } | null
    return r?.data
  }
}

const extensionsRefusal = (): string =>
  L(
    'Este navegador está com extensões, e elas leem o que é digitado na página: o login do Cofre não foi preenchido. Peça pra fechar a janela do navegador e tente de novo.',
    'This browser has extensions in it, and they read what is typed on the page: the Cofre login was not filled in. Ask for the browser window to be closed, then try again.'
  )

export const hasChrome = (bin = CHROME): boolean => !!bin && existsSync(bin)

// A PDF link downloads instead of opening in Chrome's viewer, where the agent couldn't take the file.
// Chrome reads its preferences on start; a file it can't parse is left as it is.
export function pdfsDownload(profile: string): void {
  const file = join(profile, 'Default', 'Preferences')
  try {
    const prefs = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as { plugins?: Record<string, unknown> }
    if (prefs.plugins?.['always_open_pdf_externally'] === true) return
    prefs.plugins = { ...prefs.plugins, always_open_pdf_externally: true }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(prefs))
  } catch {}
}
