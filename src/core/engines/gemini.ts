import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

export function geminiParser(): Parser {
  let text = ''
  let usage: { inputTokens: number; cacheReadTokens: number; outputTokens: number } | undefined
  let failed = false
  let error = ''

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      const type = ev['type']
      if (type === 'message' && ev['role'] === 'assistant' && typeof ev['content'] === 'string' && ev['content']) {
        text += ev['content']
        out.push({ type: 'text', delta: ev['content'] })
      } else if (type === 'tool_use' && ev['tool_name'] === GEMINI_WEB) {
        const params = (ev['parameters'] ?? {}) as Record<string, unknown>
        out.push({ type: 'web', action: 'search', detail: String(params['query'] ?? '') })
      } else if (type === 'error' && ev['severity'] === 'error' && typeof ev['message'] === 'string') {
        // A warning isn't fatal; the terminal result decides. Keep the last hard error.
        error = ev['message']
      } else if (type === 'result') {
        const err = ev['error'] as { message?: unknown } | undefined
        if (ev['status'] === 'error' || err) {
          failed = true
          error = (typeof err?.message === 'string' && err.message) || error || L('O Gemini terminou com erro.', 'Gemini ended with an error.')
        } else {
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
      return [{ type: 'error', message: L(`O Gemini saiu sem resposta (código ${code ?? '?'}).`, `Gemini exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// Headless, one shot: the prompt on stdin (big prompts don't fit an argument),
// stream-json out, the model named, and yolo so a tool call never waits on a
// terminal prompt — the gateway is the only tool source and it decides what
// runs, so auto-approving at the CLI is right. The system prompt and the MCP
// server come from the home (geminiHome).
export function geminiArgs(turn: Pick<Turn, 'model'>): string[] {
  return ['-p', '', '--output-format', 'stream-json', '--approval-mode', 'yolo', '-m', turn.model]
}

const userHomeOf = (): string => process.env['GEMINI_CLI_HOME'] || join(homedir(), '.gemini')

// Where the app keeps the Gemini homes, in its data folder.
export const geminiAppDir = (dataDir: string): string => join(dataDir, 'gemini')

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
// servers and its session from the home, so a fresh home per turn keeps a turn
// to its own tools and leaves no session behind. settings.json gives the gateway
// as the only MCP server and turns the built-in tools off; the person's login
// (OAuth credentials, or an env-based key/gateway) is brought in; the agent's
// instructions go to a file the CLI reads as the system prompt. The settings
// nest the way the CLI expects (mcpServers, tools.core/exclude, a quiet UI).
export function geminiHome(appDir: string, turn: Pick<Turn, 'system' | 'mcpUrl' | 'web'>, userHome = userHomeOf()): string {
  mkdirSync(appDir, { recursive: true })
  const home = join(appDir, randomBytes(8).toString('hex'))
  mkdirSync(home, { recursive: true })

  // The person's login stays theirs: link the OAuth credentials and the account
  // marker (an env-based key or company gateway needs nothing here).
  for (const f of ['oauth_creds.json', 'google_accounts.json']) linkOrCopy(join(userHome, f), join(home, f))

  // The agent is Tucano's: its instructions are the system prompt (GEMINI_SYSTEM_MD
  // points the CLI at this file, see geminiEnv).
  writeFileSync(join(home, 'system.md'), turn.system)

  const settings: Record<string, unknown> = {
    // The app's gateway is the only MCP server; its tools reach the model.
    ...(turn.mcpUrl ? { mcpServers: { [GATEWAY_NAME]: { httpUrl: turn.mcpUrl } } } : {}),
    // No built-in tools (shell, files, memory); only web search, and only when
    // the agent has the web. coreTools is the allow-list of built-ins.
    coreTools: turn.web ? [GEMINI_WEB] : [],
    // Nothing of Gemini's own that would run behind the app's back or spend
    // tokens outside the receipts.
    extensions: { disableAll: true },
    experimental: { skills: { enabled: false } },
    privacy: { usageStatisticsEnabled: false },
    ui: { showMemoryUsage: false },
    general: { checkpointing: { enabled: false } }
  }
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings, null, 2))
  return home
}

// The env a gemini turn runs with: its own home, the system prompt file, and no
// context-file discovery (the person's GEMINI.md never leaks into the agent).
export function geminiEnv(home: string, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...base, GEMINI_CLI_HOME: home, GEMINI_SYSTEM_MD: join(home, 'system.md') }
}

// The model is "<provider>/<model>" as the picker lists it; the CLI wants the
// model id alone. The home carries the gateway and the system prompt.
export function geminiEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'gemini',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Gemini não está instalado. Veja em Configurações.', "Gemini isn't installed. See Settings.") }
        return
      }
      const model = turn.model.includes('/') ? turn.model.slice(turn.model.indexOf('/') + 1) : turn.model
      const home = geminiHome(appDir, turn)
      // Provider keys may live in the person's shell (an SSO helper prints the
      // token), which an app opened from Finder doesn't get.
      const env = geminiEnv(home, { ...process.env, ...(await shellEnv()) })
      try {
        yield* runCli({ bin: path, args: geminiArgs({ model }), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: geminiParser(), env })
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

// The model ids Gemini can run. Without a reliable list from the CLI, the known
// current models are offered and the person can also type another by name.
export function geminiModels(): string[] {
  return ['gemini/gemini-2.5-pro', 'gemini/gemini-2.5-flash', 'gemini/gemini-2.5-flash-lite']
}
