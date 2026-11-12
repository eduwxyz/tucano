import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn, Usage } from './types'
import { isWin, osOf, spawnable } from '../platform'
import type { Os } from '../../shared/types'
import { L } from '../../shared/lang'

// Cursor's agent CLI (`cursor-agent`, also installed as `agent`). In headless
// mode (`-p --output-format stream-json`) it prints one JSON event per line and
// exits. Each turn runs in a folder of its own, with two parts:
// - a config dir (CURSOR_CONFIG_DIR) whose permissions deny Cursor's own file
//   reads, writes and shell, and allow only the gateway's tools (and the web,
//   when the agent has it). The login stays the person's: it's in the keychain.
// - a workspace with the agent's instructions (AGENTS.md, which the CLI reads
//   as the project's rules) and the gateway as the project's MCP server.
// - a home of its own (see cursorHomeEnv): the CLI reads the person's hooks,
//   plugins and skills from the home folder, not from CURSOR_CONFIG_DIR.
// MCP servers load only when approved, and the turn approves only the gateway
// (`cursor-agent mcp enable`, no --approve-mcps): the person's own servers in
// ~/.cursor/mcp.json are listed but never load. What Cursor keeps per
// workspace (transcripts, approvals, its worker's socket) goes in the turn's
// folder too (CURSOR_DATA_DIR), not in ~/.cursor/projects, and goes with the
// turn. Each run also leaves a worker process behind (it would quit after 5
// idle minutes); the turn tells it to quit when it ends.

// Cursor's stream-json events (from the CLI's output): system init; user;
// assistant {message:{content:[{type:'text', text}]}}, which with
// --stream-partial-output comes as deltas (timestamp_ms, no model_call_id),
// then again whole at the end of each model call (with model_call_id) and once
// more at the end (neither); tool_call {subtype: started|completed, tool_call:
// {<kind>ToolCall: {args, result}}}; result {subtype, is_error, result, usage:
// {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}} — the
// terminal event. inputTokens leaves the cache out.

const charsToTokens = (chars: number): number => Math.ceil(chars / 4)

