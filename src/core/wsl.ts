import { execFile, execFileSync } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ExecutionTarget, WslDistribution } from '../shared/types'

export type { ExecutionTarget, WslDistribution }

export interface WslProcessOptions {
  distro: string
  bin: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface SpawnSpec {
  file: string
  args: string[]
  verbatim: boolean
  wsl?: { distro: string }
  cleanup?: () => void
}

let activeTarget: ExecutionTarget = { kind: 'windows' }
let targetProblem: string | undefined

export const executionTarget = (): ExecutionTarget => activeTarget
export const executionProblem = (): string | undefined => targetProblem

export function setExecutionProblem(problem?: string): void {
  targetProblem = problem
}

export function setExecutionTarget(target: ExecutionTarget): void {
  if (target.kind === 'wsl' && !target.distro.trim()) throw new Error('Pick a WSL distribution before using WSL.')
  activeTarget = target.kind === 'windows' ? { kind: 'windows' } : { kind: 'wsl', distro: target.distro.trim() }
  targetProblem = undefined
}

export const wslEnabled = (): boolean => activeTarget.kind === 'wsl'

export function decodeWslOutput(output: string | Buffer): string {
  const text = Buffer.isBuffer(output) ? (output.includes(0) ? output.toString('utf16le') : output.toString('utf8')) : output
  return text.replace(/^\uFEFF/, '').replace(/\0/g, '').replace(/\r/g, '')
}

export function parseWslDistributions(output: string | Buffer): WslDistribution[] {
  const lines = decodeWslOutput(output).split('\n')
  const distributions: WslDistribution[] = []
  for (const line of lines) {
    const match = /^\s*(\*)?\s*(.*?)\s+(Running|Stopped)\s+([12])\s*$/i.exec(line)
    const name = match?.[2]?.trim()
    if (!match || !name || /^NAME$/i.test(name)) continue
    distributions.push({ name, state: match[3]![0]!.toUpperCase() + match[3]!.slice(1).toLowerCase(), version: Number(match[4]) as 1 | 2, isDefault: !!match[1] })
  }
  return distributions
}

const isDrivePath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path)
const wslUnc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\(.*))?$/i

export function windowsPathToWsl(path: string, distro: string): string {
  const unc = wslUnc.exec(path)
  if (unc) {
    if (unc[1]!.toLowerCase() !== distro.toLowerCase()) throw new Error(`This path belongs to a different WSL distribution than ${distro}.`)
    return posix.normalize(`/${(unc[2] ?? '').replace(/\\/g, '/')}`)
  }
  if (isDrivePath(path)) {
    const drive = path[0]!.toLowerCase()
    const rest = path.slice(3).replace(/\\/g, '/')
    return posix.normalize(`/mnt/${drive}${rest ? `/${rest}` : ''}`)
  }
  if (path.startsWith('/')) return posix.normalize(path)
  throw new Error(`Cannot map this path into WSL: ${path}`)
}

export function wslPathToWindows(path: string, distro: string): string {
  if (!path.startsWith('/')) throw new Error(`Expected an absolute Linux path: ${path}`)
  const normalized = posix.normalize(path)
  const mounted = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(normalized)
  if (mounted) return `${mounted[1]!.toUpperCase()}:\\${(mounted[2] ?? '').replace(/\//g, '\\')}`
  const tail = normalized.slice(1).replace(/\//g, '\\')
  return `\\\\wsl.localhost\\${distro}${tail ? `\\${tail}` : ''}`
}

export function mapWslArgument(arg: string, distro: string): string {
  if (isDrivePath(arg) || wslUnc.test(arg)) return windowsPathToWsl(arg, distro)
  const pathPrefix = /^(--image=|-f=|@)(.*)$/s.exec(arg)
  if (pathPrefix && (isDrivePath(pathPrefix[2]!) || wslUnc.test(pathPrefix[2]!))) return `${pathPrefix[1]}${windowsPathToWsl(pathPrefix[2]!, distro)}`
  return arg
}

const WINDOWS_ENV = /^(?:ALLUSERSPROFILE|APPDATA|COMSPEC|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|LOGONSERVER|PATHEXT|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PUBLIC|SYSTEMDRIVE|SYSTEMROOT|TEMP|TMP|USERDOMAIN|USERNAME|USERPROFILE|WINDIR|NODE_OPTIONS|TUCANO_DATA|TUCANO_PACKAGED)$/i
const PASS_TUCANO_ENV = new Set(['TUCANO_MCP_URL', 'TUCANO_WEB'])

function envAssignments(env: NodeJS.ProcessEnv, distro: string): string[] {
  return Object.entries(env).flatMap(([key, raw]) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      WINDOWS_ENV.test(key) ||
      (key.toUpperCase() === 'PATH' && (raw?.includes(';') || /[A-Za-z]:[\\/]/.test(raw ?? ''))) ||
      /^(?:ELECTRON_|VITE_)/i.test(key) ||
      (/^TUCANO_/i.test(key) && !PASS_TUCANO_ENV.has(key.toUpperCase())) ||
      raw === undefined ||
      raw.includes('\0')
    )
      return []
    let value = raw
    if (isDrivePath(value) || wslUnc.test(value)) value = windowsPathToWsl(value, distro)
    return [`${key}=${value}`]
  })
}

