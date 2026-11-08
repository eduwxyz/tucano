// Tucanos on servers (docs/server.md), shown in the app's own window: picking one puts its page
// over the app, under a bar the app draws (BAR px) to go back. The page is in a view of its own,
// which brings its own bridge to its core over HTTP: it never gets this app's preload, so a server,
// even one taken over, can't reach this computer through it. Each server keeps its own session
// (cookies, storage), apart from this app's and from the others'.
import { BrowserWindow, dialog, session, shell, WebContentsView, type MenuItemConstructorOptions, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { L } from '../shared/lang'
import { isOutsideLink } from '../shared/links'
import { isPreviewOf, onServer, pairProblem, parsePairing, serverName } from '../shared/servers'
import { redeemCode, thisDevice } from './redeem'

interface Saved {
  id: string
  origin: string
  token: string // sealed with the system's keychain
  open?: boolean // it was on screen when the app last quit: it comes back there
}

// The app's bar above a server's page (the renderer's ServerBar): where to go back.
export const BAR = 40

// What the app's own page sees of a server: never its token.
export interface ServerInfo {
  id: string
  name: string
  origin: string
  open: boolean // on screen now, in the app's window
}

// paired; cancelled (the person said no); invalid (not a pairing link); unsafe (nowhere safe to keep it);
// used (a one-time code already spent or past its time); unreachable (the server didn't answer)
export type PairResult = 'paired' | 'cancelled' | 'invalid' | 'unsafe' | 'used' | 'unreachable'

export interface ServersDeps {
  dataDir: () => string
  seal: (text: string) => string | null // null: this computer can't keep it safely
  unseal: (sealed: string) => string | null
  changed: () => void // the menus and the app's page list the servers, and which is on screen
  window: () => BrowserWindow | null // the app's window, where a server is shown
  showLocal: () => void // the app's window, on screen
}

// What a server's page may ask for: notifications, writing to the clipboard, the microphone for
// dictation (audio only), full screen. Never the camera, the screen, files, devices or the location.
function guard(ses: Session, origin: string): void {
  ses.setPermissionRequestHandler((_c, permission, done, details) => {
    if (!onServer((details as { requestingUrl?: string }).requestingUrl ?? '', origin)) return done(false)
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      return done(types.length > 0 && types.every((t) => t === 'audio'))
    }
    done(['notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission))
  })
  ses.setPermissionCheckHandler((_c, permission, requestingOrigin) => requestingOrigin === origin && ['notifications', 'clipboard-sanitized-write', 'media', 'fullscreen'].includes(permission))
  ses.setDevicePermissionHandler(() => false)
}

export class Servers {
  private views = new Map<string, WebContentsView>() // kept while the app runs: going back and forth is instant
  private active: string | null = null // the server on screen; null: this computer
  private host: BrowserWindow | null = null // the window the view is in now
  private guarded = new WeakSet<Session>()
  private quitting = false

  constructor(private deps: ServersDeps) {}

  private file(): string {
    return join(this.deps.dataDir(), 'servers.json')
  }

  list(): Saved[] {
    try {
      const l = JSON.parse(readFileSync(this.file(), 'utf8')) as Saved[]
      return Array.isArray(l) ? l.filter((s) => s && typeof s.id === 'string' && typeof s.origin === 'string' && typeof s.token === 'string') : []
    } catch {
      return []
    }
  }

  private save(list: Saved[]): void {
    writeFileSync(this.file(), JSON.stringify(list, null, 2), { mode: 0o600 })
    this.deps.changed()
  }

  summary(): ServerInfo[] {
    return this.list().map((s) => ({ id: s.id, name: serverName(s.origin), origin: s.origin, open: this.active === s.id }))
  }

  // A pairing link from outside the app (the system, the menu's clipboard): it says so when it isn't one.
  async pairFromOutside(link: string): Promise<void> {
    const r = await this.pair(link, true)
    if (r !== 'invalid' && r !== 'used' && r !== 'unreachable') return
    const { title, detail } = pairProblem(r)
    await dialog.showMessageBox({ type: 'warning', message: title, detail })
  }


  // A pairing link. One from outside the app may come from any web page (it can make the system
  // hand one over), so the person is asked first, with the address in plain sight. One pasted in
  // Settings was put there by the person, who reads the same warning on that screen.
  async pair(link: string, ask: boolean): Promise<PairResult> {
    const p = parsePairing(link)
    if (!p) return 'invalid'
    const name = serverName(p.origin)
    const { response } = !ask ? { response: 0 } : await dialog.showMessageBox({
      type: 'question',
      buttons: [L('Conectar', 'Connect'), L('Cancelar', 'Cancel')],
      defaultId: 0,
      cancelId: 1,
      message: L(`Conectar ao Tucano em ${name}?`, `Connect to the Tucano at ${name}?`),
      detail: L(
        'Esse link dá acesso a um Tucano num servidor: quem tem o link controla os agentes de lá. Conecte só se foi você quem criou esse servidor ou se confia em quem mandou o link.',
        'This link gives access to a Tucano on a server: whoever has it controls the agents there. Connect only if you made that server or trust whoever sent the link.'
      )
    })
    if (response !== 0) return 'cancelled'
    // A one-time code is spent here, after the click, never by opening the link: a key of this
    // computer's own comes back, and it signs in the way the server's token would.
    let token: string
    if ('code' in p) {
      const r = await redeemCode(p.origin, p.code, thisDevice(hostname(), process.platform))
      if ('error' in r) return r.error
      token = r.key
    } else token = p.token
    const sealed = this.deps.seal(token)
    if (!sealed) {
      await dialog.showMessageBox({
        type: 'error',
        message: L('Não dá pra guardar esse acesso com segurança aqui', "This access can't be kept safely here"),
        detail: L('O cofre de senhas do sistema não está disponível. Abra o endereço no navegador por enquanto.', "The system's password store isn't available. Open the address in a browser for now.")
      })
      return 'unsafe'
    }
    const list = this.list()
    const known = list.find((s) => s.origin === p.origin)
    // A new token for a server already here: its page starts again with it.
    if (known) this.drop(known.id)
    const id = known?.id ?? randomUUID()
    this.save([...list.filter((s) => s.origin !== p.origin), { id, origin: p.origin, token: sealed, open: true }])
    await this.show(id)
    return 'paired'
  }

  // A server on screen, in the app's window, over the app; made the first time, kept after.
  async show(id: string): Promise<void> {
    const s = this.list().find((x) => x.id === id)
    if (!s) return
    let view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) {
      const made = await this.make(s)
      if (!made) return
      view = made
    }
    this.active = id
    this.setOpen(id, true)
    this.place()
    this.deps.showLocal() // the window, in front
    view.webContents.focus()
    this.deps.changed()
  }

  // Back to this computer's Tucano, in the same window.
  showLocal(): void {
    if (this.active) this.setOpen(this.active, false)
    this.active = null
    this.place()
    this.deps.changed()
  }

  // The view on screen, or none, in the app's window as it is now (made again, resized).
  place(): void {
    const win = this.deps.window()
    if (this.host && this.host !== win && !this.host.isDestroyed()) for (const v of this.views.values()) this.host.contentView.removeChildView(v)
    this.host = win
    if (!win || win.isDestroyed()) return
    for (const [id, v] of this.views) if (id !== this.active) win.contentView.removeChildView(v)
    const view = this.active ? this.views.get(this.active) : undefined
    if (!view) return void win.setTitle('Tucano')
    const { width, height } = win.getContentBounds()
    view.setBounds({ x: 0, y: BAR, width, height: Math.max(0, height - BAR) })
    win.contentView.addChildView(view)
    const s = this.list().find((x) => x.id === this.active)
    if (s) win.setTitle(`Tucano · ${serverName(s.origin)}`)
  }

  private async make(s: Saved): Promise<WebContentsView | null> {
    const token = this.deps.unseal(s.token)
    if (!token) {
      console.error('[servers] the saved access could not be unsealed')
      void dialog.showMessageBox({ type: 'error', message: L('Não consegui abrir o acesso guardado', "Couldn't open the saved access"), detail: L('Conecte de novo com o link do servidor.', "Connect again with the server's link.") })
      return null
    }
    const ses = session.fromPartition(`persist:server-${s.id}`)
    if (!this.guarded.has(ses)) {
      guard(ses, s.origin)
      this.guarded.add(ses)
    }
    // Signed in the way the server's own link would: its cookie, so the token is never in an address.
    await ses.cookies.set({ url: s.origin, name: 'tucano', value: token, httpOnly: true, secure: s.origin.startsWith('https:'), sameSite: 'lax', expirationDate: Date.now() / 1000 + 365 * 86400 })
    const name = serverName(s.origin)
    const webPreferences = { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
    const view = new WebContentsView({ webPreferences })
    const wc = view.webContents
    this.views.set(s.id, view)
    // Only the server's own pages in this view. Web and mail links open in the system; anything
    // else (a local file, the app's own tucano: pages, another server) goes nowhere.
    // An agent's page, opened from the panel: in a window of this server's own session, where its
    // sign-in is (the system's browser hasn't signed in to the server).
    wc.setWindowOpenHandler(({ url }) => {
      if (onServer(url, s.origin) && new URL(url).pathname.startsWith('/preview/')) return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 760, title: `Tucano · ${name}`, webPreferences } }
      if (isOutsideLink(url) && !onServer(url, s.origin)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // That window goes only to the server and its preview addresses; the rest opens in the system.
    wc.on('did-create-window', (child) => {
      const keep = (event: { preventDefault: () => void }, url: string): void => {
        if (onServer(url, s.origin) || isPreviewOf(url, s.origin)) return
        event.preventDefault()
        if (isOutsideLink(url)) void shell.openExternal(url)
      }
      child.webContents.on('will-navigate', keep)
      child.webContents.on('will-redirect', keep)
      child.webContents.setWindowOpenHandler(({ url }) => {
        if (isOutsideLink(url) && !onServer(url, s.origin) && !isPreviewOf(url, s.origin)) void shell.openExternal(url)
        return { action: 'deny' }
      })
    })
    const stay = (event: { preventDefault: () => void }, url: string): void => {
      if (onServer(url, s.origin)) return
      event.preventDefault()
      if (isOutsideLink(url)) void shell.openExternal(url)
    }
    wc.on('will-navigate', stay)
    wc.on('will-redirect', stay)
    wc.on('will-attach-webview', (e) => e.preventDefault())
    wc.on('did-fail-load', (_e, code, _desc, url, mainFrame) => {
      if (!mainFrame || code === -3) return // -3: a navigation cut short, not a failure
      void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(unreachable(name, s.origin, url))}`)
    })
    wc.on('render-process-gone', () => {
      // Its page crashed: made again the next time it's picked.
      this.drop(s.id)
      if (this.active === s.id) this.showLocal()
    })
    // Not awaited: the view is there, its page comes as the server answers (or the page above says why not).
    void wc.loadURL(`${s.origin}/`).catch(() => {})
    return view
  }

  // A server's view, gone (forgotten, paired again, crashed).
  private drop(id: string): void {
    const v = this.views.get(id)
    if (!v) return
    this.views.delete(id)
    if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(v)
    if (!v.webContents.isDestroyed()) v.webContents.close()
  }

  private setOpen(id: string, open: boolean): void {
    const list = this.list()
    const s = list.find((x) => x.id === id)
    if (!s || !!s.open === open) return
    s.open = open
    writeFileSync(this.file(), JSON.stringify(list, null, 2), { mode: 0o600 })
  }

  // Forgetting a server: its window, its cookie and storage, its saved access. Settings asks in
  // its own dialog first; the menu asks here.
  async forget(id: string, ask: boolean): Promise<boolean> {
    const s = this.list().find((x) => x.id === id)
    if (!s) return false
    const { response } = !ask ? { response: 0 } : await dialog.showMessageBox({
      type: 'warning',
      buttons: [L('Esquecer', 'Forget'), L('Cancelar', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      message: L(`Esquecer o Tucano em ${serverName(s.origin)}?`, `Forget the Tucano at ${serverName(s.origin)}?`),
      detail: L('Só este computador esquece o acesso. O Tucano do servidor continua lá, com tudo.', 'Only this computer forgets the access. The Tucano on the server stays there, with everything.')
    })
    if (response !== 0) return false
    if (this.active === id) this.showLocal()
    this.drop(id)
    await session.fromPartition(`persist:server-${id}`).clearStorageData()
    this.save(this.list().filter((x) => x.id !== id))
    return true
  }

  // At launch: the server that was on screen when the app quit, on screen again.
  restore(): void {
    const last = this.list().find((s) => s.open)
    if (last) void this.show(last.id).catch((e: unknown) => console.error('[servers] restore', e instanceof Error ? e.message : e))
  }

  quit(): void {
    this.quitting = true
  }

  // For the tray: each server, to show.
  windowsMenu(): MenuItemConstructorOptions[] {
    return this.list().map((s): MenuItemConstructorOptions => ({ label: serverName(s.origin), click: () => void this.show(s.id) }))
  }

  // For the app's menu: this computer, each server, and pairing.
  menu(pasted: () => string | Promise<string>): MenuItemConstructorOptions[] {
    const list = this.list()
    return [
      { label: L('Este computador', 'This computer'), click: () => (this.showLocal(), this.deps.showLocal()) },
      ...this.windowsMenu(),
      { type: 'separator' },
      { label: L('Conectar com o link copiado', 'Connect with the copied link'), click: () => void Promise.resolve(pasted()).then((t) => this.pairFromOutside(t)) },
      ...(list.length
        ? [{ label: L('Esquecer um servidor', 'Forget a server'), submenu: list.map((s): MenuItemConstructorOptions => ({ label: serverName(s.origin), click: () => void this.forget(s.id, true) })) }]
        : [])
    ]
  }
}

// When the server doesn't answer: what to check, in the window itself (no app bridge here either).
function unreachable(name: string, origin: string, url: string): string {
  const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html><meta charset="utf-8"><title>Tucano</title><style>body{font:15px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#f6f3ee;color:#1d1a16}@media(prefers-color-scheme:dark){body{background:#1a1917;color:#f1ece4}}main{max-width:440px;padding:24px}p{opacity:.75;line-height:1.5}a{color:inherit;font-weight:600}</style><main><h2>${esc(L(`O Tucano em ${name} não respondeu`, `The Tucano at ${name} didn't answer`))}</h2><p>${esc(L('Confira a internet e se o servidor está no ar.', 'Check the internet and whether the server is up.'))}</p><p><a href="${esc(origin)}/">${esc(L('Tentar de novo', 'Try again'))}</a></p><p><small>${esc(url)}</small></p></main>`
}
