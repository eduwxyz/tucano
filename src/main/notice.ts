// The cards over every window, as Telegram's own are: a second window of the app, transparent and
// always on top, that is click-through wherever there is no card. It reads what waits on the person
// from the core (`noticeFeed`), and the notifications the core sends arrive here to be drawn
// (src/renderer/src/notice). Settings › General › Notifications decides whether it's used at all and
// where it sits: a rectangle the person draws on screen, the bottom right corner until then.
import { BrowserWindow, ipcMain, nativeTheme, screen, systemPreferences, type IpcMainEvent, type Rectangle } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { L } from '../shared/lang'
import { NOTICE_PAD, areaRect, clampArea, defaultArea, type NoticeArea, type NoticePush } from '../shared/notice'

// The page these windows show: the dev server's notice.html while developing, the built one otherwise.
const PAGE = process.env['ELECTRON_RENDERER_URL']
  ? `${process.env['ELECTRON_RENDERER_URL']}/notice.html`
  : pathToFileURL(join(import.meta.dirname, '../renderer/notice.html')).toString()
const PICK = 'pick=1' // the same page, drawing the rectangle on screen instead of the cards

// The system's accent color as a page takes it: Windows 11's own, the Mac's highlight, and whatever
// the Linux desktop says (its own default when it says nothing).
function accent(): string {
  try {
    const raw = systemPreferences.getAccentColor?.() // "RRGGBBAA", when the platform has one
    if (raw && /^[0-9a-f]{6}/i.test(raw)) return `#${raw.slice(0, 6)}`
  } catch {
    // A platform without one: the app's own stays.
  }
  return '#d9581a'
}

export class Notices {
  private win: BrowserWindow | null = null
  private picker: BrowserWindow | null = null
  private on = true // the setting, as the core last said
  private chosen: NoticeArea | undefined // the rectangle the person drew, if any
  private cards = 0 // how many the page has on screen now
  private loaded = false
  private waiting: (NoticePush & { demo?: boolean })[] = [] // what arrived before the page could draw
  private interactiveOn = false
  private pollTimer: ReturnType<typeof setInterval> | null = null

  // `open`: brings the app's window back on a conversation (and its thread), or on a screen.
  constructor(private deps: { open: (conversationId?: string, page?: 'skills', threadId?: string) => void }) {
    // The system's skin changes while the app runs (Windows' own light and dark, its accent color):
    // a card that follows the system follows it as it changes.
    nativeTheme.on('updated', () => this.told())
    ipcMain.on('notice:hit', (e, inside: unknown) => {
      if (this.owns(e)) this.interactive(inside === true)
    })
    ipcMain.on('notice:focus', (e) => {
      if (!this.owns(e)) return
      const win = this.win
      if (!win || win.isDestroyed()) return
      win.setFocusable(true)
      win.focus()
      win.webContents.focus()
    })
    ipcMain.on('notice:count', (e, n: unknown) => {
      if (!this.owns(e)) return
      this.cards = typeof n === 'number' && Number.isFinite(n) ? n : 0
      if (this.cards > 0) this.show()
      else this.hide()
    })
    ipcMain.on('notice:open', (e, p: unknown) => {
      if (!this.owns(e) || !p || typeof p !== 'object') return
      const at = p as { conversationId?: unknown; threadId?: unknown; page?: unknown }
      this.deps.open(typeof at.conversationId === 'string' ? at.conversationId : undefined, at.page === 'skills' ? 'skills' : undefined, typeof at.threadId === 'string' ? at.threadId : undefined)
    })
    // The rectangle is saved as a setting by the page that drew it, so the core tells every window
    // where it is (setPrefs). Nothing of it is kept here.
    ipcMain.on('notice:area-done', (e) => {
      if (this.ownsPicker(e)) this.closePicker()
    })
    ipcMain.on('notice:area-cancel', (e) => {
      if (this.ownsPicker(e)) this.closePicker()
    })
  }

  // Whether the cards are used at all.
  get enabled(): boolean {
    return this.on
  }

  // Both of the app's own pages talk to main here: the cards, and the rectangle drawn on screen.
  owns(event: IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return this.owner(this.win, event, false)
  }

  ownsPicker(event: IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return this.owner(this.picker, event, true)
  }

