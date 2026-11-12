// The person's installed apps on Windows and Linux, the way the system's own launcher shows
// them: the Start menu's (with the Store's, like Notepad and Calculator) and the
// application menu's (.desktop entries, Flatpak's and Snap's too). Each with its name in the
// person's language, an icon and how to start it. The Mac's are in apps.ts (macApps).
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { posix } from 'node:path'

// Linux paths (and Windows ones written with /): the same on whatever system runs the tests.
const { dirname, extname, join, relative, sep } = posix

export interface SystemApp {
  name: string
  id?: string // AppUserModelID on Windows (a Store app's has a "!"), the desktop id on Linux
  path?: string // a file whose icon is the app's (a .exe or .lnk on Windows)
  icon?: string // a data: URL, when the system gives an image file (Store apps, Linux)
  exe?: string // the program, on Windows: matches the open windows to the app
  exec?: string[] // the command that starts it, on Linux (from the .desktop entry)
  chromium?: boolean // made with Chromium or Electron: shows its screen to accessibility only when asked
}

// ---------- Linux: .desktop entries ----------

export interface DesktopEntry {
  name: string
  icon?: string
  exec?: string
  wmClass?: string
}

// One [Desktop Entry]: its name in the person's language (Name[pt_BR], then Name[pt], then
// Name), undefined for what a launcher doesn't show (hidden, not an app, run in a terminal).
export function parseDesktopEntry(text: string, locale = 'en_US'): DesktopEntry | undefined {
  const keys = new Map<string, string>()
  let inEntry = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    if (!inEntry || !line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq > 0) keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  if ((keys.get('Type') ?? 'Application') !== 'Application') return undefined
  if (/^true$/i.test(keys.get('NoDisplay') ?? '') || /^true$/i.test(keys.get('Hidden') ?? '') || /^true$/i.test(keys.get('Terminal') ?? '')) return undefined
  const [lang = '', region] = locale.replace(/\..*$/, '').split(/[_-]/)
  const name = (region && keys.get(`Name[${lang}_${region}]`)) || keys.get(`Name[${lang}]`) || keys.get('Name')
  if (!name) return undefined
  const icon = keys.get('Icon'), exec = keys.get('Exec'), wmClass = keys.get('StartupWMClass')
  return { name, ...(icon ? { icon } : {}), ...(exec ? { exec } : {}), ...(wmClass ? { wmClass } : {}) }
}

// The Exec line as a command: quoted words kept whole, the launcher's %f/%U/%i… dropped.
export function execArgs(exec: string): string[] {
  const out: string[] = []
  let cur = '', quoted = false, any = false
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]!
    if (quoted) {
      if (c === '\\' && i + 1 < exec.length) cur += exec[++i]
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') (quoted = true), (any = true)
    else if (/\s/.test(c)) {
      if (cur || any) out.push(cur)
      ;(cur = ''), (any = false)
    } else cur += c
  }
  if (cur || any) out.push(cur)
  return out.filter((a) => !/^%[a-zA-Z]$/.test(a)).map((a) => a.replace(/%%/g, '%'))
}

