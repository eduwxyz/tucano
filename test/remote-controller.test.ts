// Production main-process controller with Electron and network edges replaced.
// This exercises IPC/lifecycle ownership, not a second implementation of switching.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteStore, type SavedRemote } from '../src/main/remote-store'

const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), clients: [] as any[], windows: [] as any[], channels: [] as any[], cores: [] as any[], app: null as any, ipc: null as any, fail: false, hold: undefined as Promise<void> | undefined, browserQuit: vi.fn() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Port extends EventEmitter { postMessage = vi.fn(); close = vi.fn(); start = vi.fn() }
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn(), postMessage: vi.fn(), reload: vi.fn(), setWindowOpenHandler: vi.fn(), isLoading: () => false, getURL: () => 'file:///app/index.html' })
    constructor() { super(); h.windows.push(this) }
    isDestroyed = () => false; isMinimized = () => false; isFocused = () => true
    show = vi.fn(); focus = vi.fn(); restore = vi.fn(); loadFile = vi.fn(async () => {}); loadURL = vi.fn(async () => {})
  }
  const app = Object.assign(new EventEmitter(), { isPackaged: false, setName: vi.fn(), setAppUserModelId: vi.fn(), setLoginItemSettings: vi.fn(), setAsDefaultProtocolClient: vi.fn(), exit: vi.fn(), getPreferredSystemLanguages: () => ['en'], getPath: () => process.env.TUCANO_DATA!, setPath: vi.fn(), requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), isReady: () => true, setAboutPanelOptions: vi.fn(), getVersion: () => '1.0.0', getAppPath: () => '/app', quit: vi.fn() })
  const ipcMain = Object.assign(new EventEmitter(), { handle: (name: string, fn: Function) => h.handlers.set(name, fn) })
  h.app = app; h.ipc = ipcMain
  return {
    app, ipcMain, BrowserWindow: Window,
    MessageChannelMain: class { port1 = new Port(); port2 = new Port(); constructor() { h.channels.push(this) } },
    utilityProcess: { fork: vi.fn(() => { const core = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }); h.cores.push(core); return core }) },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, nativeTheme: { shouldUseDarkColors: false },
    Notification: class { static isSupported() { return false } },
    powerMonitor: new EventEmitter(), powerSaveBlocker: { start: () => 1, stop: vi.fn() },
    dialog: {}, shell: { openExternal: vi.fn() }, net: {}
  }
})
vi.mock('../src/main/browser', () => ({ Browsers: class { quit = h.browserQuit } }))
vi.mock('../src/main/updates', () => ({ Updates: class { start() {} } }))
vi.mock('../src/main/migrate', () => ({ bundleOf: () => '', moveFromAgentDesk: () => 'nothing' }))
vi.mock('../src/core/platform', () => ({ onPath: () => false }))
vi.mock('../src/main/remote', () => ({ RemoteClient: class {
  disconnect = vi.fn(); send = vi.fn(async (_message: unknown) => {})
  constructor(public options: any) { h.clients.push(this) }
  async connect(_profile: unknown, _token: string) { if (h.hold) await h.hold; if (h.fail) throw new Error('Network unavailable'); this.options.onState({ status: 'connected' }) }
  async pair(link: any) { return { profile: { ...profile('fresh'), name: link.name, reach: link.reach, server: 'server-a' }, token: 'paired-private-token' } }
} }))
const profile = (id: string): SavedRemote => ({ id, name: id.toUpperCase(), reach: { via: 'url', url: `https://${id}.example.com` }, remotePort: 7337, server: `server-${id}`, device: { id: `device-${id}`, label: 'Mac', created: 1, seen: 1 }, days: 30 })
const secrets = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
let dir = ''
function event() { const sender = h.windows.at(-1).webContents; return { sender, senderFrame: sender.mainFrame } }
function invoke(name: string, ...args: unknown[]): any { return h.handlers.get(name)!(event(), ...args) }
function port() { h.ipc.emit('core:connect', event()); return h.channels.at(-1).port1 }
async function boot(selected?: string) {
  if (selected) writeFileSync(join(dir, 'remote-selection.json'), JSON.stringify({ active: selected }))
  await import('../src/main/index')
  await vi.waitFor(() => expect(h.windows).toHaveLength(1))
}
beforeEach(() => {
  vi.resetModules(); h.app?.removeAllListeners(); h.ipc?.removeAllListeners(); h.handlers.clear(); h.clients.length = h.windows.length = h.channels.length = h.cores.length = 0
  h.fail = false; h.hold = undefined; h.browserQuit.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'tucano-controller-')); vi.stubEnv('TUCANO_DATA', dir)
  const store = new RemoteStore(join(dir, 'remote-connections.json'), secrets)
  store.put(profile('a'), 'private-token-a'); store.put(profile('b'), 'private-token-b')
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

