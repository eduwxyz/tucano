// Native turn hooks: one opt-in command, JSON on stdin, fail-open. Harness hook
// formats stay out of isolated homes; this is Tucano's own seam.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { L } from '../shared/lang'
import type { Agent, HookEvent, HookRun, HookSettings, Settings } from '../shared/types'
import { isWin, killTree, spawnable } from './platform'

export const DEFAULT_HOOK_TIMEOUT_MS = 2_000
export const HOOK_TEXT_MAX = 32_000
const TIMEOUT_MIN = 250
const TIMEOUT_MAX = 10_000
const ENV_KEYS = 20
const ENV_KEY = 64
const ENV_VAL = 4_096
const ARG_MAX = 32
const ARG_LEN = 1_024

export const CAPTURE_OWNER = 'tucano'

export function hookActive(settings: Pick<Settings, 'hooks'>, agent: Pick<Agent, 'hooks'>): boolean {
  return !!settings.hooks?.enabled && agent.hooks !== 'off' && !!settings.hooks.command
}

export function cleanHooks(raw: unknown): HookSettings | undefined {
  if (raw == null) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  const enabled = o.enabled === true
  const timeoutMs = clampTimeout(o.timeoutMs)
  const env = cleanHookEnv(o.env)
  const args = cleanArgs(o.args)
  const captureOwner = o.captureOwner === true
  if (!enabled && !command && !timeoutMs && !env && !args && !captureOwner) return undefined
  return {
    enabled,
    command,
    ...(args ? { args } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(env ? { env } : {}),
    ...(captureOwner ? { captureOwner: true } : {})
  }
}

export function hooksPatchError(raw: unknown): string | undefined {
  if (raw == null) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return L('Valor inválido pra hooks.', 'Invalid value for hooks.')
  }
  const h = cleanHooks(raw)
  if (!h) return undefined
  if (h.enabled && (!h.command || !isAbsolute(h.command))) {
    return L('O comando do gancho precisa ser um caminho absoluto.', 'The hook command has to be an absolute path.')
  }
  return undefined
}

export function cleanAgentHooks(raw: unknown): 'off' | undefined {
  return raw === 'off' ? 'off' : undefined
}

export function clipHookText(text: string): string {
  return text.length > HOOK_TEXT_MAX ? `${text.slice(0, HOOK_TEXT_MAX)}…` : text
}

export function sampleHookEvent(cwd = process.cwd()): HookEvent {
  return {
    version: 1,
    event: 'turn-end',
    session: 'run-test',
    agent: { id: 'test', handle: 'lia', name: 'Lia', engine: 'claude', model: 'sonnet' },
    conversation: { id: 'test', kind: 'dm', name: 'lia', threadId: null },
    message: { id: 'm1', text: 'ping', author: 'person' },
    reply: { text: 'pong', ms: 1, tokens: { input: 1, output: 1 } },
    tools: [],
    cwd
  }
}

export async function runTurnHook(settings: HookSettings, event: HookEvent): Promise<HookRun> {
  const started = Date.now()
  const command = settings.command
  const result = (exit: number | null, error?: string): HookRun => ({
    event: event.event,
    ms: Date.now() - started,
    exit,
    ...(error ? { error } : {})
  })
  if (!command || !isAbsolute(command)) return result(null, L('caminho inválido', 'invalid path'))
  const timeoutMs = clampTimeout(settings.timeoutMs) ?? DEFAULT_HOOK_TIMEOUT_MS
  const args = settings.args ?? []
  const env = hookProcessEnv(settings)
  const line = JSON.stringify(event)
  try {
    const s = spawnable(command, args)
    if (event.cwd && isAbsolute(event.cwd)) mkdirSync(event.cwd, { recursive: true })
    const child = spawn(s.file, s.args, {
      env,
      ...(event.cwd && isAbsolute(event.cwd) ? { cwd: event.cwd } : {}),
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: s.verbatim
    })
    const done = new Promise<HookRun>((resolve) => {
      let stderr = ''
      child.stderr?.on('data', (buf: Buffer) => {
        if (stderr.length < 2_000) stderr += buf.toString('utf8')
      })
      const finish = (exit: number | null, error?: string): void => {
        clearTimeout(timer)
        resolve(result(exit, error))
      }
      const timer = setTimeout(() => {
        killHook(child.pid)
        finish(null, 'timeout')
      }, timeoutMs)
      child.on('error', (e) => finish(null, e.message))
      child.on('close', (code) => finish(code, code === 0 ? undefined : (stderr.trim().slice(0, 400) || `exit ${code}`)))
    })
    child.stdin?.on('error', () => {}) // the command may exit before reading stdin
    child.stdin?.write(line)
    child.stdin?.end()
    return await done
  } catch (e) {
    return result(null, e instanceof Error ? e.message : String(e))
  }
}

function killHook(pid: number | undefined): void {
  if (pid == null) return
  if (isWin) {
    killTree(pid)
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 500).unref()
}

function clampTimeout(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(v)))
}

function cleanArgs(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const args = raw.filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, ARG_LEN)).filter(Boolean).slice(0, ARG_MAX)
  return args.length ? args : undefined
}

function cleanHookEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k.length > ENV_KEY) continue
    if (typeof v !== 'string') continue
    env[k] = v.slice(0, ENV_VAL)
    if (Object.keys(env).length >= ENV_KEYS) break
  }
  return Object.keys(env).length ? env : undefined
}

function hookProcessEnv(settings: HookSettings): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'TMP', 'TEMP', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']
  const env: NodeJS.ProcessEnv = {}
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]
  if (settings.env) Object.assign(env, settings.env)
  if (settings.captureOwner) {
    env['TUCANO_CAPTURE_OWNER'] = CAPTURE_OWNER
    env['AI_MEMORY_CAPTURE_OWNER'] = CAPTURE_OWNER
  }
  return env
}

export function withCaptureOwner<T extends HookEvent>(settings: HookSettings | undefined, event: T): T {
  if (!settings?.captureOwner) return event
  return { ...event, captureOwner: CAPTURE_OWNER }
}
