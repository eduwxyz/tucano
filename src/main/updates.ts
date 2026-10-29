// Updates (the installed app only): Tucano looks for a newer release on GitHub,
// downloads it in the background and says so; the person restarts when it suits
// them, or it goes in the next time the app quits. The release carries
// latest-mac.yml next to the .zip (scripts/release.sh), which is what's read here.
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared/types'

const FIRST_CHECK_MS = 20_000 // after opening, once the app has settled
const EVERY_MS = 4 * 3_600_000

export class Updates {
  private state: UpdateState
  private timer: NodeJS.Timeout | null = null
  private readonly updater = electronUpdater.autoUpdater

  constructor(private readonly onChange: (s: UpdateState) => void) {
    // A test points the app at a local server instead of GitHub.
    const feed = process.env['TUCANO_UPDATE_URL']
    this.state = { version: app.getVersion(), status: app.isPackaged || feed ? 'idle' : 'off' }
    if (this.state.status === 'off') return
    if (feed) this.updater.setFeedURL({ provider: 'generic', url: feed })
    this.updater.logger = null
    this.updater.autoDownload = true
    this.updater.autoInstallOnAppQuit = true
    this.updater.on('checking-for-update', () => this.set({ status: 'checking', error: undefined }))
    this.updater.on('update-not-available', () => this.set({ status: 'latest', checkedAt: Date.now() }))
    this.updater.on('update-available', (info) => this.set({ status: 'downloading', next: info.version, percent: 0, checkedAt: Date.now() }))
    this.updater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    this.updater.on('update-downloaded', (info) => this.set({ status: 'ready', next: info.version, percent: undefined }))
    this.updater.on('error', (e) => this.set({ status: 'error', error: e instanceof Error ? e.message : String(e) }))
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
    this.updater.checkForUpdates().catch(() => {}) // the 'error' event already says what went wrong
  }

  install(): void {
    if (this.state.status === 'ready') this.updater.quitAndInstall()
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }
}