// `sent`: the characters the app sends (instructions and prompt), to estimate
// the usage if the CLI doesn't tell it. The estimate is low (Cursor adds its own
// prompt, about 10k tokens), so it's doubled.
export function cursorParser(sent = 0): Parser {
  let text = ''
  let newCall = false
  let streamed = false // deltas came in this model call
  let finished = false

  const estimate = (): Usage => ({ inputTokens: charsToTokens(sent) * 2, cacheReadTokens: 0, outputTokens: charsToTokens(text.length) })

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      const type = ev['type']
      if (type === 'assistant') {
        // The deltas; the whole message that comes after them only when this model
        // call had none (an older CLI, or no partial output), and never the last
        // repeat of it (no timestamp).
        if (typeof ev['timestamp_ms'] !== 'number') return []
        const whole = 'model_call_id' in ev
        if (whole && streamed) return []
        const content = ((ev['message'] as Record<string, unknown> | undefined)?.['content'] ?? []) as Record<string, unknown>[]
        const delta = (Array.isArray(content) ? content : []).map((c) => (c['type'] === 'text' && typeof c['text'] === 'string' ? c['text'] : '')).join('')
        if (!delta) return []
        if (!whole) streamed = true
        // Text around tool calls comes in separate model calls; keep them as paragraphs.
        const sep = newCall && text ? '\n\n' : ''
        newCall = false
        text += sep + delta
        out.push({ type: 'text', delta: sep + delta })
      } else if (type === 'tool_call') {
        newCall = true
        streamed = false
        // A web search or read shows once it ran: one the permissions refused didn't.
        if (ev['subtype'] !== 'completed') return []
        const call = (ev['tool_call'] ?? {}) as Record<string, Record<string, unknown> | undefined>
        const ran = Object.values(call).some((c) => !!c && typeof c === 'object' && !!(c['result'] as Record<string, unknown> | undefined)?.['success'])
        if (!ran) return []
        const args = (call['webSearchToolCall']?.['args'] ?? undefined) as Record<string, unknown> | undefined
        if (args) out.push({ type: 'web', action: 'search', detail: String(args['searchTerm'] ?? args['query'] ?? '') })
        const fetch = call['webFetchToolCall'] ?? call['fetchToolCall']
        const fargs = (fetch?.['args'] ?? undefined) as Record<string, unknown> | undefined
        if (fargs) out.push({ type: 'web', action: 'fetch', detail: String(fargs['url'] ?? '') })
      } else if (type === 'result') {
        finished = true
        const whole = typeof ev['result'] === 'string' ? ev['result'] : ''
        if (ev['is_error'] === true || ev['subtype'] !== 'success') {
          out.push({ type: 'error', message: whole || L(`O Cursor terminou com erro (${String(ev['subtype'])}).`, `Cursor ended with an error (${String(ev['subtype'])}).`) })
          return out
        }
        if (!text) text = whole
        const u = ev['usage'] as Record<string, unknown> | undefined
        const told = u && (typeof u['inputTokens'] === 'number' || typeof u['outputTokens'] === 'number')
        const cacheRead = num(u?.['cacheReadTokens'])
        const usage: Usage = told
          ? { inputTokens: num(u['inputTokens']) + cacheRead + num(u['cacheWriteTokens']), cacheReadTokens: cacheRead, outputTokens: num(u['outputTokens']) }
          : estimate()
        out.push({ type: 'done', text, usage })
      }
      return out
    },
    end(code, stderr) {
      if (finished) return []
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Cursor saiu sem resposta (código ${code ?? '?'}).`, `Cursor exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// Headless, one shot: the prompt on stdin (big prompts don't fit an argument),
// stream-json with deltas, the model named, and the turn's workspace trusted
// (it's the app's own). No --force: a tool the permissions don't allow is
// refused, never run. No --approve-mcps: only the approved gateway loads.
// Images attached in the chat go with the prompt (--image, once per file), as
// with Codex: the agent sees them with Cursor's own file reads still denied.
// The CLI hides that option ("internal only"), so it may go away; see
// imageRefused for what the turn does then.
export function cursorArgs(turn: Pick<Turn, 'model' | 'images'>): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--trust',
    '--model',
    turn.model,
    ...(turn.images ?? []).filter((i) => existsSync(i.path)).flatMap((i) => ['--image', i.path])
  ]
}

// Whether the CLI refused --image itself (an unknown option, before any reply):
// then the turn runs again without the images.
export const imageRefused = (message: string): boolean => /unknown option|unrecognized|unexpected argument/i.test(message) && /--image\b/.test(message)

// What the agent is told when its images couldn't go along, so it says so
// instead of answering as if it had seen them.
export const imagesLeftOut = (): string =>
  L(
    '\n\n(Aviso do Tucano: as imagens anexadas nesta conversa não puderam ser mostradas a você desta vez, porque o Cursor CLI não aceitou anexá-las. Se a pessoa perguntar sobre uma imagem, diga que não conseguiu vê-la.)',
    "\n\n(Note from Tucano: the images attached in this conversation couldn't be shown to you this time, because Cursor CLI didn't take them. If you're asked about an image, say you couldn't see it.)"
  )

// The permissions of a turn: Cursor's file reads, writes (deleting and saving
// images included) and shell are denied; the gateway's tools are allowed and
// run without asking (the gateway decides); web fetch and web search only with
// the web. Deny wins over allow in Cursor, so the allow list is what's left.
export function cursorConfig(turn: Pick<Turn, 'mcpUrl' | 'web'>): Record<string, unknown> {
  return {
    version: 1,
    permissions: {
      allow: [...(turn.mcpUrl ? [`Mcp(${GATEWAY_NAME}:*)`] : []), ...(turn.web ? ['WebFetch(*)'] : [])],
      deny: ['Read(**)', 'Write(**)', 'Shell(*)', ...(turn.web ? [] : ['WebFetch(*)'])]
    },
    approvalMode: 'allowlist',
    autoAcceptWebSearch: !!turn.web,
    attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false }
  }
}

// Where the app keeps the Cursor turns, in its data folder.
export const cursorAppDir = (dataDir: string): string => join(dataDir, 'cursor')

