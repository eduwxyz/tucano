import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn, TurnImage, Usage } from './types'
import { L } from '../../shared/lang'

// Grok Build, the `grok` CLI, on the grok.com subscription (~/.grok/auth.json),
// not an xAI API key. Headless (`--prompt-file --output-format streaming-json`)
// prints one JSON event per line and exits. Each turn gets a home of its own in
// the temp folder, as GROK_HOME and HOME: Grok walks upward from the working
// directory to a git checkout and would otherwise load that project's rules,
// and from HOME it loads the plugins, skills and hooks installed for Claude
// Code (~/.claude), whatever the compat switches say. The login stays the
// person's, named with GROK_AUTH_PATH, and is never copied. An API key in the
// environment is dropped when that login exists: Grok would bill the key
// instead of the subscription.

// streaming-json (grok 1.0.70): text {data}; thought (skipped); tool_call and
// tool_call_update {toolCallId, toolName, status, rawInput, rawOutput}; usage
// {usage}, one per model call; end {stopReason, usage, total_cost_usd}, the
// whole turn; error {message}. `input_tokens` on these events leaves the cache
// out. A web search says its query only when it completes, in rawOutput.

const charsToTokens = (chars: number): number => Math.ceil(chars / 4)

// Built-in tools a turn takes away. search_tool and use_tool stay: they are how
// Grok finds and calls the gateway. Web search and fetch stay only with the web.
const GROK_REMOVED = [
  'read_file', 'hashline_read', 'search_replace', 'hashline_edit', 'write', 'StrReplace', 'Delete',
  'run_terminal_command', 'run_terminal_cmd', 'list_dir', 'grep', 'hashline_grep', 'Glob',
  'kill_command_or_subagent', 'kill_task', 'todo_write', 'TodoWrite',
  'get_command_or_subagent_output', 'get_task_output', 'wait_tasks',
  'spawn_subagent', 'task', 'Agent', 'workflow', 'monitor', 'lsp',
  'scheduler_create', 'scheduler_delete', 'scheduler_list',
  'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'GenerateImage', 'GenerateVideo',
  'web_search', 'web_fetch', 'WebSearch', 'WebFetch', 'XSearch'
]

const WEB_TOOLS = ['web_search', 'web_fetch']

