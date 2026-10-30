import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dockerProblem, ownedBack } from '../src/core/computer'
import { autostartEntry, autostartFile, chromeCandidates, executableNames, fallbackPath, findChrome, gitRoot, loginShell, onPath, osOf, shellCommand, spawnable, systemName, terminalCommand, userAgentPlatform } from '../src/core/platform'
import { shortcut } from '../src/shared/types'

const win = process.platform === 'win32'

describe('the system the app runs on', () => {
  it('names each platform', () => {
    expect(osOf('darwin')).toBe('mac')
    expect(osOf('linux')).toBe('linux')
    expect(osOf('win32')).toBe('windows')
    expect(systemName('mac')).toBe('macOS')
    expect(systemName('linux')).toBe('Linux')
    expect(systemName('windows')).toBe('Windows')
  })

  it('takes the login shell from the environment, else a default per system', () => {
    expect(loginShell('linux', { SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish')
    expect(['/bin/zsh', '/bin/bash']).toContain(loginShell('mac', {}).replace(/.*\/(zsh|bash)$/, '/bin/$1'))
  })

  it('falls back to where programs usually live', () => {
    expect(fallbackPath('mac')).toMatch(/^\/opt\/homebrew\/bin:/)
    expect(fallbackPath('linux', '/home/edu')).toBe(`${join('/home/edu', '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)
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

  it('opens Ghostty with the login command and keeps the shell open', () => {
    const command = "'/opt/CLI tools/claude' auth login"
    expect(terminalCommand(command, 'linux', (b) => b === 'ghostty')).toEqual({
      bin: 'ghostty',
      args: ['-e', 'sh', '-c', `${command}; exec "\${SHELL:-/bin/sh}"`]
    })
  })

  it.each([
    ['kitty', []],
    ['alacritty', ['-e']]
  ] as const)('opens %s with the login command and keeps the shell open', (bin, prefix) => {
    const command = "'/opt/CLI tools/claude' auth login"
    expect(terminalCommand(command, 'linux', (b) => b === bin)).toEqual({
      bin,
      args: [...prefix, 'sh', '-c', `${command}; exec "\${SHELL:-/bin/sh}"`]
    })
  })

  it.each(['ghostty', 'kitty', 'alacritty'])('prefers the desktop terminal when %s is also installed', (bin) => {
    expect(terminalCommand(cmd, 'linux', (b) => b === 'gnome-terminal' || b === bin)?.bin).toBe('gnome-terminal')
  })

  it('says when there is no terminal to open', () => {
    expect(terminalCommand(cmd, 'linux', () => false)).toBeUndefined()
    // Windows opens its console from a script of its own (loginEngine).
    expect(terminalCommand(cmd, 'windows', () => true)).toBeUndefined()
  })

  // Windows has no execute bit: any file counts as runnable there.
  it.skipIf(win)('finds a program on the PATH only when it can run', () => {
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
    // Installed per machine or per user.
    expect(chromeCandidates('windows', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\edu\\AppData\\Local' })).toEqual([
      join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join('C:\\Users\\edu\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ])
  })

  it("tells sites the real system, so it matches the browser's own user agent", () => {
    expect(userAgentPlatform('mac', 'arm64')).toEqual({ platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm' })
    expect(userAgentPlatform('linux', 'x64')).toEqual({ platform: 'Linux', platformVersion: '', architecture: 'x86' })
    expect(userAgentPlatform('windows', 'x64')).toEqual({ platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86' })
  })
})

describe('opening at login on Linux', () => {
  it('is a desktop entry in the autostart folder', () => {
    expect(autostartFile('/home/edu', {})).toBe(join('/home/edu', '.config', 'autostart', 'tucano.desktop'))
    expect(autostartFile('/home/edu', { XDG_CONFIG_HOME: '/cfg' })).toBe(join('/cfg', 'autostart', 'tucano.desktop'))
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

describe('spawning a CLI', () => {
  it('runs an executable as it is', () => {
    expect(spawnable('/usr/local/bin/claude', ['-p', 'a b'])).toEqual({ file: '/usr/local/bin/claude', args: ['-p', 'a b'], verbatim: false })
  })

  it.runIf(win)('looks for the Windows names of a command, never the bare shell script', () => {
    expect(executableNames('codex')).toContain('codex.cmd')
    expect(executableNames('codex')).toContain('codex.exe')
    expect(executableNames('codex')).not.toContain('codex')
    const before = process.env['PATHEXT']
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.PY'
    expect(executableNames('codex')).toEqual(['codex.com', 'codex.exe', 'codex.bat', 'codex.cmd'])
    process.env['PATHEXT'] = before
  })

  // A .cmd that isn't an npm shim still goes through cmd.exe: each argument has to reach the
  // program intact, including Codex's -c TOML values with quotes, & and %.
  it.runIf(win)('passes arguments through any other .cmd script unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano shim '))
    const echo = join(dir, 'echo-args.js')
    writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const shim = join(dir, 'fake cli.cmd')
    writeFileSync(shim, `@"${process.execPath}" "${echo}" %*\r\n`)
    const args = ['exec', '--json', '-c', 'mcp_servers.tucano.url="http://127.0.0.1:5000/mcp/a?b=1&c=2"', 'two words', '100%', '%PATH%', 'a^b', '(x)|<y>', 'back\\slash\\', 'say "hi"', '']
    const s = spawnable(shim, args)
    expect(s.verbatim).toBe(true)
    const out = spawnSync(s.file, s.args, { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout
    expect(JSON.parse(out)).toEqual(args)
  })

  // Claude and Pi get the system prompt as an argument, many lines long, before
  // the flags that keep them isolated: cmd.exe ends a command at a line break,
  // so an npm shim runs its script directly, as npm writes it.
  const npmShim = (target: string): string =>
    [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, ''
    ].join('\r\n')
  const lines = ['--system-prompt', 'line one\nline two\r\n& echo pwned %PATH%', '--no-builtin-tools', '--offline']

  it.runIf(win)('runs an npm shim directly, so a multi-line argument and every flag after it arrive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano shim '))
    mkdirSync(join(dir, 'node_modules', 'fake-cli'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'fake-cli', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(join(dir, 'fake.cmd'), npmShim('node_modules\\fake-cli\\cli.js'))
    const s = spawnable(join(dir, 'fake.cmd'), lines)
    expect(s.verbatim).toBe(false)
    expect(s.args[0]).toBe(join(dir, 'node_modules', 'fake-cli', 'cli.js'))
    const out = spawnSync(s.file, s.args, { encoding: 'utf8', timeout: 10_000 }).stdout
    expect(JSON.parse(out)).toEqual(lines)
  })

  it.runIf(win)("runs a package's own .exe straight from its shim", () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano shim '))
    mkdirSync(join(dir, 'node_modules', 'fake-cli', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'fake-cli', 'bin', 'fake.exe'), '')
    writeFileSync(join(dir, 'fake.cmd'), `@ECHO off\r\n"%~dp0\\node_modules\\fake-cli\\bin\\fake.exe"   %*\r\n`)
    expect(spawnable(join(dir, 'fake.cmd'), ['-p'])).toEqual({ file: join(dir, 'node_modules', 'fake-cli', 'bin', 'fake.exe'), args: ['-p'], verbatim: false })
  })

  it.runIf(win)('refuses a multi-line argument for any other script, instead of losing the flags after it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano shim '))
    writeFileSync(join(dir, 'own.cmd'), `@"${process.execPath}" -e "" %*\r\n`)
    expect(() => spawnable(join(dir, 'own.cmd'), lines)).toThrow(/line breaks/)
  })
})

describe('the shell for an agent on this computer', () => {
  it.skipIf(win)('is bash on a Mac or Linux', () => {
    expect(shellCommand('ls')).toMatchObject({ file: '/bin/bash', args: ['-c', 'ls'], kind: 'bash' })
  })

  it.runIf(win && !!gitRoot())("is Git's own bash on Windows, set up as its launcher would", () => {
    const sh = shellCommand('echo "$MSYSTEM"', { PATH: 'C:\\Windows', SystemRoot: process.env['SystemRoot'] })
    expect(sh.file.toLowerCase()).toMatch(/\\usr\\bin\\bash\.exe$/)
    expect(sh.env['PATH']!.split(';').slice(-1)[0]).toBe('C:\\Windows')
    expect(execFileSync(sh.file, sh.args, { env: sh.env, encoding: 'utf8' }).trim()).toMatch(/^(UCRT64|MINGW64)$/)
  })
})
