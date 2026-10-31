// An agent's browser as a real Google Chrome (spec §24), when the Mac has one.
// Google refuses logins in embedded browsers (Electron's included) and binds
// its sessions to the Chrome that made them, so the agent's browser is Chrome
// itself, with a profile of its own: headless while the agent drives it,
// a normal window when I take over ("Assumir"). Driven over the DevTools
// protocol; the page scripts are the same as in the Electron fallback. The
// screen streams to the app while it changes, so the panel is a live view.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { L } from '../shared/lang'
import { findChrome, userAgentPlatform } from './platform'
import { POINT, PICK, SNAPSHOT, TEXT } from '../shared/page'
import type { BrowserInput, BrowserOp, BrowserReply } from '../shared/types'

// Google Chrome on this computer, where it usually is on each system (see platform.ts).
export const CHROME = findChrome()

const W = 1280
const H = 800
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
// Chrome takes a moment to let go of its profile; a new one started before that just hands over to it.
async function gone(proc: ChildProcess, ms = 10_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill()
  await Promise.race([new Promise((r) => proc.once('exit', r)), wait(ms)])
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

// One Chrome process and its DevTools connection, following one tab.
class Tab {
  private ws!: WebSocket
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

  async connect(port: string): Promise<void> {
    const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
    this.ws = new WebSocket(webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', () => reject(new Error(L('o Chrome não aceitou a conexão', "Chrome didn't accept the connection"))), { once: true })
    })
    this.ws.addEventListener('message', (e) => this.onMessage(JSON.parse(String(e.data)) as Record<string, unknown>))
    this.ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(L('o Chrome fechou', 'Chrome closed')))
      this.pending.clear()
    })
    await this.send('Target.setDiscoverTargets', { discover: true })
    const { targetInfos } = (await this.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string; url: string }[] }
    const page = targetInfos.find((t) => t.type === 'page')
    await this.follow(page ? page.targetId : ((await this.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }).targetId)
  }

  send(method: string, params: Record<string, unknown> = {}, session = ''): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.n
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
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
    try {
      this.ws.close()
    } catch {}
  }
}

export class ChromeBrowsers {
  private tabs = new Map<string, Tab>()
  private starting = new Map<string, Promise<Tab>>()
  private handingBack = new Set<string>()

  constructor(
    private dir: string, // profiles live in <dir>/<agentId>
    private onShown: (agentId: string, shown: boolean) => void,
    private bin: string = CHROME ?? '',
    private onFrame?: OnFrame,
    // No screen to open a window on (Tucano as a server): taking over keeps it
    // headless and I drive it from the panel, through 'input'.
    private windowless = false
  ) {
    process.on('exit', () => this.quit())
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
    rmSync(join(profile, 'DevToolsActivePort'), { force: true })
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--disable-blink-features=AutomationControlled', // navigator.webdriver stays false, as in any Chrome
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--deny-permission-prompts',
      `--window-size=${W},${H}`,
      ...(headed ? ['--new-window'] : ['--headless=new', '--mute-audio']),
      url && /^https?:/.test(url) ? url : 'about:blank'
    ]
    const proc = spawn(this.bin, args, { stdio: 'ignore' })
    let port = ''
    for (let i = 0; i < 75 && !port; i++) {
      await wait(200)
      if (proc.exitCode !== null) throw new Error(L('o Chrome fechou logo ao abrir', 'Chrome closed right after opening'))
      try {
        port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] ?? ''
      } catch {}
    }
    if (!port) {
      proc.kill()
      throw new Error(L('o Chrome não abriu em 15 s', "Chrome didn't open in 15 s"))
    }
    const onFrame = this.onFrame
    const tab = new Tab(proc, headed, onFrame && ((jpeg) => onFrame(agentId, jpeg)))
    await tab.connect(port)
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

  // The agent's Chrome, headless, started when first needed.
  private async tab(agentId: string): Promise<Tab> {
    const t = this.tabs.get(agentId)
    if (t) return t
    const going = this.starting.get(agentId)
    if (going) return going
    const p = this.launch(agentId, false).finally(() => this.starting.delete(agentId))
    this.starting.set(agentId, p)
    return p
  }

  // I'm done with the window: back to headless, on the page I left.
  private handBack(agentId: string, url: string): void {
    if (this.handingBack.has(agentId)) return
    this.handingBack.add(agentId)
    const t = this.tabs.get(agentId)
    if (t?.headed) {
      this.tabs.delete(agentId)
      t.close()
    }
    const p = (t?.headed ? gone(t.proc) : Promise.resolve())
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
    if (op === 'close' || op === 'clear') {
      const t = this.tabs.get(agentId)
      this.tabs.delete(agentId)
      t?.close()
      if (t) await gone(t.proc)
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
        current.close()
        await gone(current.proc)
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
