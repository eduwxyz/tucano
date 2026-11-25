import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import { L } from '../../shared/lang'
import type { Effort } from '../../shared/types'
import type { Engine, EngineEvent, Turn } from './types'

// Pi has no MCP on purpose. The app's tools reach it through a small
// extension the app writes next to its data: at startup it asks the app's
// gateway (TUCANO_MCP_URL) for this turn's tools and registers each one; a
// call goes back to the gateway, which decides. With TUCANO_WEB=1 it adds a
// page reader (Pi has no web tools of its own). Plain JS, no imports beyond
// node, so Pi loads it as is.
export const piSource = (): string => `// Written by Tucano: the app's tools for this turn, from its gateway.
import { request } from 'node:http'

const url = process.env.TUCANO_MCP_URL
let id = 0
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        try {
          const r = JSON.parse(text)
          r.error ? reject(new Error(r.error.message)) : resolve(r.result)
        } catch (e) {
          reject(new Error(${JSON.stringify(L('Resposta inválida do Tucano: ', 'Invalid answer from Tucano: '))} + text.slice(0, 200)))
        }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

const contentOf = (r) => (r.content ?? []).map((c) => (c.type === 'image' ? { type: 'image', data: c.data, mimeType: c.mimeType } : { type: 'text', text: c.text ?? JSON.stringify(c) }))

export default async function (pi) {
  if (url) {
    const { tools } = await rpc('tools/list', {})
    for (const t of tools)
      pi.registerTool({
        name: t.name,
        label: t.name,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
        async execute(_callId, params) {
          const r = await rpc('tools/call', { name: t.name, arguments: params ?? {} })
          if (r.isError) throw new Error(contentOf(r).map((c) => c.text ?? '').join('\\n') || ${JSON.stringify(L('A ferramenta falhou.', 'The tool failed.'))})
          return { content: contentOf(r), details: {} }
        }
      })
  }
  if (process.env.TUCANO_WEB === '1')
    pi.registerTool({
      name: 'web_fetch',
      label: 'web_fetch',
      description: ${JSON.stringify(L('Lê uma página da web e devolve o texto dela (sem HTML). Use pra conferir fontes e responder com dados atuais.', 'Reads a web page and returns its text (no HTML). Use it to check sources and answer with current data.'))},
      parameters: { type: 'object', properties: { url: { type: 'string', description: ${JSON.stringify(L('O endereço completo, com https://', 'The full address, with https://'))} } }, required: ['url'] },
      async execute(_callId, params, signal) {
        const res = await fetch(params.url, { signal, headers: { 'user-agent': 'Mozilla/5.0 (Tucano)' } })
        const html = await res.text()
        const text = html.replace(/<script[\\s\\S]*?<\\/script>|<style[\\s\\S]*?<\\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\\s+/g, ' ').trim()
        return { content: [{ type: 'text', text: \`\${res.status} \${params.url}\\n\\n\${text.slice(0, 40000)}\` }], details: {} }
      }
    })
}
`

export function piExtension(appDir: string): string {
  mkdirSync(appDir, { recursive: true })
  const path = join(appDir, 'tucano-tools.mjs')
  writeFileSync(path, piSource()) // every turn: an update to the app updates it
  return path
}

const THINKING: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }

// Isolated like the others: no built-in tools (shell, files), none of the
// user's extensions, skills, prompt templates or AGENTS.md/CLAUDE.md, nothing
// project-local, no saved session. Only the app's extension, and its tools.
export function piArgs(turn: Pick<Turn, 'model' | 'effort' | 'system' | 'images'>, extension: string): string[] {
  return [
    '-p',
    '--mode', 'json',
    '--no-session',
    '--no-extensions',
    '-e', extension,
    '--no-builtin-tools',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--offline',
    '--model', turn.model,
    '--thinking', THINKING[turn.effort],
    '--system-prompt', turn.system,
    ...(turn.images ?? []).filter((i) => existsSync(i.path)).map((i) => `@${i.path}`)
  ]
}

// JSON events: text deltas in message_update, tool calls in tool_execution_*,
// the usage of each model call in its assistant message_end.
export function piParser(): Parser {
  let text = ''
  let input = 0
  let output = 0
  let cacheRead = 0
  let error: string | undefined
  let newMessage = false

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      if (ev['type'] === 'message_start') newMessage = true
      else if (ev['type'] === 'message_update') {
        const a = (ev['assistantMessageEvent'] ?? {}) as Record<string, unknown>
        if (a['type'] === 'thinking_delta' && typeof a['delta'] === 'string') {
          // What the model is thinking about, streamed apart from what it will say.
          out.push({ type: 'thinking', delta: a['delta'] })
        } else if (a['type'] === 'text_delta' && typeof a['delta'] === 'string') {
          // Text around tool calls comes in separate model calls; keep them as paragraphs.
          const sep = newMessage && text ? '\n\n' : ''
          newMessage = false
          text += sep + a['delta']
          out.push({ type: 'text', delta: sep + a['delta'] })
        }
      } else if (ev['type'] === 'tool_execution_start' && ev['toolName'] === 'web_fetch') {
        out.push({ type: 'web', action: 'fetch', detail: String(((ev['args'] ?? {}) as Record<string, unknown>)['url'] ?? '') })
      } else if (ev['type'] === 'message_end') {
        const m = (ev['message'] ?? {}) as Record<string, unknown>
        if (m['role'] !== 'assistant') return []
        const u = (m['usage'] ?? {}) as Record<string, unknown>
        cacheRead += num(u['cacheRead'])
        input += num(u['input']) + num(u['cacheRead']) + num(u['cacheWrite'])
        output += num(u['output'])
        out.push({ type: 'progress', tokens: input + output, cacheRead })
        if (m['stopReason'] === 'error' || m['stopReason'] === 'aborted') error ??= String(m['errorMessage'] ?? L('O Pi terminou com erro.', 'Pi ended with an error.'))
      }
      return out
    },
    end(code, stderr) {
      if (error) return [{ type: 'error', message: error }]
      if (code === 0) return [{ type: 'done', text, usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output } }]
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Pi saiu sem resposta (código ${code ?? '?'}).`, `Pi exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

// The model is "<provider>/<model>", as `pi --list-models` lists it.
export function piEngine(bin: () => string | undefined, appDir: string, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'pi',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O Pi não está instalado. Veja em Configurações.', "Pi isn't installed. See Settings.") }
        return
      }
      // Provider keys may live in the user's shell, which an app opened from Finder doesn't get.
      const env = { ...process.env, ...(await shellEnv()), TUCANO_MCP_URL: turn.mcpUrl ?? '', TUCANO_WEB: turn.web ? '1' : '0' }
      yield* runCli({ bin: path, args: piArgs(turn, piExtension(appDir)), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: piParser(), env })
    }
  }
}
