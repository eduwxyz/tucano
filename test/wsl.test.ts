import { describe, expect, it } from 'vitest'
import { executionTarget, mapWslArgument, parseWslDistributions, setExecutionTarget, wslPathToWindows, windowsPathToWsl, wslProcessSpec } from '../src/core/wsl'
import { shellCommand, spawnable } from '../src/core/platform'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../src/core/db'

describe('WSL distributions', () => {
  it('parses the default distro and WSL version from wsl.exe output', () => {
    expect(
      parseWslDistributions('\u0000N\u0000A\u0000M\u0000E\u0000 \u0000S\u0000T\u0000A\u0000T\u0000E\u0000 \u0000V\u0000E\u0000R\u0000S\u0000I\u0000O\u0000N\u0000\r\n\u0000*\u0000 Ubuntu-24.04 \u0000R\u0000u\u0000n\u0000n\u0000i\u0000n\u0000g\u0000 \u00002\u0000\r\n Debian Stopped 2\r\n')
    ).toEqual([
      { name: 'Ubuntu-24.04', state: 'Running', version: 2, isDefault: true },
      { name: 'Debian', state: 'Stopped', version: 2, isDefault: false }
    ])
  })

  it('ignores malformed rows instead of selecting an invalid distro', () => {
    expect(parseWslDistributions('NAME STATE VERSION\nUbuntu Busy 2\n* Debian Stopped 1')).toEqual([
      { name: 'Debian', state: 'Stopped', version: 1, isDefault: true }
    ])
  })
})

describe('Windows and WSL paths', () => {
  it('maps Windows drive paths into /mnt and round-trips them', () => {
    expect(windowsPathToWsl('C:\\Users\\Ana Maria\\project', 'Ubuntu')).toBe('/mnt/c/Users/Ana Maria/project')
    expect(wslPathToWindows('/mnt/c/Users/Ana Maria/project', 'Ubuntu')).toBe('C:\\Users\\Ana Maria\\project')
  })

  it('maps only the selected distro UNC path into Linux and back', () => {
    expect(windowsPathToWsl('\\\\wsl.localhost\\Ubuntu\\home\\ana\\code', 'Ubuntu')).toBe('/home/ana/code')
    expect(windowsPathToWsl('\\\\wsl$\\Ubuntu\\home\\ana\\code', 'Ubuntu')).toBe('/home/ana/code')
    expect(wslPathToWindows('/home/ana/code', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\ana\\code')
    expect(() => windowsPathToWsl('\\\\wsl.localhost\\Debian\\home\\ana', 'Ubuntu')).toThrow(/different WSL distribution/)
  })

  it('maps path arguments without rewriting ordinary text', () => {
    expect(mapWslArgument('C:\\work\\file.png', 'Ubuntu')).toBe('/mnt/c/work/file.png')
    expect(mapWslArgument('--image=C:\\work\\file.png', 'Ubuntu')).toBe('--image=/mnt/c/work/file.png')
    expect(mapWslArgument('@C:\\work\\file.png', 'Ubuntu')).toBe('@/mnt/c/work/file.png')
    expect(mapWslArgument('prompt C:\\work\\file.png', 'Ubuntu')).toBe('prompt C:\\work\\file.png')
  })
})

describe('WSL process arguments', () => {
  it('preserves argv, maps cwd and path-valued environment, and omits Windows-only environment', () => {
    const spec = wslProcessSpec(
      {
        distro: 'Ubuntu',
        bin: '/home/ana/.local/bin/claude',
        args: ['--system-prompt', 'line one\nline two & %PATH%', '--image=C:\\work\\shot.png'],
        cwd: 'C:\\Users\\Ana\\AppData\\Roaming\\Tucano\\computers\\a\\work',
        env: {
          CODEX_HOME: 'C:\\Users\\Ana\\AppData\\Roaming\\Tucano\\codex-home\\.codex',
          TUCANO_MCP_URL: 'http://127.0.0.1:5000/mcp/token',
          Path: 'C:\\Windows\\System32',
          SystemRoot: 'C:\\Windows'
        }
      },
      'C:\\Windows\\System32\\wsl.exe'
    )

    expect(spec.file).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(spec.args.slice(0, 6)).toEqual(['--distribution', 'Ubuntu', '--cd', '/mnt/c/Users/Ana/AppData/Roaming/Tucano/computers/a/work', '--exec', 'bash'])
    expect(spec.args).toContain('CODEX_HOME=/mnt/c/Users/Ana/AppData/Roaming/Tucano/codex-home/.codex')
    expect(spec.args).toContain('PWD=/mnt/c/Users/Ana/AppData/Roaming/Tucano/computers/a/work')
    expect(spec.args).toContain('TUCANO_MCP_URL=http://127.0.0.1:5000/mcp/token')
    expect(spec.args).not.toContain('Path=C:\\Windows\\System32')
    expect(spec.args).not.toContain('SystemRoot=C:\\Windows')
    expect(spec.args).toContain('--system-prompt')
    expect(spec.args).toContain('line one\nline two & %PATH%')
    expect(spec.args).toContain('--image=/mnt/c/work/shot.png')
  })

  it('routes the shared platform launcher and shell through the selected distro', () => {
    const previous = executionTarget()
    try {
      setExecutionTarget({ kind: 'wsl', distro: 'Ubuntu' })
      const cli = spawnable('/home/ana/.local/bin/pi', ['-p', 'hello'], { cwd: 'C:\\Users\\Ana\\work' })
      expect(cli.file.toLowerCase()).toMatch(/(?:^|\\|\/)wsl\.exe$/)
      expect(cli.wsl).toEqual({ distro: 'Ubuntu' })
      expect(cli.args).toContain('/mnt/c/Users/Ana/work')
      expect(cli.args.slice(-3)).toEqual(['/home/ana/.local/bin/pi', '-p', 'hello'])

      const shell = shellCommand('printf ok', {}, 'C:\\Users\\Ana\\work')
      expect(shell.kind).toBe('wsl')
      expect(shell.args).toContain('/mnt/c/Users/Ana/work')
    } finally {
      setExecutionTarget(previous)
    }
  })

  it('persists a WSL runtime on a local connector imported from a harness', () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-wsl-db-')), 'test.db'))
    try {
      db.saveConnector({ id: 'wsl-mcp', name: 'Local MCP', kind: 'stdio', command: 'node', args: ['server.js'], auth: 'none', executionTarget: { kind: 'wsl', distro: 'Ubuntu' } })
      expect(db.connector('wsl-mcp')?.executionTarget).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    } finally {
      db.close()
    }
  })
})
