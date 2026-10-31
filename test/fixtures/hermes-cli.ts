// Shared scaffolding for the tests that drive the real Hermes CLI: where the
// binary is, a local OpenAI-compatible endpoint that plays the model, and the
// daemon helpers. Both tests are opt-in (TUCANO_HERMES_E2E=1) — a Hermes install
// is not a CI given, and a 0.21 install cannot run them (no gateway daemon).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

export type ToolOffer = { function?: { name?: string } }
export type ChatMessage = { role?: string; content?: unknown }
// The model's whole behaviour, in one function: what it reads, what it answers.
export type ModelPlan = (req: { messages: ChatMessage[]; tools: ToolOffer[] }) => { message: Record<string, unknown>; finish: 'stop' | 'tool_calls' }

export function onPath(cmd: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    const p = join(dir, cmd)
    if (dir && existsSync(p)) return p
  }
  return undefined
}

export const hermesBin = (): string | undefined => process.env['TUCANO_HERMES_BIN'] || onPath('hermes')
export const hermesE2e = (): boolean => process.env['TUCANO_HERMES_E2E'] === '1' && !!hermesBin()

// A tool message's content is a string or a list of parts, depending on provider.
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
  return ''
}

// A local OpenAI-compatible endpoint. Streaming is what the CLI uses, so the
// answer goes out as SSE: one chunk with the content (or the tool call), one with
// the finish reason, then [DONE].
export function fakeModel(plan: ModelPlan): Promise<{
  url: string
  close: () => void
  calls: () => number
  requests: () => { messages: ChatMessage[]; tools: ToolOffer[] }[]
}> {
  const state: { calls: number; requests: { messages: ChatMessage[]; tools: ToolOffer[] }[] } = { calls: 0, requests: [] }
  const server: HttpServer = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: ChatMessage[]; tools?: ToolOffer[]; stream?: boolean }
      const messages = parsed.messages ?? []
      const tools = parsed.tools ?? []
      state.calls++
      state.requests.push({ messages, tools })
      const { message, finish } = plan({ messages, tools })
      if (parsed.stream) {
        const chunk = (delta: Record<string, unknown>, reason: string | null): string =>
          `data: ${JSON.stringify({ id: 'p', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(chunk(message, null) + chunk({}, finish) + 'data: [DONE]\n\n')
        return
      }
      const out = JSON.stringify({
        id: 'p', object: 'chat.completion', created: 1, model: 'fake-model',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) })
      res.end(out)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close(), calls: () => state.calls, requests: () => state.requests })
    })
  })
}

export function runCli(binPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    spawn(binPath, args, { env, stdio: 'ignore' }).on('exit', (code) => resolve(code ?? 1))
  })
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The pid the CLI recorded for the daemon serving this root (nothing else).
export function daemonPid(root: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(join(root, 'gateway.pid'), 'utf8')) as { pid?: number }).pid
  } catch {
    return undefined
  }
}

// Stop the daemon the way the app can: the CLI's own `gateway stop`, scoped to
// the home it runs in. SIGTERM is only a last resort so a probe never leaks one.
export async function stopDaemon(binPath: string, root: string): Promise<void> {
  const pid = daemonPid(root)
  if (!pid) return
  await runCli(binPath, ['gateway', 'stop'], { ...process.env, HERMES_HOME: root })
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 200))
  if (alive(pid)) process.kill(pid, 'SIGTERM')
}
