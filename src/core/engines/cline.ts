import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn, Usage } from './types'
import { osOf } from '../platform'
import type { Os } from '../../shared/types'
import { L } from '../../shared/lang'

// Cline's CLI (`cline`, npm package `cline`). With `--json` and a prompt it runs one task
// headless, prints one JSON object per line and exits; what stdin holds, when it's a file or
// a FIFO, is added to the prompt, so the conversation goes there (a file) and the argument is
// only a lead-in.
//
// The login is Tucano's own, as with Codex: `cline auth`, run with CLINE_DIR set to a folder
// in the app's data (clineLoginDir). A run saves the provider and model it used back into
// that login's providers.json, so the person's own Cline (~/.cline) is never pointed at, and
// never switched to an agent's model. A turn reads that file with CLINE_PROVIDER_SETTINGS_PATH.
//
// Everything else is the turn's: a folder of its own as HOME and CLINE_DIR, so the person's
// rules, skills, workflows, hooks, plugins and MCP servers (in ~/.cline, ~/Documents/Cline
// and ~/.agents) don't load, with:
// - global-settings.json that turns off every built-in tool (files, shell, editor, skills,
//   subagents, teams, questions), and the web ones unless the agent has the web; telemetry
//   and auto-update off. A tool turned off there isn't offered to the model at all.
// - cline_mcp_settings.json with the gateway as the only MCP server. Its tools run without
//   asking (--auto-approve true): the gateway decides.
// - an empty working folder; the agent's instructions go in as the system prompt (-s).
// CLINE_SESSION_BACKEND_MODE=local keeps the run in its own process, off the hub daemon
// the person's Cline may have running. The folder goes when the turn ends.
// Checked with cline 3.0.74 against a stand-in model and gateway: the model was offered
// only the gateway's tools, called one, and the reply came back.

// --json lines (cline 3.0.74, docs.cline.bot/cli/cli-reference#json-output-for-agent-runs):
// agent_event {event:{type}}: content_start {contentType: text, text (the delta),
// accumulated} | {contentType: tool, toolName, input}; content_end {contentType: tool,
// toolName, output, error?}; usage {inputTokens, outputTokens, cacheReadTokens,
// totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCost} once per model
// call; error {error:{message}}. run_result {finishReason: completed|error|aborted|…,
// usage:{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost}, text}
// is the last one. Errors also go to stderr as {"type":"error","message"}. inputTokens
// counts the cache reads in. `text` on run_result is only the last model call's.

// The built-in tools a turn turns off (by the names the model sees). The web ones stay
// only with the web: fetch_web_content, and web_search where the provider has it.
const TEAM_TOOLS = [
  'team_spawn_teammate', 'team_shutdown_teammate', 'team_status', 'team_task', 'team_run_task', 'team_cancel_run',
  'team_list_runs', 'team_await_runs', 'team_send_message', 'team_broadcast', 'team_read_mailbox', 'team_mission_log',
  'team_cleanup', 'team_create_outcome', 'team_attach_outcome_fragment', 'team_review_outcome_fragment',
  'team_finalize_outcome', 'team_list_outcomes'
]
export const CLINE_OFF = [
  'read_files', 'search_codebase', 'run_commands', 'editor', 'apply_patch', 'skills', 'ask_question',
  'spawn_agent', 'ux_verifier', 'tasks', 'submit_and_exit', 'image_generation', ...TEAM_TOOLS
]
const WEB_TOOLS: Record<string, 'search' | 'fetch'> = { web_search: 'search', fetch_web_content: 'fetch' }

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function usageOf(u: Raw): Usage {
  const cost = num(u['totalCost'])
  return { inputTokens: num(u['inputTokens']), cacheReadTokens: num(u['cacheReadTokens']), outputTokens: num(u['outputTokens']), ...(cost > 0 ? { apiCostUsd: cost } : {}) }
}

