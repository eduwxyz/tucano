// Each agent's browser (spec §24): a hidden window of Electron's Chromium with
// a session of its own, so its logins stay apart from everything else and last
// between conversations. The core decides what to do; this file only drives the
// page and reports back. "Assumir" shows the same window so I can log in.
// One window per (agent, conversation) — the same person with two tabs, one
// per thread — while the logins stay in the agent's session.
import { BrowserWindow, session, type WebContents } from 'electron'
import { POINT, PICK, SNAPSHOT, TEXT } from '../shared/page'
import type { BrowserOp, BrowserReply as Reply } from '../shared/types'

const W = 1280
const H = 800
const WORLD = 1001 // an isolated world: same DOM, but the page can't see or touch our variables
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const KEYS: Record<string, { code: string; char?: string }> = {
  enter: { code: 'Enter', char: '\r' },
  escape: { code: 'Escape' },
  tab: { code: 'Tab' },
  backspace: { code: 'Backspace' },
  space: { code: 'Space', char: ' ' },
  arrowdown: { code: 'Down' },
  arrowup: { code: 'Up' },
  arrowleft: { code: 'Left' },
  arrowright: { code: 'Right' },
  pagedown: { code: 'PageDown' },
  pageup: { code: 'PageUp' }
}

const keyOf = (agentId: string, conversationId: string): string => `${agentId}::${conversationId}`

export class Browsers {
  private wins = new Map<string, BrowserWindow>() // by view key: one window per (agent, conversation)
  private reopening = new Map<string, Promise<void>>()
  private quitting = false

  constructor(private onShown: (key: string, shown: boolean) => void) {}

  quit(): void {
    this.quitting = true
    for (const w of this.wins.values()) w.destroy()
    this.wins.clear()
  }

  private partition(agentId: string): string {
    return `persist:navegador-${agentId}`
  }

