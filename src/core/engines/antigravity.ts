import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn } from './types'
import { L } from '../../shared/lang'

// Gemini is Google's agent CLI. In headless mode (`-p`, `-o stream-json`) it
// prints one JSON event per line and exits. The app runs each turn in a home of
// its own (GEMINI_CLI_HOME), with a settings.json whose only MCP server is the
// app's gateway and whose built-in tools are off, a system prompt in a file
// (GEMINI_SYSTEM_MD), and the person's own login brought in. Its tools are what
// the agent gets; the gateway decides what runs.

// Gemini's stream-json events (one per line, extracted from the CLI's own
// writer): init {session_id, model}; message {role, content, delta} where the
// answer is the concatenation of the assistant deltas (the result carries no
// whole text); tool_use {tool_name, tool_id, parameters}; tool_result; error
// {severity, message}; result {status, error?, stats:{input_tokens, cached,
// output_tokens, …}} — the terminal event.
const GEMINI_WEB = 'google_web_search' // Gemini's own, kept only when the agent has the web

export function antigravityParser(): Parser {
  let text = ''
  let usage: { inputTokens: number; cacheReadTokens: number; outputTokens: number } | undefined
  let failed = false
  let error = ''

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      const event = ev['event']
      if (event === 'step_update') {
        const step = (ev['step_update'] ?? {}) as Record<string, unknown>
        if (step['step_type'] === 'agent_response' && typeof step['text_delta'] === 'string' && step['text_delta']) {
          text += step['text_delta']
          out.push({ type: 'text', delta: step['text_delta'] })
        } else if (step['step_type'] === 'tool' && (step['tool_name'] === GEMINI_WEB || step['tool_name'] === 'search_web')) {
          const info = (step['tool_info'] ?? {}) as Record<string, unknown>
          const params = (info['parameters'] ?? {}) as Record<string, unknown>
          out.push({ type: 'web', action: 'search', detail: String(params['query'] ?? params['Query'] ?? '') })
        }
      } else if (event === 'result') {
        const result = (ev['result'] ?? {}) as Record<string, unknown>
        const status = String(result['status'] ?? '').toUpperCase()
        if (status === 'ERROR') {
          failed = true
          error = (typeof result['error'] === 'string' && result['error']) || error || L('O Antigravity terminou com erro.', 'Antigravity ended with an error.')
        } else if (status === 'SUCCESS') {
          if (typeof result['response'] === 'string' && result['response'] && !text) text = result['response']
          const u = (result['usage'] ?? {}) as Record<string, unknown>
          usage = { inputTokens: num(u['input_tokens']), cacheReadTokens: num(u['cache_read_tokens']), outputTokens: num(u['output_tokens']) }
        }
      }
      const type = ev['type']
      if (type === 'message' && ev['role'] === 'assistant' && typeof ev['content'] === 'string' && ev['content']) {
        text += ev['content']
        out.push({ type: 'text', delta: ev['content'] })
      } else if (type === 'tool_use' && ev['tool_name'] === GEMINI_WEB) {
        const params = (ev['parameters'] ?? {}) as Record<string, unknown>
        out.push({ type: 'web', action: 'search', detail: String(params['query'] ?? '') })
      } else if (type === 'error' && ev['severity'] === 'error' && typeof ev['message'] === 'string') {
        error = ev['message']
      } else if (type === 'result') {
        const err = ev['error'] as { message?: unknown } | undefined
        if (ev['status'] === 'error' || err) {
          failed = true
          error = (typeof err?.message === 'string' && err.message) || error || L('O Antigravity terminou com erro.', 'Antigravity ended with an error.')
        } else if (!usage) {
          const s = (ev['stats'] ?? {}) as Record<string, unknown>
          usage = { inputTokens: num(s['input_tokens']), cacheReadTokens: num(s['cached']), outputTokens: num(s['output_tokens']) }
        }
      }
      return out
    },
    end(code, stderr) {
      if (failed) return [{ type: 'error', message: error }]
      if (usage) return [{ type: 'done', text, usage }]
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Antigravity saiu sem resposta (código ${code ?? '?'}).`, `Antigravity exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// Headless: Antigravity 1.5+ print mode takes the user turn on stdin as one
// stream-json line (`event: user`). Piping plain text with `-p=-` does not attach
// it to the conversation — the model only sees the default greeting.
export function antigravityArgs(turn: Pick<Turn, 'model'>): string[] {
  return ['--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions', '--model', turn.model]
}

export function antigravityInput(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`
}

// Person login lives under ~/.gemini or %LOCALAPPDATA%\agy (Antigravity install).
function antigravityUserGeminiDir(): string {
  const candidates = [join(homedir(), '.gemini')]
  if (process.env['LOCALAPPDATA']) {
    candidates.push(join(process.env['LOCALAPPDATA'], 'agy', '.gemini'))
    candidates.push(join(process.env['LOCALAPPDATA'], 'agy'))
  }
  for (const c of candidates) {
    if (existsSync(join(c, 'oauth_creds.json')) || existsSync(join(c, 'google_accounts.json'))) return c
  }
  return candidates[0]!
}

// Where the app keeps the Gemini homes, in its data folder.
export const antigravityAppDir = (dataDir: string): string => join(dataDir, 'antigravity')

// A link where one is possible (the login must stay the person's), a plain copy
// where the platform refuses links (Windows without privileges).
function linkOrCopy(target: string, at: string): void {
  if (!existsSync(target) || existsSync(at)) return
  try {
    symlinkSync(target, at)
  } catch {
    try {
      copyFileSync(target, at)
    } catch {
      // neither: the CLI starts without it
    }
  }
}

// A home for one turn. Gemini reads settings, context files (GEMINI.md), its MCP
// servers and its session from the home (under .gemini/), so a fresh home per turn
// keeps a turn to its own tools and leaves no session behind. settings.json gives the gateway
// as the only MCP server and turns the built-in tools off; the person's login
// (OAuth credentials, or an env-based key/gateway) is brought in; the agent's
// instructions go to a file the CLI reads as the system prompt.
export function antigravityHome(appDir: string, turn: Pick<Turn, 'system' | 'mcpUrl' | 'web'>, userHome = antigravityUserGeminiDir()): string {
  mkdirSync(appDir, { recursive: true })
  const home = join(appDir, randomBytes(8).toString('hex'))
  const dot = join(home, '.gemini')
  mkdirSync(dot, { recursive: true })

  // The person's login stays theirs: link the OAuth credentials and the account
  // marker into .gemini/, where the CLI looks (an env-based key or company
  // gateway needs nothing here).
  for (const f of ['oauth_creds.json', 'google_accounts.json']) linkOrCopy(join(userHome, f), join(dot, f))

  // The agent is Tucano's: its instructions are the system prompt (GEMINI_SYSTEM_MD
  // points the CLI at this file, see geminiEnv).
  writeFileSync(join(home, 'system.md'), turn.system)

  // Keys as Gemini CLI 0.28 reads them (older flat keys like coreTools are ignored).
  const settings: Record<string, unknown> = {
    // The app's gateway is the only MCP server; its tools reach the model.
    ...(turn.mcpUrl ? { mcpServers: { [GATEWAY_NAME]: { url: turn.mcpUrl, type: 'http', trust: true } } } : {}),
    // ...and the only one allowed: a server declared anywhere else never starts.
    mcp: { allowed: [GATEWAY_NAME] },
    // No built-in tools (shell, files, memory); only web search, and only when
    // the agent has the web. tools.core is the allow-list of built-ins; no
    // discovery or call command, so no tools come from running a command.
    tools: { core: turn.web ? [GEMINI_WEB] : [], discoveryCommand: '', callCommand: '' },
    // No hooks: a hook is a command the CLI runs around each turn.
    hooksConfig: { enabled: false },
    // Nothing of Gemini's own that would run behind the app's back or spend
    // tokens outside the receipts: no skills, no built-in subagents. Extensions
    // load from the home, which is fresh, so there are none.
    skills: { enabled: false },
    agents: { overrides: { codebase_investigator: { enabled: false }, cli_help: { enabled: false } } },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false, logPrompts: false },
    ui: { showMemoryUsage: false },
    general: { checkpointing: { enabled: false } }
  }
  writeFileSync(join(dot, 'settings.json'), JSON.stringify(settings, null, 2))
  return home
}

// The env a gemini turn runs with: its own home, the system prompt file, and no
// context-file discovery (the person's GEMINI.md never leaks into the agent).
// The turn's settings are also the system settings: Gemini applies those last,
// over a .gemini/settings.json in the working folder (headless, the CLI trusts
// any folder). That only holds for the keys we set: built-in tools, MCP servers,
// skills, subagents, tool discovery, hooks and telemetry. A key a newer CLI adds
// is the folder's until it's set here too.
export function antigravityEnv(home: string, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...base, GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, '.gemini', 'settings.json'), GEMINI_SYSTEM_MD: join(home, 'system.md') }
}

// The model is "<provider>/<model>" as the picker lists it; the CLI wants the
// model id alone. The home carries the gateway and the system prompt.
export function antigravityEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'antigravity',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Antigravity não está instalado. Veja em Configurações.', "Antigravity isn't installed. See Settings.") }
        return
      }
      const model = resolveAntigravityCliModel(turn.model, path)
      const home = antigravityHome(appDir, turn)
      // Provider keys may live in the person's shell (an SSO helper prints the
      // token), which an app opened from Finder doesn't get.
      const env = antigravityEnv(home, { ...process.env, ...(await shellEnv()) })
      try {
        yield* runCli({ bin: path, args: antigravityArgs({ model }), stdin: antigravityInput(turn.prompt), cwd: turn.cwd, signal: turn.signal, parser: antigravityParser(), env })
      } finally {
        // The turn's throwaway home goes; the login is a link, so only this
        // turn's settings, system prompt and session are dropped.
        try {
          rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          // a rare leftover is a tiny dead folder; harmless
        }
      }
    }
  }
}

// Dynamically lists model ids from `agy models` (native Antigravity CLI) or,
// for npm shims, from the @google/gemini-cli bundle.
const LEGACY_ANTIGRAVITY_MODELS: Record<string, string> = {
  'gemini-2.5-flash': 'gemini-3.8-flash-medium',
  'gemini-2.5-flash-lite': 'gemini-3.8-flash-low',
  'gemini-2.5-pro': 'gemini-4-argon-medium',
  'gemini-3.8-flash': 'gemini-3.8-flash-medium',
  'gemini-3-flash-preview': 'gemini-3.8-flash-medium',
  'gemini-3.1-pro-preview': 'gemini-4-argon-medium'
}

let cachedCliModels: { bin: string; ids: string[] } | undefined

function parseAgyModelsOutput(text: string): string[] {
  const ids: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('Fetching')) continue
    const id = line.split(/\t/)[0]?.trim()
    if (id && /^[a-z0-9.-]+$/i.test(id)) ids.push(id)
  }
  return ids
}

function antigravityCliModelIds(binPath: string): string[] {
  if (cachedCliModels?.bin === binPath) return cachedCliModels.ids
  try {
    const out = execFileSync(binPath, ['models'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    const ids = parseAgyModelsOutput(out)
    if (ids.length > 0) {
      cachedCliModels = { bin: binPath, ids }
      return ids
    }
  } catch {
    // fall through to bundle scrape
  }
  cachedCliModels = { bin: binPath, ids: [] }
  return []
}

/** Picks an id the installed `agy` accepts from a Tucano model string. */
export function resolveAntigravityCliModel(model: string, binPath?: string): string {
  const id = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
  const available = binPath ? antigravityCliModelIds(binPath) : []
  if (available.includes(id)) return id
  const mapped = LEGACY_ANTIGRAVITY_MODELS[id]
  if (mapped && available.includes(mapped)) return mapped
  if (available.length > 0) {
    const hint = id.includes('pro') || id.includes('argon') ? 'gemini-4-argon-medium' : 'gemini-3.8-flash-medium'
    if (available.includes(hint)) return hint
    return available[0]!
  }
  return mapped ?? id
}

export function detectAntigravityCliModels(binPath?: string): string[] {
  if (binPath) {
    const fromCli = antigravityCliModelIds(binPath)
    if (fromCli.length > 0) return fromCli.map((m) => `antigravity/${m}`)
  }
  if (!binPath) return []
  try {
    const real = realpathSync(binPath)
    const markers = [join('@google', 'antigravity-cli'), join('@google', 'gemini-cli')]
    let pkgDir: string | undefined
    for (const marker of markers) {
      const idx = real.indexOf(marker)
      if (idx !== -1) {
        pkgDir = real.slice(0, idx + marker.length)
        break
      }
      const alt = join(dirname(real), 'node_modules', marker)
      if (existsSync(alt)) {
        pkgDir = alt
        break
      }
    }
    if (!pkgDir) return []
    const bundleDir = join(pkgDir, 'bundle')
    if (!existsSync(bundleDir)) return []
    for (const file of readdirSync(bundleDir)) {
      if (!file.endsWith('.js') || !file.startsWith('chunk-')) continue
      const content = readFileSync(join(bundleDir, file), 'utf8')
      if (!content.includes('isVisible')) continue
      const regex = /"([a-z0-9.-]+)"\s*:\s*\{[^}]*isVisible\s*:\s*true/g
      let match: RegExpExecArray | null
      const found: string[] = []
      while ((match = regex.exec(content)) !== null) {
        if (match[1]) found.push(match[1])
      }
      if (found.length > 0) return [...new Set(found)].map((m) => `antigravity/${m}`)
    }
  } catch {
    // not resolvable or readable: use default models
  }
  return []
}

// The model ids Gemini can run. Dynamically discovered from the installed
// @google/gemini-cli package when present, falling back to known models.
export function antigravityModels(binPath?: string): string[] {
  const dynamic = detectAntigravityCliModels(binPath)
  if (dynamic.length > 0) return dynamic
  return [
    'antigravity/gemini-4-argon-medium',
    'antigravity/gemini-4-argon-high',
    'antigravity/gemini-4-argon-low',
    'antigravity/gemini-3.8-flash-medium',
    'antigravity/gemini-3.8-flash-high',
    'antigravity/gemini-3.8-flash-low',
    'antigravity/claude-sonnet-5-5-medium',
    'antigravity/claude-opus-5-5-medium'
  ]
}
