import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn, Usage } from './types'
import { osOf } from '../platform'
import type { Os } from '../../shared/types'
import { L } from '../../shared/lang'

// Antigravity CLI (`agy`), Google's agent CLI. In print mode with stream-json in and out
// (`--input-format stream-json --output-format stream-json`) it reads the user turn as one
// JSON line on stdin, prints one JSON event per line and exits.
//
// It reads everything from the home folder: its settings (~/.gemini/antigravity-cli/
// settings.json), its MCP servers (~/.gemini/config/mcp_config.json), the person's global
// rules, skills, plugins and hooks. So each turn runs with a home of its own (HOME), in a
// folder of its own, with:
// - settings whose permissions deny Antigravity's own shell, file reads and writes, page
//   reads and browser, and allow the gateway's tools (and page reads, with the web). A
//   denied tool comes back to the model as an error and the turn goes on. Explicit rules,
//   not `toolPermission: strict`: under strict the first tool it can't run ends the turn
//   with no reply. No --dangerously-skip-permissions: that approves everything.
// - the gateway as the only MCP server;
// - the agent's instructions as the workspace's GEMINI.md, which the CLI reads as rules;
// - on macOS, the person's keychain linked in, where the CLI keeps its login (nothing else
//   of ~/Library). Checked with agy 1.5.3: a home with only that is signed in.
// The workspace is the turn's own folder, not the agent's: Antigravity walks up from it
// for GEMINI.md, AGENTS.md and .agents/ (skills, hooks, plugins), and none of the person's
// may come in. The turn's folder goes when it ends.
//
// What the rules don't reach: `search_web` has no permission of its own and stays on (it
// shows as a web search, so what it brings in counts as outside content), and the CLI's
// own `schedule`, subagents and messages live only inside the run, under the same rules.

// stream-json events (agy 1.5.3, and the docs at antigravity.google/docs/cli/headless):
// init {init:{model, cwd, tools, permission_mode}}; step_update {step_update:{step_index,
// state: ACTIVE|DONE|ERROR, step_type: user_input|agent_response|tool|checkpoint,
// text_delta?, usage?, tool_name?, tool_info?:{name, parameters, output?, error?}}};
// result {result:{status: SUCCESS|ERROR|CANCELED|…, response, error?, usage:{input_tokens,
// output_tokens, thinking_tokens, cache_read_tokens, total_tokens}}} — the terminal event.
// input_tokens counts the cache reads in (total = input + output).

const WEB_TOOLS: Record<string, 'search' | 'fetch'> = { search_web: 'search', read_url_content: 'fetch' }

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {})

function usageOf(u: Raw): Usage {
  return { inputTokens: num(u['input_tokens']), cacheReadTokens: num(u['cache_read_tokens']), outputTokens: num(u['output_tokens']) + num(u['thinking_tokens']) }
}

