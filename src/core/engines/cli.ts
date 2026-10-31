import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { isWin, killTree, spawnable, trackWslStderr } from '../platform'
import { forgetWslProcess } from '../wsl'
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
  forwardEnv?: string[]
}): AsyncIterable<EngineEvent> {
  const s = spawnable(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env ?? process.env, forwardEnv: opts.forwardEnv })
  const child = spawn(s.file, s.args, { cwd: s.wsl ? undefined : opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: s.hostEnv ?? opts.env ?? process.env, windowsHide: true, windowsVerbatimArguments: s.verbatim })
  // A CLI that ignores SIGTERM (stuck on the network, say) gets SIGKILL, so a stop always ends the turn.
  // On Windows the CLI may sit behind cmd.exe (an npm shim): only killing the tree reaches it.
  const kill = (): void => {
    if (isWin && child.pid) {
      killTree(child.pid, 'SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killTree(child.pid!, 'SIGKILL')
      }, 5_000).unref()
      return
    }
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (isWin && child.pid) killTree(child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    }, 5_000).unref()
  }
  opts.signal.addEventListener('abort', kill, { once: true })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = trackWslStderr(child.pid, s, stderr + chunk).slice(-8000)
  })
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      if (child.pid) forgetWslProcess(child.pid)
      s.cleanup?.()
      resolve(code)
    })
    child.on('error', (err) => {
      s.cleanup?.()
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

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function lastLines(text: string, n = 3): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n')
}
