// Agents on an address in OpenAI's format, with no harness: OpenRouter, OmniRoute, Ollama, LM Studio,
// vLLM, or a company's own proxy. A harness gives the app two things here, the model loop and a
// subscription's login; an address with a key needs no login, and the loop is this file. Every tool an
// agent has already comes from the app's own gateway (turn.mcpUrl), so the loop lists them there, sends
// them with each call to /chat/completions, runs the ones the model asks for through the same gateway
// (approvals, limits and logs as with any harness) and calls again, until the model answers in words.
// Nothing is kept between turns: every turn carries the whole conversation (the engine has no sessions).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { L } from '../../shared/lang'
import type { Engine, EngineEvent, Turn, Usage } from './types'

export interface EndpointTarget {
  baseUrl: string // up to and including /v1, as the provider documents it (https://openrouter.ai/api/v1)
  key?: string // none for a local server that asks for none
}

export const MAX_STEPS = 60 // model calls in one turn; past it, the turn ends saying so
const MAX_TOOL_RESULT = 60_000 // characters of one tool's result sent back to the model

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Part[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
type Chunk = {
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number }
  error?: { message?: string }
}

// OpenAI's function names: letters, digits, _ and -, 64 at most. The gateway's are, today; one that
// isn't gets a name that is, and the call goes back under its own.
export function functionName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return clean.length <= 64 ? clean : `${clean.slice(0, 55)}_${createHash('sha1').update(name).digest('hex').slice(0, 8)}`
}

