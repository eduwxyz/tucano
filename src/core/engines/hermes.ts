import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Effort } from '../../shared/types'
import type { Engine, EngineEvent, Turn } from './types'
import { L } from '../../shared/lang'

// Hermes is the agent CLI the app itself runs on. It reads AGENTS.md, SOUL.md,
// skills, plugins, MCP servers and sessions from its home, and keeps every
// session in a database there. So the app gives each Tucano agent a home of
// its own (HERMES_HOME, see hermesHome) and brings in only the person's
// providers (the `providers` block of their config.yaml) and their logins
// (.env and auth.json, linked so a refreshed login stays theirs). The app's
// gateway, when given, is the only MCP server: its tools are what the agent
// gets.

// One JSON event per line: system/init, text deltas, tool_use/tool_result, and
// one terminal result with the whole turn's tokens (or an error). The answer
// comes whole in the result; the deltas before it are only for streaming.
export function hermesParser(): Parser {
  let text = ''
  let usage: { inputTokens: number; cacheReadTokens: number; outputTokens: number } | undefined
  let failed = false
  let error = ''

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      if (ev['type'] === 'text' && typeof ev['text'] === 'string' && ev['text']) {
        text += ev['text']
        out.push({ type: 'text', delta: ev['text'] })
      } else if (ev['type'] === 'tool_use') {
        const input = (ev['input'] ?? {}) as Record<string, unknown>
        if (ev['name'] === 'web_search') out.push({ type: 'web', action: 'search', detail: String(input['query'] ?? '') })
        else if (ev['name'] === 'web_extract')
          out.push({ type: 'web', action: 'fetch', detail: String(Array.isArray(input['urls']) ? (input['urls'] as unknown[])[0] ?? '' : '') })
      } else if (ev['type'] === 'result') {
        if (typeof ev['error'] === 'string' && ev['error']) {
          failed = true
          error = ev['error']
        } else {
          // `total` counts input, cache read and write, and output together;
          // `input` alone misses the cached part, which also left the machine.
          const t = (ev['tokens'] ?? {}) as Record<string, unknown>
          usage = { inputTokens: num(t['input']) + num(t['cache_read']) + num(t['cache_write']), cacheReadTokens: num(t['cache_read']), outputTokens: num(t['output']) }
          const whole = typeof ev['text'] === 'string' ? ev['text'] : ''
          text = whole || text
        }
      }
      return out
    },
    end(code, stderr) {
      if (failed) return [{ type: 'error', message: error }]
      if (usage) return [{ type: 'done', text, usage }]
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Hermes saiu sem resposta (código ${code ?? '?'}).`, `Hermes exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

const REASONING: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }

// One-shot JSONL on stdout; the query comes from stdin ('-'). The agent's
// instructions ride in the home's SOUL.md (identity slot #1: it replaces the
// CLI's own identity — an env hint would only describe the environment, and
// would repeat SOUL.md). The provider is named explicitly (a bare model id
// otherwise falls back to a provider the person never picked); the CLI's
// --image takes one path (repeating it keeps the last), so the newest image
// rides along.
export function hermesArgs(turn: Pick<Turn, 'model' | 'effort' | 'images'>, provider?: string): string[] {
  const image = [...(turn.images ?? [])].reverse().find((i) => existsSync(i.path))
  return [
    'chat',
    '--format', 'stream-json',
    '--query-file', '-',
    '--reasoning', REASONING[turn.effort],
    '-m', turn.model,
    ...(provider ? ['--provider', provider] : []),
    ...(image ? ['--image', image.path] : [])
  ]
}

const userHomeOf = (): string => process.env['HERMES_HOME'] || join(homedir(), '.hermes')

// Where the app keeps the Hermes homes: a base home for the shared dependency
// environment, and one home per agent under it.
export const hermesAppDir = (): string => process.env['TUCANO_DATA'] ? join(process.env['TUCANO_DATA'], 'hermes') : join(process.cwd(), '.tucano', 'hermes')

