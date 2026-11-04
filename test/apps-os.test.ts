import { afterEach, describe, expect, it, vi } from 'vitest'
import { appOfWindow, desktopDirs, execArgs, iconFile, parseDesktopEntry, parseWinApps, parseWinOpen } from '../src/core/apps-os'

describe('Linux application menu', () => {
  const entry = `[Desktop Entry]
Name=Text Editor
Name[pt_BR]=Editor de texto
Name[pt]=Editor de Texto (pt)
Exec=gnome-text-editor %U
Icon=org.gnome.TextEditor
Type=Application
StartupWMClass=gnome-text-editor

[Desktop Action new-window]
Name=New Window
Exec=gnome-text-editor --new-window`

  it("reads an entry's name in the person's language, then the language's, then the plain one", () => {
    expect(parseDesktopEntry(entry, 'pt_BR.UTF-8')).toEqual({ name: 'Editor de texto', icon: 'org.gnome.TextEditor', exec: 'gnome-text-editor %U', wmClass: 'gnome-text-editor' })
    expect(parseDesktopEntry(entry, 'pt_PT')?.name).toBe('Editor de Texto (pt)')
    expect(parseDesktopEntry(entry, 'de_DE')?.name).toBe('Text Editor')
  })

  it("leaves out what a launcher doesn't show", () => {
    expect(parseDesktopEntry('[Desktop Entry]\nName=Helper\nNoDisplay=true\nExec=x')).toBeUndefined()
    expect(parseDesktopEntry('[Desktop Entry]\nName=htop\nTerminal=true\nExec=htop')).toBeUndefined()
    expect(parseDesktopEntry('[Desktop Entry]\nName=Docs\nType=Link\nURL=https://x')).toBeUndefined()
  })

  it('turns Exec into a command, quoted words whole and field codes dropped', () => {
    expect(execArgs('gnome-text-editor %U')).toEqual(['gnome-text-editor'])
    expect(execArgs('/usr/bin/flatpak run --branch=stable --command=spotify com.spotify.Client @@u %U @@')).toEqual(['/usr/bin/flatpak', 'run', '--branch=stable', '--command=spotify', 'com.spotify.Client', '@@u', '@@'])
    expect(execArgs('"/opt/My App/app" --flag "a b" %f 100%%')).toEqual(['/opt/My App/app', '--flag', 'a b', '100%'])
  })

  it("looks in the person's folders first, then Flatpak's, Snap's and the system's", () => {
    const dirs = desktopDirs({ XDG_DATA_DIRS: '/usr/share' }, '/home/ana')
    expect(dirs[0]).toBe('/home/ana/.local/share/applications')
    expect(dirs).toContain('/var/lib/flatpak/exports/share/applications')
    expect(dirs).toContain('/var/lib/snapd/desktop/applications')
    expect(dirs.at(-1)).toBe('/usr/share/applications')
  })

  it('finds an icon by name in the themes, a size that looks good first', () => {
    const files = new Set(['/usr/share/icons/hicolor/256x256/apps/spotify.png', '/usr/share/icons/hicolor/48x48/apps/spotify.png', '/usr/share/icons/hicolor/scalable/apps/org.gnome.TextEditor.svg'])
    const has = (p: string): boolean => files.has(p)
    expect(iconFile('spotify', has, { XDG_DATA_DIRS: '/usr/share' }, '/home/ana')).toBe('/usr/share/icons/hicolor/48x48/apps/spotify.png')
    expect(iconFile('org.gnome.TextEditor', has, { XDG_DATA_DIRS: '/usr/share' }, '/home/ana')).toBe('/usr/share/icons/hicolor/scalable/apps/org.gnome.TextEditor.svg')
    expect(iconFile('/opt/x/icon.png', (p) => p === '/opt/x/icon.png')).toBe('/opt/x/icon.png')
    expect(iconFile('nothing', () => false)).toBeUndefined()
  })
})