export const wslExecutable = (fallback = 'wsl.exe'): string => {
  const root = process.env['SystemRoot'] ?? process.env['WINDIR']
  return root ? win32.join(root, 'System32', fallback) : fallback
}

export function wslProcessSpec(options: WslProcessOptions, wslExe = wslExecutable()): SpawnSpec {
  const { distro, bin, args, env = process.env } = options
  if (!distro.trim()) throw new Error('Pick a WSL distribution before running this command.')
  if (targetProblem && activeTarget.kind === 'wsl' && activeTarget.distro.toLowerCase() === distro.toLowerCase()) throw new Error(targetProblem)
  const linuxCwd = options.cwd ? windowsPathToWsl(options.cwd, distro) : undefined
  const effectiveEnv = linuxCwd ? { ...env, PWD: linuxCwd } : env
  const argv = [
    '--distribution',
    distro,
    ...(linuxCwd ? ['--cd', linuxCwd] : []),
    '--exec',
    'bash',
    '-lc',
    'cwd=$1; shift; if [ -n "$cwd" ]; then cd -- "$cwd" || exit $?; fi; setsid --wait bash -c \'printf "\\nTUCANO_WSL_PID=%s\\n" "$$" >&2; exec env "$@"\' tucano-wsl "$@"',
    'tucano-wsl',
    linuxCwd ?? '',
    ...envAssignments(effectiveEnv, distro),
    mapWslArgument(bin, distro),
    ...args.map((arg) => mapWslArgument(arg, distro))
  ]
  return { file: wslExe, args: argv, verbatim: false, wsl: { distro } }
}

const posixQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

export function wslLaunchSpec(options: WslProcessOptions, wslExe = wslExecutable()): SpawnSpec {
  const inline = wslProcessSpec(options, wslExe)
  const length = inline.args.reduce((n, arg) => n + arg.length + 1, 0)
  if (process.platform !== 'win32' || length < 16_000) return inline

  const distro = options.distro
  const folder = mkdtempSync(win32.join(tmpdir(), 'tucano-wsl-'))
  const script = win32.join(folder, 'run.sh')
  const linuxFolder = windowsPathToWsl(folder, distro)
  const linuxScript = windowsPathToWsl(script, distro)
  const env = envAssignments(options.cwd ? { ...(options.env ?? process.env), PWD: windowsPathToWsl(options.cwd, distro) } : options.env ?? process.env, distro).map(posixQuote)
  const command = [posixQuote(mapWslArgument(options.bin, distro)), ...options.args.map((arg) => posixQuote(mapWslArgument(arg, distro)))].join(' ')
  const changeDir = options.cwd ? `cd ${posixQuote(windowsPathToWsl(options.cwd, distro))} || exit $?\n` : ''
  const cleanup = `rm -f -- "$0"; rmdir -- ${posixQuote(linuxFolder)} 2>/dev/null || true`
  const contents = [
    '#!/usr/bin/env bash',
    `trap ${posixQuote(cleanup)} EXIT`,
    changeDir.trimEnd(),
    `setsid --wait bash -c ${posixQuote('printf "\\nTUCANO_WSL_PID=%s\\n" "$$" >&2; exec env "$@"')} tucano-wsl ${[...env, command].filter(Boolean).join(' ')}`
  ].filter(Boolean).join('\n') + '\n'
  writeFileSync(script, contents, { mode: 0o600 })
  return {
    file: wslExe,
    args: ['--distribution', distro, '--exec', 'bash', '-lc', 'exec bash "$@"', 'tucano-wsl', linuxScript],
    verbatim: false,
    wsl: { distro },
    cleanup: () => rmSync(folder, { recursive: true, force: true })
  }
}

