import { execFile, execFileSync } from 'node:child_process'
import { posix, win32 } from 'node:path'
import type { ExecutionTarget, WslDistribution } from '../shared/types'

export type { ExecutionTarget, WslDistribution }

export interface WslProcessOptions {
  distro: string
  bin: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  // Extra names are supplied by an explicit provider or connector config, not
  // inherited wholesale from the Windows process environment.
  forwardEnv?: string[]
}

export interface SpawnSpec {
  file: string
  args: string[]
  verbatim: boolean
  wsl?: { distro: string }
  hostEnv?: NodeJS.ProcessEnv
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

const WINDOWS_HOST_ENV = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']
const WSL_ENV_ALLOWLIST = new Set([
  'ALL_PROXY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_VERTEX_REGION',
  'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_CA_BUNDLE', 'AWS_CONFIG_FILE', 'AWS_DEFAULT_REGION',
  'AWS_PROFILE', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SHARED_CREDENTIALS_FILE',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLOUD_ML_REGION', 'CURL_CA_BUNDLE', 'GEMINI_API_KEY', 'GEMINI_CLI_HOME',
  'GEMINI_SYSTEM_MD', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VERTEX_PROJECT',
  'GEMINI_API_BASE_URL', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'MCP_TOOL_TIMEOUT', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_SERVER_PASSWORD',
  'PI_CODING_AGENT_DIR', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'TERM', 'TUCANO_MCP_URL', 'TUCANO_WEB',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'
])
const PASS_TUCANO_ENV = new Set(['TUCANO_MCP_URL', 'TUCANO_WEB'])
const WSL_PATH_ENV = new Set([
  'AWS_CA_BUNDLE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME',
  'GEMINI_SYSTEM_MD', 'GOOGLE_APPLICATION_CREDENTIALS', 'HOME', 'NODE_EXTRA_CA_CERTS', 'OPENCODE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'
])
const NEVER_FORWARD_ENV = new Set([
  'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'ELECTRON_NO_ASAR', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
  'LOGONSERVER', 'NODE_OPTIONS', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PUBLIC', 'SYSTEMDRIVE',
  'SYSTEMROOT', 'TEMP', 'TMP', 'TUCANO_DATA', 'TUCANO_FAKE_ENGINES', 'TUCANO_HOST', 'TUCANO_LOCALE',
  'TUCANO_PACKAGED', 'TUCANO_PORT', 'TUCANO_SEED', 'TUCANO_SERVER', 'TUCANO_TOKEN', 'USERDOMAIN',
  'USERNAME', 'USERPROFILE', 'WINDIR', 'WSL_DISTRO_NAME', 'WSL_EXECUTION_ENV', 'WSL_INTEROP'
])

interface ForwardedEnv { key: string; windowsValue: string; linuxValue: string; path: boolean }

function forwardedEnvironment(env: NodeJS.ProcessEnv, distro: string, extra: string[] = []): ForwardedEnv[] {
  const names = new Set([...WSL_ENV_ALLOWLIST, ...extra].map((name) => name.toUpperCase()))
  const forwarded: ForwardedEnv[] = []
  const seen = new Set<string>()
  for (const [key, raw] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !names.has(upper) ||
      /^(?:ELECTRON_|VITE_|WSL_)/i.test(key) || (/^TUCANO_/i.test(key) && !PASS_TUCANO_ENV.has(upper)) ||
      NEVER_FORWARD_ENV.has(upper) || upper === 'WSLENV' || upper === 'PATH' ||
      raw === undefined || raw.includes('\0') || seen.has(upper)
    ) continue
    seen.add(upper)
    const windowsPath = isDrivePath(raw) || wslUnc.test(raw)
    const path = windowsPath || WSL_PATH_ENV.has(upper)
    const windowsValue = !windowsPath && WSL_PATH_ENV.has(upper) && raw.startsWith('/') ? wslPathToWindows(raw, distro) : raw
    const linuxValue = windowsPath ? windowsPathToWsl(raw, distro) : raw
    forwarded.push({ key, windowsValue, linuxValue, path })
  }
  return forwarded
}