  private win(agentId: string, key: string): BrowserWindow {
    const existing = this.wins.get(key)
    if (existing && !existing.isDestroyed()) return existing
    const ses = session.fromPartition(this.partition(agentId))
    // A plain Chrome, as far as sites can tell: some refuse logins in "embedded" browsers.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(agent-desk|Tucano|Electron)\/\S+/g, ''))
    ses.setPermissionRequestHandler((_wc, _perm, done) => done(false)) // no camera, mic, location, notifications
    ses.on('will-download', (_e, item) => item.cancel())
    const win = new BrowserWindow({
      show: false,
      width: W,
      height: H,
      useContentSize: true,
      title: 'Navegador',
      webPreferences: { partition: this.partition(agentId), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    // New tabs open in place while the agent drives; as real windows while I do.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (win.isVisible()) return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: this.partition(agentId), sandbox: true } } }
      if (/^https?:\/\//.test(url)) void win.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    // Closing it hands the browser back to the agent; it keeps its page and logins.
    win.on('close', (e) => {
      if (this.quitting) return
      e.preventDefault()
      win.hide()
      this.fresh(key, win)
    })
    win.on('hide', () => {
      this.onShown(key, false)
      setImmediate(() => this.fresh(key, win))
    })
    win.on('show', () => this.onShown(key, true))
    this.wins.set(key, win)
    return win
  }

  // A window that was shown and hidden again stops painting (captures fail or
  // hang), so handing it back swaps it for a new hidden one on the same page.
  // The logins live in the session, so they stay.
  private fresh(key: string, old: BrowserWindow): void {
    if (this.quitting || this.wins.get(key) !== old) return
    const url = old.webContents.getURL()
    this.wins.delete(key) // from now on every action goes to the new window
    setImmediate(() => old.destroy())
    this.onShown(key, false)
    const wc = this.win(key.split('::')[0]!, key).webContents
    const p = /^https?:/.test(url) ? wc.loadURL(url).catch(() => {}).then(() => this.settle(wc)) : Promise.resolve()
    this.reopening.set(key, p)
    void p.finally(() => this.reopening.get(key) === p && this.reopening.delete(key))
  }

  async run(agentId: string, conversationId: string, op: BrowserOp, args: Record<string, unknown> = {}): Promise<Reply> {
    const key = keyOf(agentId, conversationId)
    if (op === 'close' || op === 'clear') {
      for (const [k, w] of [...this.wins]) if (k.split('::')[0] === agentId) (this.wins.delete(k), w.destroy())
      if (op === 'clear') await session.fromPartition(this.partition(agentId)).clearData()
      return { url: '', title: '' }
    }
    const win = this.win(agentId, key)
    const wc = win.webContents
    const iso = <T>(code: string): Promise<T> => wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>
    const here = (): Reply => ({ url: wc.getURL(), title: wc.getTitle(), shown: win.isVisible() })
    const point = (at: { x: number; y: number }): Reply['point'] => {
      const [w, h] = win.getContentSize() as [number, number]
      return { x: at.x / w, y: at.y / h }
    }

    switch (op) {
      case 'show':
        if (typeof args['title'] === 'string') win.setTitle(args['title'])
        win.show()
        win.focus()
        return here()
      case 'hide':
        win.hide()
        this.fresh(key, win)
        return { url: wc.getURL(), title: wc.getTitle(), shown: false }
      case 'open': {
        const url = String(args['url'] ?? '')
        if (!/^https?:\/\//.test(url)) throw new Error('Só endereços http e https.')
        await Promise.race([
          wc.loadURL(url).catch((e: Error) => {
            // A redirect or a page that changes itself aborts the first load; the page still comes.
            if (!/ERR_ABORTED/.test(e.message)) throw e
          }),
          wait(30_000)
        ])
        await this.settle(wc)
        return { ...here(), frame: await this.frame(win) }
      }
      case 'snapshot':
        return { ...(await iso<Reply>(SNAPSHOT)), shown: win.isVisible() }
      case 'click': {
        const at = typeof args['ref'] === 'number' ? await iso<{ x: number; y: number } | null>(POINT(args['ref'], false)) : { x: Number(args['x']), y: Number(args['y']) }
        if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error('Esse elemento não está mais na página. Leia a página de novo.')
        await wait(80) // after scrolling it into view
        this.click(wc, at.x, at.y)
        await this.settle(wc)
        return { ...here(), point: point(at), frame: await this.frame(win) }
      }
      case 'type': {
        const ref = Number(args['ref'])
        const text = String(args['text'] ?? '')
        const at = await iso<{ x: number; y: number; select: boolean } | null>(POINT(ref, false))
        if (!at) throw new Error('Esse campo não está mais na página. Leia a página de novo.')
        if (at.select) {
          const r = await iso<true | string[]>(PICK(ref, text))
          if (r !== true) throw new Error(`Essa lista não tem "${text}". As opções são: ${r.join(', ')}.`)
        } else {
          await wait(80)
          this.click(wc, at.x, at.y)
          await wait(120)
          await iso(POINT(ref, true)) // focus, and select what's there so the text replaces it
          await wc.insertText(text)
          await wait(150) // the page reacts to the input (autocomplete, validation) before Enter
        }
        if (args['enter'] === true) this.key(wc, 'enter')
        await this.settle(wc)
        return { ...here(), point: point(at), frame: await this.frame(win) }
      }
      case 'key': {
        const key2 = String(args['key'] ?? '').toLowerCase().replace(/[^a-z]/g, '')
        if (!KEYS[key2]) throw new Error(`Tecla desconhecida. Use uma destas: ${Object.keys(KEYS).join(', ')}.`)
        this.key(wc, key2)
        await this.settle(wc)
        return { ...here(), frame: await this.frame(win) }
      }
      case 'scroll': {
        const [w, h] = win.getContentSize() as [number, number]
        wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: -Number(args['dy'] ?? 600) })
        await wait(500)
        return { ...here(), frame: await this.frame(win) }
      }
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
        await this.settle(wc)
        return { ...here(), frame: await this.frame(win) }
      case 'text':
        return { ...here(), text: wc.getURL() === '' ? '' : await iso<string>(TEXT) }
      case 'frame':
        return { ...here(), frame: await this.frame(win) }
    }
  }

  private click(wc: WebContents, x: number, y: number): void {
    const p = { x: Math.round(x), y: Math.round(y) }
    wc.sendInputEvent({ type: 'mouseMove', ...p })
    wc.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 })
  }

  private key(wc: WebContents, name: string): void {
    const k = KEYS[name]!
    wc.sendInputEvent({ type: 'keyDown', keyCode: k.code })
    if (k.char) wc.sendInputEvent({ type: 'char', keyCode: k.char })
    wc.sendInputEvent({ type: 'keyUp', keyCode: k.code })
  }

  // Lets what an action started finish: a navigation, a request, a re-render.
  private async settle(wc: WebContents): Promise<void> {
    await wait(300)
    if (wc.isLoading()) await Promise.race([new Promise<void>((r) => wc.once('did-stop-loading', () => r())), wait(15_000)])
    await wait(400)
  }

  // Never waits more than 5 s: a page that can't be painted gives no frame, not a stuck agent.
  private async frame(win: BrowserWindow): Promise<string | undefined> {
    let img = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }).catch(() => null), wait(5000).then(() => null)])
    if (!img || img.isEmpty()) return undefined
    if (img.getSize().width > W) img = img.resize({ width: W, quality: 'good' })
    return img.toJPEG(70).toString('base64')
  }
}
