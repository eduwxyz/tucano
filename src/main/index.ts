import { randomBytes } from 'node:crypto'
import { verifyLocalUrl } from '../core/local-paths'
import { app, BrowserWindow, clipboard, session, type MediaAccessPermissionRequest, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, Menu, MessageChannelMain, nativeImage, nativeTheme, net, Notification, powerMonitor, powerSaveBlocker, protocol, safeStorage, shell, Tray, utilityProcess, type UtilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { L, langOf, setLang, type Lang } from '../shared/lang'
import { chirpOf, type BrowserOp, type Settings } from '../shared/types'
import { isAppPage, isOutsideLink } from '../shared/links'
import { Browsers } from './browser'
import { Servers } from './servers'
import { serverNote } from '../shared/servers'
import { bundleOf, moveFromAgentDesk, type Moved } from './migrate'
import { Updates } from './updates'
import { Workspaces } from './workspaces'
import { homePhone } from './home-phone'
import { suggestWorkspaceCopyName, workspaceParts, type Workspace, type WorkspaceList, type WorkspaceSummary } from '../shared/workspaces'
import { autostartEntry, autostartFile, electronPasswordStore, onPath } from '../core/platform'
import { proxyFromPac } from '../core/network'

const NAME = 'Tucano'
app.setName(NAME)
// Set here and not in the menu entry, so it holds when an update restarts the app. Someone who
// chose a store with --password-store keeps it.
const passwordStore = electronPasswordStore()
if (passwordStore && !app.commandLine.hasSwitch('password-store')) app.commandLine.appendSwitch('password-store', passwordStore)
// The AppImage's runtime sets ARGV0 for the app alone, but everything the app starts would inherit
// it. In a login shell with mise, that made `mise activate zsh` open the AppImage again, and the
// shell never came back.
delete process.env['ARGV0']
// Windows shows notifications only for an app with an id, the same as the installer's.
if (process.platform === 'win32') app.setAppUserModelId('dev.tucano.app')

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
// Only on the Mac: agent-desk never shipped for Windows, and the key lives in the macOS Keychain.
const moved: Moved =
  app.isPackaged && process.platform === 'darwin' && !process.env['TUCANO_DATA'] ? moveFromAgentDesk({ appData: app.getPath('appData'), dataDir: app.getPath('userData'), name: NAME, appPath: bundleOf(process.execPath) }) : 'nothing'
if (moved === 'old-app-open' || moved === 'keychain-denied') app.setPath('userData', join(app.getPath('temp'), 'tucano-esperando'))

const dataDir = (): string => process.env['TUCANO_DATA'] ?? app.getPath('userData')
// tucano://artifact/<id>/<name> serves what agents showed in the chat.
protocol.registerSchemesAsPrivileged([{ scheme: 'tucano', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

let registry: Workspaces
// `wikiFolder`: the wiki's folder, as that core says (an Obsidian vault, say): the one folder outside the app's own it may open.
type Runtime = { child: UtilityProcess; browsers: Browsers; ready: Promise<void>; summary: WorkspaceSummary; busy: boolean; wikiFolder: string }
const cores = new Map<string, Runtime>()
const workspaceList = (): WorkspaceList => ({ selected: registry.selected().id, workspaces: registry.list().map((w) => cores.get(w.id)?.summary ?? { id: w.id, name: w.name, isDefault: w.isDefault, paused: false, unread: 0, approvals: 0, status: 'starting' }) })
const publishWorkspaces = (): void => { mainWindow?.webContents.send('workspaces', workspaceList()) }

// The core (database, engines, runs) lives in its own process so agent work
// never blocks the window or the main process.
const localKey = randomBytes(32).toString('hex')
// The iPhone on the home Wi-Fi (Settings › Celular › Seu iPhone), once the app is ready.
let phone: ReturnType<typeof homePhone> | undefined

function startCore(workspace: Workspace): Runtime {
  const existing = cores.get(workspace.id)
  if (existing && existing.summary.status !== 'failed') return existing
  if (existing) {
    existing.browsers.quit()
    existing.child.kill()
    cores.delete(workspace.id)
  }
  const child = utilityProcess.fork(join(import.meta.dirname, 'core.js'), [], {
    serviceName: `tucano-core-${workspace.id}`,
    env: { ...process.env, TUCANO_DATA: workspace.dataDir, TUCANO_WORKSPACE_ID: workspace.id, ...(workspace.isDefault ? {} : { TUCANO_WORKSPACE_LABEL: workspace.name }), TUCANO_DEFAULT_WORKSPACE: workspace.isDefault ? '1' : '0', TUCANO_THEME: registry.theme() ?? (workspace.isDefault ? '' : 'system'), TUCANO_WEBHOOK_PORT: String(workspace.webhookPort), TUCANO_GIT_PORT: String(workspace.gitPort), TUCANO_PACKAGED: app.isPackaged ? '1' : '0', TUCANO_VERSION: app.getVersion(), TUCANO_WHISPER: whisperDir(), TUCANO_LOCAL_KEY: localKey, TUCANO_LOCALE: systemLocale ?? '', ...(systemProxy ? { TUCANO_SYSTEM_PROXY: systemProxy } : {}) }
  })
  let resolve!: () => void
  let reject!: (e: Error) => void
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  // Background startup errors are visible in the switcher, not unhandled rejections.
  void ready.catch(() => {})
  const runtime: Runtime = { child, ready, busy: false, wikiFolder: '', summary: { id: workspace.id, name: workspace.name, isDefault: workspace.isDefault, paused: false, unread: 0, approvals: 0, status: 'starting' }, browsers: new Browsers((agentId, shown) => child.postMessage({ type: 'browser-shown', agentId, shown }), workspace.isDefault ? '' : `${workspace.id}-`) }
  cores.set(workspace.id, runtime)
  const timer = setTimeout(() => {
    reject(new Error(L('O workspace demorou demais para iniciar.', 'The workspace took too long to start.')))
    runtime.summary.status = 'failed'
    publishWorkspaces()
    child.kill()
  }, 90_000)
  phone?.coreStarted(workspace.id, child)
  child.on('message', (msg: CoreRequest) => {
    if (phone?.fromCore(msg as { type?: string; id?: string })) return
    if (msg.type === 'ready') {
      clearTimeout(timer)
      const theme = registry.theme()
      if (theme) child.postMessage({ type: 'workspace-theme', theme })
      runtime.summary.status = 'ready'
      resolve()
      publishWorkspaces()
    } else if (msg.type === 'workspace-summary') {
      registry.rename(workspace.id, msg.name)
      runtime.summary = { ...runtime.summary, name: msg.name || runtime.summary.name, paused: msg.paused, unread: msg.unread, approvals: msg.approvals }
      publishWorkspaces()
    } else handleCore(child, msg, workspace, runtime)
  })
  child.on('exit', (code) => {
    console.error(`[main] core of workspace ${workspace.id} exited with code ${code}`)
    clearTimeout(timer)
    if (cores.get(workspace.id) !== runtime) return // replaced by a new one already
    reject(new Error(`Workspace core exited (${code})`))
    runtime.summary.status = 'failed'
    runtime.busy = false
    runtime.browsers.quit()
    syncBusy()
    if (!quitting) publishWorkspaces()
    // The one on screen: the window says so. Reloading the page connects again, and connecting starts a new core.
    if (!quitting && registry.selected().id === workspace.id && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('core:down')
  })
  return runtime
}

// The proxy in the system's network settings (or its PAC), which Node in the core never asks about:
// Chromium resolves it here, once, and each core gets it (src/core/network.ts). A slow PAC doesn't
// hold the launch up for more than a moment.
let systemProxy = ''
let systemProxyRead: Promise<void> = Promise.resolve()
async function readSystemProxy(): Promise<void> {
  try {
    const answer = await Promise.race([session.defaultSession.resolveProxy('https://api.github.com/'), new Promise<string>((r) => setTimeout(() => r('DIRECT'), 1500))])
    systemProxy = proxyFromPac(answer) ?? ''
  } catch (e) {
    console.error('[main] system proxy', e)
  }
}

// The workspace on screen starts first; the others follow it one at a time, a few seconds
// apart, so they don't all run their login shell and check every harness at once.
function startWorkspaces(): void {
  const first = registry.selected()
  const rest = registry.list().filter((w) => w.id !== first.id)
  void startCore(first).ready.catch(() => {}).then(async () => {
    for (const w of rest) {
      await new Promise((r) => setTimeout(r, 5_000))
      if (quitting) return
      if (registry.list().some((x) => x.id === w.id)) startCore(w) // not deleted meanwhile
    }
  })
}

type CoreRequest =
  | { type: 'theme'; theme: Settings['theme']; initial?: boolean }
  | { type: 'ready' }
  | { type: 'workspace-summary'; name: string; paused: boolean; unread: number; approvals: number }
  | { type: 'workspace-cleaned'; agentIds?: string[]; error?: string }
  | { type: 'workspace-duplicated'; error?: string }
  | { type: 'workspace-paused'; error?: string }
  | { type: 'wiki-relocated'; error?: string }
  | { type: 'secret'; id: string; op: 'encrypt' | 'decrypt'; data: string }
  | { type: 'open'; url: string }
  | { type: 'open_path'; path: string }
  | { type: 'open_local'; path: string; how: 'open' | 'reveal' }
  | { type: 'wiki_dir'; path: string }
  | { type: 'notify'; title: string; body: string; conversationId?: string; threadId?: string; kind?: 'approval' | 'question' | 'done'; page?: 'skills'; sound?: boolean }
  | { type: 'login_item'; open: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'lang'; lang: Lang }
  | { type: 'screenshot'; id: string; url: string; width: number; height: number; fullPage: boolean }
  | { type: 'icons'; id: string; paths: string[] }
  | { type: 'browser'; id: string; agentId: string; op: BrowserOp; args?: Record<string, unknown> }

// The app's page: the dev server while developing, the built index.html otherwise.
const APP_PAGE = process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).toString()

// Only the app's own page, in the app's window, talks to main: never a page that window
// was somehow taken to, nor a frame inside it. Its bridge reaches the core.
function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  const ok = !!frame && frame === event.sender.mainFrame && !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && isAppPage(frame.url, APP_PAGE)
  if (!ok) console.error('[main] ignored a message from', frame?.url ?? 'a closed frame')
  return ok
}

// The conversation open in the window, so a notification about it can stay quiet.
let viewing: string | null = null
ipcMain.on('viewing', (e, id: unknown) => {
  if (!fromApp(e)) return
  viewing = typeof id === 'string' ? id : null
  cores.get(registry.selected().id)?.child.postMessage({ type: 'viewing', conversationId: viewing })
})

// The toucan's own sound, instead of the system's: a knock at the door when an agent needs
// you, two notes when the work is done. Never more than one at a time.
let chirpedAt = 0
const resource = (name: string): string => (app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'build', name))
// Dictation's whisper-cli, packed with the app (scripts/whisper.mjs); in development, the one built for this machine.
const whisperDir = (): string => (app.isPackaged ? join(process.resourcesPath, 'whisper') : join(app.getAppPath(), 'build', 'whisper', `${({ darwin: 'mac', win32: 'win' } as Record<string, string>)[process.platform] ?? process.platform}-${process.arch}`))
// The system's own player: afplay on a Mac; on Windows .NET's SoundPlayer, with nothing
// to install; on Linux PipeWire's or PulseAudio's, else ALSA's.
const player = ((): ((file: string) => [string, string[]]) | null => {
  if (process.platform === 'darwin') return (f) => ['afplay', ['-v', '0.7', f]]
  if (process.platform === 'win32') return (f) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${f.replace(/'/g, "''")}').PlaySync()`]]
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
  execFile(bin, args, { windowsHide: true }, () => {})
}

// While an agent is replying, the Mac doesn't go to sleep on its own (closing the lid still does).
let awakeBlocker: number | null = null
function syncBusy(): void {
  const busy = [...cores.values()].some((r) => r.busy)
  if (busy && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
  else if (!busy && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker)
    awakeBlocker = null
  }
}

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

// On Linux and Windows, closing the window keeps the app running (routines, triggers,
// Telegram), as the Dock does on a Mac; the tray icon brings it back or quits it. A desktop
// without a tray (plain GNOME) reopens it from the app menu: a second launch shows it.
let tray: Tray | null = null
let quitting = false
let toldStillOpen = false
function setTray(): void {
  if (process.platform === 'darwin') return
  // Windows draws tray icons at 16 px (scaled up on a high-DPI screen); Linux panels at 22.
  const size = process.platform === 'win32' ? 16 : 22
  tray ??= new Tray(nativeImage.createFromPath(resource('tray.png')).resize({ width: size, height: size }))
  tray.setToolTip(NAME)
  tray.removeAllListeners('click')
  tray.on('click', () => showWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: L(`Abrir o ${NAME}`, `Open ${NAME}`), click: () => showWindow() },
      ...(servers.list().length ? [{ type: 'separator' as const }, ...servers.windowsMenu()] : []),
      { type: 'separator' },
      { label: L(`Encerrar o ${NAME}`, `Quit ${NAME}`), click: () => app.quit() }
    ])
  )
}
// Linux shows a notification with the icon it's given (a Mac uses the app's own).
const noteIcon = (): { icon?: string } => (process.platform === 'linux' ? { icon: resource('icon.png') } : {})
function stillOpen(): void {
  if (process.platform === 'darwin' || quitting || toldStillOpen || !Notification.isSupported()) return
  toldStillOpen = true
  new Notification({
    ...noteIcon(),
    title: L(`O ${NAME} continua aberto`, `${NAME} is still open`),
    body:
      process.platform === 'win32'
        ? L('As rotinas seguem rodando. Pra voltar, use o ícone do tucano na bandeja, perto do relógio (talvez dentro da setinha ^), ou abra o Tucano de novo.', 'Routines keep running. To get back, use the toucan icon in the tray by the clock (maybe inside the little ^ arrow), or open Tucano again.')
        : L('As rotinas seguem rodando. Pra voltar, use o ícone do tucano perto do relógio ou abra o Tucano de novo.', 'Routines keep running. To get back, use the toucan icon by the clock or open Tucano again.'),
    silent: true
  }).show()
}

// Things the core can't do itself: the OS keychain, the browser, notifications.
function handleCore(child: UtilityProcess, msg: CoreRequest, workspace: Workspace, runtime: Runtime): void {
  if (msg.type === 'theme') {
    // Adopt the default workspace's old preference once. Other startup events
    // and stale workspace snapshots must never overwrite the app preference.
    if (msg.initial && (!workspace.isDefault || registry.theme() !== undefined)) return
    registry.setTheme(msg.theme)
    if (nativeTheme.themeSource !== msg.theme) nativeTheme.themeSource = msg.theme
    for (const core of cores.values()) if (core.summary.status !== 'failed') core.child.postMessage({ type: 'workspace-theme', theme: msg.theme })
  } else if (msg.type === 'secret') {
    try {
      // Linux without an open keyring falls back to a fixed key, or to nothing: Tucano keeps no
      // secret that way, and says what to do.
      if (process.platform === 'linux' && (!safeStorage.isEncryptionAvailable() || ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())))
        throw new Error(
          L(
            'Este Linux não tem um chaveiro aberto (GNOME Keyring ou KWallet), e o Tucano não guarda senhas sem cifrar. Abra ou ative o KWallet, ou instale o gnome-keyring, entre de novo na sua sessão e tente outra vez.',
            "This Linux has no keyring open (GNOME Keyring or KWallet), and Tucano doesn't keep passwords unencrypted. Open or enable KWallet, or install gnome-keyring, log in again and try once more."
          )
        )
      if (!safeStorage.isEncryptionAvailable())
        throw new Error(
          process.platform === 'darwin'
            ? L('O Tucano não conseguiu usar as Chaves do macOS. Reinicie o Tucano e, se o Mac pedir, clique em Permitir.', "Tucano couldn't use the macOS Keychain. Restart Tucano and, if the Mac asks, click Allow.")
            : process.platform === 'win32'
              ? L('O Tucano não conseguiu usar a proteção de dados do Windows. Reinicie o Tucano e entre de novo na sua conta do Windows se continuar.', "Tucano couldn't use Windows data protection. Restart Tucano, and sign in to Windows again if it keeps happening.")
              : L('O Tucano não conseguiu usar o chaveiro do sistema. Reinicie o Tucano e tente de novo.', "Tucano couldn't use the system's keyring. Restart Tucano and try again.")
        )
      let data: string
      if (msg.op === 'encrypt') data = safeStorage.encryptString(msg.data).toString('base64')
      else {
        try {
          data = safeStorage.decryptString(Buffer.from(msg.data, 'base64'))
        } catch (e) {
          // Saved under another key (the system's changed, or the data came from another computer).
          console.error('[main] decrypt', e)
          throw new Error(L('Não consegui abrir as credenciais salvas: a chave do sistema mudou ou não foi liberada. Elas continuam guardadas.', "I couldn't open the saved credentials: the system's key changed or wasn't released. They're still saved."))
        }
      }
      child.postMessage({ type: 'secret-result', id: msg.id, data })
    } catch (e) {
      child.postMessage({ type: 'secret-result', id: msg.id, error: e instanceof Error ? e.message : String(e) })
    }
  } else if (msg.type === 'open') {
    if (/^https?:\/\//.test(msg.url)) void shell.openExternal(msg.url)
  } else if (msg.type === 'open_local') {
    // Never openPath on what isn't a folder or a PDF: that would run an app or a script.
    if (msg.how === 'open') void shell.openPath(msg.path)
    else shell.showItemInFolder(msg.path)
  } else if (msg.type === 'wiki_dir') {
    runtime.wikiFolder = normalize(msg.path)
  } else if (msg.type === 'open_path') {
    // Only folders the app keeps (an agent's computer, the backups), never an arbitrary path.
    const path = normalize(msg.path)
    const wikiFolder = runtime.wikiFolder
    if (path.startsWith(join(workspace.dataDir, 'computers') + sep) || path === join(workspace.dataDir, 'backups') || (!!wikiFolder && (path === wikiFolder || path.startsWith(join(wikiFolder, 'fontes', 'arquivos') + sep)))) void shell.openPath(path)
  } else if (msg.type === 'notify') {
    phone?.notify(workspace.id, msg)
    // Already looking at that conversation: nothing to tell.
    if (registry.selected().id === workspace.id && msg.conversationId && msg.conversationId === viewing && mainWindow?.isFocused()) return
    const sound = chirpOf(msg.kind, msg.sound)
    if (sound) chirp(sound)
    if (!Notification.isSupported()) return
    const n = new Notification({ title: msg.title, body: msg.body, silent: true, ...noteIcon() })
    n.on('click', () => { void switchWorkspace(workspace.id).then(() => showWindow(msg.conversationId, msg.page, msg.threadId)).catch(console.error) })
    n.show()
  } else if (msg.type === 'busy') {
    runtime.busy = msg.busy
    syncBusy()
  } else if (msg.type === 'lang') {
    if (registry.selected().id !== workspace.id) return
    setLang(msg.lang)
    setMenu()
  } else if (msg.type === 'login_item') {
    // Only the installed app: in dev this would register the bare Electron binary.
    if (app.isPackaged && workspace.isDefault) openAtLogin(msg.open)
  } else if (msg.type === 'browser') {
    runtime.browsers.run(msg.agentId, msg.op, msg.args).then(
      (data) => child.postMessage({ type: 'browser-result', id: msg.id, data }),
      (e: unknown) => child.postMessage({ type: 'browser-result', id: msg.id, error: e instanceof Error ? e.message : String(e) })
    )
  } else if (msg.type === 'icons') {
    // The apps' own icons, small, for the picker of the apps an agent may use.
    // The system's own thumbnail of an app bundle is its real icon (getFileIcon gives a generic one for bundles on a Mac).
    const icon = (p: string): Promise<string> =>
      nativeImage.createThumbnailFromPath(p, { width: 64, height: 64 }).then((i) => (i.isEmpty() ? Promise.reject(new Error('empty')) : i.toDataURL())).catch(() => app.getFileIcon(p, { size: 'normal' }).then((i) => i.toDataURL(), () => ''))
    void Promise.all(msg.paths.map(icon))
      .then((urls) => child.postMessage({ type: 'icons-result', id: msg.id, data: Object.fromEntries(msg.paths.map((p, i) => [p, urls[i]])) }))
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
  if (!/^https?:\/\//.test(o.url)) throw new Error(L('Só dá pra capturar endereços http e https.', 'Only http and https addresses can be captured.'))
  const win = new BrowserWindow({
    show: false,
    width: o.width,
    height: o.height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'screenshots' }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await Promise.race([win.loadURL(o.url), wait(30_000).then(() => Promise.reject(new Error(L('A página não carregou em 30 s. Confira o endereço ou tente de novo.', "The page didn't load in 30 s. Check the address or try again."))))])
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
  if (u.host === 'local') {
    // A file the core checked and signed for the window: see resolveLocal.
    const path = verifyLocalUrl(localKey, u)
    if (!path) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(path).toString(), { headers: req.headers }).then((r) => {
      const headers = new Headers(r.headers)
      headers.set('Content-Security-Policy', 'sandbox')
      return new Response(r.body, { status: r.status, headers })
    })
  }
  const [id = '', name = ''] = u.pathname.slice(1).split('/')
  const dir = join(registry.selected().dataDir, 'artifacts', id)
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
ipcMain.on('core:connect', async (event) => {
  if (!fromApp(event)) return
  await systemProxyRead
  const workspace = registry.selected()
  const runtime = startCore(workspace)
  try { await runtime.ready } catch { return }
  if (event.sender.isDestroyed() || registry.selected().id !== workspace.id) return
  const { port1, port2 } = new MessageChannelMain()
  runtime.child.postMessage(null, [port1])
  event.sender.postMessage('core:port', null, [port2])
})

let switching = false
async function switchWorkspace(id: string): Promise<void> {
  if (id === registry.selected().id) return // already on screen: nothing to reload
  if (switching) throw new Error(L('Aguarde a troca de workspace.', 'Wait for the workspace switch.'))
  switching = true
  try {
    const workspace = registry.get(id)
    await startCore(workspace).ready
    cores.get(registry.selected().id)?.child.postMessage({ type: 'viewing', conversationId: null })
    registry.select(id)
    viewing = null
    mainWindow?.reload()
  } finally { switching = false }
}

function trustedWorkspaceRequest(event: Electron.IpcMainInvokeEvent): void {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Not the app window')
}
function requestWorkspace(runtime: Runtime, request: object, response: 'workspace-cleaned' | 'workspace-duplicated' | 'workspace-paused' | 'wiki-relocated'): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Workspace operation timed out')) }, 180_000)
    const onExit = (): void => { cleanup(); reject(new Error('Workspace stopped before the operation finished')) }
    const onMessage = (msg: CoreRequest): void => {
      if (msg.type !== response) return
      cleanup()
      if (msg.error) reject(new Error(msg.error))
      else resolve('agentIds' in msg ? msg.agentIds ?? [] : [])
    }
    const cleanup = (): void => { clearTimeout(timer); runtime.child.removeListener('message', onMessage); runtime.child.removeListener('exit', onExit) }
    runtime.child.on('message', onMessage)
    runtime.child.once('exit', onExit)
    runtime.child.postMessage(request)
  })
}
// Seu iPhone (home-phone.ts): on or off, and a one-time code for the QR.
ipcMain.handle('home-phone:state', (event) => (fromApp(event) ? phone?.state() : undefined))
ipcMain.handle('home-phone:set', (event, on: unknown) => (fromApp(event) && typeof on === 'boolean' ? phone?.set(on) : undefined))
ipcMain.handle('home-phone:code', (event) => (fromApp(event) ? phone?.code() : undefined))
ipcMain.handle('workspaces:list', (event) => { trustedWorkspaceRequest(event); return workspaceList() })
ipcMain.handle('workspaces:pause', async (event, paused: unknown, id?: unknown) => {
  trustedWorkspaceRequest(event)
  if (switching) throw new Error('Wait for the workspace operation')
  if (typeof paused !== 'boolean' || (id !== undefined && typeof id !== 'string')) throw new Error('Invalid workspace pause request')
  const targets = typeof id === 'string' ? [registry.get(id)] : registry.list()
  switching = true
  try {
    const results = await Promise.allSettled(targets.map(async (w) => {
      const runtime = cores.get(w.id)
      // Pausing must never start a failed core and accidentally fire its jobs.
      if (!runtime || runtime.summary.status === 'failed') throw new Error('Workspace is unavailable')
      await runtime.ready
      await requestWorkspace(runtime, { type: 'workspace-pause', paused }, 'workspace-paused')
    }))
    const failed = targets.filter((_w, index) => results[index]!.status === 'rejected')
    if (failed.length) throw new Error(L(`Não foi possível atualizar a pausa de: ${failed.map((w) => w.name).join(', ')}.`, `Could not update pause state for: ${failed.map((w) => w.name).join(', ')}.`))
  } finally { switching = false }
})
ipcMain.handle('workspaces:switch', async (event, id: unknown) => {
  trustedWorkspaceRequest(event)
  if (typeof id !== 'string') throw new Error('Invalid workspace')
  await switchWorkspace(id)
})
ipcMain.handle('workspaces:create', async (event, name?: unknown) => {
  trustedWorkspaceRequest(event)
  if (switching) throw new Error('Wait for the workspace switch')
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 120)) throw new Error(L('Dê um nome ao workspace, com até 120 caracteres.', 'Give the workspace a name, up to 120 characters.'))
  const workspace = registry.create(typeof name === 'string' ? name.trim() : undefined)
  startCore(workspace)
  await switchWorkspace(workspace.id)
})
// `parts`: what comes along; unset, all of it.
ipcMain.handle('workspaces:duplicate', async (event, id: unknown, requestedName?: unknown, parts?: unknown) => {
  trustedWorkspaceRequest(event)
  if (switching) throw new Error('Wait for the workspace operation')
  if (typeof id !== 'string') throw new Error('Invalid workspace')
  if (requestedName !== undefined && (typeof requestedName !== 'string' || !requestedName.trim() || requestedName.trim().length > 120)) throw new Error(L('Dê um nome ao workspace, com até 120 caracteres.', 'Give the workspace a name, up to 120 characters.'))
  const source = registry.get(id)
  switching = true
  let target: Workspace | undefined
  try {
    const runtime = startCore(source)
    await runtime.ready
    const name = typeof requestedName === 'string' ? requestedName.trim() : suggestWorkspaceCopyName(source.name, registry.list().map((w) => w.name))
    target = registry.create(name)
    await requestWorkspace(runtime, { type: 'duplicate-workspace', targetDir: target.dataDir, name: target.name, ...(parts !== undefined ? { parts: workspaceParts(parts) } : {}) }, 'workspace-duplicated')
    await startCore(target).ready
    publishWorkspaces()
    return target.id
  } catch (error) {
    // Only remove a failed, newly generated copy, never the source workspace.
    if (target && !cores.has(target.id)) registry.deleteData(target.id)
    publishWorkspaces()
    throw error
  } finally { switching = false }
})
ipcMain.handle('workspaces:delete', async (event, id: unknown) => {
  trustedWorkspaceRequest(event)
  if (switching) throw new Error('Wait for the workspace switch')
  if (id !== undefined && typeof id !== 'string') throw new Error('Invalid workspace')
  const workspace = id === undefined ? registry.selected() : registry.get(id as string)
  if (workspace.isDefault) throw new Error(L('O workspace padrão não pode ser excluído.', 'The default workspace cannot be deleted.'))
  // Workspaces made with this one's wiki brought along use its folder: the wiki stays, moved to them.
  const inside = (p: string): boolean => p === workspace.dataDir || p.startsWith(workspace.dataDir + sep)
  const sharers = registry.list().filter((w) => w.id !== workspace.id && inside(cores.get(w.id)?.wikiFolder ?? ''))
  if (sharers.some((w) => cores.get(w.id)?.summary.status !== 'ready'))
    throw new Error(L(`A wiki deste workspace também é a de ${sharers.map((w) => `“${w.name}”`).join(', ')}, que não está pronto agora. Tente de novo daqui a pouco.`, `This workspace's wiki is also ${sharers.map((w) => `“${w.name}”`).join(', ')}'s, which isn't ready right now. Try again in a moment.`))
  switching = true
  try {
    const answer = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: L('Excluir workspace', 'Delete workspace'),
      message: L(`Excluir “${workspace.name}” e todos os seus dados?`, `Delete “${workspace.name}” and all its data?`),
      detail: L('Conversas, agentes, memórias, credenciais, rotinas e backups deste workspace serão apagados. Não dá para desfazer. Pastas de projetos e outros workspaces ficam intactos.', 'Conversations, agents, memories, credentials, routines and backups in this workspace will be deleted. This cannot be undone. Project folders and other workspaces are kept.') +
        (sharers.length ? L(` A wiki fica: ela também é a de “${sharers[0]!.name}” e passa para a pasta dele.`, ` The wiki stays: it's also “${sharers[0]!.name}”'s, and moves to its folder.`) : ''),
      buttons: [L('Cancelar', 'Cancel'), L('Excluir todos os dados', 'Delete all data')], defaultId: 0, cancelId: 0, noLink: true
    })
    if (answer.response !== 1) return
    const runtime = startCore(workspace)
    await runtime.ready
    const agentIds = await requestWorkspace(runtime, { type: 'delete-workspace' }, 'workspace-cleaned')
    for (const agentId of agentIds) await runtime.browsers.run(agentId, 'clear')
    runtime.browsers.quit()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Workspace did not stop. Data has not been removed.')), 10_000)
      runtime.child.once('exit', () => { clearTimeout(timer); resolve() })
      if (!runtime.child.kill()) { clearTimeout(timer); reject(new Error('Could not stop workspace')) }
    })
    // Each wiki folder still in use moves to the first workspace using it, and they all follow it.
    for (const folder of new Set(sharers.map((w) => cores.get(w.id)!.wikiFolder))) {
      const using = sharers.filter((w) => cores.get(w.id)!.wikiFolder === folder)
      const to = join(using[0]!.dataDir, `wiki-${workspace.id.slice(-7)}`)
      renameSync(folder, to)
      try {
        for (const w of using) await requestWorkspace(cores.get(w.id)!, { type: 'wiki-relocate', path: to }, 'wiki-relocated')
      } catch (error) {
        renameSync(to, folder) // back where they all look for it; nothing is deleted
        throw error
      }
    }
    const active = registry.selected().id === workspace.id
    registry.deleteData(workspace.id)
    cores.delete(workspace.id)
    for (const w of registry.list()) startCore(w)
    if (active) { viewing = null; mainWindow?.reload() }
    else publishWorkspaces()
  } catch (error) {
    const runtime = cores.get(workspace.id)
    if (runtime) {
      runtime.summary.status = 'failed'
      runtime.child.kill()
      publishWorkspaces()
    }
    throw error
  } finally { switching = false }
})

