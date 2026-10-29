import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeImage, nativeTheme, net, Notification, powerMonitor, powerSaveBlocker, protocol, safeStorage, shell, Tray, utilityProcess, type UtilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { L, langOf, setLang, type Lang } from '../shared/lang'
import type { BrowserOp } from '../shared/types'
import { Browsers } from './browser'
import { bundleOf, moveFromAgentDesk, type Moved } from './migrate'
import { Updates } from './updates'
import { autostartEntry, autostartFile, onPath } from '../core/platform'

const NAME = 'Tucano'
app.setName(NAME)

// Until the core says which language the person picked, the Mac's.
const systemLocale = ((): string | undefined => {
  if (process.env['TUCANO_LOCALE']) return process.env['TUCANO_LOCALE'] // a test picks it
  try {
    return app.getPreferredSystemLanguages()[0]
  } catch {
    return undefined
  }
})()
setLang(langOf(systemLocale))

// Run from the code (npm run dev), the app keeps its own data, apart from an installed Tucano.
if (!app.isPackaged && !process.env['TUCANO_DATA']) app.setPath('userData', join(app.getPath('appData'), `${NAME} Dev`))

// The data from when the app was called agent-desk comes over first (see migrate.ts). If it
// can't yet, the app opens on a scratch folder only to say why, and the data stays put.
const moved: Moved =
  app.isPackaged && process.platform === 'darwin' && !process.env['TUCANO_DATA'] ? moveFromAgentDesk({ appData: app.getPath('appData'), dataDir: app.getPath('userData'), name: NAME, appPath: bundleOf(process.execPath) }) : 'nothing'
if (moved === 'old-app-open' || moved === 'keychain-denied') app.setPath('userData', join(app.getPath('temp'), 'tucano-esperando'))

const dataDir = (): string => process.env['TUCANO_DATA'] ?? app.getPath('userData')

// tucano://artifact/<id>/<name> serves what agents showed in the chat.
protocol.registerSchemesAsPrivileged([{ scheme: 'tucano', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

let core: UtilityProcess | null = null

// Agents' browsers (spec §24); the core is told when I take one over or hand it back.
const browsers = new Browsers((agentId, shown) => core?.postMessage({ type: 'browser-shown', agentId, shown }))

// The core (database, engines, runs) lives in its own process so agent work
// never blocks the window or the main process.
function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(import.meta.dirname, 'core.js'), [], {
    serviceName: 'tucano-core',
    env: { ...process.env, TUCANO_DATA: dataDir(), TUCANO_PACKAGED: app.isPackaged ? '1' : '0', TUCANO_LOCALE: systemLocale ?? '' }
  })
  child.on('message', (msg: CoreRequest) => handleCore(child, msg))
  child.on('exit', (code) => {
    console.error(`[main] core exited with code ${code}`)
    if (core === child) core = null
  })
  return child
}

type CoreRequest =
  | { type: 'secret'; id: string; op: 'encrypt' | 'decrypt'; data: string }
  | { type: 'open'; url: string }
  | { type: 'open_path'; path: string }
  | { type: 'notify'; title: string; body: string; conversationId?: string; kind?: 'approval' | 'question' | 'done' }
  | { type: 'login_item'; open: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'lang'; lang: Lang }
  | { type: 'screenshot'; id: string; url: string; width: number; height: number; fullPage: boolean }
  | { type: 'browser'; id: string; agentId: string; op: BrowserOp; args?: Record<string, unknown> }

// The conversation open in the window, so a notification about it can stay quiet.
let viewing: string | null = null
ipcMain.on('viewing', (_e, id: unknown) => {
  viewing = typeof id === 'string' ? id : null
})

// The toucan's own sound, instead of the system's: a knock at the door when an agent needs
// you, two notes when the work is done. Never more than one at a time.
let chirpedAt = 0
const resource = (name: string): string => (app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'build', name))
// The system's own player: afplay on a Mac; on Linux PipeWire's or PulseAudio's, else ALSA's.
const player = ((): ((file: string) => [string, string[]]) | null => {
  if (process.platform === 'darwin') return (f) => ['afplay', ['-v', '0.7', f]]
  if (process.platform !== 'linux') return null
  if (onPath('pw-play')) return (f) => ['pw-play', ['--volume=0.7', f]]
  if (onPath('paplay')) return (f) => ['paplay', ['--volume=45875', f]]
  if (onPath('aplay')) return (f) => ['aplay', ['-q', f]]
  return null
})()
function chirp(sound: 'chama' | 'pronto'): void {
  if (!player || Date.now() - chirpedAt < 1500) return
  chirpedAt = Date.now()
  const [bin, args] = player(join(resource('sounds'), `tucano-${sound}.wav`))
  execFile(bin, args, () => {})
}

