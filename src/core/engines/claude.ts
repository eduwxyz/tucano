import { readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { lastLines, LiveCli, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn, TurnShape } from './types'
import { L } from '../../shared/lang'

export const GATEWAY_NAME = 'tucano'
const WEB_TOOLS = ['WebSearch', 'WebFetch'] // run on Anthropic's side, on the subscription
const TOOL_SEARCH = 'ToolSearch' // loads a deferred MCP tool by name; touches nothing on the computer

// How the user's own Claude Code reaches the model, from their settings.json:
// the `env` block (a company gateway: ANTHROPIC_BASE_URL and its token, or
// Bedrock/Vertex) and `apiKeyHelper` (a script that prints the key). The rest
// of that file (hooks, plugins, permissions, MCP servers) stays out. Read at
// every turn, so a change there counts from the next reply.
export interface Provider {
  env: Record<string, string>
  apiKeyHelper?: string
}

export function userProvider(dir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')): Provider {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { env?: unknown; apiKeyHelper?: unknown }
    const env = s.env && typeof s.env === 'object' ? Object.fromEntries(Object.entries(s.env).filter((e): e is [string, string] => typeof e[1] === 'string')) : {}
    return { env, ...(typeof s.apiKeyHelper === 'string' && s.apiKeyHelper.trim() ? { apiKeyHelper: s.apiKeyHelper } : {}) }
  } catch {
    return { env: {} }
  }
}

// Flags that keep the CLI isolated: no built-in tools (shell, files), no
// user settings, hooks, plugins or MCP servers, and no saved session unless
// the turn keeps one (then it starts it with its id, or resumes it). Not
// --bare: it turns off the subscription login. The app's gateway, when given,
// is the only MCP server, and its tools are pre-allowed: the gateway decides.
// With web, the only built-in tools are web search and page reading.
// With the gateway, also ToolSearch: without it the CLI turns tool search off and puts every
// connector tool in every model call (measured: 198 tools, 239k tokens a call, up to 7.8 s to the
// first token; with it, 11k). The CLI then lists the connector tools by name and the model loads
// the ones it needs; the app's own tools stay in the prompt (ALWAYS_LOAD in the gateway).
export const GATEWAY_ENV = 'TUCANO_MCP_URL'

export function claudeArgs(turn: Pick<Turn, 'model' | 'effort' | 'system' | 'mcpUrl' | 'web' | 'blocks' | 'images' | 'session'>, apiKeyHelper?: string): string[] {
  const web = turn.web ? WEB_TOOLS : []
  const search = turn.mcpUrl ? [TOOL_SEARCH] : []
  const allowed = [...(turn.mcpUrl ? [`mcp__${GATEWAY_NAME}`] : []), ...search, ...web]
  // The address carries the gateway's token: the CLI fills it in from the environment, so it
  // never shows in the arguments, which any program on the computer can list.
  const gateway = turn.mcpUrl ? ['--mcp-config', JSON.stringify({ mcpServers: { [GATEWAY_NAME]: { type: 'http', url: `\${${GATEWAY_ENV}}` } } })] : []
  return [
    '-p',
    ...(turn.session || turn.blocks?.some((b) => b.trim()) || turn.images?.length ? ['--input-format', 'stream-json'] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', turn.model,
    '--effort', turn.effort,
    '--system-prompt', turn.system,
    '--tools', [...search, ...web].join(','),
    '--strict-mcp-config',
    '--setting-sources', '',
    ...(turn.session ? [turn.session.resume ? '--resume' : '--session-id', turn.session.id] : ['--no-session-persistence']),
    // --settings still applies with no setting sources; only the key helper goes in it
    ...(apiKeyHelper ? ['--settings', JSON.stringify({ apiKeyHelper })] : []),
    ...gateway,
    ...(allowed.length ? ['--allowedTools', ...allowed] : [])
  ]
}

// With blocks, one user message with a text block per piece; an attached image
// goes right after the block of the message it came with. A new turn with the
// same blocks plus the new ones doesn't read them back from the cache (measured:
// only the system prompt and tools are), so a kept session sends only the new
// ones, and its turns before come from the cache. It always gets a JSON message:
// its process reads one per turn.
export function claudeInput(turn: Pick<Turn, 'prompt' | 'blocks' | 'images' | 'session'>): string {
  const images = turn.images ?? []
  const blocks = turn.blocks?.length ? turn.blocks : images.length || turn.session ? [turn.prompt] : []
  const content: Record<string, unknown>[] = []
  blocks.forEach((text, i) => {
    if (text.trim()) content.push({ type: 'text', text })
    for (const img of images.filter((x) => x.block === i)) {
      let data: string
      try {
        data = readFileSync(img.path).toString('base64')
      } catch {
        continue // deleted since: the message still says it had an image
      }
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data } })
    }
  })
  if (!content.length) return turn.prompt
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
}