// Where the application menu's entries live, the person's own first (they win over the system's).
export function desktopDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const data = env['XDG_DATA_HOME'] || join(home, '.local/share')
  const sys = (env['XDG_DATA_DIRS'] || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [
    join(data, 'applications'),
    join(data, 'flatpak/exports/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
    ...sys.map((d) => join(d, 'applications'))
  ].filter((d, i, all) => all.indexOf(d) === i)
}

const iconBases = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] => {
  const data = env['XDG_DATA_HOME'] || join(home, '.local/share')
  const sys = (env['XDG_DATA_DIRS'] || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [join(data, 'icons'), join(home, '.icons'), join(data, 'flatpak/exports/share/icons'), '/var/lib/flatpak/exports/share/icons', ...sys.map((d) => join(d, 'icons'))]
}
const THEMES = ['hicolor', 'Adwaita', 'breeze', 'Papirus', 'Yaru', 'elementary']
const SIZES = ['64x64', '48x48', '96x96', '128x128', '256x256', 'scalable', '32x32', '512x512']

// An icon name ("org.gnome.TextEditor") to a file, through the icon themes, the way a
// launcher finds it; a path is used as it is.
export function iconFile(icon: string, exists: (p: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  if (icon.startsWith('/')) return exists(icon) ? icon : undefined
  for (const base of iconBases(env, home))
    for (const theme of THEMES)
      for (const size of SIZES)
        for (const ext of size === 'scalable' ? ['svg'] : ['png', 'svg']) {
          const p = join(base, theme, size, 'apps', `${icon}.${ext}`)
          if (exists(p)) return p
        }
  for (const ext of ['png', 'svg']) {
    const p = `/usr/share/pixmaps/${icon}.${ext}`
    if (exists(p)) return p
  }
  return undefined
}

// An image file as a data: URL the picker can show (PNG or SVG; nothing too big).
export function dataUrl(file: string): string | undefined {
  const type = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' }[extname(file).toLowerCase()]
  try {
    if (!type || statSync(file).size > 150_000) return undefined
    return `data:${type};base64,${readFileSync(file).toString('base64')}`
  } catch {
    return undefined
  }
}

// Whether a file is on disk, without opening it. Inside Electron, node:fs treats any .asar it's
// asked about as an archive: it opens it and keeps it open in its cache, which on Windows locks
// other apps' app.asar and breaks their updates (#97). original-fs is the unpatched one. In
// server mode (plain Node) there's no original-fs, and node:fs is already the plain one.
export const diskExists: (p: string) => boolean = (() => {
  if (!process.versions['electron']) return existsSync
  try {
    return (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).existsSync
  } catch {
    return existsSync
  }
})()

// A program made with Chromium or Electron, by what sits next to it.
export function isChromium(program: string, exists: (p: string) => boolean = diskExists): boolean {
  const dir = dirname(program)
  return ['resources/app.asar', 'resources.pak', 'chrome_100_percent.pak', 'chrome-sandbox', 'v8_context_snapshot.bin', 'libcef.so', 'libcef.dll'].some((f) => exists(join(dir, f)))
}

// The folders a Linux launcher leads to: its own, symlinks resolved, and for a small shell
// script (Arch's /usr/bin/google-chrome-stable) the folders of the programs it names. The
// process that opens the window lives in one of them, under a name of its own ("chrome").
export function launcherDirs(program: string, fs: { real: (p: string) => string; script: (p: string) => string | undefined } = { real: realpathSync, script: smallScript }): string[] {
  let real = program
  try {
    real = fs.real(program)
  } catch {
    // a launcher that isn't there: its own folder still
  }
  const script = fs.script(real)
  // A script's own folder is just where launchers sit: the program it starts is elsewhere.
  const dirs = script === undefined ? [dirname(real)] : [...script.matchAll(/(?:^|[\s"'=])(\/(?:opt|usr|snap|var\/lib\/flatpak)\/[^\s"'$;]+)/gm)].map((m) => dirname(m[1]!))
  // Folders every program shares say nothing about which one it is (gnome-shell is in /usr/bin too),
  // nor do the shared library folders a script may name (/usr/lib/x86_64-linux-gnu/libfoo.so).
  return [...new Set(dirs)].filter((d) => !SHARED_BIN.has(d) && !/^\/usr\/(lib(32|64|exec)?|share)(\/[^/]+-linux-gnu[^/]*)?$/.test(d))
}
const SHARED_BIN = new Set(['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin'])
const smallScript = (p: string): string | undefined => {
  try {
    if (statSync(p).size > 64 * 1024) return undefined
    const text = readFileSync(p, 'utf8')
    return text.startsWith('#!') ? text : undefined
  } catch {
    return undefined
  }
}

const whichSync = (cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : undefined
  for (const d of (env['PATH'] ?? '').split(':')) if (d && existsSync(join(d, cmd))) return join(d, cmd)
  return undefined
}

export function linuxApps(env: NodeJS.ProcessEnv = process.env, home = homedir()): SystemApp[] {
  const locale = env['LC_ALL'] || env['LC_MESSAGES'] || env['LANG'] || 'en_US'
  const seen = new Set<string>()
  const out: SystemApp[] = []
  for (const dir of desktopDirs(env, home)) {
    const files: string[] = []
    const walk = (d: string): void => {
      let names: string[] = []
      try {
        names = readdirSync(d)
      } catch {
        return
      }
      for (const n of names) {
        const p = join(d, n)
        if (n.endsWith('.desktop')) files.push(p)
        else if (!n.includes('.')) {
          try {
            if (statSync(p).isDirectory()) walk(p)
          } catch {}
        }
      }
    }
    walk(dir)
    for (const file of files) {
      const id = relative(dir, file).split(sep).join('-').replace(/\.desktop$/, '')
      if (seen.has(id)) continue // the person's own entry wins over the system's
      seen.add(id)
      let entry: DesktopEntry | undefined
      try {
        entry = parseDesktopEntry(readFileSync(file, 'utf8'), locale)
      } catch {}
      if (!entry || /^(dev\.tucano|tucano)$/i.test(id)) continue
      const exec = entry.exec ? execArgs(entry.exec) : undefined
      const program = exec?.[0] ? whichSync(exec[0], env) : undefined
      const icon = entry.icon ? iconFile(entry.icon, existsSync, env, home) : undefined
      const url = icon ? dataUrl(icon) : undefined
      out.push({
        name: entry.name,
        id,
        ...(url ? { icon: url } : {}),
        ...(exec?.length ? { exec } : {}),
        ...(program && launcherDirs(program).some((d) => isChromium(join(d, 'x'))) ? { chromium: true } : {})
      })
    }
  }
  // Two entries with the same name (a Flatpak and a .deb of one app): the first.
  return out.filter((a, i) => out.findIndex((b) => b.name === a.name) === i).sort((a, b) => a.name.localeCompare(b.name))
}

// ---------- Windows: the Start menu ----------

// One PowerShell script, a JSON answer: the Start menu's shortcuts (name, target program)
// and the Store's apps (name, AppUserModelID, logo), the way Start lists them.
const WIN_LIST = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = New-Object System.Collections.ArrayList
$sh = New-Object -ComObject WScript.Shell
$dirs = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:AppData\Microsoft\Windows\Start Menu\Programs")
foreach ($d in $dirs) {
  Get-ChildItem -Path $d -Filter *.lnk -Recurse | ForEach-Object {
    $t = $sh.CreateShortcut($_.FullName).TargetPath
    if ($t -and $t.ToLower().EndsWith('.exe') -and (Test-Path $t)) {
      [void]$out.Add(@{ name = $_.BaseName; path = $_.FullName; exe = $t })
    }
  }
}
$pkgs = @{}
Get-AppxPackage | ForEach-Object { $pkgs[$_.PackageFamilyName] = $_.InstallLocation }
foreach ($a in (Get-StartApps)) {
  if ($a.AppID -notlike '*!*') { continue }
  $fam = $a.AppID.Split('!')[0]
  $loc = $pkgs[$fam]
  $logo = $null
  if ($loc) {
    $m = [xml](Get-Content -Raw (Join-Path $loc 'AppxManifest.xml'))
    $app = @($m.Package.Applications.Application) | Where-Object { $_.Id -eq $a.AppID.Split('!')[1] } | Select-Object -First 1
    $ve = $app.VisualElements
    $rel = if ($ve.Square44x44Logo) { $ve.Square44x44Logo } else { $ve.Logo }
    if ($rel) {
      $base = Join-Path $loc ([IO.Path]::GetDirectoryName($rel))
      $stem = [IO.Path]::GetFileNameWithoutExtension($rel)
      $cands = Get-ChildItem -Path $base -Filter "$stem*.png" | Sort-Object { if ($_.Name -match 'targetsize-48(_altform-unplated)?\.png$') { 0 } elseif ($_.Name -match 'targetsize-(32|64)') { 1 } elseif ($_.Name -match 'scale-200') { 2 } else { 3 } }
      if ($cands) { $logo = @($cands)[0].FullName }
    }
  }
  [void]$out.Add(@{ name = $a.Name; id = $a.AppID; logo = $logo; dir = $loc })
}
$out | ConvertTo-Json -Compress -Depth 3
`

export const powershell = (script: string, timeoutMs = 30_000): Promise<string> =>
  new Promise((resolve) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (_e, stdout) => resolve(String(stdout ?? ''))
    )
  )

type WinRow = { name?: string; path?: string; exe?: string; id?: string; logo?: string | null; dir?: string | null }

// Uninstallers, help files and the like aren't apps a person would give an agent.
const NOT_AN_APP = /\b(uninstall|desinstalar|deinstall|readme|leia-me|help|ajuda|documentation|release notes|website|license|licen[cç]a)\b/i

export function parseWinApps(json: string, exists: (p: string) => boolean = diskExists): SystemApp[] {
  let rows: WinRow[] = []
  try {
    const v = JSON.parse(json.trim() || '[]') as WinRow | WinRow[]
    rows = Array.isArray(v) ? v : [v]
  } catch {
    return []
  }
  const out: SystemApp[] = []
  for (const r of rows) {
    const name = (r.name ?? '').trim()
    if (!name || NOT_AN_APP.test(name) || /^tucano$/i.test(name)) continue
    if (r.id) {
      const icon = r.logo ? dataUrl(r.logo) : undefined
      out.push({ name, id: r.id, ...(icon ? { icon } : {}), ...(r.dir ? { exe: r.dir } : {}) })
    } else if (r.exe) {
      if (/\\(unins\d*|uninstall|update)\.exe$/i.test(r.exe)) continue
      out.push({ name, path: r.exe, exe: r.exe, ...(isChromium(r.exe.replace(/\\/g, '/'), (p) => exists(p.replace(/\//g, '\\'))) ? { chromium: true } : {}) })
    }
  }
  // The same app twice (a shortcut for everyone and one for the person): once.
  return out.filter((a, i) => out.findIndex((b) => b.name.toLowerCase() === a.name.toLowerCase()) === i).sort((a, b) => a.name.localeCompare(b.name))
}

export async function windowsApps(): Promise<SystemApp[]> {
  return parseWinApps(await powershell(WIN_LIST, 60_000))
}

// ---------- the open apps (with a window) ----------

const WIN_OPEN = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  @{ pid = $_.Id; name = $_.ProcessName; path = $_.Path; desc = $_.MainModule.FileVersionInfo.FileDescription; title = $_.MainWindowTitle }
} | ConvertTo-Json -Compress
`

export type OpenWin = { pid: number; name: string; path?: string; desc?: string; title?: string }

export function parseWinOpen(json: string): OpenWin[] {
  try {
    const v = JSON.parse(json.trim() || '[]') as OpenWin | OpenWin[]
    return (Array.isArray(v) ? v : [v]).filter((w) => w && w.name)
  } catch {
    return []
  }
}

export async function windowsOpen(): Promise<OpenWin[]> {
  return parseWinOpen(await powershell(WIN_OPEN, 15_000))
}

// A window's app among the installed ones: by its program (a shortcut's target, or a Store
// app's folder), else by name.
export function appOfWindow(w: OpenWin, apps: SystemApp[]): SystemApp | undefined {
  const p = (w.path ?? '').toLowerCase()
  return (
    (p && apps.find((a) => a.exe && (a.exe.toLowerCase() === p || (a.id?.includes('!') && p.startsWith(a.exe.toLowerCase() + '\\'))))) ||
    apps.find((a) => [w.desc, w.name].some((n) => n && n.toLowerCase() === a.name.toLowerCase()))
  )
}

// ---------- starting an app ----------

// Starts an installed app, with Chromium's accessibility on when it's made with it (an
// argument a plain program could take for a file to open, so only then). False when it
// couldn't be started this way (agent-desktop's launch tries next).
export function startApp(a: SystemApp, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const flag = a.chromium ? ['--force-renderer-accessibility'] : []
  return new Promise((resolve) => {
    let cmd: string, args: string[]
    if (platform === 'win32') {
      if (a.id?.includes('!')) (cmd = 'explorer.exe'), (args = [`shell:AppsFolder\\${a.id}`])
      else if (a.exe) (cmd = a.exe), (args = flag)
      else return resolve(false)
    } else if (a.exec?.length) {
      // A Flatpak or Snap wrapper passes the extra arguments on to the app.
      ;[cmd, ...args] = [...a.exec, ...flag] as [string, ...string[]]
    } else if (a.id) (cmd = 'gtk-launch'), (args = [a.id])
    else return resolve(false)
    try {
      // On Linux a Chromium window joins the accessibility bus only with this set, whatever the flag says
      // (GNOME leaves org.a11y.Status IsEnabled off unless a screen reader is on).
      const env = a.chromium && platform === 'linux' ? { ...process.env, ACCESSIBILITY_ENABLED: '1' } : process.env
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env })
      child.on('error', () => resolve(false))
      child.on('spawn', () => (child.unref(), resolve(true)))
    } catch {
      resolve(false)
    }
  })
}
