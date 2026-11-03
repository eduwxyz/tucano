import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeImage, nativeTheme, net, Notification, powerMonitor, powerSaveBlocker, protocol, safeStorage, shell, Tray, utilityProcess, type UtilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { L, langOf, setLang, type Lang } from '../shared/lang'
import { chirpOf, type BrowserOp } from '../shared/types'
import { Browsers } from './browser'
import { bundleOf, moveFromAgentDesk, type Moved } from './migrate'
import { Updates } from './updates'
import { RemoteClient, type RemoteState as TransportState } from './remote'
import { RemoteStore } from './remote-store'
import { SessionDrafts } from './session-drafts'
import { parsePairLink } from '../shared/pairlink'
import { autostartEntry, autostartFile, onPath } from '../core/platform'

const NAME = 'Tucano'
app.setName(NAME)
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
  child.on('message', (msg: CoreRequest) => { if (core === child) handleCore(child, msg) })
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
  | { type: 'notify'; title: string; body: string; conversationId?: string; kind?: 'approval' | 'question' | 'done'; sound?: boolean }
  | { type: 'login_item'; open: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'lang'; lang: Lang }
  | { type: 'screenshot'; id: string; url: string; width: number; height: number; fullPage: boolean }
  | { type: 'icons'; id: string; paths: string[] }
  | { type: 'browser'; id: string; agentId: string; op: BrowserOp; args?: Record<string, unknown> }

// The conversation open in the window, so a notification about it can stay quiet.
let viewing: string | null = null
ipcMain.on('viewing', (_e, id: unknown) => {
  viewing = !activeRemote && typeof id === 'string' ? id : null
})

// The toucan's own sound, instead of the system's: a knock at the door when an agent needs
// you, two notes when the work is done. Never more than one at a time.
let chirpedAt = 0
const resource = (name: string): string => (app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'build', name))
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
    body: L('As rotinas seguem rodando. Pra voltar, use o ícone do tucano perto do relógio ou abra o Tucano de novo.', 'Routines keep running. To get back, use the toucan icon by the clock or open Tucano again.'),
    silent: true
  }).show()
}