export function claudeParser(): Parser {
  let doneTokens = 0 // tokens of model calls already finished in this turn
  let doneCache = 0
  let callInput = 0
  let callCache = 0
  let callOutput = 0
  let finished = false
  let wroteText = false // text from an earlier model call in this turn
  let newCall = false

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []

      if (ev['type'] === 'stream_event') {
        const e = ev['event'] as Record<string, unknown> | undefined
        if (!e) return []
        if (e['type'] === 'message_start') {
          doneTokens += callInput + callOutput
          doneCache += callCache
          const u = ((e['message'] as Record<string, unknown> | undefined)?.['usage'] ?? {}) as Record<string, unknown>
          callCache = num(u['cache_read_input_tokens'])
          callInput = num(u['input_tokens']) + callCache + num(u['cache_creation_input_tokens'])
          callOutput = 0
          newCall = true
          out.push({ type: 'progress', tokens: doneTokens + callInput, cacheRead: doneCache + callCache })
        } else if (e['type'] === 'content_block_delta') {
          const d = e['delta'] as Record<string, unknown> | undefined
          if (d?.['type'] === 'text_delta' && typeof d['text'] === 'string') {
            // Text around tool calls comes in separate model calls; keep them as paragraphs.
            const sep = newCall && wroteText ? '\n\n' : ''
            newCall = false
            wroteText = true
            out.push({ type: 'text', delta: sep + d['text'] })
          }
        } else if (e['type'] === 'message_delta') {
          callOutput = num((e['usage'] as Record<string, unknown> | undefined)?.['output_tokens'])
          out.push({ type: 'progress', tokens: doneTokens + callInput + callOutput, cacheRead: doneCache + callCache })
        }
      } else if (ev['type'] === 'assistant') {
        // The full message after its stream: where built-in tool calls show up whole.
        const content = ((ev['message'] as Record<string, unknown> | undefined)?.['content'] ?? []) as Record<string, unknown>[]
        for (const c of Array.isArray(content) ? content : []) {
          const input = (c['input'] ?? {}) as Record<string, unknown>
          if (c['type'] !== 'tool_use') continue
          if (c['name'] === 'WebSearch') out.push({ type: 'web', action: 'search', detail: String(input['query'] ?? '') })
          else if (c['name'] === 'WebFetch') out.push({ type: 'web', action: 'fetch', detail: String(input['url'] ?? '') })
        }
      } else if (ev['type'] === 'rate_limit_event') {
        const w = ((ev['rate_limit_info'] as Record<string, unknown> | undefined)?.['unifiedWindows'] ?? {}) as Record<string, Record<string, unknown> | undefined>
        const win = (k: string): { utilization: number; resetsAt: number } | undefined =>
          typeof w[k]?.['utilization'] === 'number' ? { utilization: w[k]!['utilization'] as number, resetsAt: num(w[k]!['resetsAt']) * 1000 } : undefined
        const quota = { fiveHour: win('five_hour'), sevenDay: win('seven_day'), at: Date.now() }
        if (quota.fiveHour || quota.sevenDay) out.push({ type: 'quota', quota })
      } else if (ev['type'] === 'result') {
        finished = true
        const u = (ev['usage'] ?? {}) as Record<string, unknown>
        const text = typeof ev['result'] === 'string' ? ev['result'] : ''
        if (ev['is_error'] === true || ev['subtype'] !== 'success') {
          out.push({ type: 'error', message: text || L(`O Claude Code terminou com erro (${String(ev['subtype'])}).`, `Claude Code ended with an error (${String(ev['subtype'])}).`) })
        } else {
          const cacheRead = num(u['cache_read_input_tokens'])
          out.push({
            type: 'done',
            text,
            context: callInput + callOutput,
            usage: {
              inputTokens: num(u['input_tokens']) + cacheRead + num(u['cache_creation_input_tokens']),
              cacheReadTokens: cacheRead,
              outputTokens: num(u['output_tokens']),
              apiCostUsd: typeof ev['total_cost_usd'] === 'number' ? ev['total_cost_usd'] : undefined
            }
          })
        }
      }
      return out
    },
    end(code, stderr) {
      if (finished) return []
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Claude Code saiu sem resposta (código ${code ?? '?'}).`, `Claude Code exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// Without CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC the CLI makes one more model call after the
// reply (its post-turn summary) and only then sends `result`: about 2.5 s on every reply, at
// times over 10 s. Nobody reads that summary here.
// The gateway's address goes in the environment, not the arguments (see claudeArgs).
export function claudeEnv(p: Provider, account?: string, mcpUrl?: string): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...p.env, ...(account ? { CLAUDE_CONFIG_DIR: account } : {}), ...(mcpUrl ? { [GATEWAY_ENV]: mcpUrl } : {}), MCP_TOOL_TIMEOUT: '900000' }
}

