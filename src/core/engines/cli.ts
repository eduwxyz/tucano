import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { isWin, killTree, spawnable } from '../platform'
import type { EngineEvent } from './types'
import { sandboxProvider } from '../sandbox'
import { OUT_OF_QUOTA } from '../../shared/errors'

// A parser turns the CLI's JSONL stdout into engine events. It is pure so it
// can be tested against recorded output from the real CLIs.
export interface Parser {
  line(line: string): EngineEvent[]
  end(exitCode: number | null, stderr: string): EngineEvent[]
  // A line of stderr that ends the turn, for a CLI that logs an error and then hangs without
  // exiting (OpenCode): the error, and how long to wait for output anyway (a retry that works)
  // before stopping it.
  stderr?(line: string): { message: string; waitMs: number } | undefined
}

// `stdinFile`: stdin is that file instead of `stdin`, for a CLI that reads stdin only when it's a
// file or a FIFO (Cline): a pipe from here is a socket on macOS and Linux.
export async function* runCli(opts: {
  bin: string
  args: string[]
  stdin: string
  stdinFile?: string
  cwd: string
  signal: AbortSignal
  parser: Parser
  env?: NodeJS.ProcessEnv
  sandbox?: import('../../shared/types').SandboxConfig
}): AsyncIterable<EngineEvent> {
  const sandbox = opts.sandbox ?? { provider: 'none' as const }
  const { provider: _provider, ...policy } = sandbox
  const command = sandboxProvider(sandbox.provider).wrap({ command: opts.bin, args: opts.args, cwd: opts.cwd, policy })
  const s = spawnable(command.command, command.args)
  const input = opts.stdinFile ? openSync(opts.stdinFile, 'r') : undefined
  let child: ChildProcess
  try {
    child = spawn(s.file, s.args, { cwd: command.cwd ?? opts.cwd, stdio: [input ?? 'pipe', 'pipe', 'pipe'], env: opts.env ?? process.env, windowsHide: true, windowsVerbatimArguments: s.verbatim })
  } finally {
    if (input !== undefined) closeSync(input) // the child has its own copy
  }
  // A CLI that ignores SIGTERM (stuck on the network, say) gets SIGKILL, so a stop always ends the turn.
  // On Windows the CLI may sit behind cmd.exe (an npm shim): only killing the tree reaches it.
  const kill = (): void => {
    if (isWin && child.pid) return killTree(child.pid)
    child.kill('SIGTERM')
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 5_000).unref()
  }
  opts.signal.addEventListener('abort', kill, { once: true })

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  let stderr = ''
  let partial = ''
  let fatal: string | undefined // the error that stopped it
  let failing: NodeJS.Timeout | undefined // an error logged: it stops unless output goes on
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000)
    if (!opts.parser.stderr || fatal !== undefined || failing) return
    const lines = (partial + chunk).split('\n')
    partial = lines.pop()!.slice(-8000)
    for (const line of lines) {
      const f = opts.parser.stderr(line)
      if (!f) continue
      failing = setTimeout(() => {
        fatal = f.message
        kill()
        // What it started may still hold its output open: the turn ends now.
        rl.close()
        child.stdout!.destroy()
        child.stderr!.destroy()
      }, f.waitMs)
      return
    }
  })
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      resolve(-1)
    })
  })

  child.stdin?.on('error', () => {}) // the CLI may exit before reading stdin
  child.stdin?.end(opts.stdin)

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      if (failing && fatal === undefined) {
        clearTimeout(failing) // it went on: the error wasn't the end
        failing = undefined
      }
      yield* opts.parser.line(line)
    }
    const code = await exited
    if (fatal !== undefined && !opts.signal.aborted) yield { type: 'error', message: fatal }
    else if (!opts.signal.aborted) yield* opts.parser.end(code, stderr)
  } finally {
    clearTimeout(failing)
    opts.signal.removeEventListener('abort', kill)
    if (child.exitCode === null) {
      if (isWin && child.pid) killTree(child.pid)
      else child.kill('SIGTERM')
    }
  }
}

// A CLI that stays open between turns, reading one JSON message per turn on stdin (Claude Code with
// `--input-format stream-json`). A turn's events come until its parser reports the end of it (`done`
// or `error`); a stop kills the process, since what it was doing can't be trusted to go on.
export class LiveCli {
  private readonly child: ChildProcess
  private lines: string[] = []
  private wake: (() => void) | null = null
  private stderr = ''
  private code: number | null | undefined // set once it exited
  private turning = false
  private exits: (() => void)[] = []

  constructor(opts: { bin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }) {
    const s = spawnable(opts.bin, opts.args)
    this.child = spawn(s.file, s.args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env, windowsHide: true, windowsVerbatimArguments: s.verbatim })
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8000)
    })
    this.child.stdin!.on('error', () => {}) // it may exit before reading
    createInterface({ input: this.child.stdout!, crlfDelay: Infinity }).on('line', (line) => {
      if (!this.turning || !line.trim()) return // between turns there's nothing to read
      this.lines.push(line)
      this.wake?.()
    })
    const exit = (code: number | null): void => {
      if (this.code !== undefined) return
      this.code = code
      this.wake?.()
      for (const done of this.exits.splice(0)) done()
    }
    this.child.on('close', exit)
    this.child.on('error', (err) => {
      this.stderr += `
${err.message}`
      exit(-1)
    })
  }

  get alive(): boolean {
    return this.code === undefined
  }

  get busy(): boolean {
    return this.turning
  }

  // Once it has exited (at once if it already has).
  exited(): Promise<void> {
    return this.alive ? new Promise((resolve) => this.exits.push(resolve)) : Promise.resolve()
  }

  async *turn(input: string, parser: Parser, signal: AbortSignal): AsyncIterable<EngineEvent> {
    if (this.turning) throw new Error('a turn is already running in this process')
    this.turning = true
    this.lines = []
    const stop = (): void => {
      this.kill()
      this.wake?.()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      if (this.alive && !signal.aborted) this.child.stdin!.write(input)
      for (;;) {
        if (signal.aborted) return
        const line = this.lines.shift()
        if (line !== undefined) {
          const events = parser.line(line)
          yield* events
          if (events.some((e) => e.type === 'done' || e.type === 'error')) return
          continue
        }
        if (!this.alive) {
          yield* parser.end(this.code ?? null, this.stderr)
          return
        }
        await new Promise<void>((resolve) => (this.wake = resolve))
        this.wake = null
      }
    } finally {
      signal.removeEventListener('abort', stop)
      this.turning = false
    }
  }

  kill(): void {
    if (!this.alive) return
    const pid = this.child.pid
    if (isWin && pid) return killTree(pid)
    this.child.kill('SIGTERM')
    setTimeout(() => this.alive && this.child.kill('SIGKILL'), 5_000).unref()
  }

  // No more turns: it exits on its own once stdin closes (killed if it doesn't).
  end(): void {
    if (!this.alive) return
    this.child.stdin!.end()
    setTimeout(() => this.kill(), 10_000).unref()
  }

  // The app is quitting: nothing async, the process may be gone before taskkill would run.
  killNow(): void {
    if (this.alive) this.child.kill()
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
