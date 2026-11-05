// Updates (the installed app only): Tucano looks for a newer release on GitHub,
// downloads it in the background and says so; the person restarts when it suits
// them, or it goes in the next time the app quits. The release carries each system's
// feed: latest-mac.yml next to the .zip (scripts/release.sh), latest-linux*.yml and
// latest.yml, for Windows, from the workflows that build those installers.
import { app } from 'electron'
import electronUpdater, { AppUpdater } from 'electron-updater'
import { offline } from '../shared/errors'
import { L } from '../shared/lang'
import type { UpdateState } from '../shared/types'

const FIRST_CHECK_MS = 20_000 // after opening, once the app has settled
const EVERY_MS = 4 * 3_600_000

export class Updates {
  private state: UpdateState
  private timer: NodeJS.Timeout | null = null
  private readonly updater: AppUpdater | null = null

  constructor(private readonly onChange: (s: UpdateState) => void) {
    // A test points the app at a local server instead of GitHub.
    const feed = process.env['TUCANO_UPDATE_URL']
    this.state = { version: app.getVersion(), status: app.isPackaged || feed ? 'idle' : 'off' }
    // Only create the auto-updater for a packaged app (or a test feed). Running unpacked,
    // electron-updater reads a placeholder version ("0.0") that isn't valid semver and crashes.
    if (!app.isPackaged && !feed) return
    const u = electronUpdater.autoUpdater
    if (feed) u.setFeedURL({ provider: 'generic', url: feed })
    u.logger = null
    u.autoDownload = true
    u.autoInstallOnAppQuit = true
    u.on('checking-for-update', () => this.set({ status: 'checking', error: undefined, errorKind: undefined }))
    u.on('update-not-available', () => this.set({ status: 'latest', checkedAt: Date.now() }))
    u.on('update-available', (info) => this.set({ status: 'downloading', next: info.version, percent: 0, checkedAt: Date.now() }))
    u.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    u.on('update-downloaded', (info) => this.set({ status: 'ready', next: info.version, percent: undefined }))
    // No internet just waits for the next check; anything else may need the new version by hand.
    u.on('error', (e) => {
      console.error('[updates]', e)
      this.set(
        offline(e)
          ? { status: 'error', errorKind: 'offline', error: L('Sem internet pra procurar uma versão nova. Tento de novo mais tarde.', 'No internet to look for a new version. I’ll try again later.') }
          : { status: 'error', errorKind: 'other', error: L('Não consegui atualizar sozinho. Baixe a versão nova na página de versões do Tucano.', 'I couldn’t update on my own. Download the new version from Tucano’s releases page.') }
      )
    })
    Object.defineProperty(this, 'updater', { value: u, writable: false, configurable: false })
  }

  get(): UpdateState {
    return this.state
  }

  start(): void {
    if (this.state.status === 'off') return
    setTimeout(() => this.check(), FIRST_CHECK_MS).unref()
    this.timer = setInterval(() => this.check(), EVERY_MS)
    this.timer.unref()
  }

  // Already downloading or ready: nothing new to ask for.
  check(): void {
    if (this.state.status === 'off' || this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'ready') return
    this.updater!.checkForUpdates().catch(() => {}) // the 'error' event already says what went wrong
  }

  install(): void {
    if (this.state.status !== 'ready') return
    // On Windows the installer runs without its window, then opens the app again.
    if (process.platform === 'win32') this.updater!.quitAndInstall(true, true)
    else this.updater!.quitAndInstall()
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }
}