export interface CursorTurnDirs {
  root: string
  config: string // CURSOR_CONFIG_DIR
  data: string // CURSOR_DATA_DIR
  workspace: string
  home: string // HOME (USERPROFILE on Windows)
}

// The CLI reads, from the home folder and not from CURSOR_CONFIG_DIR, the
// person's hooks (~/.cursor/hooks.json, and the ones in ~/.claude/settings.json,
// whose format it imports), plugins (~/.claude/plugins, ~/.cursor/plugins) and
// skills (~/.cursor, ~/.claude, ~/.codex, ~/.agents). Hooks run in headless
// mode too: commands outside the gateway, handed the turn's prompt and tool
// calls. So a turn gets an empty home, with only the way to the person's login:
// - macOS: the keychain, linked in as Library/Keychains (nothing else of ~/Library);
// - Linux: a file under XDG_CONFIG_HOME (cursor/auth.json), so that stays the person's;
// - Windows: a file under %APPDATA% (Cursor\auth.json), which stays the person's.
// What's left out on purpose: hooks an admin set for the machine (/Library,
// /etc, ProgramData) or for the team, in Cursor's dashboard.
// The CLI keeps a compile cache in the home; it goes in the app's folder, so
// each turn doesn't start cold.
export function cursorHomeEnv(home: string, appDir: string, os: Os = osOf(), realHome = homedir(), env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const set = (v: string | undefined): string | undefined => (v && v.trim() ? v : undefined)
  return {
    HOME: home,
    NODE_COMPILE_CACHE: join(appDir, 'compile-cache'),
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

// A folder for one turn: the config dir, the workspace (instructions and the
// gateway) and the home (on macOS, with the keychain linked in).
export function cursorTurnDirs(appDir: string, turn: Pick<Turn, 'system' | 'mcpUrl' | 'web'>, os: Os = osOf(), realHome = homedir()): CursorTurnDirs {
  const root = join(appDir, randomBytes(8).toString('hex'))
  const config = join(root, 'config')
  const data = join(root, 'd') // short: the worker's socket path is built from it
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  mkdirSync(config, { recursive: true })
  mkdirSync(data, { recursive: true })
  mkdirSync(join(workspace, '.cursor'), { recursive: true })
  mkdirSync(home, { recursive: true })
  if (os === 'mac') {
    mkdirSync(join(home, 'Library'), { recursive: true })
    try {
      symlinkSync(join(realHome, 'Library', 'Keychains'), join(home, 'Library', 'Keychains'))
    } catch {
      // without it the CLI says it isn't signed in, and the turn shows that
    }
  }
  writeFileSync(join(config, 'cli-config.json'), JSON.stringify(cursorConfig(turn), null, 2))
  writeFileSync(join(workspace, 'AGENTS.md'), turn.system)
  if (turn.mcpUrl) writeFileSync(join(workspace, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { [GATEWAY_NAME]: { url: turn.mcpUrl } } }, null, 2))
  return { root, config, data, workspace, home }
}

// How Cursor names a workspace's folder: its real path, as a slug.
export function cursorSlug(workspace: string): string {
  let real = workspace
  try {
    real = realpathSync(workspace)
  } catch {
    // gone already: the path as given
  }
  return real.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

// Where the CLI puts its worker's socket for a workspace (the CLI's own rule,
// which keeps the path short enough for a Unix socket): under <data>/projects,
// or <data>, or the temp folder, cut to 83 characters plus a hash when long.
export function cursorWorkerSocket(workspace: string, data: string, tmp = tmpdir()): string {
  let base = join(data, 'projects')
  if (base.length > 83) {
    base = data
    if (base.length > 83) base = join(tmp, '.cursor').length <= 83 ? join(tmp, '.cursor') : join('/tmp', '.cursor')
  }
  let dir = join(base, cursorSlug(workspace))
  if (dir.length > 91) dir = `${dir.substring(0, 83)}-${createHash('sha256').update(dir).digest('hex').substring(0, 7)}`
  return join(dir, 'worker.sock')
}

// Asks the turn's worker to quit (it answers, then exits). Without one, nothing happens.
function stopWorker(socket: string): Promise<void> {
  if (isWin || !existsSync(socket)) return Promise.resolve()
  return new Promise((resolve) => {
    const req = request({ socketPath: socket, path: '/kill', method: 'POST', timeout: 3_000 }, (res) => {
      res.resume()
      res.on('end', () => resolve())
    })
    req.on('error', () => resolve())
    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.end()
  })
}

// The end of a turn: the worker quits, and the turn's folder goes: the config,
// the workspace, the home, and what Cursor kept for it (the transcript, the
// approval, the socket). The home's link to the keychain goes as a link: what
// it points to stays. With a long data path the socket sits in the temp folder
// instead, in a folder named after this turn's workspace alone.
export async function cursorCleanup(dirs: CursorTurnDirs): Promise<void> {
  const socket = cursorWorkerSocket(dirs.workspace, dirs.data)
  await stopWorker(socket)
  const gone = dirname(socket).startsWith(dirs.root) ? [dirs.root] : [dirs.root, dirname(socket)]
  for (const dir of gone)
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // a rare leftover is a small dead folder; harmless
    }
}

const quiet = (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve) => {
    const s = spawnable(bin, args)
    execFile(s.file, s.args, { cwd, env, timeout: 30_000, windowsHide: true, windowsVerbatimArguments: s.verbatim }, (err) => resolve(err ? 1 : 0))
  })