export function grokParser(sent = 0): Parser {
  let text = ''
  let finished = false
  const pending = new Map<string, { action: 'search' | 'fetch'; detail: string }>()
  const reported = new Set<string>()
  // The turn so far: each usage event is one model call.
  let tokens = 0
  let cacheRead = 0

  const usageOf = (raw: unknown, costFrom?: unknown): Usage | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    const u = raw as Record<string, unknown>
    const told = 'input_tokens' in u || 'output_tokens' in u || 'inputTokens' in u || 'outputTokens' in u
    if (!told) return undefined
    const cacheRead = num(u['cache_read_input_tokens'] ?? u['cacheReadInputTokens'])
    const cacheWrite = num(u['cache_creation_input_tokens'] ?? u['cacheCreationInputTokens'])
    const cost = typeof costFrom === 'number' ? costFrom : u['total_cost_usd']
    return {
      inputTokens: num(u['input_tokens'] ?? u['inputTokens']) + cacheRead + cacheWrite,
      cacheReadTokens: cacheRead,
      outputTokens: num(u['output_tokens'] ?? u['outputTokens']),
      ...(typeof cost === 'number' ? { apiCostUsd: cost } : {})
    }
  }

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev || finished) return []
      const out: EngineEvent[] = []
      const type = ev['type']
      if (type === 'text' && typeof ev['data'] === 'string' && ev['data']) {
        text += ev['data']
        out.push({ type: 'text', delta: ev['data'] })
      } else if (type === 'tool_call' || type === 'tool_call_update') {
        const id = typeof ev['toolCallId'] === 'string' ? ev['toolCallId'] : ''
        const found = webCall(ev)
        if (id && found) pending.set(id, found)
        const item = (id && pending.get(id)) || found
        if (item && !item.detail) item.detail = searchQuery(ev)
        if (item && ev['status'] === 'completed' && !reported.has(id || item.detail)) {
          reported.add(id || item.detail)
          out.push({ type: 'web', action: item.action, detail: item.detail })
        }
      } else if (type === 'usage') {
        const u = usageOf(ev['usage'])
        if (u) {
          tokens += u.inputTokens + u.outputTokens
          cacheRead += u.cacheReadTokens
          out.push({ type: 'progress', tokens, cacheRead })
        }
      } else if (type === 'error') {
        finished = true
        out.push({ type: 'error', message: typeof ev['message'] === 'string' && ev['message'] ? ev['message'] : L('O Grok terminou com erro.', 'Grok ended with an error.') })
      } else if (type === 'end') {
        finished = true
        const stop = String(ev['stopReason'] ?? '')
        if ((stop === 'refusal' || stop === 'cancelled') && !text) {
          out.push({ type: 'error', message: L(`O Grok parou (${stop}).`, `Grok stopped (${stop}).`) })
          return out
        }
        if (typeof ev['text'] === 'string' && ev['text'] && !text) text = ev['text']
        const u = usageOf(ev['usage'], ev['total_cost_usd']) ?? { inputTokens: charsToTokens(sent), cacheReadTokens: 0, outputTokens: charsToTokens(text.length) }
        out.push({ type: 'progress', tokens: u.inputTokens + u.outputTokens, cacheRead: u.cacheReadTokens })
        out.push({ type: 'done', text, usage: u })
      }
      return out
    },
    end(code, stderr) {
      if (finished) return []
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Grok saiu sem resposta (código ${code ?? '?'}).`, `Grok exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// A web search or page read the CLI did itself. Refused calls never reach status completed.
function webCall(ev: Record<string, unknown>): { action: 'search' | 'fetch'; detail: string } | undefined {
  const name = String(ev['toolName'] ?? ev['title'] ?? '')
  const args = (ev['rawInput'] ?? {}) as Record<string, unknown>
  if (/web.?search|^xsearch$/i.test(name)) return { action: 'search', detail: String(args['query'] ?? args['search_term'] ?? args['q'] ?? '') }
  if (/web.?fetch/i.test(name)) return { action: 'fetch', detail: String(args['url'] ?? '') }
  return undefined
}

function searchQuery(ev: Record<string, unknown>): string {
  const out = ev['rawOutput'] as { action?: { query?: unknown } } | null | undefined
  return typeof out?.action?.query === 'string' ? out.action.query : ''
}

// Grok reaches MCP tools through search_tool and use_tool, by their full name; a
// bare name fails and costs the agent a try.
const gatewayNote = (): string =>
  L(
    `As ferramentas do Tucano estão no servidor MCP \`${GATEWAY_NAME}\`. Chame com use_tool pelo nome completo, \`${GATEWAY_NAME}__<nome>\` (por exemplo \`${GATEWAY_NAME}__lembrar\`); search_tool lista as que existem.`,
    `Tucano's tools are on the \`${GATEWAY_NAME}\` MCP server. Call them with use_tool by their full name, \`${GATEWAY_NAME}__<name>\` (for example \`${GATEWAY_NAME}__lembrar\`); search_tool lists the ones there are.`
  )

// Headless, one shot. The prompt is a file: Grok does not read the prompt from
// stdin, and a .json file is ACP content blocks, which is how images go along.
// No -p beside --prompt-file (the two are alternatives, and -p wins).
// bypassPermissions so the gateway's tools don't wait on a prompt a headless
// run can't answer; deny rules still block Grok's own shell and files, and
// --disallowed-tools takes those tools off the list. The leader socket is the
// turn's, so this run doesn't attach to the person's grok and stop it on exit.
export function grokArgs(turn: Pick<Turn, 'model' | 'effort' | 'system' | 'web' | 'mcpUrl'>, promptFile: string, socket: string): string[] {
  const model = turn.model.includes(':') ? turn.model.slice(turn.model.indexOf(':') + 1) : turn.model.includes('/') ? turn.model.slice(turn.model.indexOf('/') + 1) : turn.model
  const web = !!turn.web
  // With the web, Grok's own search and page reading stay; X search does not.
  const webTool = (name: string): boolean => WEB_TOOLS.includes(name) || name === 'WebSearch' || name === 'WebFetch'
  const removed = GROK_REMOVED.filter((name) => !web || !webTool(name))
  return [
    '--no-auto-update',
    '--no-wait-for-background',
    '--output-format', 'streaming-json',
    '--model', model,
    '--reasoning-effort', turn.effort,
    '--system-prompt-override', turn.mcpUrl ? `${turn.system}\n\n${gatewayNote()}` : turn.system,
    '--permission-mode', 'bypassPermissions',
    '--no-subagents',
    '--no-plan',
    ...(web ? [] : ['--disable-web-search']),
    '--tools', ['search_tool', 'use_tool', ...(web ? WEB_TOOLS : [])].join(','),
    '--disallowed-tools', removed.join(','),
    '--deny', 'Bash',
    '--deny', 'Read',
    '--deny', 'Write',
    '--deny', 'Edit',
    '--deny', 'Grep',
    ...(web ? [] : ['--deny', 'WebFetch']),
    '--leader-socket', socket,
    '--prompt-file', promptFile
  ]
}

// The prompt file's contents. Images are ACP blocks after the text; without
// them the file is plain text (a .json file would be parsed as blocks).
export function grokPrompt(turn: Pick<Turn, 'prompt' | 'images'>): { name: string; body: string } {
  const images = (turn.images ?? []).filter((img) => existsSync(img.path))
  if (!images.length) return { name: 'prompt.txt', body: turn.prompt }
  const blocks: Record<string, unknown>[] = []
  if (turn.prompt.trim()) blocks.push({ type: 'text', text: turn.prompt })
  for (const img of images) blocks.push(imageBlock(img))
  return { name: 'prompt.json', body: JSON.stringify(blocks) }
}

function imageBlock(img: TurnImage): Record<string, unknown> {
  return { type: 'image', mimeType: img.mime, data: readFileSync(img.path).toString('base64') }
}

const tomlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// The turn's config: the gateway is the only MCP server, and the scans that
// would pull in the person's Claude, Cursor and Codex setup stay off. Env vars
// say the same thing and outrank this file (see grokTurnEnv).
export function grokConfig(turn: Pick<Turn, 'mcpUrl'>): string {
  const mcp = turn.mcpUrl
    ? `[mcp_servers.${GATEWAY_NAME}]\nurl = ${tomlString(turn.mcpUrl)}\nenabled = true\n\n`
    : ''
  return (
    mcp +
    ['[memory]', 'enabled = false', '', '[memory_v2]', 'enabled = false', '', '[workflows]', 'enabled = false', '', '[compat.claude]', 'agents = false', 'hooks = false', 'mcps = false', 'rules = false', 'skills = false', '', '[compat.cursor]', 'agents = false', 'hooks = false', 'mcps = false', 'rules = false', 'skills = false', '', '[compat.codex]', 'hooks = false', 'skills = false', ''].join('\n')
  )
}

// Where the person signed in. Their GROK_HOME, or ~/.grok. Read before a turn
// replaces GROK_HOME with its own.
export function userGrokHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const set = env['GROK_HOME']?.trim()
  return set || join(home, '.grok')
}