function windowsHostEnvironment(): NodeJS.ProcessEnv {
  const host: NodeJS.ProcessEnv = {}
  for (const key of WINDOWS_HOST_ENV) {
    const actual = Object.keys(process.env).find((name) => name.toUpperCase() === key.toUpperCase())
    if (actual && process.env[actual] !== undefined) host[actual] = process.env[actual]
  }
  return { ...host, WSLENV: '' }
}

function hostEnvironment(env: NodeJS.ProcessEnv, distro: string, extra: string[] = []): NodeJS.ProcessEnv {
  const forwarded = forwardedEnvironment(env, distro, extra)
  return {
    ...windowsHostEnvironment(),
    ...Object.fromEntries(forwarded.map(({ key, windowsValue }) => [key, windowsValue])),
    WSLENV: forwarded.map(({ key, path }) => `${key}/${path ? 'pu' : 'u'}`).join(':')
  }
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
  const argv = [
    '--distribution',
    distro,
    ...(linuxCwd ? ['--cd', linuxCwd] : []),
    '--exec',
    'bash',
    '-lc',
    'cwd=$1; shift; if [ -n "$cwd" ]; then cd -- "$cwd" || exit $?; fi; setsid --wait bash -c \'printf "\\nTUCANO_WSL_PID=%s\\n" "$$" >&2; exec "$@"\' tucano-wsl "$@"',
    'tucano-wsl',
    linuxCwd ?? '',
    mapWslArgument(bin, distro),
    ...args.map((arg) => mapWslArgument(arg, distro))
  ]
  return { file: wslExe, args: argv, verbatim: false, wsl: { distro }, hostEnv: hostEnvironment(env, distro, options.forwardEnv) }
}

const posixQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

function longLaunchScript(options: WslProcessOptions, env: ForwardedEnv[]): string {
  const distro = options.distro
  const linuxCwd = options.cwd ? windowsPathToWsl(options.cwd, distro) : undefined
  const command = [mapWslArgument(options.bin, distro), ...options.args.map((arg) => mapWslArgument(arg, distro))].map(posixQuote).join(' ')
  const changeDir = linuxCwd ? `cd -- ${posixQuote(linuxCwd)} || exit $?\n` : ''
  return [
    '#!/usr/bin/env bash',
    `trap 'rm -f -- "$0"' EXIT`,
    `rm -f -- "$0"`,
    ...env.map(({ key, linuxValue }) => `export ${posixQuote(`${key}=${linuxValue}`)}`),
    changeDir.trimEnd(),
    `setsid --wait bash -c ${posixQuote('printf "\\nTUCANO_WSL_PID=%s\\n" "$$" >&2; exec "$@"')} tucano-wsl ${command}`,
    ''
  ].filter(Boolean).join('\n')
}

export function wslLaunchScript(options: WslProcessOptions): string {
  return longLaunchScript(options, forwardedEnvironment(options.env ?? process.env, options.distro, options.forwardEnv))
}

function stageLongLaunch(options: WslProcessOptions, wslExe: string, hostEnv: NodeJS.ProcessEnv): string {
  const marker = '__TUCANO_WSL_SCRIPT__'
  const bootstrap = `umask 077; script=$(mktemp /tmp/tucano-wsl-XXXXXXXXXX) || exit $?; trap 'rm -f -- "$script"' EXIT; cat > "$script" || exit 1; chmod 600 "$script" || exit 1; printf '\\n${marker}%s\\n' "$script"; trap - EXIT`
  const output = execFileSync(wslExe, ['--distribution', options.distro, '--exec', 'bash', '-c', bootstrap], {
    encoding: 'utf8',
    env: { ...hostEnv, WSLENV: '' },
    input: wslLaunchScript(options),
    maxBuffer: 1024 * 1024,
    timeout: 20_000,
    windowsHide: true
  })
  const script = new RegExp(`${marker}(\\/[^\\r\\n]+)`).exec(output)?.[1]
  if (!script) throw new Error('Could not create the private WSL launch file.')
  return script
}

