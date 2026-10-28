import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { L } from '../../shared/lang'
import type { EngineId, EngineStatus } from '../../shared/types'
import { userProvider } from './claude'
import { codexEnv, userCodexProvider } from './codex'

function run(bin: string, args: string[], timeout = 15_000, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// Apps opened from Finder get a minimal PATH. Borrow the one from the user's
// login shell so `claude` and `codex` are found where the terminal finds them.
export async function adoptLoginShellPath(): Promise<void> {
  const shell = process.env['SHELL'] || '/bin/zsh'
  const { code, stdout } = await run(shell, ['-ilc', 'printf "__PATH__%s" "$PATH"'], 10_000)
  const path = stdout.split('__PATH__').pop()?.trim()
  if (code === 0 && path) process.env['PATH'] = path
}

async function which(cmd: string): Promise<string | undefined> {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (!dir) continue
    const p = join(dir, cmd)
    try {
      await access(p, constants.X_OK)
      return p
    } catch {
      // not here
    }
  }
  return undefined
}

const version = (out: string): string | undefined => out.match(/\d+\.\d+\.\d+/)?.[0]

export async function detectClaude(): Promise<EngineStatus> {
  const path = await which('claude')
  if (!path) return { installed: false, loggedIn: false }
  const [v, auth] = await Promise.all([run(path, ['--version']), run(path, ['auth', 'status'])])
  let status: Record<string, unknown> = {}
  try {
    status = JSON.parse(auth.stdout) as Record<string, unknown>
  } catch {
    // older CLI or not logged in
  }
  const loggedIn = status['loggedIn'] === true
  const subscription = typeof status['subscriptionType'] === 'string' ? status['subscriptionType'] : undefined
  const viaSubscription = status['authMethod'] === 'claude.ai'
  const gateway = gatewayHost(userProvider().env['ANTHROPIC_BASE_URL'])
  if (gateway) return { installed: true, path, version: version(v.stdout), loggedIn: true, route: 'gateway', gateway, account: L(`Gateway ${gateway} · pelo seu settings.json`, `Gateway ${gateway} · from your settings.json`) }
  return {
    installed: true,
    path,
    version: version(v.stdout),
    loggedIn,
    ...(loggedIn ? { route: viaSubscription ? 'plan' : 'apikey' } : {}),
    account: loggedIn ? (viaSubscription ? `${L('Plano Claude', 'Claude plan')}${subscription ? ` ${subscription[0]!.toUpperCase()}${subscription.slice(1)}` : ''}` : L('Chave de API', 'API key')) : undefined,
    warning: loggedIn && !viaSubscription ? apiKeyWarning() : undefined
  }
}

const apiKeyWarning = (): string => L('Logado com chave de API: o uso será cobrado por token.', 'Signed in with an API key: usage will be billed per token.')

const gatewayHost = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).host : undefined
  } catch {
    return url
  }
}

// Checks the app's own Codex login (see codexEnv), not the user's.
export async function detectCodex(home: string): Promise<EngineStatus> {
  const path = await which('codex')
  if (!path) return { installed: false, loggedIn: false }
  const gateway = gatewayHost(userCodexProvider().baseUrl)
  if (gateway) return { installed: true, path, version: version((await run(path, ['--version'])).stdout), loggedIn: true, route: 'gateway', gateway, account: L(`Gateway ${gateway} · pelo seu config.toml`, `Gateway ${gateway} · from your config.toml`) }
  const [v, auth] = await Promise.all([run(path, ['--version']), run(path, ['login', 'status'], 15_000, codexEnv(home))])
  const text = `${auth.stdout}\n${auth.stderr}`
  const loggedIn = auth.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)
  const viaChatGpt = /chatgpt/i.test(text)
  return {
    installed: true,
    path,
    version: version(v.stdout),
    loggedIn,
    ...(loggedIn ? { route: viaChatGpt ? ('plan' as const) : ('apikey' as const) } : {}),
    account: loggedIn ? (viaChatGpt ? L('Plano ChatGPT · login próprio do Tucano', "ChatGPT plan · Tucano's own login") : L('Chave de API', 'API key')) : L('Precisa de um login próprio do Tucano', "Needs Tucano's own login"),
    warning: loggedIn && !viaChatGpt ? apiKeyWarning() : undefined
  }
}