export function antigravityParser(): Parser {
  let text = ''
  let lastStep = -1 // the agent_response step the text came from
  let sent = 0 // tokens of the model calls so far, for the running total
  let cached = 0
  let finished = false

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      if (ev['event'] === 'step_update') {
        const step = obj(ev['step_update'])
        const index = num(step['step_index'])
        if (step['step_type'] === 'agent_response') {
          const delta = typeof step['text_delta'] === 'string' ? step['text_delta'] : ''
          if (delta) {
            // Text around tool calls comes in separate steps; keep them as paragraphs.
            const sep = text && index !== lastStep ? '\n\n' : ''
            lastStep = index
            text += sep + delta
            out.push({ type: 'text', delta: sep + delta })
          }
          if (step['state'] === 'DONE' && step['usage']) {
            const u = usageOf(obj(step['usage']))
            sent += u.inputTokens + u.outputTokens
            cached += u.cacheReadTokens
            out.push({ type: 'progress', tokens: sent, cacheRead: cached })
          }
        } else if (step['step_type'] === 'tool' && step['state'] === 'DONE') {
          // A web search or page read shows once it ran: a denied one ends in ERROR.
          const action = WEB_TOOLS[String(step['tool_name'])]
          if (action) {
            const p = obj(obj(step['tool_info'])['parameters'])
            const detail = action === 'search' ? (p['query'] ?? p['Query']) : (p['Url'] ?? p['url'] ?? p['URL'])
            out.push({ type: 'web', action, detail: typeof detail === 'string' ? detail : '' })
          }
        }
      } else if (ev['event'] === 'result') {
        finished = true
        const r = obj(ev['result'])
        const status = String(r['status'] ?? '').toUpperCase()
        if (status !== 'SUCCESS') {
          const why = typeof r['error'] === 'string' && r['error'] ? r['error'] : ''
          out.push({ type: 'error', message: why || L(`O Antigravity terminou sem resposta (${status || '?'}).`, `Antigravity ended without a reply (${status || '?'}).`) })
          return out
        }
        if (!text && typeof r['response'] === 'string') text = r['response']
        out.push({ type: 'done', text, usage: usageOf(obj(r['usage'])) })
      }
      return out
    },
    end(code, stderr) {
      if (finished) return []
      const detail = lastLines(stderr)
      const signIn = /sign in|authentication required/i.test(stderr)
      return [
        {
          type: 'error',
          message: signIn
            ? L('O Antigravity não está logado. Abra o terminal, rode agy e entre com sua conta Google.', "Antigravity isn't signed in. Open a terminal, run agy and sign in with your Google account.")
            : L(`O Antigravity saiu sem resposta (código ${code ?? '?'}).`, `Antigravity exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '')
        }
      ]
    }
  }
}

// Print mode, stream-json both ways (a prompt piped as plain text isn't taken as the
// turn), the model named, and slash commands off: a prompt that starts with "/" is the
// person's text, not a command to the CLI.
export function antigravityArgs(model: string): string[] {
  return ['--output-format', 'stream-json', '--input-format', 'stream-json', '--disable-slash-commands', '--model', model]
}

// The user turn, as the one stdin line stream-json takes. Text only: the CLI takes no images.
export const antigravityInput = (prompt: string): string => `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`

// The CLI cuts a rules file at 24,000 bytes, and the agent can't read the rest (its file
// reads are denied). Longer instructions go at the top of the prompt instead.
export const RULES_MAX = 24_000

export function antigravityPrompt(turn: Pick<Turn, 'system' | 'prompt' | 'images'>): string {
  const inRules = Buffer.byteLength(turn.system, 'utf8') <= RULES_MAX
  const head = inRules || !turn.system ? '' : `<instructions>\n${turn.system}\n</instructions>\n\n`
  const images = (turn.images ?? []).some((i) => existsSync(i.path)) ? imagesLeftOut() : ''
  return head + turn.prompt + images
}

const imagesLeftOut = (): string =>
  L(
    '\n\n(Aviso do Tucano: as imagens anexadas nesta conversa não puderam ser mostradas a você, porque o Antigravity CLI não aceita imagens. Se a pessoa perguntar sobre uma imagem, diga que não conseguiu vê-la.)',
    "\n\n(Note from Tucano: the images attached in this conversation couldn't be shown to you, because Antigravity CLI doesn't take images. If you're asked about an image, say you couldn't see it.)"
  )

// What a turn may do: the gateway's tools, run without asking (the gateway decides), and
// page reads only with the web. Deny wins over allow in Antigravity.
export function antigravitySettings(turn: Pick<Turn, 'mcpUrl' | 'web'>): Record<string, unknown> {
  return {
    permissions: {
      allow: [...(turn.mcpUrl ? [`mcp(${GATEWAY_NAME}/*)`] : []), ...(turn.web ? ['read_url(*)'] : [])],
      deny: ['command(*)', 'unsandboxed(*)', 'read_file(*)', 'write_file(*)', 'execute_url(*)', ...(turn.web ? [] : ['read_url(*)'])]
    },
    showTips: false,
    showFeedbackSurvey: false,
    notifications: false
  }
}

// Where the app keeps the Antigravity turns, in its data folder.
export const antigravityAppDir = (dataDir: string): string => join(dataDir, 'antigravity')

export interface AntigravityTurnDirs {
  root: string
  home: string // HOME (and USERPROFILE on Windows)
  workspace: string // the CLI's working folder
}

// A folder for one turn: a home with the settings, the gateway and the way to the
// person's login, and a workspace with the agent's instructions.
export function antigravityTurnDirs(appDir: string, turn: Pick<Turn, 'system' | 'mcpUrl' | 'web'>, os: Os = osOf(), realHome = homedir()): AntigravityTurnDirs {
  const root = join(appDir, randomBytes(8).toString('hex'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const cli = join(home, '.gemini', 'antigravity-cli')
  const config = join(home, '.gemini', 'config')
  mkdirSync(cli, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  if (os === 'mac') {
    mkdirSync(join(home, 'Library'), { recursive: true })
    try {
      symlinkSync(join(realHome, 'Library', 'Keychains'), join(home, 'Library', 'Keychains'))
    } catch {
      // without it the CLI says it isn't signed in, and the turn shows that
    }
  }
  writeFileSync(join(cli, 'settings.json'), JSON.stringify(antigravitySettings(turn), null, 2))
  writeFileSync(join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: turn.mcpUrl ? { [GATEWAY_NAME]: { url: turn.mcpUrl } } : {} }, null, 2))
  if (turn.system && Buffer.byteLength(turn.system, 'utf8') <= RULES_MAX) writeFileSync(join(workspace, 'GEMINI.md'), turn.system)
  return { root, home, workspace }
}

// The home of a turn. On Linux and Windows the login lives in the system's own store
// (Secret Service, Credential Manager), which doesn't follow HOME; the folders for app
// data stay the person's, as for Cursor.
export function antigravityHomeEnv(home: string, os: Os = osOf(), realHome = homedir(), env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const set = (v: string | undefined): string | undefined => (v && v.trim() ? v : undefined)
  return {
    HOME: home,
    ...(os === 'linux' ? { XDG_CONFIG_HOME: set(env['XDG_CONFIG_HOME']) ?? join(realHome, '.config') } : {}),
    ...(os === 'windows'
      ? {
          USERPROFILE: home,
          APPDATA: set(env['APPDATA']) ?? join(realHome, 'AppData', 'Roaming'),
          LOCALAPPDATA: set(env['LOCALAPPDATA']) ?? join(realHome, 'AppData', 'Local')
        }
      : {})
  }
}

// Model ids the app kept from the Gemini CLI, and the Antigravity one each became.
const LEGACY: Record<string, string> = {
  'gemini-2.5-flash': 'gemini-3.8-flash-medium',
  'gemini-2.5-flash-lite': 'gemini-3.8-flash-low',
  'gemini-2.5-pro': 'gemini-4-argon-medium',
  'gemini-3.8-flash': 'gemini-3.8-flash-medium',
  'gemini-3.5-flash-lite': 'gemini-3.8-flash-low',
  'gemini-3-flash-preview': 'gemini-3.8-flash-medium',
  'gemini-3.1-pro-preview': 'gemini-4-argon-medium'
}

// The id the CLI takes, from the app's "antigravity/<id>" (or an old "gemini/<id>").
export function antigravityModel(model: string): string {
  const id = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
  return LEGACY[id] ?? id
}

// `agy models` prints "<id>\t<label>" per line, after a "Fetching…" line; signed out, an error.
export function parseAntigravityModels(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => /^([a-z0-9][a-z0-9.-]*)\t\S/i.exec(l)?.[1])
    .filter((id): id is string => !!id)
    .map((id) => `antigravity/${id}`)
}

export function antigravityEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'antigravity',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Antigravity CLI não está instalado. Veja em Configurações.', "Antigravity CLI isn't installed. See Settings.") }
        return
      }
      const dirs = antigravityTurnDirs(appDir, turn)
      // A key or proxy may live in the person's shell, which an app opened from Finder doesn't get.
      const env: NodeJS.ProcessEnv = { ...process.env, ...(await shellEnv()), ...antigravityHomeEnv(dirs.home) }
      try {
        yield* runCli({ bin: path, args: antigravityArgs(antigravityModel(turn.model)), stdin: antigravityInput(antigravityPrompt(turn)), cwd: dirs.workspace, signal: turn.signal, parser: antigravityParser(), env, sandbox: turn.sandbox })
      } finally {
        // The keychain is a link: only the link goes.
        try {
          rmSync(dirs.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          // a rare leftover is a small dead folder; harmless
        }
      }
    }
  }
}