export function clineParser(): Parser {
  let text = ''
  let iteration = 0 // the model call the text came from
  let lastIteration = -1
  let error = ''
  let finished = false
  const tools = new Map<string, { action: 'search' | 'fetch'; detail: string }>()

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev || finished) return []
      const out: EngineEvent[] = []
      if (ev['type'] === 'agent_event') {
        const e = obj(ev['event'])
        const type = e['type']
        if (type === 'iteration_start') iteration = num(e['iteration'])
        else if (type === 'content_start' && e['contentType'] === 'text') {
          const delta = str(e['text'])
          if (delta) {
            // Text around tool calls comes in separate model calls; keep them as paragraphs.
            const sep = text && iteration !== lastIteration ? '\n\n' : ''
            lastIteration = iteration
            text += sep + delta
            out.push({ type: 'text', delta: sep + delta })
          }
        } else if (type === 'content_start' && e['contentType'] === 'tool') {
          const action = WEB_TOOLS[str(e['toolName'])]
          const input = obj(e['input'])
          if (action) tools.set(str(e['toolCallId']), { action, detail: str(action === 'search' ? (input['query'] ?? input['q']) : input['url']) })
        } else if (type === 'content_end' && e['contentType'] === 'tool') {
          // A web search or page read shows once it ran.
          const id = str(e['toolCallId'])
          const call = tools.get(id)
          if (call && !e['error']) out.push({ type: 'web', ...call })
          tools.delete(id)
        } else if (type === 'usage') {
          out.push({ type: 'progress', tokens: num(e['totalInputTokens']) + num(e['totalOutputTokens']), cacheRead: num(e['totalCacheReadTokens']) })
        } else if (type === 'error') {
          error = str(obj(e['error'])['message']) || str(e['message']) || error
        }
      } else if (ev['type'] === 'run_result') {
        finished = true
        const reason = str(ev['finishReason'])
        const said = text || str(ev['text'])
        if (reason === 'error' || reason === 'aborted' || !said) {
          const why = error || (reason === 'error' ? str(ev['text']) : '')
          out.push({ type: 'error', message: why || L(`O Cline terminou sem resposta (${reason || '?'}).`, `Cline ended without a reply (${reason || '?'}).`) })
          return out
        }
        out.push({ type: 'done', text: said, usage: usageOf(obj(ev['usage'])) })
      } else if (ev['type'] === 'error') {
        error = str(ev['message']) || error
      }
      return out
    },
    end(code, stderr) {
      if (finished) return []
      // The CLI's own error line, on stderr, says it best.
      const said = stderr
        .split('\n')
        .map((l) => str(parseJson(l.trim())?.['message']))
        .filter(Boolean)
        .pop()
      const why = said || error
      if (why) return [{ type: 'error', message: why }]
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Cline saiu sem resposta (código ${code ?? '?'}).`, `Cline exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// What goes before the conversation, as the prompt argument (it must have a space in it, or
// the CLI takes it for a command); the conversation comes on stdin, after it.
export const clineLead = (): string => L('A conversa segue abaixo.', 'The conversation follows.')

// A model as the app keeps it: "<provider>/<model>" (the provider is Cline's id, and a Cline
// account's models have a "/" of their own, as in "cline/anthropic/claude-sonnet-4.5"), or
// a bare name for the provider last signed into.
export function clineModel(model: string): { provider?: string; model: string } {
  const id = model.trim()
  const slash = id.indexOf('/')
  if (slash <= 0) return { model: id }
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) }
}

// Headless (--json), the turn's model and effort, the gateway's tools run without asking, the
// agent's instructions as the whole system prompt. No -k: a key passed there is saved.
export function clineArgs(turn: Pick<Turn, 'model' | 'effort' | 'system'>): string[] {
  const m = clineModel(turn.model)
  return [
    '--json',
    '--auto-approve', 'true',
    '--thinking', turn.effort,
    ...(m.provider ? ['--provider', m.provider] : []),
    ...(m.model ? ['--model', m.model] : []),
    '--system', turn.system || ' ',
    clineLead()
  ]
}

// What goes on stdin: the conversation, and a note when it had images (the CLI takes none).
export function clinePrompt(turn: Pick<Turn, 'prompt' | 'images'>): string {
  return turn.prompt + ((turn.images ?? []).some((i) => existsSync(i.path)) ? imagesLeftOut() : '')
}

const imagesLeftOut = (): string =>
  L(
    '\n\n(Aviso do Tucano: as imagens anexadas nesta conversa não puderam ser mostradas a você, porque o Cline CLI não aceita imagens por aqui. Se a pessoa perguntar sobre uma imagem, diga que não conseguiu vê-la.)',
    "\n\n(Note from Tucano: the images attached in this conversation couldn't be shown to you, because Cline CLI takes no images this way. If you're asked about an image, say you couldn't see it.)"
  )

// The turn's global settings: built-in tools off (the web ones only without the web).
export function clineSettings(turn: Pick<Turn, 'web'>): Record<string, unknown> {
  return {
    telemetryOptOut: true,
    autoUpdateEnabled: false,
    disabledTools: [...CLINE_OFF, ...(turn.web ? [] : Object.keys(WEB_TOOLS))],
    tools: { web_search: { enabled: !!turn.web } }
  }
}

export function clineMcp(turn: Pick<Turn, 'mcpUrl'>): Record<string, unknown> {
  return { mcpServers: turn.mcpUrl ? { [GATEWAY_NAME]: { type: 'streamableHttp', url: turn.mcpUrl } } : {} }
}

// Where the app keeps Cline: its own login, and the turns' folders.
export const clineAppDir = (dataDir: string): string => join(dataDir, 'cline')
export const clineLoginDir = (appDir: string): string => join(appDir, 'login')
export const clineProvidersFile = (loginDir: string): string => join(loginDir, 'data', 'settings', 'providers.json')

// The variables of the app's own Cline login (`cline auth`, and the checks that read it).
export const clineLoginEnv = (loginDir: string): Record<string, string> => ({ CLINE_DIR: loginDir, CLINE_SESSION_BACKEND_MODE: 'local' })

