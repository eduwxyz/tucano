import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import { opencodeMajor, runOpencodeV2 } from './opencode-v2'
import type { Engine, EngineEvent, Turn } from './types'
import { L } from '../../shared/lang'

// OpenCode reads AGENTS.md, plugins, agents, commands, skills and MCP servers
// from the user's config dir, and keeps every session in its data dir. So the
// app runs it with dirs of its own (XDG_*), and brings in only the person's
// logins (auth.json, linked so a refreshed login stays theirs) and the
// providers in their opencode.json (a company gateway, a custom endpoint).
// The cache (the model catalog, provider packages) stays the user's: the same
// models `opencode models` lists, without downloading them again.
export function opencodeHome(appDir: string, userData = join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'opencode')): Record<string, string> {
  const dirs = { XDG_CONFIG_HOME: join(appDir, 'config'), XDG_DATA_HOME: join(appDir, 'data'), XDG_STATE_HOME: join(appDir, 'state') }
  for (const d of Object.values(dirs)) mkdirSync(join(d, 'opencode'), { recursive: true })
  const auth = join(dirs.XDG_DATA_HOME, 'opencode', 'auth.json')
  if (!existsSync(auth) && existsSync(join(userData, 'auth.json'))) symlinkSync(join(userData, 'auth.json'), auth)
  return dirs
}

// The providers block of the user's opencode.json(c): where their models come
// from. The rest (agents, plugins, MCP servers, instructions) stays out. V2 also
// reads its own shape: `providers`, and `policies` on which providers to use.
export function userOpencodeProviders(dir = join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'opencode'), v2 = false): Record<string, unknown> {
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    try {
      const c = JSON.parse(stripJsonComments(readFileSync(join(dir, name), 'utf8'))) as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of ['provider', 'enabled_providers', 'disabled_providers', ...(v2 ? ['providers'] : [])]) if (c[k] !== undefined) out[k] = c[k]
      const policies = v2 && Array.isArray(c['policies']) ? c['policies'].filter((p) => (p as Record<string, unknown> | null)?.['action'] === 'provider.use') : []
      if (policies.length) out['policies'] = policies
      return out
    } catch {
      // not there, or not readable: next
    }
  }
  return {}
}

// JSONC to JSON: comments and trailing commas out, strings left alone.
export function stripJsonComments(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

// The whole setup goes in OPENCODE_CONFIG_CONTENT: of the built-in tools only `read`,
// kept to the agent's own folder (the turn's cwd); the app's gateway as the only MCP
// server and its tools allowed, web fetch and search only when the agent has the web,
// the system prompt as the agent's own, and nothing shared.
// `read` is there for OpenCode's free models (opencode/…-free): their server refuses a call
// that doesn't offer it ("Free usage limit reached. Free models work in OpenCode"), and a
// tool that's denied is left out of the call. Outside the folder it's denied
// (external_directory), so the person's files stay out of reach as before.
export function opencodeConfig(turn: Pick<Turn, 'system' | 'mcpUrl' | 'web'>, providers: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    ...providers,
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    mcp: turn.mcpUrl ? { [GATEWAY_NAME]: { type: 'remote', url: turn.mcpUrl, enabled: true } } : {},
    tools: { '*': false, read: true, [`${GATEWAY_NAME}_*`]: true, webfetch: !!turn.web, websearch: !!turn.web },
    permission: { read: 'allow', external_directory: 'deny' },
    agent: { tucano: { mode: 'primary', prompt: turn.system } }
  }
}

// Its errors logged to stderr: a model call that fails is only logged, and `run` waits on without
// exiting (see opencodeParser's stderr).
export const OPENCODE_LOGS = ['--print-logs', '--log-level', 'ERROR']

export function opencodeArgs(turn: Pick<Turn, 'model' | 'images'>): string[] {
  return ['run', ...OPENCODE_LOGS, '--pure', '--format', 'json', '--agent', 'tucano', '-m', turn.model, ...(turn.images ?? []).filter((i) => existsSync(i.path)).flatMap((i) => ['-f', i.path])]
}

// The free models (opencode/…-free) answer only a call that looks like OpenCode's own app's (see
// opencodeConfig), and only up to their free usage limit: past it, or if OpenCode asks more of the call,
// "Free usage limit reached. Free models work in OpenCode".
const FREE_ONLY = /free models work in opencode|free usage limit/i
// How long a failed model call may still go on (OpenCode retrying) before the turn stops.
export const OPENCODE_ERROR_WAIT_MS = 30_000