// OpenCode and Pi keep their own logins and providers; what they list is what
// the person can use, so the list is the status. Their models go to `listed`.
const providerName = (id: string): string => ({ openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', google: 'Google', opencode: 'OpenCode', 'opencode-go': 'OpenCode Go', 'openai-codex': 'ChatGPT', 'github-copilot': 'Copilot' })[id] ?? id

function listedStatus(path: string, v: string, models: string[], login: string): EngineStatus {
  const providers = [...new Set(models.map((m) => m.split('/')[0]!))]
  return {
    installed: true,
    path,
    version: version(v),
    loggedIn: models.length > 0,
    ...(models.length ? { route: 'providers' as const } : {}),
    account: models.length
      ? `${providers.slice(0, 3).map(providerName).join(', ')}${providers.length > 3 ? L(` e mais ${providers.length - 3}`, ` and ${providers.length - 3} more`) : ''} · ${models.length} ${L('modelos', 'models')}`
      : L(`Sem modelos: faça login com ${login}`, `No models: sign in with ${login}`)
  }
}

// One binary for V1 and V2: the major version picks the engine that gets the
// full status; the other shows not installed with a hint about the right one.
export function opencodeStatuses(out: string, path: string, models: string[]): { v1: EngineStatus; v2: EngineStatus } {
  const v = version(out)
  const major = v ? parseInt(v, 10) : 1
  const full = listedStatus(path, out, models, 'opencode auth login')
  const hint = (found: string, use: string): EngineStatus => ({ installed: false, loggedIn: false, account: L(`Encontrei o OpenCode ${found} — use o harness ${use}`, `Found OpenCode ${found} — use the ${use} harness`) })
  return major >= 2 ? { v1: hint('V2', 'OpenCode V2'), v2: full } : { v1: full, v2: hint('V1', 'OpenCode') }
}

export async function detectOpenCode(): Promise<{ opencode: EngineStatus; 'opencode-v2': EngineStatus; models: string[] }> {
  const none: EngineStatus = { installed: false, loggedIn: false }
  const path = await which('opencode')
  if (!path) return { opencode: none, 'opencode-v2': none, models: [] }
  const [v, list] = await Promise.all([run(path, ['--version']), run(path, ['models'], 30_000)])
  const models = list.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l))
  const { v1, v2 } = opencodeStatuses(v.stdout, path, models)
  return { opencode: v1, 'opencode-v2': v2, models }
}

// `pi --list-models` prints a table: provider, model, then the limits.
export function parsePiModels(out: string): string[] {
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 2 && c[0] && c[1])
    .map((c) => `${c[0]}/${c[1]}`)
}

export async function detectPi(): Promise<{ status: EngineStatus; models: string[] }> {
  const path = await which('pi')
  if (!path) return { status: { installed: false, loggedIn: false }, models: [] }
  const [v, list] = await Promise.all([run(path, ['--version']), run(path, ['--list-models', '--offline', '--no-extensions'], 30_000)])
  const models = parsePiModels(list.stdout)
  return { status: listedStatus(path, v.stdout, models, 'pi (e /login)'), models }
}

export async function detectEngines(codexHome: string): Promise<{ engines: Record<EngineId, EngineStatus>; listed: Partial<Record<EngineId, string[]>> }> {
  const [claude, codex, oc, pi] = await Promise.all([detectClaude(), detectCodex(codexHome), detectOpenCode(), detectPi()])
  return { engines: { claude, codex, opencode: oc.opencode, 'opencode-v2': oc['opencode-v2'], pi: pi.status }, listed: { opencode: oc.models, 'opencode-v2': oc.models, pi: pi.models } }
}