  private owner(win: BrowserWindow | null, event: IpcMainEvent | Electron.IpcMainInvokeEvent, picker: boolean): boolean {
    const frame = event.senderFrame
    if (!win || win.isDestroyed() || event.sender !== win.webContents || frame !== event.sender.mainFrame) return false
    return frame.url.includes(PICK) === picker
  }

  // The setting changed (on or off, the rectangle, both): off clears what's on screen, since the
  // system's own notifications take over; a new rectangle moves the window.
  setPrefs(on: boolean, area: NoticeArea | undefined): void {
    const before = JSON.stringify(this.area())
    this.on = on
    this.chosen = area ? clampArea(area) : undefined
    if (!on) return this.clear()
    if (JSON.stringify(this.area()) !== before) this.place()
  }

  // A notification the core sent. False: the window has none of it, so the system's notification
  // is the one to show.
  push(p: NoticePush): boolean {
    if (!this.on) return false
    const win = this.ensure()
    if (this.loaded) win.webContents.send('notice:push', p)
    else this.waiting.push(p)
    return true
  }

  // A card for something to look at now (Settings › Notifications › Send one): the window's own,
  // never the system's.
  test(): void {
    const win = this.ensure()
    const card = {
      title: L('Notificação de teste', 'Test notification'),
      body: L('É assim que os avisos chegam. Passe o ponteiro pra ela ficar.', 'This is how notifications arrive. Hover it to keep it.'),
      at: Date.now()
    }
    if (this.loaded) win.webContents.send('notice:push', card)
    else this.waiting.push(card)
  }

  // Settings › Notifications › Test notifications: one card of each, drawn by the page itself, so the
  // person sees how they look with the settings they chose.
  demo(): void {
    const win = this.ensure()
    if (this.loaded) win.webContents.send('notice:demo')
    else this.waiting.push({ title: '', body: '', demo: true })
  }