describe('native remote controller lifecycle', () => {
  it('initializes the native shell on the current operating system', async () => {
    await boot()
    expect(h.app.setName).toHaveBeenCalledWith('Tucano')
    if (process.platform === 'win32') expect(h.app.setAppUserModelId).toHaveBeenCalledWith('dev.tucano.app')
    else expect(h.app.setAppUserModelId).not.toHaveBeenCalled()
    expect(h.cores).toHaveLength(1)
    expect(invoke('remote:state').status).toBe('local')
  })
  it('switches Local → A → B → Local while preserving the single local core', async () => {
    await boot(); const localPort = port()
    expect(h.cores[0].postMessage).toHaveBeenCalledWith(null, [localPort])
    await invoke('remote:select', 'a'); expect(invoke('remote:state').active).toBe('a')
    const a = h.clients.at(-1)
    await invoke('remote:select', 'b'); expect(a.disconnect).toHaveBeenCalledOnce()
    await invoke('remote:select', null)
    expect(invoke('remote:state').status).toBe('local'); expect(h.cores).toHaveLength(1)
    expect(h.cores[0].kill).not.toHaveBeenCalled(); expect(h.browserQuit).not.toHaveBeenCalled()
  })
  it('preserves A after a failed B switch and rejects overlapping transitions', async () => {
    await boot(); await invoke('remote:select', 'a'); const a = h.clients.at(-1)
    let release!: () => void; h.hold = new Promise<void>(r => { release = r }); h.fail = true
    const pending = invoke('remote:select', 'b')
    await expect(invoke('remote:select', null)).rejects.toThrow('already in progress')
    release(); await expect(pending).rejects.toThrow('Network unavailable')
    expect(invoke('remote:state')).toMatchObject({ active: 'a', status: 'connected' }); expect(a.disconnect).not.toHaveBeenCalled()
  })
  it('drops late RPC replies across renderer reload and environment replacement', async () => {
    await boot(); await invoke('remote:select', 'a'); const a = h.clients.at(-1), first = port()
    first.emit('message', { data: { id: 1, method: 'snapshot' } }); const wire1 = a.send.mock.calls[0][0].id
    const second = port(); second.emit('message', { data: { id: 1, method: 'snapshot' } }); const wire2 = a.send.mock.calls[1][0].id
    expect(wire2).not.toBe(wire1)
    a.options.onMessage({ id: wire1, result: 'stale' }); expect(second.postMessage).not.toHaveBeenCalled()
    a.options.onMessage({ id: wire2, result: 'current' }); expect(second.postMessage).toHaveBeenCalledWith({ id: 1, result: 'current' })
    await invoke('remote:select', 'b'); const third = port()
    a.options.onMessage({ event: { type: 'settings' } }); expect(third.postMessage).not.toHaveBeenCalled()
  })
  it('opens external pairing links for review without redeeming them, and replaces re-paired profiles', async () => {
    await boot()
    const link = 'tucano://pair?v=1&code=K7QM-2XPD-9TWH&url=https%3A%2F%2Fa.example.com&name=Replacement'
    const e = { preventDefault: vi.fn() }; h.app.emit('open-url', e, link)
    expect(e.preventDefault).toHaveBeenCalledOnce(); expect(h.clients).toHaveLength(0)
    expect(invoke('remote:state').pairLink).toBe(link)
    await invoke('remote:rename', 'a', 'Production'); await invoke('remote:pair', link)
    const state = invoke('remote:state'); expect(state.active).toBe('a'); expect(state.profiles).toHaveLength(2)
    expect(state.profiles.find((p: any) => p.id === 'a').name).toBe('Production'); expect(state.pairLink).toBeUndefined()
    expect(JSON.stringify(state)).not.toContain('private-token')
  })
  it('forgets the active profile by returning Local without stopping work', async () => {
    await boot(); await invoke('remote:select', 'a'); await invoke('remote:forget', 'a')
    expect(invoke('remote:state')).toMatchObject({ active: null, status: 'local' })
    expect(invoke('remote:state').profiles.map((p: any) => p.id)).toEqual(['b'])
    expect(h.cores[0].kill).not.toHaveBeenCalled()
    const rogue = { sender: {}, senderFrame: {} }
    expect(() => h.handlers.get('remote:rename')!(rogue, 'b', 'Hijacked')).toThrow('Untrusted')
  })
  it('keeps saved remote selection visible when startup is offline and permits Local recovery', async () => {
    h.fail = true; await boot('a')
    await vi.waitFor(() => expect(invoke('remote:state')).toMatchObject({ active: 'a', status: 'error' }))
    expect(h.cores).toHaveLength(1)
    await invoke('remote:select', null); expect(invoke('remote:state').status).toBe('local')
  })
  it('blocks navigation to arbitrary schemes in the privileged app window', async () => {
    await boot()
    const wc = h.windows[0].webContents
    const e = { preventDefault: vi.fn() }
    wc.emit('will-navigate', e, 'data:text/html,untrusted')
    expect(e.preventDefault).toHaveBeenCalledOnce()
    const handler = wc.setWindowOpenHandler.mock.calls[0][0]
    expect(handler({ url: 'file:///tmp/untrusted.html' })).toEqual({ action: 'deny' })
    expect(h.clients).toHaveLength(0)
  })

})