// While an agent is replying, the Mac doesn't go to sleep on its own (closing the lid still does).
let awakeBlocker: number | null = null

// Opening at login: the system's login items on a Mac; on Linux a desktop entry in
// ~/.config/autostart (an AppImage starts from wherever the person keeps it).
function openAtLogin(open: boolean): void {
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: open })
  const file = autostartFile()
  try {
    if (!open) return rmSync(file, { force: true })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, autostartEntry(process.env['APPIMAGE'] ?? process.execPath))
  } catch (e) {
    console.error('[main] autostart', e)
  }
}

// On Linux, closing the window keeps the app running (routines, triggers, Telegram),
// as the Dock does on a Mac; the tray icon brings it back or quits it. A desktop
// without a tray (plain GNOME) reopens it from the app menu: a second launch shows it.
let tray: Tray | null = null
let quitting = false
let toldStillOpen = false
function setTray(): void {
  if (process.platform !== 'linux') return
  tray ??= new Tray(nativeImage.createFromPath(resource('tray.png')).resize({ width: 22, height: 22 }))
  tray.setToolTip(NAME)
  tray.removeAllListeners('click')
  tray.on('click', () => showWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: L(`Abrir o ${NAME}`, `Open ${NAME}`), click: () => showWindow() },
      { type: 'separator' },
      { label: L(`Encerrar o ${NAME}`, `Quit ${NAME}`), click: () => app.quit() }
    ])
  )
}
function stillOpen(): void {
  if (process.platform !== 'linux' || quitting || toldStillOpen || !Notification.isSupported()) return
  toldStillOpen = true
  new Notification({
    title: L(`O ${NAME} continua aberto`, `${NAME} is still open`),
    body: L('As rotinas seguem rodando. Pra voltar, use o ícone do tucano na barra do sistema ou abra o Tucano de novo.', 'Routines keep running. To get back, use the toucan icon in the system bar or open Tucano again.'),
    silent: true
  }).show()
}

