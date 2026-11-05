import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import { linkOrCopy } from './gemini'
import type { Engine, EngineEvent, Turn, Usage } from './types'
import { L } from '../../shared/lang'

// GitHub Copilot CLI (`copilot`, @github/copilot). Headless, the prompt comes on
// stdin and `--output-format json` prints one JSON event per line. Each turn
// runs in a folder of its own:
// - a COPILOT_HOME with no person's settings, MCP servers, plugins, skills or
//   sessions in it, and hooks off (disableAllHooks). The login stays the
//   person's: it's in the system's credential store, which COPILOT_HOME doesn't move.
// - a workspace with the agent's instructions as AGENTS.md, which the CLI reads
//   as the repository's instructions.
// The CLI still lists the person's skills from ~/.agents (on Windows even with
// HOME moved), but `--available-tools` leaves out the `skill` tool, so no skill
// can load: the model sees only the gateway's tools (and web_fetch with the web).

// Copilot's JSON events, as the CLI 1.0 prints them: session.* (MCP servers,
// tools, the usage checkpoint), user.message, assistant.turn_start/turn_end per
// model call, assistant.message_delta {messageId, deltaContent} then
// assistant.message {messageId, content, toolRequests} with the whole text,
// assistant.reasoning_delta (the model's thinking, not the answer),
// tool.execution_start {toolCallId, toolName, arguments} and
// tool.execution_complete {toolCallId, success}, and last
// result {exitCode, usage:{premiumRequests, …}}. The stream carries no token
// counts: those come in the file named by --usage-output-file (copilotUsage).
export const COPILOT_WEB = 'web_fetch'

const charsToTokens = (chars: number): number => Math.ceil(chars / 4)

