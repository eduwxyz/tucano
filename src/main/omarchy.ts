import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { omarchyPalette, type OmarchyPalette } from '../shared/omarchy'

// Where Omarchy keeps the theme it's showing: current/theme/colors.toml and current/theme.name.
// Omarchy moved it into the state folder (its migrations relink what pointed at the config
// one), and the config folder is where an install from before that still has it.
export function omarchyCurrentDirs(home = homedir()): string[] {
  return [join(home, '.local', 'state', 'omarchy', 'current'), join(home, '.config', 'omarchy', 'current')]
}

// The desktop's theme: its name, and its colours when it has some to read.
export type OmarchyTheme = { name: string; palette: OmarchyPalette | null }

// The desktop's theme now, or null off Omarchy. Being on Omarchy is its folder being there,
// not the theme having colours: a theme without them still shows the choice, to turn it off.
export function readOmarchy(dirs = omarchyCurrentDirs()): OmarchyTheme | null {
  if (process.platform !== 'linux') return null
  const dir = dirs.find((d) => existsSync(d))
  if (!dir) return null
  let palette: OmarchyPalette | null = null
  try { palette = omarchyPalette(readFileSync(join(dir, 'theme', 'colors.toml'), 'utf8')) } catch { /* no colours to read */ }
  let name = ''
  try { name = readFileSync(join(dir, 'theme.name'), 'utf8').trim() } catch { /* a theme without its name still has its colours */ }
  return { name, palette }
}

// Calls back with the new theme each time it changes. A switch builds the next theme beside
// the current one and renames it over `theme/`, so a watcher on `theme/` alone would go on
// watching a folder that's gone: the one on `current/` sees the rename, and the one on
// `theme/` (made again after each change) sees a file rewritten in place.
export function watchOmarchy(onChange: (theme: OmarchyTheme | null) => void, dirs = omarchyCurrentDirs()): () => void {
  const root = dirs.find((d) => existsSync(d))
  if (process.platform !== 'linux' || !root) return () => {}
  let last = JSON.stringify(readOmarchy(dirs))
  let timer: ReturnType<typeof setTimeout> | undefined
  let inner: FSWatcher | undefined
  const open = (dir: string): FSWatcher | undefined => {
    try {
      const w = watch(dir, () => changed())
      w.on('error', () => w.close())
      return w
    } catch {
      return undefined
    }
  }
  const rearm = (): void => {
    inner?.close()
    inner = open(join(root, 'theme'))
  }
  // A switch writes several files in a row: read once they've settled.
  const changed = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      rearm()
      const theme = readOmarchy(dirs)
      const now = JSON.stringify(theme)
      if (now === last) return
      last = now
      onChange(theme)
    }, 250)
  }
  const outer = open(root)
  rearm()
  return () => {
    clearTimeout(timer)
    outer?.close()
    inner?.close()
  }
}