// Things the core can't do itself: the OS keychain, the browser, notifications.
function handleCore(child: UtilityProcess, msg: CoreRequest): void {
  if (msg.type === 'secret') {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(L('O cofre do sistema não está disponível.', "The system's vault isn't available."))
      // Linux without a keyring falls back to a fixed key: Tucano doesn't keep secrets that way.
      if (process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))
        throw new Error(
          L(
            'Este Linux não tem um chaveiro aberto (GNOME Keyring ou KWallet), e o Tucano não guarda senhas sem cifrar. Instale o gnome-keyring (ou use o KWallet), entre de novo na sua sessão e tente outra vez.',
            "This Linux has no keyring open (GNOME Keyring or KWallet), and Tucano doesn't keep passwords unencrypted. Install gnome-keyring (or use KWallet), log in again and try once more."
          )
        )
      const data =
        msg.op === 'encrypt' ? safeStorage.encryptString(msg.data).toString('base64') : safeStorage.decryptString(Buffer.from(msg.data, 'base64'))
      child.postMessage({ type: 'secret-result', id: msg.id, data })
    } catch (e) {
      child.postMessage({ type: 'secret-result', id: msg.id, error: e instanceof Error ? e.message : String(e) })
    }
  } else if (msg.type === 'open') {
    if (/^https?:\/\//.test(msg.url)) void shell.openExternal(msg.url)
  } else if (msg.type === 'open_path') {
    // Only folders the app keeps (an agent's computer, the backups), never an arbitrary path.
    const path = normalize(msg.path)
    if (path.startsWith(join(dataDir(), 'computers') + sep) || path === join(dataDir(), 'backups')) void shell.openPath(path)
  } else if (msg.type === 'notify') {
    // Already looking at that conversation: nothing to tell.
    if (msg.conversationId && msg.conversationId === viewing && mainWindow?.isFocused()) return
    chirp(msg.kind === 'approval' || msg.kind === 'question' ? 'chama' : 'pronto')
    if (!Notification.isSupported()) return
    const n = new Notification({ title: msg.title, body: msg.body, silent: true })
    n.on('click', () => showWindow(msg.conversationId))
    n.show()
  } else if (msg.type === 'busy') {
    if (msg.busy && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!msg.busy && awakeBlocker !== null) {
      powerSaveBlocker.stop(awakeBlocker)
      awakeBlocker = null
    }
  } else if (msg.type === 'lang') {
    setLang(msg.lang)
    setMenu()
  } else if (msg.type === 'login_item') {
    // Only the installed app: in dev this would register the bare Electron binary.
    if (app.isPackaged) openAtLogin(msg.open)
  } else if (msg.type === 'browser') {
    browsers.run(msg.agentId, msg.op, msg.args).then(
      (data) => child.postMessage({ type: 'browser-result', id: msg.id, data }),
      (e: unknown) => child.postMessage({ type: 'browser-result', id: msg.id, error: e instanceof Error ? e.message : String(e) })
    )
  } else if (msg.type === 'screenshot') {
    screenshot(msg).then(
      (png) => child.postMessage({ type: 'screenshot-result', id: msg.id, data: png.toString('base64') }),
      (e: unknown) => child.postMessage({ type: 'screenshot-result', id: msg.id, error: e instanceof Error ? e.message : String(e) })
    )
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Loads the page in a hidden window with its own throwaway session (no cookies
// from anything else) and captures it.
async function screenshot(o: { url: string; width: number; height: number; fullPage: boolean }): Promise<Buffer> {
  if (!/^https?:\/\//.test(o.url)) throw new Error('só http e https')
  const win = new BrowserWindow({
    show: false,
    width: o.width,
    height: o.height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'screenshots' }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await Promise.race([win.loadURL(o.url), wait(30_000).then(() => Promise.reject(new Error('a página não carregou em 30 s')))])
    await wait(1200) // fonts, charts and client-side rendering
    if (o.fullPage) {
      const h = Number(await win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)'))
      if (h > o.height) {
        win.setContentSize(o.width, Math.min(h, 6000))
        await wait(600)
      }
    }
    return (await win.webContents.capturePage()).toPNG()
  } finally {
    win.destroy()
  }
}

function serveArtifact(req: Request): Promise<Response> | Response {
  const u = new URL(req.url)
  const [id = '', name = ''] = u.pathname.slice(1).split('/')
  const dir = join(dataDir(), 'artifacts', id)
  const file = normalize(join(dir, decodeURIComponent(name)))
  if (u.host !== 'artifact' || !/^[0-9a-f-]{36}$/.test(id) || !file.startsWith(dir + sep)) return new Response('not found', { status: 404 })
  return net.fetch(pathToFileURL(file).toString()).then((r) => {
    const headers = new Headers(r.headers)
    // A page an agent made runs scripts, but in a sandbox with no access to the app.
    headers.set('Content-Security-Policy', 'sandbox allow-scripts allow-popups')
    return new Response(r.body, { status: r.status, headers })
  })
}

// Each page load asks for a port; one end goes to the core, the other to the page.
ipcMain.on('core:connect', (event) => {
  core ??= startCore()
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage(null, [port1])
  event.sender.postMessage('core:port', null, [port2])
})

// Brings the window back (closing it keeps the app and its routines running),
// optionally opening a conversation.
// The app's own window; agents' browsers are windows too, hidden, and never count as it.
let mainWindow: BrowserWindow | null = null

function showWindow(conversationId?: string): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (!conversationId) return
  const go = (): void => win.webContents.send('navigate', conversationId)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go)
  else go()
}

// New versions: the window shows when one is ready, and restarting puts it in.
const updates = new Updates((state) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update', state)
})
ipcMain.handle('update:state', () => updates.get())
ipcMain.on('update:check', () => updates.check())
ipcMain.on('update:install', () => {
  // A reply in progress would be cut off: the person decides.
  if (awakeBlocker !== null && mainWindow && !mainWindow.isDestroyed()) {
    const answer = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: [L('Reiniciar agora', 'Restart now'), L('Depois', 'Later')],
      defaultId: 1,
      cancelId: 1,
      message: L('Um agente ainda está trabalhando', 'An agent is still working'),
      detail: L('Reiniciar agora interrompe o que ele está fazendo. Se esperar, a atualização entra quando você fechar o Tucano.', 'Restarting now stops what it is doing. If you wait, the update goes in when you quit Tucano.')
    })
    if (answer !== 0) return
  }
  updates.install()
})