const OFF = {
  GROK_MEMORY: '0',
  GROK_WORKFLOWS: '0',
  GROK_DISABLE_AUTOUPDATER: '1',
  GROK_MANAGED_MCPS_ENABLED: 'false',
  GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: 'false',
  GROK_CLAUDE_AGENTS_ENABLED: 'false',
  GROK_CLAUDE_HOOKS_ENABLED: 'false',
  GROK_CLAUDE_MCPS_ENABLED: 'false',
  GROK_CLAUDE_RULES_ENABLED: 'false',
  GROK_CLAUDE_SKILLS_ENABLED: 'false',
  GROK_CURSOR_AGENTS_ENABLED: 'false',
  GROK_CURSOR_HOOKS_ENABLED: 'false',
  GROK_CURSOR_MCPS_ENABLED: 'false',
  GROK_CURSOR_RULES_ENABLED: 'false',
  GROK_CURSOR_SKILLS_ENABLED: 'false'
} as const

// authFile set: the subscription login, and the API key is removed so it can't
// replace that login. Unset: an API key in the environment is the only way in.
// HOME is the turn's too, so nothing installed for Claude Code loads.
export function grokTurnEnv(base: NodeJS.ProcessEnv, home: string, authFile?: string, os: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...OFF, GROK_HOME: home, HOME: home, ...(os === 'win32' ? { USERPROFILE: home } : {}) }
  delete env['GROK_CONFIG']
  delete env['GROK_CONFIG_PATH']
  delete env['GROK_AGENT']
  if (authFile) {
    env['GROK_AUTH_PATH'] = authFile
    delete env['XAI_API_KEY']
    delete env['GROK_CODE_XAI_API_KEY']
  }
  return env
}