describe('Windows Start menu', () => {
  const rows = [
    { name: 'Spotify', path: 'C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Spotify.lnk', exe: 'C:\\Users\\ana\\AppData\\Roaming\\Spotify\\Spotify.exe' },
    { name: 'Uninstall Spotify', path: 'x.lnk', exe: 'C:\\Spotify\\unins000.exe' },
    { name: 'Bloco de Notas', id: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', logo: null, dir: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2409.9.0_x64__8wekyb3d8bbwe' },
    { name: 'spotify', path: 'y.lnk', exe: 'C:\\Spotify\\Spotify.exe' }
  ]

  it('lists shortcuts and Store apps, without uninstallers or the same app twice', () => {
    const apps = parseWinApps(JSON.stringify(rows), () => false)
    expect(apps.map((a) => a.name)).toEqual(['Bloco de Notas', 'Spotify'])
    expect(apps.find((a) => a.name === 'Spotify')).toMatchObject({ path: rows[0]!.exe, exe: rows[0]!.exe })
    expect(apps.find((a) => a.name === 'Bloco de Notas')).toMatchObject({ id: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' })
  })

  it("marks an app made with Chromium or Electron by what's next to its program", () => {
    const apps = parseWinApps(JSON.stringify([rows[0]]), (p) => p === 'C:\\Users\\ana\\AppData\\Roaming\\Spotify\\chrome_100_percent.pak')
    expect(apps[0]?.chromium).toBe(true)
  })

  it('takes a single row and bad output without breaking', () => {
    expect(parseWinApps(JSON.stringify(rows[2]))).toHaveLength(1)
    expect(parseWinApps('')).toEqual([])
    expect(parseWinApps('not json')).toEqual([])
  })

  it("matches an open window to its app by program, a Store app's by its folder", () => {
    const apps = parseWinApps(JSON.stringify(rows), () => false)
    expect(appOfWindow({ pid: 1, name: 'Spotify', path: 'c:\\users\\ana\\appdata\\roaming\\spotify\\spotify.exe' }, apps)?.name).toBe('Spotify')
    expect(appOfWindow({ pid: 2, name: 'Notepad', path: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2409.9.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe' }, apps)?.name).toBe('Bloco de Notas')
    expect(appOfWindow({ pid: 3, name: 'obs64', desc: 'OBS Studio' }, apps)).toBeUndefined()
    expect(parseWinOpen(JSON.stringify({ pid: 3, name: 'obs64' }))).toEqual([{ pid: 3, name: 'obs64' }])
  })
})

describe('diskExists (#97)', () => {
  afterEach(() => {
    vi.doUnmock('node:module')
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it("is node:fs's existsSync outside Electron, which doesn't open .asar archives", async () => {
    const fs = await import('node:fs')
    const { diskExists } = await import('../src/core/apps-os')
    expect(diskExists).toBe(fs.existsSync)
  })

  it("inside Electron, asks original-fs, so other apps' app.asar isn't left open", async () => {
    const calls: string[] = []
    vi.doMock('node:module', async (orig) => ({
      ...(await orig<typeof import('node:module')>()),
      createRequire: () => (id: string) => {
        if (id !== 'original-fs') throw new Error(id)
        return { existsSync: (p: string) => (calls.push(p), p.endsWith('app.asar')) }
      }
    }))
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, electron: '39.0.0' } })
    const { isChromium, parseWinApps } = await import('../src/core/apps-os')
    expect(isChromium('/opt/Obsidian/obsidian')).toBe(true)
    expect(calls).toEqual(['/opt/Obsidian/resources/app.asar'])
    expect(parseWinApps(JSON.stringify([{ name: 'Obsidian', path: 'o.lnk', exe: 'C:\\Obsidian\\Obsidian.exe' }]))[0]?.chromium).toBe(true)
    expect(calls[1]).toBe('C:\\Obsidian\\resources\\app.asar')
  })
})
