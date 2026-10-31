import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn } from './types'
import { L } from '../../shared/lang'

export const GATEWAY_NAME = 'tucano'
const WEB_TOOLS = ['WebSearch', 'WebFetch'] // run on Anthropic's side, on the subscription

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
// user settings, hooks, plugins or MCP servers, and no saved session. Not
// --bare: it turns off the subscription login. The app's gateway, when given,
// is the only MCP server, and its tools are pre-allowed: the gateway decides.
// With web, the only built-in tools are web search and page reading.
export function claudeArgs(turn: Pick<Turn, 'model' | 'effort' | 'system' | 'mcpUrl' | 'web' | 'blocks' | 'images'>, apiKeyHelper?: string): string[] {
  const web = turn.web ? WEB_TOOLS : []
  const allowed = [...(turn.mcpUrl ? [`mcp__${GATEWAY_NAME}`] : []), ...web]
  const gateway = turn.mcpUrl ? ['--mcp-config', JSON.stringify({ mcpServers: { [GATEWAY_NAME]: { type: 'http', url: turn.mcpUrl } } })] : []
  return [
    '-p',
    ...(turn.blocks?.some((b) => b.trim()) || turn.images?.length ? ['--input-format', 'stream-json'] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', turn.model,
    '--effort', turn.effort,
    '--system-prompt', turn.system,
    '--tools', web.join(','),
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
    // --settings still applies with no setting sources; only the key helper goes in it
    ...(apiKeyHelper ? ['--settings', JSON.stringify({ apiKeyHelper })] : []),
    ...gateway,
    ...(allowed.length ? ['--allowedTools', ...allowed] : [])
  ]
}

// With blocks, one user message with a text block per piece: the CLI marks the
// last block for caching, and the next turn, which starts with the same blocks,
// reads them back from the cache instead of sending them again. An attached
// image goes right after the block of the message it came with.
export function claudeInput(turn: Pick<Turn, 'prompt' | 'blocks' | 'images'>): string {
  const images = turn.images ?? []
  const blocks = turn.blocks?.length ? turn.blocks : images.length ? [turn.prompt] : []
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

export function claudeEngine(bin: () => string | undefined, provider: () => Promise<Provider> = async () => userProvider()): Engine {
  return {
    id: 'claude',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Claude Code não está instalado. Veja em Configurações.', "Claude Code isn't installed. See Settings.") }
        return
      }
      // The gateway's token goes in the environment, never in the arguments (other processes can read those).
      const p = await provider()
      yield* runCli({ bin: path, args: claudeArgs(turn, p.apiKeyHelper), stdin: claudeInput(turn), cwd: turn.cwd, signal: turn.signal, parser: claudeParser(), env: { ...process.env, ...p.env, MCP_TOOL_TIMEOUT: '900000' }, forwardEnv: Object.keys(p.env) })
    }
  }
}
