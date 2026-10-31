import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { L } from '../../shared/lang'
import { ENGINES, type EngineId, type EngineStatus } from '../../shared/types'
import { executableNames, isWin, pathDirs, spawnable, withInstallDirs } from '../platform'
import { userProvider } from './claude'
import { codexEnv, userCodexProvider } from './codex'
import { opencodeMajor } from './opencode-v2'
import { geminiModels } from './gemini'
import { hermesAppDir, userHermesProviders, warmHermes } from './hermes'

function run(bin: string, args: string[], timeout = 15_000, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const s = spawnable(bin, args)
    execFile(s.file, s.args, { timeout, env, windowsHide: true, windowsVerbatimArguments: s.verbatim }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// Apps opened from Finder get a minimal PATH. Borrow the one from the user's
// login shell so `claude` and `codex` are found where the terminal finds them.
// Windows hands every app the user's full PATH already. Either way, the folders
// the CLIs install themselves into are added when the installer left them out.
export async function adoptLoginShellPath(): Promise<void> {
  if (!isWin) {
    const shell = process.env['SHELL'] || '/bin/zsh'
    const { code, stdout } = await run(shell, ['-ilc', 'printf "__PATH__%s" "$PATH"'], 10_000)
    const path = stdout.split('__PATH__').pop()?.trim()
    if (code === 0 && path) process.env['PATH'] = path
  }
  // (process.env is case-insensitive on Windows, so PATH is also Path there.)
  process.env['PATH'] = withInstallDirs(process.env['PATH'] ?? '')
}

async function which(cmd: string): Promise<string | undefined> {
  for (const dir of pathDirs()) {
    for (const name of executableNames(cmd)) {
      const p = join(dir, name)
      try {
        await access(p, constants.X_OK)
        return p
      } catch {
        // not here
      }
    }
  }
  return undefined
}

const version = (out: string): string | undefined => out.match(/\d+\.\d+\.\d+/)?.[0]

// "0.22.5" is at least "0.22.0": compare part by part, missing parts as zero.
export const olderThan = (found: string, min: string): boolean => {
  const a = found.split('.').map((n) => parseInt(n, 10) || 0)
  const b = min.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

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

export async function detectOpenCode(): Promise<{ status: EngineStatus; models: string[] }> {
  const path = await which('opencode')
  if (!path) return { status: { installed: false, loggedIn: false }, models: [] }
  const v = await run(path, ['--version'])
  // V2's commands talk to a background service and start it when it isn't running;
  // --standalone (V2 only) answers from a private server that ends with the command.
  const list = await run(path, opencodeMajor(version(v.stdout)) >= 2 ? ['models', '--standalone'] : ['models'], 30_000)
  const models = list.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l))
  return { status: listedStatus(path, v.stdout, models, 'opencode auth login'), models }
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

// The model ids Hermes can run, from its provider cache: one entry per
// credential (a provider slug, or `custom:<url>#<fingerprint>` for an endpoint
// in the person's config), each with the models its catalog lists. A custom
// endpoint is labelled with the config key it belongs to, not the host: that
// is the name the CLI routes with.
export function parseHermesModels(
  file = join(process.env['HERMES_HOME'] || join(homedir(), '.hermes'), 'provider_models_cache.json'),
  providers: Record<string, string> = {}
): string[] {
  let cache: Record<string, unknown>
  try {
    cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return []
  }
  const out: string[] = []
  for (const [key, entry] of Object.entries(cache)) {
    const models = ((entry ?? {}) as Record<string, unknown>)['models']
    if (!Array.isArray(models)) continue
    const provider = key.startsWith('custom:') ? (providers[normalizeUrl(endpointUrl(key))] ?? hostOf(endpointUrl(key)) ?? key) : key
    for (const m of models) if (typeof m === 'string' && m) out.push(`${provider}/${m}`)
  }
  return out
}

const endpointUrl = (key: string): string => key.slice(7).split('#')[0]! // "custom:<url>#<fingerprint>" → url
const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase()

// The endpoints of the person's own providers, by config key: a URL with
// trailing slashes and case differences is still the same endpoint.
export const hermesEndpointProviders = (providers: Record<string, unknown> | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(providers ?? {})) {
    const e = (entry ?? {}) as Record<string, unknown>
    const url = e['base_url'] ?? e['url'] ?? e['api']
    if (typeof url === 'string' && url) out[normalizeUrl(url)] = key
  }
  return out
}

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

export async function detectHermes(): Promise<{ status: EngineStatus; models: string[] }> {
  const path = await which('hermes')
  if (!path) return { status: { installed: false, loggedIn: false }, models: [] }
  const v = await run(path, ['--version'])
  void warmHermes(path, hermesAppDir()) // started early; every run waits for it
  const models = parseHermesModels(undefined, hermesEndpointProviders(userHermesProviders()['providers'] as Record<string, unknown> | undefined))
  // What the cache lists is what the person can use; the status is the list.
  const status = listedStatus(path, v.stdout, models, 'hermes setup')
  // The options the app runs it with (--format stream-json, --query-file) are
  // 0.22's; the package on PyPI is older and would fail every single turn, so
  // the row says it instead of the person finding out mid-conversation.
  const found = version(v.stdout)
  const min = ENGINES.hermes.min
  if (found && min && olderThan(found, min)) {
    status.warning = L(
      `O seu Hermes é ${found}: o Tucano roda com a ${min} ou mais nova (o pacote do PyPI é mais antigo e não tem as opções que o app usa). Atualize pelo instalador oficial.`,
      `Your Hermes is ${found}: Tucano runs with ${min} or newer (the package on PyPI is older and lacks the options the app uses). Update through the official installer.`
    )
  }
  return { status, models }
}

// Gemini CLI. Its model list isn't offered by an offline command, so the known
// current models are used; "signed in" is whether a login is in place — the
// OAuth credentials in the home, or an API key / Vertex in the environment.
export async function detectGemini(): Promise<{ status: EngineStatus; models: string[] }> {
  const path = await which('gemini')
  if (!path) return { status: { installed: false, loggedIn: false }, models: [] }
  const v = await run(path, ['--version'])
  const home = process.env['GEMINI_CLI_HOME'] || join(homedir(), '.gemini')
  const signedIn = existsSync(join(home, 'oauth_creds.json')) || !!(process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'] || process.env['GOOGLE_GENAI_USE_VERTEXAI'])
  const models = geminiModels()
  return {
    status: {
      installed: true,
      path,
      version: version(v.stdout),
      loggedIn: signedIn,
      ...(signedIn ? { route: 'providers' as const, account: `Google · ${models.length} ${L('modelos', 'models')}` } : { account: L('Sem login: entre com gemini', 'Not signed in: sign in with gemini') })
    },
    models: signedIn ? models : []
  }
}

export async function detectEngines(codexHome: string): Promise<{ engines: Record<EngineId, EngineStatus>; listed: Partial<Record<EngineId, string[]>> }> {
  // A CLI installed while the app is open may have created its folder just now.
  process.env['PATH'] = withInstallDirs(process.env['PATH'] ?? '')
  const [claude, codex, opencode, pi, gemini, hermes] = await Promise.all([detectClaude(), detectCodex(codexHome), detectOpenCode(), detectPi(), detectGemini(), detectHermes()])
  return { engines: { claude, codex, opencode: opencode.status, pi: pi.status, gemini: gemini.status, hermes: hermes.status }, listed: { opencode: opencode.models, pi: pi.models, gemini: gemini.models, hermes: hermes.models } }
}