export function wslLaunchSpec(options: WslProcessOptions, wslExe = wslExecutable()): SpawnSpec {
  const inline = wslProcessSpec(options, wslExe)
  const length = inline.args.reduce((n, arg) => n + arg.length + 1, 0) + Object.entries(inline.hostEnv ?? {}).reduce((n, [key, value]) => n + key.length + (value?.length ?? 0) + 2, 0)
  if (process.platform !== 'win32' || length < 16_000) return inline
  const hostEnv = windowsHostEnvironment()
  const linuxScript = stageLongLaunch(options, wslExe, hostEnv)
  const args = ['--distribution', options.distro, ...(options.cwd ? ['--cd', windowsPathToWsl(options.cwd, options.distro)] : []), '--exec', 'bash', '-lc', 'exec bash "$@"', 'tucano-wsl', linuxScript]
  return {
    file: wslExe,
    args,
    verbatim: false,
    wsl: { distro: options.distro },
    hostEnv,
    cleanup: () => {
      try {
        execFileSync(wslExe, ['--distribution', options.distro, '--exec', 'rm', '-f', '--', linuxScript], { env: hostEnv, windowsHide: true, timeout: 5000, stdio: 'ignore' })
      } catch {
        // The launch script removes itself on exit; cleanup is a fallback if spawning fails.
      }
    }
  }
}

export function listWslDistributions(wslExe = wslExecutable()): Promise<WslDistribution[]> {
  return new Promise((resolve) => {
    execFile(wslExe, ['--list', '--verbose'], { encoding: 'buffer', env: windowsHostEnvironment(), windowsHide: true, timeout: 15_000 }, (_error, stdout) => {
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
  execFile(wslExecutable(), ['--distribution', process.distro, '--exec', '/bin/kill', `-${signal}`, '--', `-${process.linuxPid}`], { env: windowsHostEnvironment(), windowsHide: true, timeout: 5000 }, () => {})
  if (signal === 'KILL') wslProcesses.delete(hostPid)
  return true
}

const homes = new Map<string, string>()
const loginEnvs = new Map<string, Promise<NodeJS.ProcessEnv>>()

export function wslHome(distro: string): string {
  const known = homes.get(distro.toLowerCase())
  if (known) return known
  const output = execFileSync(wslExecutable(), ['--distribution', distro, '--exec', 'bash', '-lc', "printf '\\n__TUCANO_HOME__%s\\n' \"$HOME\""], { encoding: 'utf8', env: windowsHostEnvironment(), windowsHide: true, timeout: 10_000 })
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
        const output = execFileSync(wslExecutable(), ['--distribution', distro, '--exec', 'bash', '-lc', 'getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7'], { encoding: 'utf8', env: windowsHostEnvironment(), windowsHide: true, timeout: 10_000 })
        shell = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\/.+\/(?:bash|zsh|fish)$/.test(line)).at(-1) ?? '/bin/bash'
      } catch {
        // A minimal distro may not have getent; Bash is the tool shell fallback.
      }
      execFile(wslExecutable(), ['--distribution', distro, '--exec', shell, '-ilc', "printf '\\n__TUCANO_ENV__\\0'; env -0"], { encoding: 'buffer', env: windowsHostEnvironment(), windowsHide: true, timeout: 15_000 }, (_error, stdout) => {
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
    const output = execFileSync(wslExecutable(), ['--distribution', distro, '--exec', 'bash', '-lc', "ip -4 route show default | awk 'NR == 1 { print $3 }'"], { encoding: 'utf8', env: windowsHostEnvironment(), windowsHide: true, timeout: 10_000 })
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
      { env: windowsHostEnvironment(), windowsHide: true, timeout: 5000 },
      (error) => resolve(!error)
    )
  })
}

export function wslHasCommand(distro: string, command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      wslExecutable(),
      ['--distribution', distro, '--exec', 'bash', '-lc', 'command -v -- "$1" >/dev/null 2>&1', 'tucano-command-check', command],
      { env: windowsHostEnvironment(), windowsHide: true, timeout: 10_000 },
      (error) => resolve(!error)
    )
  })
}

export function activeWslDistro(): string | undefined {
  return activeTarget.kind === 'wsl' ? activeTarget.distro : undefined
}