  // Settings › Notifications › Where: the screen dimmed, with the rectangle on it to drag and pull by
  // its corners. Saving it goes through the core, like every other setting.
  pick(): void {
    if (this.picker && !this.picker.isDestroyed()) {
      this.picker.show()
      this.picker.focus()
      return
    }
    const { workArea } = this.display()
    const win = new BrowserWindow({
      ...workArea,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.picker = win
    win.setAlwaysOnTop(true, 'screen-saver')
    win.on('closed', () => {
      if (this.picker === win) this.picker = null
    })
    win.webContents.on('did-finish-load', () => {
      const a = this.area()
      // In the picker's own coordinates: its window is the whole work area.
      win.webContents.send('notice:pick', { x: a.x - workArea.x, y: a.y - workArea.y, w: a.w, h: a.h, up: a.up })
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void win.loadURL(`${PAGE}?${PICK}`)
    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })
  }

  private closePicker(): void {
    const win = this.picker
    this.picker = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  // What the person chose, or the default corner: the rectangle in screen pixels, with the way its
  // stack grows.
  private area(): { x: number; y: number; w: number; h: number; up: boolean } {
    const { workArea } = this.display()
    const chosen = this.chosen ?? defaultArea(workArea)
    const rect = areaRect(chosen, workArea)
    return { ...rect, up: chosen.up }
  }

  clear(): void {
    this.waiting = []
    this.cards = 0
    this.stopPoll()
    if (this.win && !this.win.isDestroyed() && this.loaded) this.win.webContents.send('notice:clear')
    this.hide()
  }

  // Another workspace on screen: what waited there isn't what waits here.
  reload(): void {
    this.clear()
    if (this.win && !this.win.isDestroyed()) this.win.webContents.reload()
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      ...this.bounds(),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      // Never taken by the system's own snapping or its resizing edges, and never focused by a
      // click: the cards act on the app without taking the person out of what they're doing.
      thickFrame: false,
      focusable: false,
      acceptFirstMouse: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.win = win
    this.loaded = false
    this.interactiveOn = false
    // Everything that isn't a card lets the click through to the window behind it.
    win.setIgnoreMouseEvents(true, { forward: true })
    // Above the app's own windows, and above most of what the system draws over them.
    win.setAlwaysOnTop(true, process.platform === 'linux' ? 'screen-saver' : 'floating')
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    win.on('closed', () => {
      if (this.win === win) this.win = null
      this.loaded = false
      this.cards = 0
    })
    win.on('blur', () => {
      if (win.isDestroyed()) return
      win.setFocusable(false)
    })
    win.webContents.on('did-finish-load', () => {
      this.loaded = true
      this.told()
      for (const p of this.waiting.splice(0)) win.webContents.send(p.demo ? 'notice:demo' : 'notice:push', p)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void win.loadURL(PAGE)
    return win
  }

  // The display the app is on: the rectangle is measured against its work area, so a stack never
  // lands under the taskbar or off the screen.
  private display(): { display: Electron.Display; workArea: Rectangle } {
    const others = BrowserWindow.getAllWindows().filter((w) => w !== this.win && w !== this.picker && !w.isDestroyed())
    const host = others.find((w) => w.isVisible()) ?? BrowserWindow.getFocusedWindow()
    const display = host ? screen.getDisplayMatching(host.getBounds()) : screen.getPrimaryDisplay()
    return { display, workArea: display.workArea }
  }

  // The window is the rectangle plus room for the cards' shadow and the way they come in.
  private bounds(): Rectangle {
    const a = this.area()
    return this.inside({ x: a.x - NOTICE_PAD, y: a.y - NOTICE_PAD, width: a.w + NOTICE_PAD * 2, height: a.h + NOTICE_PAD * 2 })
  }

  // A window never goes past the edge of the screen: a shadow cut off by the screen is one thing, a
  // window that can't be clicked is another.
  private inside(b: Rectangle): Rectangle {
    const { workArea } = this.display()
    const width = Math.min(b.width, workArea.width)
    const height = Math.min(b.height, workArea.height)
    return {
      x: Math.min(Math.max(b.x, workArea.x), workArea.x + workArea.width - width),
      y: Math.min(Math.max(b.y, workArea.y), workArea.y + workArea.height - height),
      width,
      height
    }
  }

  // Where it sits, and which way the stack grows in it.
  private place(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const b = this.bounds()
    const now = win.getBounds()
    if (now.x !== b.x || now.y !== b.y || now.width !== b.width || now.height !== b.height) win.setBounds(b)
    this.told()
  }

  // Where the cards grow from, and the skin they're painted with: the system's own surfaces and
  // accent, so a card looks like the window it lies over.
  private told(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !this.loaded) return
    win.webContents.send('notice:place', { up: this.area().up, dark: nativeTheme.shouldUseDarkColors, accent: accent() })
  }

  private show(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    // Wherever the app's window is now, the cards follow it: a second screen has its own corner.
    this.place()
    if (!win.isVisible()) win.showInactive()
    win.setFocusable(true)
    this.startPoll()
  }

  private hide(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    this.stopPoll()
    win.setFocusable(false)
    if (win.isVisible()) win.hide()
    this.interactive(false)
  }

  private interactive(on: boolean): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (this.interactiveOn === on) return
    this.interactiveOn = on
    // Still forwarding the pointer's moves while it passes through: that's how the page knows it
    // came back over a card.
    win.setIgnoreMouseEvents(!on, { forward: true })
  }

  // The page's pointer tracking is fast but misses the case where a card appears under a pointer
  // that is not moving: the click then passes through to the window behind it. While cards are on
  // screen, tell the page where the cursor is and let it run the same `elementFromPoint` test it runs
  // on a move, so a card that arrived under a still pointer is reachable and the empty part of the
  // rectangle keeps passing clicks through. `getCursorScreenPoint` and `getBounds` are both measured
  // in DIP, so the difference is the point in the window's own coordinates and no scale factor
  // applies; dividing by it puts the point in the display's top-left and answers "outside" for every
  // cursor inside the window on a scaled display.
  private startPoll(): void {
    if (this.pollTimer) return
    let last = ''
    this.pollTimer = setInterval(() => {
      const win = this.win
      if (!win || win.isDestroyed()) return this.stopPoll()
      const point = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const at = { x: Math.round(point.x - b.x), y: Math.round(point.y - b.y) }
      const here = `${at.x},${at.y}`
      if (here === last) return
      last = here
      if (this.loaded) win.webContents.send('notice:cursor', at)
    }, 80)
  }
  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.interactive(false)
  }
}