// The person's words, with the images of the conversation after them (a model with no eyes for them is
// told by the provider, in the error it answers with).
export function userContent(turn: Pick<Turn, 'prompt' | 'images'>, read: (path: string) => Buffer = readFileSync): string | Part[] {
  if (!turn.images?.length) return turn.prompt
  const pictures: Part[] = []
  for (const img of turn.images) {
    try {
      pictures.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${read(img.path).toString('base64')}` } })
    } catch {
      // gone from the disk meanwhile: the words go without it
    }
  }
  return pictures.length ? [{ type: 'text', text: turn.prompt }, ...pictures] : turn.prompt
}

// The events of a streamed answer ("data: {…}" lines), or the whole answer when the server didn't stream.
async function* chunks(res: Response): AsyncIterable<Chunk> {
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
    yield (await res.json()) as Chunk
    return
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data) as Chunk
      } catch {
        // a keep-alive or a comment some servers send between events
      }
    }
    if (done) return
  }
}

// What the provider said when it refused, in a sentence: its own message when it gives one.
async function refusal(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  let said = ''
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    said = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? '')
  } catch {
    said = body.slice(0, 300)
  }
  const why =
    res.status === 401 || res.status === 403
      ? L('o endpoint recusou a chave', 'the endpoint refused the key')
      : res.status === 404
        ? L('o endpoint não achou esse modelo ou esse endereço', 'the endpoint found no such model or address')
        : res.status === 429
          ? L('o endpoint pediu pra esperar (limite de uso)', 'the endpoint asked to wait (rate limit)')
          : L(`o endpoint respondeu ${res.status}`, `the endpoint answered ${res.status}`)
  return said.trim() ? `${why}: ${said.trim()}` : why
}

const textOf = (r: unknown): string => {
  const content = (r as { content?: { type?: string; text?: string }[] }).content ?? []
  const text = content.map((c) => (c.type === 'text' || c.text ? (c.text ?? '') : `[${c.type}]`)).join('\n')
  return (r as { isError?: boolean }).isError ? `Error: ${text}` : text
}

export function endpointEngine(target: () => Promise<EndpointTarget | undefined>, f: typeof fetch = fetch): Engine {
  return {
    id: 'endpoint',
    async *run(turn: Turn): AsyncIterable<EngineEvent> {
      const t = await target()
      if (!t?.baseUrl) {
        yield { type: 'error', message: L('Nenhum endpoint configurado: ponha o endereço e a chave em Configurações › Modelos.', 'No endpoint set up: add its address and key in Settings › Models.') }
        return
      }
      const url = `${t.baseUrl.replace(/\/+$/, '')}/chat/completions`
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream, application/json', 'x-title': 'Tucano', 'http-referer': 'https://tucano.sh' }
      if (t.key) headers['authorization'] = `Bearer ${t.key}`

      // The tools of this turn, as the gateway has them.
      let client: Client | undefined
      const tools: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[] = []
      const names = new Map<string, string>() // the name the model sees → the gateway's
      try {
        if (turn.mcpUrl) {
          client = new Client({ name: 'tucano-endpoint', version: '1.0.0' })
          await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
          for (const tool of (await client.listTools()).tools) {
            const name = functionName(tool.name)
            names.set(name, tool.name)
            tools.push({ type: 'function', function: { name, description: tool.description ?? '', parameters: tool.inputSchema ?? { type: 'object', properties: {} } } })
          }
        }
      } catch (e) {
        await client?.close().catch(() => {})
        yield { type: 'error', message: L(`Não consegui abrir as ferramentas do app: ${e instanceof Error ? e.message : String(e)}`, `I couldn't open the app's tools: ${e instanceof Error ? e.message : String(e)}`) }
        return
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: turn.system },
        { role: 'user', content: userContent(turn) }
      ]
      const usage: Usage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
      let cost = 0
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          let res: Response
          try {
            res = await f(url, { method: 'POST', headers, body: JSON.stringify({ model: turn.model, messages, ...(tools.length ? { tools } : {}), stream: true, stream_options: { include_usage: true } }), signal: turn.signal })
          } catch (e) {
            if (turn.signal.aborted) return
            yield { type: 'error', message: L(`Não consegui falar com o endpoint (${new URL(url).host}): ${e instanceof Error ? e.message : String(e)}`, `I couldn't reach the endpoint (${new URL(url).host}): ${e instanceof Error ? e.message : String(e)}`) }
            return
          }
          if (!res.ok) {
            yield { type: 'error', message: await refusal(res) }
            return
          }
          // One answer: its words as they come, and the tool calls it builds piece by piece.
          let said = ''
          const calls: { id: string; name: string; args: string }[] = []
          for await (const c of chunks(res)) {
            if (c.error?.message) {
              yield { type: 'error', message: c.error.message }
              return
            }
            if (c.usage) {
              usage.inputTokens += c.usage.prompt_tokens ?? 0
              usage.outputTokens += c.usage.completion_tokens ?? 0
              usage.cacheReadTokens += c.usage.prompt_tokens_details?.cached_tokens ?? 0
              cost += c.usage.cost ?? 0
            }
            const choice = c.choices?.[0]
            // A server that didn't stream sends the whole message at once.
            const whole = choice?.message
            if (whole) {
              if (whole.content) {
                said += whole.content
                yield { type: 'text', delta: whole.content }
              }
              for (const tc of whole.tool_calls ?? []) calls.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments ?? '' })
              continue
            }
            const delta = choice?.delta
            if (delta?.content) {
              said += delta.content
              yield { type: 'text', delta: delta.content }
            }
            for (const tc of delta?.tool_calls ?? []) {
              const i = tc.index ?? calls.length
              const call = (calls[i] ??= { id: '', name: '', args: '' })
              if (tc.id) call.id = tc.id
              if (tc.function?.name) call.name += tc.function.name
              if (tc.function?.arguments) call.args += tc.function.arguments
            }
          }
          const asked = calls.filter((c) => c.name)
          if (!asked.length) {
            yield { type: 'done', text: said, usage: { ...usage, ...(cost ? { apiCostUsd: cost } : {}) } }
            return
          }
          // The tools it asked for, each through the gateway, and their results back to it.
          asked.forEach((c, i) => (c.id ||= `call_${step}_${i}`))
          messages.push({ role: 'assistant', content: said || null, tool_calls: asked.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) })
          for (const call of asked) {
            if (turn.signal.aborted) return
            let out: string
            try {
              const args = call.args.trim() ? (JSON.parse(call.args) as Record<string, unknown>) : {}
              out = client ? textOf(await client.callTool({ name: names.get(call.name) ?? call.name, arguments: args })) : L('Não há ferramentas neste turno.', 'There are no tools in this turn.')
            } catch (e) {
              out = `Error: ${e instanceof SyntaxError ? L('os argumentos não são JSON válido', 'the arguments are not valid JSON') : e instanceof Error ? e.message : String(e)}`
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: out.length > MAX_TOOL_RESULT ? `${out.slice(0, MAX_TOOL_RESULT)}\n[…]` : out })
          }
          yield { type: 'progress', tokens: usage.inputTokens + usage.outputTokens, cacheRead: usage.cacheReadTokens }
        }
        yield { type: 'error', message: L(`Parei: foram ${MAX_STEPS} chamadas ao modelo nesta resposta sem ele terminar.`, `I stopped: ${MAX_STEPS} model calls in this reply without it finishing.`) }
      } finally {
        await client?.close().catch(() => {})
      }
    }
  }
}