export interface GrokTurnDirs {
  root: string
  work: string
  socket: string
}

// A folder for one turn, outside any checkout. The socket path has to stay
// short enough for a Unix socket; a long temp path gets a socket beside it.
export function grokTurnDirs(): GrokTurnDirs {
  const root = join(tmpdir(), `tucano-grok-${randomBytes(8).toString('hex')}`)
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const inside = join(root, 'leader.sock')
  const socket = inside.length <= 100 ? inside : join(tmpdir(), `tg-${randomBytes(4).toString('hex')}.sock`)
  return { root, work, socket }
}

export function grokCleanup(dirs: GrokTurnDirs): void {
  for (const p of [dirs.root, dirs.socket])
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // a rare leftover is a small dead folder; harmless
    }
}

// `grok models` prints "You are logged in with grok.com.", "You are using
// XAI_API_KEY." or "You are not authenticated.", then a line per model,
// "* grok-4.7 (default)" or "- grok-4.6", listed even when signed out.
export function parseGrokModels(out: string): string[] {
  const ids: string[] = []
  for (const line of out.split('\n')) {
    const id = /^\s*[*+-]\s+([A-Za-z0-9][\w.-]*)/.exec(line)?.[1]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export function grokLogin(out: string): { loggedIn: boolean; plan: boolean } {
  if (/not signed in|not logged in|not authenticated/i.test(out)) return { loggedIn: false, plan: false }
  const plan = /logged in with grok\.com/i.test(out)
  const models = parseGrokModels(out)
  return { loggedIn: plan || (models.length > 0 && /logged in|api[ _]key/i.test(out)), plan }
}

export function grokEngine(bin: () => string | undefined, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'grok',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Grok não está instalado. Veja em Configurações.', "Grok isn't installed. See Settings.") }
        return
      }
      const dirs = grokTurnDirs()
      const prompt = grokPrompt(turn)
      writeFileSync(join(dirs.root, prompt.name), prompt.body)
      writeFileSync(join(dirs.root, 'config.toml'), grokConfig(turn))
      // The shell may hold an API key the app, opened from Finder, doesn't.
      const shell = await shellEnv()
      const auth = join(userGrokHome({ ...process.env, ...shell }), 'auth.json')
      const env = grokTurnEnv({ ...process.env, ...shell }, dirs.root, existsSync(auth) ? auth : undefined)
      try {
        const sent = turn.system.length + turn.prompt.length
        yield* runCli({
          bin: path,
          args: grokArgs(turn, join(dirs.root, prompt.name), dirs.socket),
          stdin: '',
          cwd: dirs.work,
          signal: turn.signal,
          parser: grokParser(sent),
          env,
          sandbox: turn.sandbox
        })
      } finally {
        grokCleanup(dirs)
      }
    }
  }
}
