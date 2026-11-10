import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { L } from '../../shared/lang'
import type { AccountEngine, EngineId, EngineStatus } from '../../shared/types'
import { executableNames, isWin, killTree, pathDirs, spawnable, withInstallDirs } from '../platform'
import { userProvider } from './claude'
import { codexEnv, userCodexProvider } from './codex'
import { opencodeMajor } from './opencode-v2'
import { parseAntigravityModels } from './antigravity'
import { cursorSignedIn, parseCursorModels } from './cursor'
import { grokLogin, parseGrokModels } from './grok'
import { readClineLogins } from './cline'

// The app waits for these answers before anything can run, so the limit has to hold whatever the
// command does. execFile's own timeout only sends SIGTERM, which an interactive zsh ignores, and it
// answers only when the output pipes close, which what the command started can keep open for good.
export function run(bin: string, args: string[], timeout = 15_000, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const s = spawnable(bin, args)
    // Its own process group, so the limit takes its children with it. (On Windows, detached would open a console.)
    const child = spawn(s.file, s.args, { env, detached: !isWin, windowsHide: true, windowsVerbatimArguments: s.verbatim })
    let stdout = ''
    let stderr = ''
    let giveUp: NodeJS.Timeout | undefined
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    const finish = (code: number): void => {
      clearTimeout(limit)
      clearTimeout(giveUp)
      resolve({ code, stdout, stderr })
    }
    const limit = setTimeout(() => {
      if (child.pid) killTree(child.pid, 'SIGKILL')
      // Something that left the group can still hold the pipes: answer without waiting for them.
      giveUp = setTimeout(() => finish(1), 1_000)
    }, timeout)
    child.on('error', () => finish(1))
    child.on('close', (code) => finish(code ?? 1))
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
// Whether another login of Claude Code or Codex (Settings › Accounts) is signed in, and on which
// plan, from the CLI's own status for that folder. The parsing is pure, to test it on their output.
export function accountLogin(engine: AccountEngine, out: { code: number; stdout: string; stderr: string }): { loggedIn: boolean; detail?: string } {
  if (engine === 'claude') {
    let status: Record<string, unknown> = {}
    try {
      status = JSON.parse(out.stdout) as Record<string, unknown>
    } catch {
      // not signed in, or an older CLI
    }
    if (status['loggedIn'] !== true) return { loggedIn: false }
    const plan = typeof status['subscriptionType'] === 'string' ? status['subscriptionType'] : undefined
    const email = typeof status['email'] === 'string' ? status['email'] : undefined
    const what = status['authMethod'] === 'claude.ai' ? `${L('Plano Claude', 'Claude plan')}${plan ? ` ${plan[0]!.toUpperCase()}${plan.slice(1)}` : ''}` : L('Chave de API', 'API key')
    return { loggedIn: true, detail: email ? `${what} · ${email}` : what }
  }
  const text = `${out.stdout}\n${out.stderr}`
  const loggedIn = out.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)
  return loggedIn ? { loggedIn, detail: /chatgpt/i.test(text) ? L('Plano ChatGPT', 'ChatGPT plan') : L('Chave de API', 'API key') } : { loggedIn }
}

export const accountDir = (dataDir: string, id: string): string => join(dataDir, 'accounts', id)

export async function accountStatus(engine: AccountEngine, bin: string, dir: string): Promise<{ loggedIn: boolean; detail?: string }> {
  const out = engine === 'claude' ? await run(bin, ['auth', 'status'], 15_000, { ...process.env, CLAUDE_CONFIG_DIR: dir }) : await run(bin, ['login', 'status'], 15_000, codexEnv(dir, bin))
  return accountLogin(engine, out)
}

