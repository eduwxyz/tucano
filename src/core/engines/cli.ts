import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { isWin, killTree, spawnable } from '../platform'
import type { EngineEvent } from './types'

// A parser turns the CLI's JSONL stdout into engine events. It is pure so it
// can be tested against recorded output from the real CLIs.
export interface Parser {
  line(line: string): EngineEvent[]
  end(exitCode: number | null, stderr: string): EngineEvent[]
}

export async function* runCli(opts: {
  bin: string
  args: string[]
  stdin: string
  cwd: string
  signal: AbortSignal
  parser: Parser
  env?: NodeJS.ProcessEnv
}): AsyncIterable<EngineEvent> {
  const s = spawnable(opts.bin, opts.args)
  const child = spawn(s.file, s.args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env, windowsHide: true, windowsVerbatimArguments: s.verbatim })
  // A CLI that ignores SIGTERM (stuck on the network, say) gets SIGKILL, so a stop always ends the turn.
  // On Windows the CLI may sit behind cmd.exe (an npm shim): only killing the tree reaches it.
  const kill = (): void => {
    if (isWin && child.pid) return killTree(child.pid)
    child.kill('SIGTERM')
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 5_000).unref()
  }
  opts.signal.addEventListener('abort', kill, { once: true })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000)
  })
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      resolve(-1)
    })
  })

  child.stdin.on('error', () => {}) // the CLI may exit before reading stdin
  child.stdin.end(opts.stdin)

  try {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      yield* opts.parser.line(line)
    }
    const code = await exited
    if (!opts.signal.aborted) yield* opts.parser.end(code, stderr)
  } finally {
    opts.signal.removeEventListener('abort', kill)
    if (child.exitCode === null) {
      if (isWin && child.pid) killTree(child.pid)
      else child.kill('SIGTERM')
    }
  }
}

export function parseJson(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// The CLI's own words when the subscription or the provider is out for now: Claude Code's
// "You've hit your limit" and 5-hour or weekly limit, Codex's "usage limit", Gemini's quota
// (RESOURCE_EXHAUSTED), OpenCode's and the providers' 429s. Not Tucano's own monthly limit,
// which never reaches here as an engine error.
const OUT_OF_QUOTA = /usage limit|hit your (usage )?limit|limit reached|limit_reached|quota|resource_exhausted|rate.?limit|too many requests|\b429\b|insufficient_quota|credit balance is too low|out of (extra )?usage/i
export const outOfQuota = (message: string): boolean => OUT_OF_QUOTA.test(message)

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function lastLines(text: string, n = 3): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n')
}