// `usage`: the turn's tokens, read once the CLI is done. `sent`: the characters the
// app sends, to estimate the usage if the CLI didn't write it (doubled, as for
// Cursor: the CLI adds its own prompt).
export function copilotParser(usage: () => Usage | undefined = () => undefined, sent = 0): Parser {
  let text = ''
  const spokenIds = new Set<string>()
  const webUrlByCall = new Map<string, string>()
  let exitCode: number | undefined

  // Text around tool calls comes in separate messages; keep them as paragraphs.
  const say = (id: string, delta: string): EngineEvent => {
    const sep = !spokenIds.has(id) && text ? '\n\n' : ''
    spokenIds.add(id)
    text += sep + delta
    return { type: 'text', delta: sep + delta }
  }

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const data = (ev['data'] ?? {}) as Record<string, unknown>
      const id = String(data['messageId'] ?? '')
      switch (ev['type']) {
        case 'assistant.message_delta':
          return typeof data['deltaContent'] === 'string' && data['deltaContent'] ? [say(id, data['deltaContent'])] : []
        case 'assistant.message':
          // The whole message, only when no deltas came for it (it repeats them).
          return typeof data['content'] === 'string' && data['content'] && !spokenIds.has(id) ? [say(id, data['content'])] : []
        case 'tool.execution_start':
          if (data['toolName'] === COPILOT_WEB) webUrlByCall.set(String(data['toolCallId']), String((data['arguments'] as Record<string, unknown> | undefined)?.['url'] ?? ''))
          return []
        case 'tool.execution_complete': {
          const url = webUrlByCall.get(String(data['toolCallId']))
          return url !== undefined && data['success'] === true ? [{ type: 'web', action: 'fetch', detail: url }] : []
        }
        case 'result':
          exitCode = num(ev['exitCode'])
          return []
        default:
          return []
      }
    },
    end(code, stderr) {
      const detail = lastLines(stderr)
      if (exitCode === undefined) return [{ type: 'error', message: L(`O Copilot saiu sem resposta (código ${code ?? '?'}).`, `Copilot exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
      if (exitCode !== 0) return [{ type: 'error', message: detail || L(`O Copilot terminou com erro (código ${exitCode}).`, `Copilot ended with an error (code ${exitCode}).`) }]
      return [{ type: 'done', text, usage: usage() ?? { inputTokens: charsToTokens(sent) * 2, cacheReadTokens: 0, outputTokens: charsToTokens(text.length) } }]
    }
  }
}

// The tokens of a turn, from --usage-output-file: one entry per model the turn used
// (`--model auto` can use more than one). inputTokens already counts the cache.
export function copilotUsage(file: string): Usage | undefined {
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as { modelMetrics?: Record<string, { usage?: Record<string, unknown> }> }
    const all = Object.values(body.modelMetrics ?? {}).map((m) => m.usage ?? {})
    if (!all.length) return undefined
    const sum = (k: string): number => all.reduce((n, u) => n + num(u[k]), 0)
    return { inputTokens: sum('inputTokens'), cacheReadTokens: sum('cacheReadTokens'), outputTokens: sum('outputTokens') }
  } catch {
    return undefined
  }
}

// Every tool is allowed without asking: the only ones are the gateway's (it
// decides what runs) and, with the web, web_fetch. The tool list is never empty: an empty --available-tools gives the model all
// of Copilot's own tools, shell and files included. With no gateway the name
// matches nothing, and no tool is left.
// No auto-update: the turn's home is new each time, so it would download the
// CLI again; the installed version runs.
export function copilotArgs(turn: Pick<Turn, 'model' | 'effort' | 'web' | 'images'>, files: { mcpConfig?: string; usage: string }, effort = true): string[] {
  return [
    '--output-format', 'json',
    '--allow-all-tools',
    `--available-tools=${[GATEWAY_NAME, ...(turn.web ? [COPILOT_WEB] : [])].join(',')}`,
    '--disable-builtin-mcps',
    '--no-ask-user',
    '--disable-client-telemetry',
    '--no-auto-update',
    '--model', turn.model,
    ...(effort ? ['--reasoning-effort', turn.effort] : []),
    ...(turn.web ? ['--allow-all-urls'] : []),
    ...(files.mcpConfig ? ['--additional-mcp-config', `@${files.mcpConfig}`] : []),
    ...(turn.images ?? []).filter((i) => existsSync(i.path)).flatMap((i) => ['--attachment', i.path]),
    '--usage-output-file', files.usage
  ]
}

// Some models take no reasoning effort and the CLI refuses the turn before
// anything else: then it runs again without one.
export const effortRefused = (message: string): boolean => /does not support reasoning effort/i.test(message)

export const copilotAppDir = (dataDir: string): string => join(dataDir, 'copilot')

// The person's Copilot home, where the CLI keeps the login when the system has no
// credential store.
const userHomeOf = (): string => process.env['COPILOT_HOME'] || join(homedir(), '.copilot')

export interface CopilotTurnDirs {
  root: string
  home: string
  workspace: string
  mcpConfig?: string
  usage: string
}

// A folder for one turn. settings.json turns the hooks off (the person's and any
// repository's: a hook is a command the CLI runs around the turn) and keeps the
// CLI away from an open editor. config.json is linked in from the person's home:
// without a credential store (a Linux box with no keyring) the login is there.
export function copilotTurnDirs(appDir: string, turn: Pick<Turn, 'system' | 'mcpUrl'>, userHome = userHomeOf()): CopilotTurnDirs {
  const root = join(appDir, randomBytes(8).toString('hex'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ disableAllHooks: true, ide: { autoConnect: false } }, null, 2))
  linkOrCopy(join(userHome, 'config.json'), join(home, 'config.json'))
  writeFileSync(join(workspace, 'AGENTS.md'), turn.system)
  const mcpConfig = turn.mcpUrl ? join(root, 'mcp.json') : undefined
  if (mcpConfig) writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [GATEWAY_NAME]: { type: 'http', url: turn.mcpUrl, tools: ['*'] } } }, null, 2))
  return { root, home, workspace, mcpConfig, usage: join(root, 'usage.json') }
}

// The env a turn runs with: its own home, and none of the person's variables that
// would change what the turn is: more instruction folders (their instructions
// would reach the agent), the assisted-approval judge (it overrides
// --allow-all-tools and could refuse the gateway's tools) and COPILOT_ALLOW_ALL
// (exactly "true" trusts the folder). A provider of their own (COPILOT_PROVIDER_*)
// or a GitHub host stays: that's their setup.
export function copilotEnv(home: string, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, COPILOT_HOME: home }
  for (const k of ['COPILOT_CUSTOM_INSTRUCTIONS_DIRS', 'COPILOT_ASSISTED_APPROVAL', 'COPILOT_ALLOW_ALL']) delete env[k]
  return env
}

export function copilotEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'copilot',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O GitHub Copilot CLI não está instalado. Veja em Configurações.', "GitHub Copilot CLI isn't installed. See Settings.") }
        return
      }
      const dirs = copilotTurnDirs(appDir, turn)
      // A token (COPILOT_GITHUB_TOKEN, GH_TOKEN) may live in the person's shell, which an app opened from Finder doesn't get.
      const env = copilotEnv(dirs.home, { ...process.env, ...(await shellEnv()) })
      const sent = turn.system.length + turn.prompt.length
      const run = (effort: boolean): AsyncIterable<EngineEvent> =>
        runCli({ bin: path, args: copilotArgs(turn, dirs, effort), stdin: turn.prompt, cwd: dirs.workspace, signal: turn.signal, parser: copilotParser(() => copilotUsage(dirs.usage), sent), env })
      try {
        let said = false
        let refused = false
        for await (const ev of run(true)) {
          if (!said && ev.type === 'error' && effortRefused(ev.message)) {
            refused = true
            break
          }
          said = said || ev.type === 'text'
          yield ev
        }
        if (refused && !turn.signal.aborted) yield* run(false)
      } finally {
        try {
          rmSync(dirs.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          // On Windows the CLI that just exited may still hold a file for a moment;
          // a folder left behind must not turn a finished reply into an error.
        }
      }
    }
  }
}

// The models the CLI can run, as `copilot help config` lists them under `model`
// (offline; what the person's plan allows of them shows when a turn runs).
export function parseCopilotModels(help: string): string[] {
  const lines = help.split(/\r?\n/)
  const at = lines.findIndex((l) => /^\s*`model`:/.test(l))
  if (at < 0) return []
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    const m = /^\s*-\s*"([\w.:-]+)"\s*$/.exec(l)
    if (!m) break
    out.push(m[1]!)
  }
  return out
}