// Where Claude Code keeps a session: its config folder, then the working folder with every
// character other than a letter or digit turned into "-".
// As Claude Code names it: past 200 characters, cut there and followed by a hash of the whole path.
export const claudeProjectDir = (configDir: string, cwd: string): string => {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (name.length <= 200) return join(configDir, 'projects', name)
  let hash = 0
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0
  return join(configDir, 'projects', `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`)
}
const configDirOf = (account?: string): string => account || process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')

// A process kept open after a reply waits this long for the next one, and only this many wait at
// once (each holds about 140 MB): past either, it closes, and the next reply resumes the session
// from disk in a new process instead. Two were too few for a team: switching between three agents
// started a process on every reply.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const KEEP_IDLE_MS = 10 * 60_000
export const MAX_IDLE = 4
// A process started ahead of a turn with no session (the router's) waits this long, and only this
// many wait: it's started while the person types, so the message comes soon or not at all.
export const SPARE_MS = 2 * 60_000
export const MAX_SPARES = 2

// The flags of a turn with no session, reading its message as JSON: a process started ahead of
// time has to read it that way, so the turn that uses it does too.
const oneShot = (t: TurnShape, apiKeyHelper?: string): string[] => claudeArgs({ ...t, blocks: ['.'] }, apiKeyHelper)

interface Kept {
  cli: LiveCli
  key: string // what it was started with: another turn may write to it only with the same
  timer?: NodeJS.Timeout
  usedAt: number
}

