import { existsSync } from 'node:fs'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import { L } from '../../shared/lang'
import type { Effort } from '../../shared/types'
import type { Engine, EngineEvent, Turn } from './types'

// The Quebra-Galho CLI (`qg`). Headless (`exec --output-format stream-json`)
// prints one JSON event per line and exits. The login stays the person's
// (their saved key), and each turn runs in the per-agent folder the app gives.
// Tools are hidden with --plan (read-only, no shell): the agent's tools reach
// it through the person's setup, not the app's gateway — QG has no MCP
// client, so `turn.mcpUrl` is ignored here.

// stream-json (schemaVersion 2): run_start {model, provider}; reasoning {delta}
// (skipped); text {delta}; usage {promptTokens, completionTokens,
// cachedInputTokens, costUsd}, once per model call; final {text}; run_end
// {status, exitCode}; error {message}. promptTokens leaves the cache out.
export function qgParser(): Parser {
  let text = ''
  let input = 0
  let output = 0
  let cacheRead = 0
  let cost = 0
  let error: string | undefined

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      const type = ev['type']
      if (type === 'text' && typeof ev['delta'] === 'string' && ev['delta']) {
        text += ev['delta']
        out.push({ type: 'text', delta: ev['delta'] })
      } else if (type === 'error' && typeof ev['message'] === 'string') {
        error = ev['message']
      } else if (type === 'usage') {
        const read = num(ev['cachedInputTokens'])
        cacheRead += read
        input += num(ev['promptTokens']) + read + num(ev['cacheWriteTokens'])
        output += num(ev['completionTokens'])
        cost += num(ev['costUsd'])
        out.push({ type: 'progress', tokens: input + output, cacheRead })
      }
      return out
    },
    end(code, stderr) {
      if (error) return [{ type: 'error', message: error }]
      if (code === 0) return [{ type: 'done', text, usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, ...(cost ? { apiCostUsd: cost } : {}) } }]
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O QG saiu sem resposta (código ${code ?? '?'}).`, `QG exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    }
  }
}

const EFFORT: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }

// Isolated like the others: --plan hides write and shell tools (read-only),
// so the agent can't touch files outside what the person's QG setup allows.
export function qgArgs(turn: Pick<Turn, 'model' | 'effort' | 'images'>): string[] {
  return [
    'exec',
    '--plan',
    '--output-format', 'stream-json',
    '--reasoning-effort', EFFORT[turn.effort],
    ...(turn.model ? ['-m', turn.model] : []),
    ...(turn.images ?? []).filter((i) => existsSync(i.path)).flatMap((i) => ['--image', i.path])
  ]
}

export function qgEngine(bin: () => string | undefined, shellEnv: () => Promise<NodeJS.ProcessEnv> = async () => ({})): Engine {
  return {
    id: 'qg',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: L('O QG não está instalado. Veja em Configurações.', "QG isn't installed. See Settings.") }
        return
      }
      // The saved key may live in the person's shell, which an app opened from Finder doesn't get.
      const env = { ...process.env, ...(await shellEnv()) }
      yield* runCli({ bin: path, args: qgArgs(turn), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: qgParser(), env })
    }
  }
}