// Things the core can't do itself: the OS keychain, the browser, notifications.
function handleCore(child: UtilityProcess, msg: CoreRequest): void {
  if (child !== core) return
  if (msg.type === 'secret') {
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
      if (!safeStorage.isEncryptionAvailable()) throw new Error(L('O cofre do sistema não está disponível.', "The system's vault isn't available."))
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
    const sound = chirpOf(msg.kind, msg.sound)
    if (sound) chirp(sound)
    if (!Notification.isSupported()) return
    const n = new Notification({ title: activeRemote ? `${L('Local', 'Local')} · ${msg.title}` : msg.title, body: msg.body, silent: true, ...noteIcon() })
    n.on('click', () => {
      void openLocalConversation(msg.conversationId)
    })
    n.show()
  } else if (msg.type === 'busy') {
    if (msg.busy && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!msg.busy && awakeBlocker !== null) {
      powerSaveBlocker.stop(awakeBlocker)
      awakeBlocker = null
    }
  } else if (msg.type === 'lang') {
    if (activeRemote) return
    setLang(msg.lang)
    setMenu()
  } else if (msg.type === 'login_item') {
    // Only the installed app: in dev this would register the bare Electron binary.
    if (app.isPackaged) openAtLogin(msg.open)
  } else if (msg.type === 'browser') {
    browsers.run(msg.agentId, msg.op, msg.args).then(
      (data) => { if (core === child) child.postMessage({ type: 'browser-result', id: msg.id, data }) },
      (e: unknown) => { if (core === child) child.postMessage({ type: 'browser-result', id: msg.id, error: e instanceof Error ? e.message : String(e) }) }
    )
  } else if (msg.type === 'icons') {
    // The apps' own icons, small, for the picker of the apps an agent may use.
    // The system's own thumbnail of an app bundle is its real icon (getFileIcon gives a generic one for bundles on a Mac).
    const icon = (p: string): Promise<string> =>
      nativeImage.createThumbnailFromPath(p, { width: 64, height: 64 }).then((i) => (i.isEmpty() ? Promise.reject(new Error('empty')) : i.toDataURL())).catch(() => app.getFileIcon(p, { size: 'normal' }).then((i) => i.toDataURL(), () => ''))
    void Promise.all(msg.paths.map(icon))
      .then((urls) => { if (core === child) child.postMessage({ type: 'icons-result', id: msg.id, data: Object.fromEntries(msg.paths.map((p, i) => [p, urls[i]])) }) })
  } else if (msg.type === 'screenshot') {
    screenshot(msg).then(
      (png) => { if (core === child) child.postMessage({ type: 'screenshot-result', id: msg.id, data: png.toString('base64') }) },
      (e: unknown) => { if (core === child) child.postMessage({ type: 'screenshot-result', id: msg.id, error: e instanceof Error ? e.message : String(e) }) }
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
  if (activeRemote) {
    if (u.host !== 'artifact' || !/^[0-9a-f-]{36}$/.test(id) || !name || u.search || u.hash) return new Response('not found', { status: 404 })
    return remoteClient?.asset(`/artifact/${id}/${name}`).catch(() => new Response('remote asset unavailable', { status: 503 })) ?? new Response('server disconnected', { status: 503 })
  }
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

// A remote server uses the same renderer contract, but its token stays in this process.
let remoteStore: RemoteStore | undefined
let remoteClient: RemoteClient | undefined
const clientStates = new WeakMap<RemoteClient, TransportState>()
let activeRemote: string | null = null
let remoteStatus: TransportState = { status: 'disconnected' }
let switchError: string | undefined
let pendingPairLink: string | undefined
let pairLinkSequence = 0
let switching = false
let switchSettled = Promise.resolve()
let activeServer: string | undefined
const sessionDrafts = new SessionDrafts()
let draftSession: string | undefined
let checkpointSequence = 0
let pendingCheckpoint: { id: number; session: string; finish(ok: boolean): void } | undefined
let remotePort: Electron.MessagePortMain | undefined
let requestSequence = 0
const remoteRequests = new Map<number, number>()
const selectionFile = (): string => join(dataDir(), 'remote-selection.json')
function rememberSelection(id: string | null): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  const file = selectionFile()
  writeFileSync(`${file}.tmp`, JSON.stringify({ active: id }), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}
function connectionState(): unknown {
  let profiles = [] as ReturnType<RemoteStore['list']>
  let error = switchError ?? remoteStatus.error
  try { profiles = remoteStore?.list() ?? [] } catch { error = 'Cannot read saved servers. Restore the connection file from backup.' }
  return { active: activeRemote, profiles: profiles.map(({ id, name, reach, remotePort }) => ({ id, name, reach, remotePort })),
    status: !activeRemote ? 'local' : remoteStatus.status === 'disconnected' ? 'connecting' : remoteStatus.status,
    error, switching, pairLink: pendingPairLink, pairLinkId: pendingPairLink ? pairLinkSequence : undefined }
}
function publishConnection(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:state', connectionState())
}
function remoteMessage(message: unknown): void {
  if (!message || typeof message !== 'object' || !remotePort) return
  const msg = message as { id?: number; event?: unknown; result?: unknown; error?: string }
  if ('event' in msg) { remotePort.postMessage(msg); return }
  if (typeof msg.id !== 'number') return
  const original = remoteRequests.get(msg.id)
  if (original === undefined) return
  remoteRequests.delete(msg.id)
  // Keep the server platform for its tool setup; desktop chrome uses the separate client platform.
  if (msg.result && typeof msg.result === 'object' && 'platform' in msg.result && 'settings' in msg.result)
    msg.result = { ...msg.result, packaged: app.isPackaged }
  remotePort.postMessage({ ...msg, id: original })
}
function candidateClient(): RemoteClient {
  const client = new RemoteClient({
    onMessage: (message) => { if (remoteClient === client) remoteMessage(message) },
    onState: (state) => {
      clientStates.set(client, state)
      if (remoteClient !== client) return
      remoteStatus = state
      if (state.status === 'error') {
        switchError = undefined
        for (const id of remoteRequests.values()) remotePort?.postMessage({ id, error: state.error ?? 'Server disconnected.' })
        remoteRequests.clear()
      }
      publishConnection()
    }
  })
  return client
}
function trustedWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Untrusted window.')
}
ipcMain.on('drafts:open', (event) => {
  trustedWindow(event)
  const opened = sessionDrafts.open(activeRemote, activeServer)
  draftSession = opened.session
  event.returnValue = opened
})
ipcMain.on('drafts:save', (event, session: unknown, entries: unknown) => {
  trustedWindow(event)
  event.returnValue = typeof session === 'string' ? sessionDrafts.save(session, entries) : 'invalid'
})
ipcMain.on('drafts:checkpoint', (event, id: unknown, session: unknown, entries: unknown) => {
  trustedWindow(event)
  if (!pendingCheckpoint || id !== pendingCheckpoint.id || session !== pendingCheckpoint.session) return
  pendingCheckpoint.finish(sessionDrafts.save(pendingCheckpoint.session, entries) !== 'invalid')
})
async function checkpointDrafts(): Promise<void> {
  if (!draftSession || !mainWindow || mainWindow.isDestroyed()) return
  const session = draftSession, win = mainWindow
  const saved = await new Promise<boolean>((resolve) => {
    const id = ++checkpointSequence
    const timer = setTimeout(() => finish(false), 5000)
    const finish = (ok: boolean): void => {
      clearTimeout(timer)
      if (pendingCheckpoint?.id === id) pendingCheckpoint = undefined
      resolve(ok)
    }
    pendingCheckpoint = { id, session, finish }
    win.webContents.send('drafts:checkpoint', id)
  })
  if (!saved) throw new Error('Cannot keep unsent drafts. Your current environment is unchanged. Try again or save your draft before switching.')
}
async function openLocalConversation(conversationId?: string): Promise<void> {
  // A notification belongs to the local core even if a VPS transition is pending.
  while (switching) await switchSettled
  try {
    if (activeRemote) await switchConnection(null)
    showWindow(conversationId)
  } catch {
    // Keep the current environment intact (for example while a draft is sending).
    showWindow()
  }
}
async function switchConnection(id: string | null, pairingLink?: string, reload = true): Promise<void> {
  if (switching) throw new Error('A connection is already in progress.')
  if (!remoteStore) throw new Error('Connections are not ready.')
  if (id !== null && (typeof id !== 'string' || !id)) throw new Error('Invalid server selection.')
  if (pairingLink === undefined && id === activeRemote && (id === null ? !remoteStatus.error : remoteClient && remoteStatus.status === 'connected')) return
  switching = true
  switchError = undefined
  let settle!: () => void
  switchSettled = new Promise<void>((resolve) => { settle = resolve })
  publishConnection()
  let candidate: RemoteClient | undefined
  let server: string | undefined
  let pairedSaved = false
  try {
    if (pairingLink !== undefined) {
      const parsed = parsePairLink(pairingLink)
      if (!parsed.ok) throw new Error(parsed.error)
      const pending = pendingPairLink ? parsePairLink(pendingPairLink) : undefined
      const arrival = pending?.ok && pending.link.code === parsed.link.code && pending.link.remotePort === parsed.link.remotePort &&
        JSON.stringify(pending.link.reach) === JSON.stringify(parsed.link.reach) ? pairLinkSequence : undefined
      // Refuse an unreadable store before consuming a single-use pairing code.
      const profiles = remoteStore.list()
      // Check the vault before redeeming a single-use code.
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())))
        throw new Error('Secure storage is unavailable. Unlock the system keychain and try again.')
      candidate = candidateClient()
      const { profile, token } = await candidate.pair(parsed.link)
      const previous = profiles.find((p) => p.server === profile.server && p.remotePort === profile.remotePort && JSON.stringify(p.reach) === JSON.stringify(profile.reach))
      if (previous) { profile.id = previous.id; profile.name = previous.name }
      remoteStore.put(profile, token)
      pairedSaved = true
      id = profile.id
      if (arrival !== undefined && arrival === pairLinkSequence) pendingPairLink = undefined
    }
    if (id) {
      const saved = remoteStore.get(id)
      if (!saved) throw new Error('Saved server not found.')
      candidate ??= candidateClient()
      await candidate.connect(saved.profile, saved.token)
      const ready = clientStates.get(candidate)
      if (ready?.status !== 'connected') throw new Error(ready?.error ?? 'Server disconnected before the workspace opened.')
      server = saved.profile.server
    }
    if (reload) await checkpointDrafts()
    // The event stream can close while the renderer checkpoints a large draft.
    if (candidate && clientStates.get(candidate)?.status !== 'connected') throw new Error('Server disconnected before the workspace opened.')
    rememberSelection(id)
    const old = remoteClient
    remoteClient = candidate
    activeRemote = id
    activeServer = server
    remoteStatus = { status: id ? 'connected' : 'disconnected' }
    old?.disconnect()
    remotePort?.close(); remotePort = undefined; remoteRequests.clear()
    viewing = null
    // Selecting an environment only changes the view. Local and VPS routines keep running.
    core ??= startCore()
    if (reload && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
  } catch (error) {
    candidate?.disconnect()
    // Keep the previous connection usable after a failed switch.
    if (!activeRemote && !core) core = startCore()
    const failure = pairedSaved ? new Error('Server paired and saved, but connection failed. Choose its saved connection to retry without a new pairing code.') : error
    switchError = failure instanceof Error ? failure.message : 'Connection failed.'
    if (!remoteClient) remoteStatus = { status: 'error', error: failure instanceof Error ? failure.message : 'Connection failed.' }
    throw failure
  } finally { switching = false; publishConnection(); settle() }
}
ipcMain.handle('remote:state', (event) => { trustedWindow(event); return connectionState() })
ipcMain.handle('remote:pair', async (event, link: unknown) => {
  trustedWindow(event)
  if (typeof link !== 'string' || link.length > 2048) throw new Error('Invalid pairing link.')
  await switchConnection(null, link)
})
ipcMain.handle('remote:select', async (event, id: unknown) => {
  trustedWindow(event)
  if (id !== null && (typeof id !== 'string' || !id)) throw new Error('Invalid server selection.')
  await switchConnection(id)
})
ipcMain.handle('remote:rename', (event, id: unknown, name: unknown) => {
  trustedWindow(event)
  if (switching || typeof id !== 'string' || typeof name !== 'string') throw new Error('Connection is busy or invalid.')
  remoteStore?.rename(id, name)
  publishConnection()
})
ipcMain.handle('remote:forget', async (event, id: unknown) => {
  trustedWindow(event)
  if (switching || typeof id !== 'string') throw new Error('Connection is busy or invalid.')
  if (activeRemote === id) await switchConnection(null)
  remoteStore?.remove(id)
  sessionDrafts.forget(id)
  publishConnection()
})
ipcMain.on('remote:mode', (event) => {
  event.returnValue = !!mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && !!activeRemote
})
function receivePairLink(link: string): void {
  if (!parsePairLink(link).ok) return
  // An external link only opens a review screen. It never runs SSH or redeems a code by itself.
  pendingPairLink = link
  pairLinkSequence++
  if (app.isReady()) { showWindow(); publishConnection() }
}
app.on('open-url', (event, url) => { event.preventDefault(); receivePairLink(url) })

