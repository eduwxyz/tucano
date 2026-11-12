// An agent's browser as a real Google Chrome (spec §24), when the Mac has one.
// Google refuses logins in embedded browsers (Electron's included) and binds
// its sessions to the Chrome that made them, so the agent's browser is Chrome
// itself, with a profile of its own: headless while the agent drives it,
// a normal window when I take over ("Assumir"). Driven over the DevTools
// protocol; the page scripts are the same as in the Electron fallback. The
// screen streams to the app while it changes, so the panel is a live view.
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { existsSync, mkdirSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { L } from '../shared/lang'
import { chromeKeyringFlags, findChrome, userAgentPlatform } from './platform'
import { POINT, PICK, SNAPSHOT, TEXT } from '../shared/page'
import type { BrowserInput, BrowserOp, BrowserReply } from '../shared/types'

// Google Chrome on this computer, where it usually is on each system (see platform.ts).
export const CHROME = findChrome()

const W = 1280
const H = 800
// How long a first open gets before it's called failed. Generous on purpose: a cold Chrome
// on a slow or loaded machine (a server, CI) is the slowest thing here, and a person only
// ever waits on a Chrome that is never going to answer.
const OPEN_TIMEOUT_MS = 90_000
const FRAME_MS = 150 // at most ~6 frames a second while someone watches
const IDLE_MS = 2000 // and one every 2 s otherwise: an animated page left open costs little
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
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
  remote = false // I'm driving it from the panel (no window: Tucano as a server)

  constructor(
    readonly proc: ChildProcess,
    readonly headed: boolean,
    private onFrame?: (jpeg: string) => boolean
  ) {}

  // Chrome reads commands on its fd 3 and writes on fd 4, each message ending in a NUL.
  private get input(): Writable {
    return this.proc.stdio[3] as Writable
  }

  async connect(): Promise<void> {
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
    await this.send('Target.setDiscoverTargets', { discover: true })
    const { targetInfos } = (await this.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string; url: string }[] }
    const page = targetInfos.find((t) => t.type === 'page')
    await this.follow(page ? page.targetId : ((await this.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }).targetId)
  }

  send(method: string, params: Record<string, unknown> = {}, session = ''): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.n
      if (this.closed) return reject(new Error(L('o Chrome fechou', 'Chrome closed')))
      this.pending.set(id, { resolve, reject })
      this.input.write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0')
      setTimeout(() => this.pending.get(id) && (this.pending.delete(id), reject(new Error(L(`o Chrome não respondeu (${method})`, `Chrome didn't answer (${method})`)))), 30_000).unref()
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

