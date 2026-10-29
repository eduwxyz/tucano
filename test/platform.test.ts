import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dockerProblem, ownedBack } from '../src/core/computer'
import { autostartEntry, autostartFile, chromeCandidates, fallbackPath, findChrome, loginShell, onPath, osOf, systemName, terminalCommand, userAgentPlatform } from '../src/core/platform'
import { shortcut } from '../src/shared/types'

describe('the system the app runs on', () => {
  it('names each platform', () => {
    expect(osOf('darwin')).toBe('mac')
    expect(osOf('linux')).toBe('linux')
    expect(osOf('win32')).toBe('windows')
    expect(systemName('mac')).toBe('macOS')
    expect(systemName('linux')).toBe('Linux')
  })

  it('takes the login shell from the environment, else a default per system', () => {
    expect(loginShell('linux', { SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish')
    expect(['/bin/zsh', '/bin/bash']).toContain(loginShell('mac', {}).replace(/.*\/(zsh|bash)$/, '/bin/$1'))
  })

  it('falls back to where programs usually live', () => {
    expect(fallbackPath('mac')).toMatch(/^\/opt\/homebrew\/bin:/)
    expect(fallbackPath('linux', '/home/edu')).toBe('/home/edu/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  })

  it('shows shortcuts with ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(shortcut('mac', 'N')).toBe('⌘N')
    expect(shortcut('linux', 'N')).toBe('Ctrl+N')
  })
})

describe('a terminal for the person', () => {
  const cmd = "'/usr/bin/claude' auth login"

  it("opens the Mac's Terminal with the command", () => {
    const t = terminalCommand(cmd, 'mac', () => false)!
    expect(t.bin).toBe('osascript')
    expect(t.args.at(-1)).toBe(`tell application "Terminal" to do script ${JSON.stringify(cmd)}`)
  })

  it("opens the desktop's own terminal on Linux, and keeps it on the shell after", () => {
    expect(terminalCommand(cmd, 'linux', (b) => b === 'gnome-terminal')).toEqual({ bin: 'gnome-terminal', args: ['--', 'sh', '-c', `${cmd}; exec "\${SHELL:-/bin/sh}"`] })
    expect(terminalCommand(cmd, 'linux', (b) => b === 'konsole')?.args.slice(0, 3)).toEqual(['-e', 'sh', '-c'])
    expect(terminalCommand(cmd, 'linux', (b) => b === 'xfce4-terminal')?.args[0]).toBe('-x')
    // GNOME's comes before the Debian alternative when both are there.
    expect(terminalCommand(cmd, 'linux', (b) => b === 'gnome-terminal' || b === 'x-terminal-emulator')?.bin).toBe('gnome-terminal')
  })

  it('says when there is no terminal to open', () => {
    expect(terminalCommand(cmd, 'linux', () => false)).toBeUndefined()
  })

  it('finds a program on the PATH only when it can run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'path-'))
    writeFileSync(join(dir, 'runs'), '#!/bin/sh\n')
    chmodSync(join(dir, 'runs'), 0o755)
    writeFileSync(join(dir, 'text'), 'not a program')
    expect(onPath('runs', { PATH: dir })).toBe(true)
    expect(onPath('text', { PATH: dir })).toBe(false)
    expect(onPath('missing', { PATH: dir })).toBe(false)
  })
})

describe("the agents' Chrome", () => {
  it('looks where Chrome lives on each system, Google Chrome first', () => {
    expect(chromeCandidates('mac')).toEqual(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])
    expect(chromeCandidates('linux')[0]).toBe('/usr/bin/google-chrome-stable')
    expect(chromeCandidates('linux')).toContain('/usr/bin/chromium')
    expect(findChrome('linux', (p) => p === '/usr/bin/chromium')).toBe('/usr/bin/chromium')
    expect(findChrome('linux', () => false)).toBeUndefined()
  })

  it("tells sites the real system, so it matches the browser's own user agent", () => {
    expect(userAgentPlatform('mac', 'arm64')).toEqual({ platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm' })
    expect(userAgentPlatform('linux', 'x64')).toEqual({ platform: 'Linux', platformVersion: '', architecture: 'x86' })
  })
})

describe('opening at login on Linux', () => {
  it('is a desktop entry in the autostart folder', () => {
    expect(autostartFile('/home/edu', {})).toBe('/home/edu/.config/autostart/tucano.desktop')
    expect(autostartFile('/home/edu', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/autostart/tucano.desktop')
    const entry = autostartEntry('/opt/Tucano/tucano')
    expect(entry).toContain('[Desktop Entry]\nType=Application\nName=Tucano\nExec=/opt/Tucano/tucano\n')
  })

  it('quotes a path with spaces', () => {
    expect(autostartEntry('/home/edu/Apps/Tucano 0.2.AppImage')).toContain('Exec="/home/edu/Apps/Tucano 0.2.AppImage"')
  })
})

describe('Docker on Linux', () => {
  it('gives back to the person what root wrote in the shared folders, keeping the exit code', () => {
    const s = ownedBack("'timeout' '-k' '5' '120' 'bash' '-lc' 'npm i'", ['/work', '/projetos/loja'], 1000, 1000)
    expect(s).toBe("'timeout' '-k' '5' '120' 'bash' '-lc' 'npm i'; s=$?; find '/work' '/projetos/loja' -xdev -uid 0 -exec chown -h 1000:1000 {} + 2>/dev/null; exit $s")
  })

  it('says what is wrong with Docker itself', () => {
    expect(dockerProblem('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock')).toContain('usermod -aG docker')
    expect(dockerProblem('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')).toMatch(/Docker/)
    expect(dockerProblem('Error: No such container: tucano-x')).toBeUndefined()
  })
})