// A model call that failed, from its log line: `level=ERROR … message="stream error" … error.error="…"`.
export function opencodeStreamError(line: string): { message: string; waitMs: number } | undefined {
  if (!/level=ERROR/.test(line) || !/message="stream error"/.test(line)) return undefined
  const said = /error\.error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1]?.replace(/\\"/g, '"').replace(/^AI_APICallError:\s*/, '').trim()
  if (said && FREE_ONLY.test(said))
    return {
      message: L(
        `O OpenCode recusou o modelo grátis: o uso grátis pode ter chegado ao limite. Se continuar, troque o modelo deste agente por um pago (OpenCode Go ou Zen) ou de um provedor com a sua chave.\nO OpenCode disse: ${said}`,
        `OpenCode refused the free model: free usage may have hit its limit. If it keeps happening, switch this agent to a paid model (OpenCode Go or Zen) or one from a provider with your key.\nOpenCode said: ${said}`
      ),
      waitMs: 0
    }
  return { message: L(`O modelo falhou no OpenCode: ${said || 'erro sem detalhe'}`, `The model failed in OpenCode: ${said || 'error with no detail'}`), waitMs: OPENCODE_ERROR_WAIT_MS }
}

// One JSON event per line: step_start, text (a whole part), tool_use, step_finish (with tokens), error.
export function opencodeParser(): Parser {
  let text = ''
  let input = 0
  let output = 0
  let cacheRead = 0
  let cost = 0
  let failed = false

  return {
    stderr: opencodeStreamError,
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      const part = (ev['part'] ?? {}) as Record<string, unknown>
      if (ev['type'] === 'text' && typeof part['text'] === 'string' && part['text']) {
        const delta = text ? `\n\n${part['text']}` : part['text']
        text += delta
        out.push({ type: 'text', delta })
      } else if (ev['type'] === 'tool_use') {
        const input = ((part['state'] as Record<string, unknown> | undefined)?.['input'] ?? {}) as Record<string, unknown>
        if (part['tool'] === 'webfetch') out.push({ type: 'web', action: 'fetch', detail: String(input['url'] ?? '') })
        else if (part['tool'] === 'websearch') out.push({ type: 'web', action: 'search', detail: String(input['query'] ?? '') })
      } else if (ev['type'] === 'step_finish') {
        const t = (part['tokens'] ?? {}) as Record<string, unknown>
        const cache = (t['cache'] ?? {}) as Record<string, unknown>
        cacheRead += num(cache['read'])
        input += num(t['input']) + num(cache['read']) + num(cache['write'])
        output += num(t['output']) + num(t['reasoning'])
        cost += num(part['cost'])
        out.push({ type: 'progress', tokens: input + output, cacheRead })
      } else if (ev['type'] === 'error' && !failed) {
        failed = true
        const err = (ev['error'] ?? {}) as Record<string, unknown>
        const data = (err['data'] ?? {}) as Record<string, unknown>
        out.push({ type: 'error', message: String(data['message'] ?? err['message'] ?? err['name'] ?? L('O OpenCode terminou com erro.', 'OpenCode ended with an error.')) })
      }
      return out
    },
    end(code, stderr) {
      if (failed) return []
      if (code === 0) return [{ type: 'done', text, usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, ...(cost ? { apiCostUsd: cost } : {}) } }]
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O OpenCode saiu sem resposta (código ${code ?? '?'}).`, `OpenCode exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// The model is "<provider>/<model>", as `opencode models` lists it. The installed
// version picks V1's way or V2's (see opencode-v2.ts), so an upgrade keeps the agents running.
export function opencodeEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({}), version: () => string | undefined = () => undefined): Engine {
  return {
    id: 'opencode',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O OpenCode não está instalado. Veja em Configurações.', "OpenCode isn't installed. See Settings.") }
        return
      }
      // Provider keys may live in the user's shell, which an app opened from Finder doesn't get.
      if (opencodeMajor(version()) >= 2) {
        yield* runOpencodeV2(path, turn, appDir, await shellEnv())
        return
      }
      // PWD too: OpenCode takes its folder (where `read` may go) from it, not from the process's cwd,
      // and the app's own PWD is wherever it was opened from (`/` from the Finder).
      const env = { ...process.env, ...(await shellEnv()), ...opencodeHome(appDir), PWD: turn.cwd, OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(turn, userOpencodeProviders())), OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' }
      yield* runCli({ bin: path, args: opencodeArgs(turn), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: opencodeParser(), env, sandbox: turn.sandbox })
    }
  }
}