export class ChromeBrowsers {
  private tabs = new Map<string, Tab>()
  private starting = new Map<string, Promise<Tab>>()
  private handingBack = new Set<string>()
  private used = new Map<string, number>() // when each agent last asked its Chrome for something
  private busy = new Map<string, number>() // what it's doing right now
  private resumeAt = new Map<string, string>() // the page a Chrome closed for idling was on
  private closing = new Map<string, Promise<void>>() // a Chrome closed for idling, still writing its cookies

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
    private idleMs?: number
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
    for (const t of this.tabs.values()) t.proc.kill()
    this.tabs.clear()
  }

  private profile(agentId: string): string {
    return join(this.dir, agentId)
  }

  private async launch(agentId: string, headed: boolean, url?: string): Promise<Tab> {
    const profile = this.profile(agentId)
    mkdirSync(profile, { recursive: true })
    // A Chrome left behind (the app crashed) still holds the profile: a new one would just hand over to it.
    try {
      const pid = Number(readlinkSync(join(profile, 'SingletonLock')).split('-').pop())
      if (pid && alive(pid)) {
        process.kill(pid)
        for (let i = 0; i < 50 && alive(pid); i++) await wait(200)
      }
    } catch {}
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
      ...(headed ? ['--new-window'] : ['--headless=new', '--mute-audio']),
      url && /^https?:/.test(url) ? url : 'about:blank'
    ]
    const proc = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    const onFrame = this.onFrame
    const tab = new Tab(proc, headed, onFrame && ((jpeg) => onFrame(agentId, jpeg)))
    let timer: ReturnType<typeof setTimeout> | undefined
    const failed = new Promise<never>((_, reject) => {
      proc.once('exit', () => reject(new Error(L('o Chrome fechou logo ao abrir', 'Chrome closed right after opening'))))
      // The first open on a computer can be slow, with nothing of Chrome in memory yet. As long as any other answer gets (see send).
      // 90 s, not 30: a cold Chrome with a brand-new profile took 22 s on GitHub's Windows runner and
      // more than 30 s on its Ubuntu one, while the very next open on the same machine took 6 s.
      // Nothing is waited on here that a person sees: the first answer returns the moment Chrome speaks.
      timer = setTimeout(() => reject(new Error(L('o Chrome não abriu em 90 s', "Chrome didn't open in 90 s"))), OPEN_TIMEOUT_MS)
    })
    try {
      await Promise.race([tab.connect(), failed])
    } catch (e) {
      proc.kill()
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
    return tab
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
    if (t) return t
    const going = this.starting.get(agentId)
    if (going) return going
    const back = this.resumeAt.get(agentId)
    this.resumeAt.delete(agentId)
    const closing = this.closing.get(agentId)
    const p = (closing ? closing.then(() => this.launch(agentId, false, back)) : this.launch(agentId, false, back))
      .then(async (tab) => {
        if (back) await this.settle(tab)
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
    const p = (t?.headed ? this.shutDown(t) : Promise.resolve())
      .then(() => this.launch(agentId, false, url))
      .then(async (tab) => {
        await this.settle(tab)
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

  async run(agentId: string, op: BrowserOp, args: Record<string, unknown> = {}): Promise<BrowserReply> {
    this.used.set(agentId, Date.now())
    this.busy.set(agentId, (this.busy.get(agentId) ?? 0) + 1)
    try {
      return await this.runOp(agentId, op, args)
    } finally {
      this.busy.set(agentId, (this.busy.get(agentId) ?? 1) - 1)
      this.used.set(agentId, Date.now())
    }
  }

  private async runOp(agentId: string, op: BrowserOp, args: Record<string, unknown>): Promise<BrowserReply> {
    if (op === 'close' || op === 'clear') {
      this.resumeAt.delete(agentId)
      const t = this.tabs.get(agentId)
      this.tabs.delete(agentId)
      if (t && op === 'close') await this.shutDown(t)
      else if (t) {
        t.close()
        await gone(t.proc)
      }
      if (op === 'clear') {
        rmSync(this.profile(agentId), { recursive: true, force: true })
      }
      return { url: '', title: '' }
    }
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
    if (op === 'show') {
      const current = this.tabs.get(agentId) ?? (await this.starting.get(agentId))
      if (current?.headed) return { url: current.url, title: '', shown: true }
      const url = current?.url
      if (current) {
        this.tabs.delete(agentId)
        await this.shutDown(current)
      }
      const tab = await this.launch(agentId, true, url)
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
      return { ...info, shown: tab.headed || tab.remote, ...(point ? { point } : {}), ...(frame ? { frame: await this.frame(tab) } : {}) }
    }

    switch (op) {
      case 'open': {
        const url = String(args['url'] ?? '')
        if (!/^https?:\/\//.test(url)) throw new Error(L('Só endereços http e https.', 'Only http and https addresses.'))
        const r = (await tab.cmd('Page.navigate', { url })) as { errorText?: string }
        if (r.errorText && !/ERR_ABORTED/.test(r.errorText)) throw new Error(L(`não abriu: ${r.errorText}`, `didn't open: ${r.errorText}`))
        await this.settle(tab)
        return here(true)
      }
      case 'snapshot':
        return { ...(await tab.run<BrowserReply>(SNAPSHOT)), shown: tab.headed || tab.remote }
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
      await Promise.race([tab.cmd('Page.navigate', { url: o.url }), wait(30_000).then(() => Promise.reject(new Error(L('a página não carregou em 30 s', "the page didn't load in 30 s"))))])
      await this.settle(tab)
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
    const r = (await Promise.race([tab.cmd('Page.captureScreenshot', { format: 'jpeg', quality: 70 }).catch(() => null), wait(5000).then(() => null)])) as { data?: string } | null
    return r?.data
  }
}

export const hasChrome = (bin = CHROME): boolean => !!bin && existsSync(bin)