export interface ClineTurnDirs {
  root: string // HOME (and USERPROFILE on Windows)
  config: string // CLINE_DIR
  work: string // the CLI's working folder
}

export function clineTurnDirs(appDir: string, turn: Pick<Turn, 'mcpUrl' | 'web'>): ClineTurnDirs {
  const root = join(appDir, 'turns', randomBytes(8).toString('hex'))
  const config = join(root, '.cline')
  const settings = join(config, 'data', 'settings')
  const work = join(root, 'work')
  mkdirSync(settings, { recursive: true })
  mkdirSync(work, { recursive: true })
  writeFileSync(join(settings, 'global-settings.json'), JSON.stringify(clineSettings(turn), null, 2))
  writeFileSync(join(settings, 'cline_mcp_settings.json'), JSON.stringify(clineMcp(turn), null, 2))
  return { root, config, work }
}

// Variables that would send Cline to other folders, or to the person's own setup.
const MOVED = /^CLINE_(DIR|DATA_DIR|SESSION_DATA_DIR|TEAM_DATA_DIR|DB_DATA_DIR|PROVIDER_SETTINGS_PATH|GLOBAL_SETTINGS_PATH|MCP_SETTINGS_PATH|HOOKS_DIR|SANDBOX|SANDBOX_DATA_DIR|SESSION_BACKEND_MODE|HUB_[A-Z_]+|CONNECTOR[A-Z_]*|RULES|PLUGIN[A-Z_]*|BIN_PATH|LOG_PATH)$/

// A turn's environment: its own home and config, the app's login, the hub left alone. On
// Windows the redirected Documents folders (OneDrive), where Cline also looks for rules, go.
export function clineTurnEnv(base: NodeJS.ProcessEnv, dirs: ClineTurnDirs, providersFile: string, os: Os = osOf()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!MOVED.test(k) && !/^OneDrive(Consumer|Commercial)?$/i.test(k)) env[k] = v
  return {
    ...env,
    HOME: dirs.root,
    ...(os === 'windows' ? { USERPROFILE: dirs.root } : {}),
    CLINE_DIR: dirs.config,
    CLINE_PROVIDER_SETTINGS_PATH: providersFile,
    CLINE_SESSION_BACKEND_MODE: 'local',
    NO_COLOR: '1'
  }
}

export function clineCleanup(dirs: ClineTurnDirs): void {
  try {
    if (existsSync(dirs.root)) rmSync(dirs.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // a rare leftover is a small dead folder; harmless
  }
}

// The app's Cline login, from its providers.json: each provider signed into (a key, an
// account's token, AWS or Google settings, or a server's address) and the model it last ran,
// as "<provider>/<model>". Nothing else of the file is read, and no secret leaves here.
export function clineLogins(json: string): { providers: string[]; models: string[] } {
  let file: Raw = {}
  try {
    file = obj(JSON.parse(json))
  } catch {
    return { providers: [], models: [] }
  }
  const providers: string[] = []
  const models: string[] = []
  const has = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
  for (const [id, entry] of Object.entries(obj(file['providers']))) {
    const s = obj(obj(entry)['settings'])
    const auth = obj(s['auth'])
    const aws = obj(s['aws'])
    const signed = [s['apiKey'], auth['apiKey'], auth['accessToken'], aws['accessKey'], aws['profile'], obj(s['gcp'])['projectId'], obj(s['sap'])['clientId'], s['baseUrl']].some(has)
    if (!signed) continue
    providers.push(id)
    if (has(s['model'])) models.push(`${id}/${String(s['model']).trim()}`)
  }
  return { providers, models }
}

export function readClineLogins(loginDir: string): { providers: string[]; models: string[] } {
  try {
    return clineLogins(readFileSync(clineProvidersFile(loginDir), 'utf8'))
  } catch {
    return { providers: [], models: [] }
  }
}

export function clineEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'cline',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Cline CLI não está instalado. Veja em Configurações.', "Cline CLI isn't installed. See Settings.") }
        return
      }
      const dirs = clineTurnDirs(appDir, turn)
      // A provider's key may live in the person's shell, which an app opened from Finder doesn't get.
      const env = clineTurnEnv({ ...process.env, ...(await shellEnv()) }, dirs, clineProvidersFile(clineLoginDir(appDir)))
      try {
        // The CLI reads stdin only when it's a file (or a FIFO), so the conversation goes in one:
        // no length limit, as an argument would have.
        const prompt = join(dirs.root, 'prompt.txt')
        writeFileSync(prompt, clinePrompt(turn))
        yield* runCli({ bin: path, args: clineArgs(turn), stdin: '', stdinFile: prompt, cwd: dirs.work, signal: turn.signal, parser: clineParser(), env, sandbox: turn.sandbox })
      } finally {
        clineCleanup(dirs)
      }
    }
  }
}