// Each page load gets a new port; RPC ids are remapped so a late reply cannot reach another screen.
ipcMain.on('core:connect', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return
  const { port1, port2 } = new MessageChannelMain()
  if (!activeRemote) {
    core ??= startCore()
    core.postMessage(null, [port1])
  } else {
    remotePort?.close(); remoteRequests.clear(); remotePort = port1
    port1.on('close', () => { if (remotePort === port1) { remotePort = undefined; remoteRequests.clear() } })
    port1.on('message', ({ data }: { data: { id?: unknown; method?: unknown; params?: unknown } }) => {
      if (!data || !Number.isSafeInteger(data.id) || typeof data.method !== 'string') return
      const id = data.id as number
      if (data.method === 'openExternal') {
        const url = (data.params as { url?: unknown } | undefined)?.url
        if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url)
        port1.postMessage({ id, result: null }); return
      }
      if (!remoteClient || remoteStatus.status !== 'connected') { port1.postMessage({ id, error: 'Server disconnected. Use Reconnect or Local.' }); return }
      const wireId = ++requestSequence
      remoteRequests.set(wireId, id)
      void remoteClient.send({ ...data, id: wireId }).catch((error: unknown) => {
        if (remoteRequests.delete(wireId)) port1.postMessage({ id, error: error instanceof Error ? error.message : 'Server disconnected.' })
      })
    })
    port1.start()
  }
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
  trustedWindow(event)
  if (activeRemote) throw new Error('Use a folder path on the VPS, not a folder on this computer.')
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
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: [L('Continuar editando', 'Keep editing'), L('Continuar mesmo assim', 'Continue anyway')],
      defaultId: 0, cancelId: 0,
      message: L('Não foi possível preservar os rascunhos', 'Could not preserve unsent drafts'),
      detail: L('Aguarde o envio ou o preparo de imagens e tente novamente. Se o rascunho for muito grande, copie o texto antes de sair. Continuar pode descartar rascunhos; uma mensagem já enviada ainda pode chegar ao servidor.', 'Wait for sending or image preparation to finish, then try again. If the draft is too large, copy the text before leaving. Continuing may discard drafts; a message already sent may still reach the server.')
    })
    if (choice === 1) event.preventDefault()
    else quitting = false
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    stillOpen()
  })

  // Links in messages open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    else if (url.startsWith('tucano://pair')) receivePairLink(url)
    return { action: 'deny' }
  })

  // react-markdown renders message links as plain <a href>, and a plain click
  // navigates this whole window away (the app "disappears" behind the site).
  // Same promise as above, for those: web links go to the real browser;
  // a same-URL navigation (reload) is not a link and stays.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    else if (url.startsWith('tucano://pair')) receivePairLink(url)
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
// with its own data folder is a separate app. `Tucano --quit` (install.ps1, before
// it replaces the app) asks the open one to quit as its tray menu does, and never
// opens one itself.
if (process.env['TUCANO_DATA']) app.setPath('userData', process.env['TUCANO_DATA'])
const quitOnly = process.argv.includes('--quit')
const primary = app.requestSingleInstanceLock() && !quitOnly
if (!primary) app.quit()
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--quit')) return app.quit()
  for (const arg of argv) if (arg.startsWith('tucano://pair')) receivePairLink(arg)
  showWindow()
})
for (const arg of process.argv) if (arg.startsWith('tucano://pair')) receivePairLink(arg)

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
} else if (primary) app.whenReady().then(async () => {
  setMenu()
  protocol.handle('tucano', serveArtifact)
  remoteStore = new RemoteStore(join(dataDir(), 'remote-connections.json'), safeStorage)
  try {
    const selected = JSON.parse(readFileSync(selectionFile(), 'utf8')) as { active?: unknown }
    if (typeof selected.active === 'string') activeRemote = selected.active
  } catch { /* a fresh installation starts locally */ }
  if (app.isPackaged) app.setAsDefaultProtocolClient('tucano')
  core = startCore()
  // The Mac wakes for a few seconds at a time while asleep (maintenance, "DarkWake"):
  // routines wait for a real wake, so a run doesn't start and freeze mid-way.
  powerMonitor.on('suspend', () => core?.postMessage({ type: 'power', awake: false }))
  powerMonitor.on('resume', () => core?.postMessage({ type: 'power', awake: true }))
  createWindow()
  if (activeRemote) void switchConnection(activeRemote, undefined, true).catch(() => publishConnection())
  setTray()
  updates.start()
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
})

app.on('will-quit', () => {
  browsers.quit()
  remoteClient?.disconnect()
  core?.kill()
})