// Brings the window back (closing it keeps the app and its routines running),
// optionally opening a conversation (and a thread in it).
// The app's own window; agents' browsers are windows too, hidden, and never count as it.
let mainWindow: BrowserWindow | null = null

function showWindow(conversationId?: string, page?: 'skills', threadId?: string): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (!conversationId && !page) return
  servers.showLocal() // a conversation of this computer's: its Tucano on screen
  const go = (): void => (page ? win.webContents.send('navigate-page', page) : win.webContents.send('navigate', conversationId, threadId))
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go)
  else go()
}

// New versions: the window shows when one is ready, and restarting puts it in.
const updates = new Updates((state) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update', state)
})
ipcMain.handle('update:state', (e) => (fromApp(e) ? updates.get() : null))
ipcMain.on('update:check', (e) => fromApp(e) && updates.check())
ipcMain.on('update:install', (e) => {
  if (!fromApp(e)) return
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
  if (!fromApp(event)) return null
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
  // A server on screen keeps the window's size (servers.ts), and comes back in a window made again.
  win.on('resize', () => servers.place())
  win.webContents.once('did-finish-load', () => servers.place())
  win.on('closed', () => {
    if (mainWindow === win) {
      cores.get(registry.selected().id)?.child.postMessage({ type: 'viewing', conversationId: null })
      viewing = null
      mainWindow = null
    }
    stillOpen()
  })

  // Links in messages open in the default browser or the mail app, never inside the app;
  // any other scheme isn't handed to the system either.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOutsideLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // react-markdown renders message links as plain <a href>, and a plain click navigates
  // this whole window. The window only ever shows the app: a reload stays, web and mail
  // links go to the system, and anything else (a local page, which would get the app's
  // bridge to the core) goes nowhere.
  const guard = (event: { preventDefault: () => void }, url: string): void => {
    if (isAppPage(url, APP_PAGE)) return
    event.preventDefault()
    if (isOutsideLink(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', guard)
  win.webContents.on('will-redirect', guard)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

// One app per data folder: two would both run the same routines. Opening it
// again (Dock, Spotlight, at login) just brings the window back. A test run
// with its own data folder is a separate app. `Tucano --quit` (install.ps1, before
// it replaces the app) asks the open one to quit as its tray menu does, and never
// opens one itself.
if (process.env['TUCANO_DATA']) app.setPath('userData', process.env['TUCANO_DATA'])
const quitOnly = process.argv.includes('--quit')
const primary = app.requestSingleInstanceLock() && !quitOnly
if (!primary) app.quit()
// Tucanos on servers, shown in the app's window (servers.ts). The keychain keeps their access, as it
// keeps the core's secrets; where it can't, nothing is saved.
const servers = new Servers({
  dataDir,
  seal: (text) => (safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text' ? safeStorage.encryptString(text).toString('base64') : null),
  unseal: (sealed) => {
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    } catch {
      return null
    }
  },
  changed: () => {
    setMenu()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('servers')
  },
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  showLocal: () => showWindow()
})
// Settings › Servers, on the app's own page only (fromApp): the list without tokens, pairing with a
// pasted link, opening and forgetting.
ipcMain.handle('servers:list', (e) => (fromApp(e) ? servers.summary() : []))
ipcMain.handle('servers:pair', (e, link: unknown) => (fromApp(e) && typeof link === 'string' && link.length < 4096 ? servers.pair(link, false) : 'invalid'))
ipcMain.on('servers:open', (e, id: unknown) => fromApp(e) && typeof id === 'string' && void servers.show(id))
ipcMain.on('servers:local', (e) => fromApp(e) && servers.showLocal())
ipcMain.handle('servers:forget', (e, id: unknown) => (fromApp(e) && typeof id === 'string' ? servers.forget(id, false) : false))
// A server's page in this window hands its notifications here (src/preload/server.ts): the app
// shows them as its own, and a click puts that server, and what it's about, on screen. The page
// already left out the conversation being read there; a server can't send more than a few a minute.
const serverNotes = new Map<string, number[]>()
ipcMain.on('server:notify', (e, raw: unknown) => {
  const frame = e.senderFrame
  const id = frame && frame === e.sender.mainFrame ? servers.serverOf(e.sender, frame.url) : undefined
  const note = id ? serverNote(raw) : null
  if (!id || !note || !Notification.isSupported()) return
  const now = Date.now()
  const recent = (serverNotes.get(id) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= 20) return
  serverNotes.set(id, [...recent, now])
  const sound = chirpOf(note.kind, note.sound)
  if (sound) chirp(sound)
  const n = new Notification({ title: note.title, body: note.body, silent: true, ...noteIcon() })
  n.on('click', () => void servers.openNote(id, note).catch(console.error))
  n.show()
})
// Settings › General › Notifications: one now, so the system asks about them (a Mac lists the app
// under Notifications only after its first one), and the person sees whether they come.
ipcMain.handle('notify:test', (e) => {
  if (!fromApp(e) || !Notification.isSupported()) return 'unsupported'
  new Notification({ title: NAME, body: L('As notificações estão chegando.', 'Notifications are coming through.'), silent: true, ...noteIcon() }).show()
  return 'shown'
})
// A tucano://connect link: on a Mac the system hands it over by open-url; on Windows and Linux it
// comes as an argument, to this instance or (the app already open) to second-instance.
const linkIn = (argv: string[]): string | undefined => argv.find((a) => a.startsWith('tucano://'))
let pendingLink = linkIn(process.argv)
const openLink = (link: string): void => {
  if (app.isReady()) void servers.pairFromOutside(link)
  else pendingLink = link
}
app.on('open-url', (e, url) => {
  e.preventDefault()
  openLink(url)
})
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--quit')) return app.quit()
  const link = linkIn(argv)
  if (link) openLink(link)
  else showWindow()
})

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
      { label: L('Servidores', 'Servers'), submenu: servers.menu(() => clipboard.readText()) },
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
  // Dictation: audio, for the app's own page. A service open in the side panel or anything else asks in vain.
  session.defaultSession.setPermissionRequestHandler((contents, permission, done, details) => {
    if (permission !== 'media') return done(true)
    const media = details as MediaAccessPermissionRequest
    const own = !!BrowserWindow.fromWebContents(contents) && (media.requestingUrl ?? '').startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'file://')
    done(own && !!media.mediaTypes?.length && media.mediaTypes.every((t) => t === 'audio'))
  })
  setMenu()
  protocol.handle('tucano', serveArtifact)
  registry = new Workspaces(dataDir())
  nativeTheme.themeSource = registry.theme() ?? 'system'
  systemProxyRead = readSystemProxy()
  void systemProxyRead.then(startWorkspaces)
  phone = homePhone({
    dir: dataDir(),
    selected: () => registry.selected(),
    workspace: (id) => registry.list().find((w) => w.id === id),
    child: async (id) => {
      const w = registry.list().find((x) => x.id === id)
      if (!w) return undefined
      await systemProxyRead
      const r = startCore(w)
      await r.ready
      return r.child
    },
    publish: (state) => mainWindow?.webContents.send('home-phone', state)
  })
  void phone.restore()
  // The Mac wakes for a few seconds at a time while asleep (maintenance, "DarkWake"):
  // routines wait for a real wake, so a run doesn't start and freeze mid-way.
  powerMonitor.on('suspend', () => { for (const r of cores.values()) r.child.postMessage({ type: 'power', awake: false }) })
  powerMonitor.on('resume', () => { for (const r of cores.values()) r.child.postMessage({ type: 'power', awake: true }) })
  createWindow()
  setTray()
  updates.start()
  // Only the installed app takes tucano:// links: a development run would take them from it.
  if (app.isPackaged) app.setAsDefaultProtocolClient('tucano')
  servers.restore()
  if (pendingLink) void servers.pairFromOutside(pendingLink)
  pendingLink = undefined
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

// A Mac keeps the app in the Dock, Linux and Windows in the tray (see setTray); elsewhere it quits.
app.on('window-all-closed', () => {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) app.quit()
})

app.on('before-quit', () => {
  quitting = true
  void phone?.quit()
  servers.quit()
  for (const r of cores.values()) r.browsers.quit()
})

app.on('will-quit', () => {
  for (const r of cores.values()) r.child.kill()
})