export function cursorEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'cursor',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Cursor CLI não está instalado. Veja em Configurações.', "Cursor CLI isn't installed. See Settings.") }
        return
      }
      const model = turn.model.includes('/') ? turn.model.slice(turn.model.indexOf('/') + 1) : turn.model
      const dirs = cursorTurnDirs(appDir, turn)
      // CURSOR_API_KEY may live in the person's shell, which an app opened from Finder doesn't get.
      const env: NodeJS.ProcessEnv = { ...process.env, ...(await shellEnv()), ...cursorHomeEnv(dirs.home, appDir), CURSOR_CONFIG_DIR: dirs.config, CURSOR_DATA_DIR: dirs.data, NO_OPEN_BROWSER: '1' }
      try {
        if (turn.mcpUrl && (await quiet(path, ['mcp', 'enable', GATEWAY_NAME], dirs.workspace, env)) !== 0) {
          yield { type: 'error', message: L('O Cursor não aceitou as ferramentas do Tucano (cursor-agent mcp enable).', "Cursor didn't take Tucano's tools (cursor-agent mcp enable).") }
          return
        }
        const sent = turn.system.length + turn.prompt.length
        const run = (images: Turn['images'], prompt: string): AsyncIterable<EngineEvent> =>
          runCli({ bin: path, args: cursorArgs({ model, images }), stdin: prompt, cwd: dirs.workspace, signal: turn.signal, parser: cursorParser(sent), env, sandbox: turn.sandbox })
        const withImages = (turn.images ?? []).some((i) => existsSync(i.path))
        if (!withImages) {
          yield* run(undefined, turn.prompt)
          return
        }
        // With images, a refusal of --image (it comes before anything else) runs
        // the turn again without them, and the agent is told why.
        let said = false
        let refused = false
        for await (const ev of run(turn.images, turn.prompt)) {
          if (!said && ev.type === 'error' && imageRefused(ev.message)) {
            refused = true
            break
          }
          said = said || ev.type === 'text'
          yield ev
        }
        if (refused && !turn.signal.aborted) yield* run(undefined, turn.prompt + imagesLeftOut())
      } finally {
        await cursorCleanup(dirs)
      }
    }
  }
}

// `cursor-agent models` prints "<id> - <label>" per line, under a title.
export function parseCursorModels(out: string): string[] {
  return out
    .split('\n')
    .map((l) => /^\s*([a-z0-9][\w.\-[\]=,]*)\s+-\s+\S/i.exec(l)?.[1])
    .filter((id): id is string => !!id)
}

// Whether the CLI is signed in, from `cursor-agent status` (or an API key).
export const cursorSignedIn = (statusOut: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  /logged in/i.test(statusOut) && !/not logged in/i.test(statusOut) ? true : !!env['CURSOR_API_KEY']