// The Mac's folder picker, for a folder lent to an agent's computer. The core checks the choice.
ipcMain.handle('pick-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = { title: L('Escolher pasta', 'Choose a folder'), buttonLabel: L('Escolher', 'Choose'), properties: ['openDirectory' as const] }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? null : (r.filePaths[0] ?? null)
})

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Off a Mac the menu lives in the window: hidden until Alt, so the app looks the same.
    autoHideMenuBar: process.platform !== 'darwin',
    ...(process.platform === 'linux' ? { icon: resource('icon.png') } : {}),
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121110' : '#f3f0ea',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true // the PDF viewer, for PDFs agents show
    }
  })

  win.once('ready-to-show', () => win.show())
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    stillOpen()
  })

  // Links in messages open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

// One app per data folder: two would both run the same routines. Opening it
// again (Dock, Spotlight, at login) just brings the window back. A test run
// with its own data folder is a separate app.
if (process.env['TUCANO_DATA']) app.setPath('userData', process.env['TUCANO_DATA'])
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', () => showWindow())

// The app's own menu, in the app's language (Electron's would be in English).
function setMenu(): void {
  app.setAboutPanelOptions({ applicationName: NAME, applicationVersion: app.getVersion() })
  // Services and hiding the app exist only on a Mac.
  const macOnly: Electron.MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          { role: 'services', label: L('Serviços', 'Services') },
          { type: 'separator' },
          { role: 'hide', label: L(`Ocultar o ${NAME}`, `Hide ${NAME}`) },
          { role: 'hideOthers', label: L('Ocultar os outros', 'Hide Others') },
          { role: 'unhide', label: L('Mostrar tudo', 'Show All') },
          { type: 'separator' }
        ]
      : []
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: NAME,
        submenu: [{ role: 'about', label: L(`Sobre o ${NAME}`, `About ${NAME}`) }, { type: 'separator' }, ...macOnly, { role: 'quit', label: L(`Encerrar o ${NAME}`, `Quit ${NAME}`) }]
      },
      { role: 'editMenu', label: L('Editar', 'Edit') },
      { role: 'viewMenu', label: L('Visualizar', 'View') },
      { role: 'windowMenu', label: L('Janela', 'Window') }
    ])
  )
  if (tray) setTray() // its menu, in the new language
}

// The data couldn't come over yet: say why and close, leaving everything as it was.
if (moved === 'old-app-open' || moved === 'keychain-denied') {
  void app.whenReady().then(async () => {
    await dialog.showMessageBox({
      type: 'warning',
      message: moved === 'old-app-open' ? L('Feche o app antigo primeiro', 'Close the old app first') : L('O Tucano precisa da sua chave antiga', 'Tucano needs your old key'),
      detail:
        moved === 'old-app-open'
          ? L('A versão anterior do Tucano ainda está aberta. Encerre ela (⌘Q) e abra o Tucano de novo: seus agentes, conversas e memórias vêm junto.', 'The previous version of Tucano is still open. Quit it (⌘Q) and open Tucano again: your agents, conversations and memories come along.')
          : L('Pra trazer seus logins salvos, o macOS pede acesso à chave "agent-desk Safe Storage". Abra o Tucano de novo e clique em Permitir. Nada foi mexido.', 'To bring your saved logins along, macOS asks for access to the "agent-desk Safe Storage" key. Open Tucano again and click Allow. Nothing was changed.')
    })
    app.exit(0)
  })
} else if (primary) app.whenReady().then(() => {
  setMenu()
  protocol.handle('tucano', serveArtifact)
  core = startCore()
  // The Mac wakes for a few seconds at a time while asleep (maintenance, "DarkWake"):
  // routines wait for a real wake, so a run doesn't start and freeze mid-way.
  powerMonitor.on('suspend', () => core?.postMessage({ type: 'power', awake: false }))
  powerMonitor.on('resume', () => core?.postMessage({ type: 'power', awake: true }))
  createWindow()
  setTray()
  updates.start()
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

// A Mac keeps the app in the Dock and Linux in the tray (see setTray); elsewhere it quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  browsers.quit()
})

app.on('will-quit', () => {
  core?.kill()
})