export function claudeEngine(bin: () => string | undefined, provider: () => Promise<Provider> = async () => userProvider()): Engine {
  const kept = new Map<string, Kept>() // by session id
  const files = new Map<string, string>() // session id → its file
  const shapes = new Map<string, TurnShape>() // session id → the settings of its last turn, to start it again
  const spares = new Map<string, { cli: LiveCli; timer: NodeJS.Timeout; at: number }>() // by flags and provider

  const removing = new Set<Promise<void>>() // session files waiting for their process to exit
  const close = (id: string): void => {
    const k = kept.get(id)
    if (!k) return
    kept.delete(id)
    if (k.timer) clearTimeout(k.timer)
    k.cli.kill()
  }
  // Waiting processes past the cap close, the longest waiting first.
  const trim = (): void => {
    const idle = [...kept].filter(([, k]) => !k.cli.busy).sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [id] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) close(id)
  }
  // An open process waits for the next turn, for a while.
  const park = (id: string, k: Kept): void => {
    if (k.timer) clearTimeout(k.timer)
    k.usedAt = Date.now()
    k.timer = setTimeout(() => kept.get(id) === k && close(id), KEEP_IDLE_MS)
    k.timer.unref()
    trim()
  }
  // The same flags and provider as an open process: then it can take this turn.
  const keyOf = (path: string, t: TurnShape, args: string[], p: Provider): string => JSON.stringify([path, t.cwd, args, p.env, t.account ?? '', t.mcpUrl ?? ''])
  const keptKey = (path: string, t: TurnShape, id: string, p: Provider): string => keyOf(path, t, claudeArgs({ ...t, session: { id, resume: true } }, p.apiKeyHelper), p)
  const dropSpare = (key: string): void => {
    const s = spares.get(key)
    if (!s) return
    spares.delete(key)
    clearTimeout(s.timer)
    s.cli.end()
  }

  return {
    id: 'claude',
    sessions: true,
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Claude Code não está instalado. Veja em Configurações.', "Claude Code isn't installed. See Settings.") }
        return
      }
      // The gateway's token goes in the environment, never in the arguments (other processes can read those).
      const p = await provider()
      const env = claudeEnv(p, turn.account, turn.mcpUrl)
      const session = turn.session
      if (!session) {
        // A process started for it ahead of time takes the turn, then goes.
        const key = keyOf(path, turn, oneShot(turn, p.apiKeyHelper), p)
        const spare = spares.get(key)
        if (spare?.cli.alive) {
          spares.delete(key)
          clearTimeout(spare.timer)
          try {
            yield* spare.cli.turn(claudeInput({ ...turn, blocks: turn.blocks?.length ? turn.blocks : [turn.prompt] }), claudeParser(), turn.signal)
          } finally {
            spare.cli.end()
          }
          return
        }
        yield* runCli({ bin: path, args: claudeArgs(turn, p.apiKeyHelper), stdin: claudeInput(turn), cwd: turn.cwd, signal: turn.signal, parser: claudeParser(), env, sandbox: turn.sandbox })
        return
      }

      const { prompt: _p, blocks: _b, images: _i, signal: _s, session: _n, ...shape } = turn
      shapes.set(session.id, shape)
      files.set(session.id, join(claudeProjectDir(configDirOf(turn.account), turn.cwd), `${session.id}.jsonl`))
      const key = keptKey(path, turn, session.id, p)
      let k = kept.get(session.id)
      if (k && (k.key !== key || !k.cli.alive || k.cli.busy || !session.resume)) {
        close(session.id)
        k = undefined
      }
      if (k?.timer) clearTimeout(k.timer)
      if (!k) {
        k = { cli: new LiveCli({ bin: path, args: claudeArgs(turn, p.apiKeyHelper), cwd: turn.cwd, env }), key, usedAt: Date.now() }
        kept.set(session.id, k)
      }
      const current = k
      let ended = false // a whole turn, with its result
      try {
        for await (const ev of current.cli.turn(claudeInput(turn), claudeParser(), turn.signal)) {
          if (ev.type === 'done') ended = true
          yield ev
        }
      } finally {
        // Kept for the next reply only after a clean one; anything else and it goes.
        if (kept.get(session.id) === current) {
          if (ended && session.keep && current.cli.alive && !turn.signal.aborted) park(session.id, current)
          else close(session.id)
        }
      }
    },
    warm(turn) {
      const path = bin()
      if (!path) return
      void provider().then((p) => {
        const args = oneShot(turn, p.apiKeyHelper)
        const key = keyOf(path, turn, args, p)
        const had = spares.get(key)
        if (had?.cli.alive) {
          // Still waiting: it waits a while longer.
          clearTimeout(had.timer)
          had.timer = setTimeout(() => spares.get(key) === had && dropSpare(key), SPARE_MS)
          had.timer.unref()
          return
        }
        if (had) dropSpare(key)
        const cli = new LiveCli({ bin: path, args, cwd: turn.cwd, env: claudeEnv(p, turn.account, turn.mcpUrl) })
        const spare = { cli, at: Date.now(), timer: setTimeout(() => spares.get(key)?.cli === cli && dropSpare(key), SPARE_MS) }
        spare.timer.unref()
        spares.set(key, spare)
        const oldest = [...spares].sort((a, b) => a[1].at - b[1].at)
        for (const [k] of oldest.slice(0, Math.max(0, oldest.length - MAX_SPARES))) dropSpare(k)
      })
    },
    rewarm(id) {
      const path = bin()
      const open = kept.get(id)
      if (open?.cli.alive) {
        if (!open.cli.busy) park(id, open) // open already: it waits a while longer
        return
      }
      const shape = shapes.get(id)
      if (!path || !shape) return
      void provider().then((p) => {
        if (kept.has(id) || !shapes.has(id)) return // a turn or a release got there first
        const k: Kept = { cli: new LiveCli({ bin: path, args: claudeArgs({ ...shape, session: { id, resume: true } }, p.apiKeyHelper), cwd: shape.cwd, env: claudeEnv(p, shape.account, shape.mcpUrl) }), key: keptKey(path, shape, id, p), usedAt: Date.now() }
        kept.set(id, k)
        park(id, k)
      })
    },
    release(id) {
      const open = kept.get(id)?.cli
      close(id)
      shapes.delete(id)
      const file = files.get(id)
      files.delete(id)
      if (!file) return
      // The file, and the folder Claude Code may keep beside it (tool results). Only once the process
      // is gone: on its way out it writes the session's last prompt and cost to the file again.
      // Still in use (on Windows), it stays: the next start's clean() takes it.
      const remove = (): void => {
        for (const p of [file, file.slice(0, -'.jsonl'.length)])
          try {
            rmSync(p, { recursive: true, force: true })
          } catch {
            /* in use */
          }
        try {
          rmdirSync(dirname(file)) // the agent's folder, once it holds nothing
        } catch {
          /* not empty */
        }
      }
      if (!open?.alive) return remove()
      const gone = open.exited().then(remove)
      removing.add(gone)
      void gone.finally(() => removing.delete(gone))
    },
    async settle() {
      await Promise.all([...removing])
    },
    // Only the exact folders of the agents under workDir, in the usual config folder and in each
    // account's: Claude Code's folder names are lossy, so a prefix could take someone else's.
    clean(workDir, accountDirs = []) {
      let agents: string[]
      try {
        agents = readdirSync(workDir)
      } catch {
        return // no agent has worked here yet
      }
      for (const config of [configDirOf(), ...accountDirs])
        for (const a of agents) {
          const dir = claudeProjectDir(config, join(workDir, a))
          try {
            for (const f of readdirSync(dir)) {
              const id = f.endsWith('.jsonl') ? f.slice(0, -'.jsonl'.length) : f
              if (!files.has(id) && (f.endsWith('.jsonl') || SESSION_ID.test(f))) rmSync(join(dir, f), { recursive: true, force: true })
            }
            if (!readdirSync(dir).length) rmdirSync(dir)
          } catch {
            /* none here, in use, or gone: the next start tries again */
          }
        }
    },
    dispose() {
      for (const [, k] of kept) k.cli.killNow()
      for (const [, s] of spares) s.cli.killNow()
      kept.clear()
      spares.clear()
    }
  }
}