export async function detectCodex(home: string): Promise<EngineStatus> {
  const path = await which('codex')
  if (!path) return { installed: false, loggedIn: false }
  const gateway = gatewayHost(userCodexProvider().baseUrl)
  if (gateway) return { installed: true, path, version: version((await run(path, ['--version'])).stdout), loggedIn: true, route: 'gateway', gateway, account: L(`Gateway ${gateway} · pelo seu config.toml`, `Gateway ${gateway} · from your config.toml`) }
  const [v, auth] = await Promise.all([run(path, ['--version']), run(path, ['login', 'status'], 15_000, codexEnv(home, path))])
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

// The models Codex offers this login, newest first, from its own catalog: `codex debug models`
// (its cache when that command isn't there). Hidden ones (internal, retired) are left out.
export interface CodexModel {
  slug: string
  label: string
  description?: string
}

// 0 is the top of the list, not a missing priority.
const priorityOf = (p: unknown): number => (typeof p === 'number' ? p : 999)

export function parseCodexCatalog(json: string): CodexModel[] {
  try {
    const d = JSON.parse(json) as { models?: unknown } | unknown[]
    const list = (Array.isArray(d) ? d : Array.isArray(d.models) ? d.models : []) as { slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown; priority?: unknown }[]
    return list
      .filter((m) => typeof m.slug === 'string' && m.slug && (m.visibility === undefined || m.visibility === 'list'))
      .sort((a, b) => priorityOf(a.priority) - priorityOf(b.priority))
      .map((m) => ({
        slug: m.slug as string,
        label: typeof m.display_name === 'string' && m.display_name ? m.display_name : (m.slug as string),
        ...(typeof m.description === 'string' && m.description ? { description: m.description } : {})
      }))
  } catch {
    return []
  }
}

export async function codexModels(path: string, home: string): Promise<CodexModel[]> {
  const r = await run(path, ['debug', 'models'], 15_000, codexEnv(home, path))
  const list = r.code === 0 ? parseCodexCatalog(r.stdout) : []
  if (list.length) return list
  try {
    return parseCodexCatalog(readFileSync(join(home, '.codex', 'models_cache.json'), 'utf8'))
  } catch {
    return []
  }
}

// OpenCode and Pi keep their own logins and providers; what they list is what
// the person can use, so the list is the status. Their models go to `listed`.
const providerName = (id: string): string => ({ openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', google: 'Google', opencode: 'OpenCode', 'opencode-go': 'OpenCode Go', 'openai-codex': 'ChatGPT', 'github-copilot': 'Copilot', cline: 'Cline', 'openai-compatible': 'OpenAI Compatible', deepseek: 'DeepSeek', bedrock: 'Bedrock', ollama: 'Ollama', lmstudio: 'LM Studio' })[id] ?? id

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

// Antigravity's CLI. `agy models` lists the models the signed-in account can run, and
// says to sign in when there's no login (it lives in the keychain, not in a file).
export async function detectAntigravity(): Promise<{ status: EngineStatus; models: string[] }> {
  const path = await which('agy')
  if (!path) return { status: { installed: false, loggedIn: false }, models: [] }
  const [v, list] = await Promise.all([run(path, ['--version']), run(path, ['models'], 30_000)])
  const models = parseAntigravityModels(list.stdout)
  const signedIn = models.length > 0
  return {
    status: {
      installed: true,
      path,
      version: version(v.stdout),
      loggedIn: signedIn,
      ...(signedIn ? { route: 'providers' as const, account: `Google · ${models.length} ${L('modelos', 'models')}` } : { account: L('Sem login: entre com agy', 'Not signed in: sign in with agy') })
    },
    models
  }
}

// Grok's CLI. `grok models` says whether the grok.com login is in place and
// lists the models that login can run. An API key, with no subscription login,
// still counts as signed in, and the screen warns that it bills per token.
export async function detectGrok(): Promise<{ status: EngineStatus; models: string[] }> {
  const path = await which('grok')
  if (!path) return { status: { installed: false, loggedIn: false }, models: [] }
  const [v, list] = await Promise.all([run(path, ['--version']), run(path, ['models'], 30_000, { ...process.env, NO_COLOR: '1' })])
  const text = `${list.stdout}\n${list.stderr}`
  const login = grokLogin(text)
  const models = login.loggedIn ? parseGrokModels(list.stdout) : []
  const viaKey = login.loggedIn && !login.plan
  return {
    status: {
      installed: true,
      path,
      version: version(v.stdout),
      loggedIn: login.loggedIn && models.length > 0,
      ...(login.loggedIn && models.length ? { route: login.plan ? ('plan' as const) : ('apikey' as const) } : {}),
      account: models.length
        ? login.plan
          ? `Grok · ${models.length} ${L('modelos', 'models')}`
          : L('Chave de API', 'API key')
        : L('Sem login: entre com grok login', 'Not signed in: sign in with grok login'),
      ...(viaKey ? { warning: apiKeyWarning() } : {})
    },
    models
  }
}

// Cline's CLI, on Tucano's own login (see cline.ts): what it's signed into is in that
// login's providers.json, read here (there's no status command), with the model each
// provider last ran. Cline lists no models of its own; the rest go by name.
export async function detectCline(loginDir: string): Promise<{ status: EngineStatus; models: string[] }> {
  const path = await which('cline')
  if (!path) return { status: { installed: false, loggedIn: false }, models: [] }
  const v = await run(path, ['--version'])
  const { providers, models } = readClineLogins(loginDir)
  const signedIn = providers.length > 0
  const names = `${providers.slice(0, 3).map(providerName).join(', ')}${providers.length > 3 ? L(` e mais ${providers.length - 3}`, ` and ${providers.length - 3} more`) : ''}`
  return {
    status: {
      installed: true,
      path,
      version: version(v.stdout),
      loggedIn: signedIn,
      ...(signedIn ? { route: 'providers' as const, account: `${names} · ${L('login próprio do Tucano', "Tucano's own login")}` } : { account: L('Precisa de um login próprio do Tucano: cline auth', "Needs Tucano's own login: cline auth") })
    },
    models
  }
}

// Cursor's agent CLI, by its unique name (it also installs a plain `agent`).
// `status` says whether it's signed in; `models` lists what the account can run.
export async function detectCursor(): Promise<{ status: EngineStatus; models: string[] }> {
  const path = await which('cursor-agent')
  if (!path) return { status: { installed: false, loggedIn: false }, models: [] }
  const [v, st] = await Promise.all([run(path, ['--version']), run(path, ['status'], 20_000, { ...process.env, NO_OPEN_BROWSER: '1' })])
  const signedIn = cursorSignedIn(st.stdout + st.stderr)
  const models = signedIn ? parseCursorModels((await run(path, ['models'], 30_000, { ...process.env, NO_OPEN_BROWSER: '1' })).stdout) : []
  return {
    status: {
      installed: true,
      path,
      version: v.stdout.trim().match(/^[\w.-]+/)?.[0] ?? version(v.stdout),
      loggedIn: signedIn && models.length > 0,
      ...(signedIn && models.length ? { route: 'providers' as const, account: `Cursor · ${models.length} ${L('modelos', 'models')}` } : { account: signedIn ? L('Sem modelos: confira o plano do Cursor', 'No models: check your Cursor plan') : L('Sem login: entre com cursor-agent login', 'Not signed in: sign in with cursor-agent login') })
    },
    models
  }
}

export async function detectEngines(codexHome: string, clineLogin: string): Promise<{ engines: Record<EngineId, EngineStatus>; listed: Partial<Record<EngineId, string[]>>; codexCatalog: CodexModel[] }> {
  // A CLI installed while the app is open may have created its folder just now.
  process.env['PATH'] = withInstallDirs(process.env['PATH'] ?? '')
  // Codex's catalog is read alongside (it can take a couple of seconds), used once the login is known.
  const catalog = which('codex').then((p) => (p ? codexModels(p, codexHome) : []))
  const [claude, codex, opencode, pi, antigravity, cursor, grok, cline] = await Promise.all([detectClaude(), detectCodex(codexHome), detectOpenCode(), detectPi(), detectAntigravity(), detectCursor(), detectGrok(), detectCline(clineLogin)])
  // A gateway serves its own list (asked when picking); a plan or an API key gets Codex's catalog.
  const codexCatalog = codex.loggedIn && codex.route !== 'gateway' ? await catalog : []
  return {
    engines: { claude, codex, opencode: opencode.status, pi: pi.status, antigravity: antigravity.status, cursor: cursor.status, grok: grok.status, cline: cline.status },
    listed: { opencode: opencode.models, pi: pi.models, antigravity: antigravity.models, cursor: cursor.models, grok: grok.models, cline: cline.models, ...(codexCatalog.length ? { codex: codexCatalog.map((m) => m.slug) } : {}) },
    codexCatalog
  }
}
