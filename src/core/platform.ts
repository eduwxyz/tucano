// What differs between the systems Tucano runs on, in one place: the rest of the
// code asks "open a terminal with this", "where is Chrome?", and never checks the
// platform itself. Each answer is a plain function of the system, so it's tested
// for every system on any machine.
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'

import type { Os } from '../shared/types'

export type { Os }

export const osOf = (platform: NodeJS.Platform = process.platform): Os => (platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux')

// The system's name for the agent, which needs it to pick commands (brew or apt).
export const systemName = (os: Os = osOf()): string => ({ mac: 'macOS', linux: 'Linux', windows: 'Windows' })[os]

// The person's login shell, for their PATH and for commands run on this computer.
export function loginShell(os: Os = osOf(), env: NodeJS.ProcessEnv = process.env): string {
  let fromUser: string | undefined
  try {
    fromUser = userInfo().shell ?? undefined
  } catch {
    // no passwd entry (a container): the defaults below
  }
  return env['SHELL'] || fromUser || (os === 'mac' ? '/bin/zsh' : '/bin/bash')
}

// Where programs usually live, when the login shell can't say.
export const fallbackPath = (os: Os = osOf(), home = homedir()): string =>
  os === 'mac' ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' : `${join(home, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`

// Whether a program is on the PATH, without starting it.
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, bin), constants.X_OK)
      return true
    } catch {
      // not here
    }
  }
  return false
}

// Terminals, in the order tried, each with how it takes a command to run. The desktop's
// own come first (GNOME, its new Console and Ptyxis, KDE, Xfce), then the Debian
// alternative and the popular ones.
const LINUX_TERMINALS: [string, (run: string[]) => string[]][] = [
  ['gnome-terminal', (run) => ['--', ...run]],
  ['ptyxis', (run) => ['--', ...run]],
  ['kgx', (run) => ['--', ...run]],
  ['konsole', (run) => ['-e', ...run]],
  ['xfce4-terminal', (run) => ['-x', ...run]],
  ['x-terminal-emulator', (run) => ['-e', ...run]],
  ['tilix', (run) => ['-e', ...run]],
  ['kitty', (run) => run],
  ['alacritty', (run) => ['-e', ...run]],
  ['wezterm', (run) => ['start', '--', ...run]],
  ['xterm', (run) => ['-e', ...run]]
]

// How to show a command to the person in a terminal window (a CLI's own login), or
// undefined when there's no terminal to open: the app shows the command to copy.
// On Linux the window stays open on the person's shell after the command, so they
// see how it went.
export function terminalCommand(command: string, os: Os, has: (bin: string) => boolean): { bin: string; args: string[] } | undefined {
  if (os === 'mac') return { bin: 'osascript', args: ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`] }
  if (os !== 'linux') return undefined
  const run = ['sh', '-c', `${command}; exec "\${SHELL:-/bin/sh}"`]
  for (const [bin, args] of LINUX_TERMINALS) if (has(bin)) return { bin, args: args(run) }
  return undefined
}

// Google Chrome first: Google refuses its logins in the app's own browser. Chromium
// from a snap is left out, since a snap can't write the profile in the app's
// (hidden) data folder.
export const chromeCandidates = (os: Os = osOf()): string[] =>
  os === 'mac'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : os === 'linux'
      ? ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/usr/bin/chromium']
      : []

export const findChrome = (os: Os = osOf(), exists: (p: string) => boolean = existsSync): string | undefined => chromeCandidates(os).find(exists)

// What a headless Chrome tells sites about the machine, matching the real one.
export const userAgentPlatform = (os: Os = osOf(), arch: string = process.arch): { platform: string; platformVersion: string; architecture: string } => ({
  platform: systemName(os),
  platformVersion: os === 'mac' ? '15.0.0' : '',
  architecture: arch === 'arm64' ? 'arm' : 'x86'
})

// Opening at login on Linux: a desktop entry in ~/.config/autostart, the freedesktop way.
export const autostartFile = (home = homedir(), env: NodeJS.ProcessEnv = process.env): string => join(env['XDG_CONFIG_HOME'] || join(home, '.config'), 'autostart', 'tucano.desktop')

export function autostartEntry(exec: string): string {
  const q = /[\s"'\\$`]/.test(exec) ? `"${exec.replace(/(["\\$`])/g, '\\$1')}"` : exec
  return ['[Desktop Entry]', 'Type=Application', 'Name=Tucano', `Exec=${q}`, 'Icon=tucano', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n')
}