export function listWslDistributions(wslExe = wslExecutable()): Promise<WslDistribution[]> {
  return new Promise((resolve) => {
    execFile(wslExe, ['--list', '--verbose'], { encoding: 'buffer', windowsHide: true, timeout: 15_000 }, (_error, stdout) => {
      resolve(parseWslDistributions(stdout ?? Buffer.alloc(0)))
    })
  })
}

const wslProcesses = new Map<number, { distro: string; linuxPid?: number }>()

export function rememberWslProcess(hostPid: number, distro: string, linuxPid: number): void {
  if (hostPid > 0 && linuxPid > 0) wslProcesses.set(hostPid, { distro, linuxPid })
}

export function forgetWslProcess(hostPid: number): void {
  wslProcesses.delete(hostPid)
}

export function wslPidFromStderr(stderr: string): number | undefined {
  const match = /(?:^|\n)TUCANO_WSL_PID=(\d+)\r?(?:\n|$)/.exec(stderr)
  return match ? Number(match[1]) : undefined
}

export function terminateWslProcess(hostPid: number, signal: 'TERM' | 'KILL' = 'TERM'): boolean {
  const process = wslProcesses.get(hostPid)
  if (!process?.linuxPid) return false
  execFile(wslExecutable(), ['--distribution', process.distro, '--exec', '/bin/kill', `-${signal}`, '--', `-${process.linuxPid}`], { windowsHide: true, timeout: 5000 }, () => {})
  if (signal === 'KILL') wslProcesses.delete(hostPid)
  return true
}

const homes = new Map<string, string>()
const loginEnvs = new Map<string, Promise<NodeJS.ProcessEnv>>()

export function wslHome(distro: string): string {
  const known = homes.get(distro.toLowerCase())
  if (known) return known
  const output = execFileSync(wslExecutable(), ['--distribution', distro, '--exec', 'bash', '-lc', "printf '\\n__TUCANO_HOME__%s\\n' \"$HOME\""], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  const home = /__TUCANO_HOME__(\/[^\r\n]*)/.exec(output)?.[1]?.trim()
  if (!home?.startsWith('/')) throw new Error(`Could not determine the home directory in WSL distribution ${distro}.`)
  homes.set(distro.toLowerCase(), home)
  return home
}

export function wslLoginEnv(distro: string): Promise<NodeJS.ProcessEnv> {
  const key = distro.toLowerCase()
  let pending = loginEnvs.get(key)
  if (!pending) {
    pending = new Promise((resolve) => {
      let shell = '/bin/bash'
      try {
        const output = execFileSync(wslExecutable(), ['--distribution', distro, '--exec', 'bash', '-lc', 'getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
        shell = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\/.+\/(?:bash|zsh|fish)$/.test(line)).at(-1) ?? '/bin/bash'
      } catch {
        // A minimal distro may not have getent; Bash is the tool shell fallback.
      }
      execFile(wslExecutable(), ['--distribution', distro, '--exec', shell, '-ilc', "printf '\\n__TUCANO_ENV__\\0'; env -0"], { encoding: 'buffer', windowsHide: true, timeout: 15_000 }, (_error, stdout) => {
        const output = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '')
        const at = output.indexOf('__TUCANO_ENV__\0')
        const env: NodeJS.ProcessEnv = {}
        if (at >= 0) {
          for (const pair of output.slice(at + '__TUCANO_ENV__\0'.length).split('\0')) {
            const i = pair.indexOf('=')
            if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1)
          }
        }
        resolve(env)
      })
    })
    loginEnvs.set(key, pending)
  }
  return pending
}

export function wslHostAddress(distro: string): string | undefined {
  try {
    const output = execFileSync(wslExecutable(), ['--distribution', distro, '--exec', 'bash', '-lc', "ip -4 route show default | awk 'NR == 1 { print $3 }'"], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    const host = output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(line))
    return host && host !== '0.0.0.0' ? host : undefined
  } catch {
    return undefined
  }
}

export function wslCanConnect(distro: string, host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      wslExecutable(),
      ['--distribution', distro, '--exec', 'bash', '-lc', 'exec 3<>/dev/tcp/"$1"/"$2"', 'tucano-probe', host, String(port)],
      { windowsHide: true, timeout: 5000 },
      (error) => resolve(!error)
    )
  })
}

export function wslHasCommand(distro: string, command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      wslExecutable(),
      ['--distribution', distro, '--exec', 'bash', '-lc', 'command -v -- "$1" >/dev/null 2>&1', 'tucano-command-check', command],
      { windowsHide: true, timeout: 10_000 },
      (error) => resolve(!error)
    )
  })
}

export function activeWslDistro(): string | undefined {
  return activeTarget.kind === 'wsl' ? activeTarget.distro : undefined
}