// The user's provider config, from their ~/.hermes/config.yaml: the `providers`
// block (a company gateway, a custom endpoint) and which one their model
// section routes through. The rest (their MCP servers, toolsets, approvals)
// stays out.
export function userHermesProviders(userHome = userHomeOf()): Record<string, unknown> {
  const c = userHermesConfig(userHome)
  const out: Record<string, unknown> = {}
  if (c['providers'] && typeof c['providers'] === 'object') out['providers'] = c['providers']
  const model = c['model']
  if (model && typeof model === 'object' && typeof (model as Record<string, unknown>)['provider'] === 'string')
    out['model'] = { provider: (model as Record<string, unknown>)['provider'] }
  return out
}

function userHermesConfig(userHome: string): Record<string, unknown> {
  try {
    const v: unknown = parseYaml(readFileSync(join(userHome, 'config.yaml'), 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {} // not there, or not readable
  }
}

// A link where one is possible (auth and logins must stay the person's), a
// plain copy where the platform refuses links (Windows without privileges).
function linkOrCopy(target: string, at: string): void {
  try {
    symlinkSync(target, at)
  } catch {
    try {
      copyFileSync(target, at)
    } catch {
      // neither link nor copy: the CLI starts without it
    }
  }
}

// The app's own Hermes root, laid out the way the CLI's one-gateway-per-host
// runtime (0.22+) expects: the root itself is the default home (it carries the
// root config with `_config_version`), and each Tucano agent is a named
// profile under profiles/ — one shared daemon serves them all, and every turn
// runs scoped to its profile's home (config, SOUL.md, secrets). `agents/`
// would not qualify as profiles: the CLI counts a home as a profile only under
// `<root>/profiles/`. The agent's instructions go to SOUL.md (identity slot
// #1, so the agent is Tucano's, not Hermes'), rewritten every turn because a
// fresh home gets seeded with a default one. JSON is valid YAML, so the
// configs are written with JSON.stringify.
export function hermesHome(appDir: string, turn: Pick<Turn, 'system' | 'mcpUrl' | 'web' | 'agentKey'>, userHome = userHomeOf()): string {
  // Only the router runs without an agent key; it gets a profile of its own.
  const key = (turn.agentKey ?? 'router').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'router'
  mkdirSync(appDir, { recursive: true })
  // The root must look like a Hermes home (the profiles resolver requires it)
  // and pass the CLI's config migration. The CLI's own gateway daemon is part
  // of 0.22's runtime (every turn goes through it, and it multiplexes the
  // profiles), so an agent can't run without one; it is scoped to this root —
  // its pid file records this home — and it leaves on its own, 2 minutes idle,
  // so it never outlives the app by long. A restart on a warm root measured
  // 4 s, against 24 s for a cold root's first bootstrap.
  // Nothing of Hermes' own scheduler runs behind the app: an agent can't create
  // jobs, and a missed run is dropped instead of caught up. Routines are the
  // app's, with its approvals and limits.
  const rootConfig: Record<string, unknown> = {
    _config_version: 12,
    approvals: { mode: 'off' },
    gateway: { unmanaged_idle_exit_seconds: 120 },
    cron: { allow_agent_scheduling: false, catch_up_missed: false },
    ...userHermesProviders(userHome)
  }
  writeFileSync(join(appDir, 'config.yaml'), JSON.stringify(rootConfig, null, 2))

  const home = join(appDir, 'profiles', key)
  mkdirSync(home, { recursive: true })

  const auth = join(home, 'auth.json')
  if (!existsSync(auth) && existsSync(join(userHome, 'auth.json'))) linkOrCopy(join(userHome, 'auth.json'), auth)
  const dotenv = join(home, '.env')
  if (!existsSync(dotenv) && existsSync(join(userHome, '.env'))) linkOrCopy(join(userHome, '.env'), dotenv)

  // The agent is Tucano's: its instructions replace the CLI's identity. The
  // CLI re-seeds the person's bundled skills into the home at every startup
  // (HERMES_BUNDLED_SKILLS, see hermesEnv), so nothing to remove here.
  writeFileSync(join(home, 'SOUL.md'), turn.system)

  const config: Record<string, unknown> = {
    _config_version: 12,
    approvals: { mode: 'off' }, // the gateway decides what runs
    // No built-in tools (shell, files); web search and page reading only when
    // the agent has the web. The app's gateway is the only MCP server.
    platform_toolsets: { cli: turn.web ? ['web'] : [] },
    // The gateway's tools reach the model directly (tool_search would defer
    // them behind a search bridge no Tucano tool ever surfaces through).
    tools: { tool_search: { enabled: 'off' } },
    // Nothing of the person's is learned or reviewed behind the app's back:
    // no memories written, no skills patched, no post-turn review.
    memory: { memory_enabled: false, user_profile_enabled: false },
    skills: { auto_load: [], project_discovery: false },
    auxiliary: { background_review: { enabled: false }, title_generation: { enabled: false } },
    ...(turn.mcpUrl ? { mcp_servers: { [GATEWAY_NAME]: { url: turn.mcpUrl } } } : {}),
    ...userHermesProviders(userHome)
  }
  writeFileSync(join(home, 'config.yaml'), JSON.stringify(config, null, 2))
  // Where the CLI looks for skills to seed into a home: an empty folder, so
  // the person's own catalog never leaks into the agent (verified: a run with
  // this set seeds nothing and completes).
  mkdirSync(join(appDir, 'no-skills'), { recursive: true })
  return home
}

// The env a hermes turn runs with: the agent's home, and an empty skills
// source (HERMES_BUNDLED_SKILLS) so the CLI seeds none of the person's
// catalog into the home (verified: a run with this set seeds nothing).
export function hermesEnv(appDir: string, home: string, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...base, HERMES_HOME: home, HERMES_BUNDLED_SKILLS: join(appDir, 'no-skills') }
}

// The model is "<provider>/<model>" as the picker lists it; the CLI wants the
// model id alone and the provider named separately (--provider).
export function hermesEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'hermes',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Hermes não está instalado. Veja em Configurações.', "Hermes isn't installed. See Settings.") }
        return
      }
      const [prefix, ...rest] = turn.model.split('/')
      const user = userHermesProviders()
      const provider = rest.length ? prefix : ((user['model'] as Record<string, unknown> | undefined)?.['provider'] as string | undefined)
      const model = rest.length ? rest.join('/') : turn.model
      // A cold root cannot even start the CLI: wait for its dependencies.
      await warmHermes(path, appDir)
      const home = hermesHome(appDir, turn)
      // Provider keys may live in the user's shell (an SSO helper prints the
      // token), which an app opened from Finder doesn't get.
      const env = hermesEnv(appDir, home, { ...process.env, ...(await shellEnv()) })
      yield* runCli({ bin: path, args: hermesArgs({ ...turn, model }, provider), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: hermesParser(), env })
    }
  }
}

// Build the shared dependency environment, once per root. Detection starts it
// early (a warm root makes the first turn quick) and every run waits for it: on
// a cold root the CLI dies on its own imports ("No module named 'ruamel'"),
// which is what a person got testing the harness right after opening the app.
// One promise per root, so turns starting together share a build instead of
// racing over it ("an update is still running"). No model is called, nothing is
// spent; a failed repair is not remembered, so the next run tries again.
const warming = new Map<string, Promise<void>>()

export function warmHermes(bin: string, appDir: string): Promise<void> {
  const running = warming.get(appDir)
  if (running) return running
  const done = new Promise<void>((resolve) => {
    execFile(bin, ['pm', 'repair'], { timeout: 300_000, env: { ...process.env, HERMES_HOME: appDir } }, (err) => {
      if (err) warming.delete(appDir)
      resolve()
    })
  })
  warming.set(appDir, done)
  return done
}
