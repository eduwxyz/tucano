// Codex as a long-lived `codex app-server` (JSON-RPC over stdio) instead of one `codex exec` per
// turn. One process per login and provider holds every agent's thread: a turn goes on from the
// thread's last one with only what's new (kept on disk, so a thread unloaded or a process gone is
// resumed from there), its text streams as it's written, and a process with a thread ready is
// started while the person types. Method and event names are those of `codex app-server
// generate-ts` (Codex 0.153).
//
// Isolated as `codex exec` is (see codexArgs): the same features off, read-only sandbox in the
// agent's empty folder, no approvals asked, no skills or project docs, the gateway as the only MCP
// server, and a home of the app's own. What exec takes as flags with no app-server equivalent:
// --ignore-user-config and --ignore-rules skip the config.toml and the rules in that home, so with
// either there the engine runs exec instead (see `isolated`); --ephemeral: a thread kept for a
// session is written to that home and deleted with thread/delete when the session goes, and at the
// next start whatever an earlier run left of the agents' threads (see `clean`).
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { isWin, killTree, spawnable } from '../platform'
import { lastLines, num, parseJson, type Parser } from './cli'
import type { EngineEvent, Turn, TurnShape, Usage } from './types'
import { L } from '../../shared/lang'

export interface RpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
  }
}

const METHOD_NOT_FOUND = -32601
const INIT_MS = 30_000
const REQUEST_MS = 60_000

// What the process asks of the client. With approvals off none of these should come, and nothing
// is granted if one does: no command, patch or permission; no answers for the model, no form.
function refusal(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: 'denied' }
    case 'item/tool/requestUserInput':
      return { answers: {} }
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null }
    case 'item/tool/call':
      return { success: false, contentItems: [] }
    default:
      return undefined // answered with an error
  }
}

// The process: requests and their answers by id, notifications to whoever listens to their thread.
export class AppServer {
  private readonly child: ChildProcess
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private listeners = new Map<string, Set<(m: RpcMessage) => void>>() // by thread id
  private exits: (() => void)[] = []
  private code: number | null | undefined // set once it exited
  stderr = ''
  readonly ready: Promise<void>

  constructor(opts: { bin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }) {
    const s = spawnable(opts.bin, opts.args)
    this.child = spawn(s.file, s.args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env, windowsHide: true, windowsVerbatimArguments: s.verbatim })
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8000)
    })
    this.child.stdin!.on('error', () => {}) // it may exit before reading
    createInterface({ input: this.child.stdout!, crlfDelay: Infinity }).on('line', (line) => this.receive(line))
    const exit = (code: number | null): void => {
      if (this.code !== undefined) return
      this.code = code
      const err = new RpcError(L(`O Codex saiu (código ${code ?? '?'}).`, `Codex exited (code ${code ?? '?'}).`) + (lastLines(this.stderr) ? `\n${lastLines(this.stderr)}` : ''))
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
      for (const set of this.listeners.values()) for (const l of [...set]) l({ method: '$exit' })
      for (const done of this.exits.splice(0)) done()
    }
    this.child.on('close', exit)
    this.child.on('error', (err) => {
      this.stderr += `\n${err.message}`
      exit(-1)
    })
    this.ready = this.request('initialize', { clientInfo: { name: 'tucano', title: 'Tucano', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } }, INIT_MS).then(() =>
      this.notify('initialized')
    )
    this.ready.catch(() => this.kill())
  }

  // Also asks the system: on Windows a killed process is gone a while before its exit comes, and a
  // resumed thread sent to it then would fail instead of going to a new process.
  get alive(): boolean {
    if (this.code !== undefined) return false
    const pid = this.child.pid
    if (pid === undefined) return true // still starting (or about to say it couldn't)
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  get exitCode(): number | null | undefined {
    return this.code
  }

  exited(): Promise<void> {
    return this.alive ? new Promise((resolve) => this.exits.push(resolve)) : Promise.resolve()
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = REQUEST_MS): Promise<T> {
    if (!this.alive) return Promise.reject(new RpcError(L('O Codex já tinha saído.', 'Codex had already exited.')))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(L(`O Codex não respondeu a ${method}.`, `Codex didn't answer ${method}.`)))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  // Notifications about this thread, until the returned function is called. `$exit` when the process goes.
  listen(threadId: string, fn: (m: RpcMessage) => void): () => void {
    let set = this.listeners.get(threadId)
    if (!set) this.listeners.set(threadId, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (!set.size) this.listeners.delete(threadId)
    }
  }

  kill(): void {
    if (!this.alive) return
    const pid = this.child.pid
    if (isWin && pid) return killTree(pid)
    this.child.kill('SIGTERM')
    setTimeout(() => this.alive && this.child.kill('SIGKILL'), 5_000).unref()
  }

  // The app is quitting: nothing async.
  killNow(): void {
    if (this.alive) this.child.kill()
  }

  private write(msg: unknown): void {
    if (this.alive) this.child.stdin!.write(`${JSON.stringify(msg)}\n`)
  }

  private receive(line: string): void {
    const m = parseJson(line) as RpcMessage | null
    if (!m) return
    if (m.id !== undefined && m.method === undefined) {
      const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined
      if (!p) return
      this.pending.delete(m.id as number)
      clearTimeout(p.timer)
      if (m.error) p.reject(new RpcError(m.error.message, m.error.code))
      else p.resolve(m.result)
      return
    }
    if (m.id !== undefined && m.method) {
      const result = refusal(m.method)
      this.write(result === undefined ? { id: m.id, error: { code: METHOD_NOT_FOUND, message: `${m.method} is not supported` } } : { id: m.id, result })
      return
    }
    const thread = m.params?.['threadId']
    if (typeof thread === 'string') for (const l of [...(this.listeners.get(thread) ?? [])]) l(m)
  }
}

// ---------- one turn's events ----------

type Breakdown = { input: number; cached: number; output: number }
const breakdown = (v: unknown): Breakdown => {
  const b = (v ?? {}) as Record<string, unknown>
  return { input: num(b['inputTokens']), cached: num(b['cachedInputTokens']), output: num(b['outputTokens']) }
}

// A turn's notifications as engine events: the text as it streams (each agent message its own
// paragraph), the running token count, web searches, and how it ended. Pure, so it can be fed the
// output of the real CLI. `line` takes one JSON message, `message` the same already parsed.
export function codexAppParser(): Parser & { message(m: RpcMessage): EngineEvent[]; readonly finished: boolean } {
  const items: { id: string; text: string; streamed: boolean }[] = []
  let base: Breakdown | undefined // the thread's total before this turn
  let total: Breakdown = { input: 0, cached: 0, output: 0 }
  let last: Breakdown = { input: 0, cached: 0, output: 0 }
  let finished = false

  const itemOf = (id: string): (typeof items)[number] => {
    let it = items.find((i) => i.id === id)
    if (!it) items.push((it = { id, text: '', streamed: false }))
    return it
  }
  // A paragraph break before an agent message's first words, when another one wrote before it.
  const sep = (it: (typeof items)[number]): string => (!it.text && items.some((i) => i !== it && i.text) ? '\n\n' : '')
  const usage = (): Usage => ({ inputTokens: total.input - (base?.input ?? 0), cacheReadTokens: total.cached - (base?.cached ?? 0), outputTokens: total.output - (base?.output ?? 0) })

  const message = (m: RpcMessage): EngineEvent[] => {
    if (finished) return []
    const p = m.params ?? {}
    const out: EngineEvent[] = []
    switch (m.method) {
      case 'item/agentMessage/delta': {
        const delta = typeof p['delta'] === 'string' ? p['delta'] : ''
        if (!delta) break
        const it = itemOf(String(p['itemId']))
        const d = sep(it) + delta
        it.text += delta
        it.streamed = true
        out.push({ type: 'text', delta: d })
        break
      }
      case 'item/completed': {
        const item = (p['item'] ?? {}) as Record<string, unknown>
        if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
          const it = itemOf(String(item['id']))
          // A message that came whole (no deltas), or more than its deltas said: the rest of it.
          const full = item['text']
          if (full.startsWith(it.text) && full.length > it.text.length) {
            const d = sep(it) + full.slice(it.text.length)
            it.text = full
            out.push({ type: 'text', delta: d })
          } else it.text = full
        } else if (item['type'] === 'webSearch') {
          const action = (item['action'] ?? {}) as Record<string, unknown>
          const url = typeof action['url'] === 'string' ? action['url'] : undefined
          if (url) out.push({ type: 'web', action: 'fetch', detail: url })
          else {
            const queries = Array.isArray(action['queries']) ? action['queries'].filter((q): q is string => typeof q === 'string') : []
            out.push({ type: 'web', action: 'search', detail: String(item['query'] || action['query'] || queries.join(' · ') || '') })
          }
        }
        break
      }
      case 'thread/tokenUsage/updated': {
        const u = (p['tokenUsage'] ?? {}) as Record<string, unknown>
        total = breakdown(u['total'])
        last = breakdown(u['last'])
        // `total` is the thread's, earlier turns included: this turn's starts where the first call's `last` began.
        base ??= { input: total.input - last.input, cached: total.cached - last.cached, output: total.output - last.output }
        const n = usage()
        out.push({ type: 'progress', tokens: n.inputTokens + n.outputTokens, cacheRead: n.cacheReadTokens })
        break
      }
      case 'error': {
        if (p['willRetry'] === true) break // the CLI tries again on its own
        finished = true
        out.push({ type: 'error', message: errorText(p['error']) })
        break
      }
      case 'turn/completed': {
        finished = true
        const turn = (p['turn'] ?? {}) as Record<string, unknown>
        if (turn['status'] === 'completed') {
          out.push({ type: 'done', text: items.map((i) => i.text).filter(Boolean).join('\n\n'), usage: usage(), context: last.input + last.output })
        } else if (turn['status'] === 'failed') out.push({ type: 'error', message: errorText(turn['error']) })
        // interrupted: stopped on purpose, nothing to say
        break
      }
    }
    return out
  }

  return {
    message,
    line(line) {
      const m = parseJson(line) as RpcMessage | null
      return m ? message(m) : []
    },
    end(code, stderr) {
      if (finished) return []
      finished = true
      const detail = lastLines(stderr)
      return [{ type: 'error', message: L(`O Codex saiu sem resposta (código ${code ?? '?'}).`, `Codex exited without a reply (code ${code ?? '?'}).`) + (detail ? `\n${detail}` : '') }]
    },
    get finished() {
      return finished
    }
  }
}

function errorText(e: unknown): string {
  const err = (e ?? {}) as Record<string, unknown>
  const message = typeof err['message'] === 'string' && err['message'] ? err['message'] : L('O Codex terminou com erro.', 'Codex ended with an error.')
  const details = typeof err['additionalDetails'] === 'string' && err['additionalDetails'] ? err['additionalDetails'] : ''
  return details && !message.includes(details) ? `${message}\n${details}` : message
}

const turnOf = (m: RpcMessage): unknown => m.params?.['turnId'] ?? (m.params?.['turn'] as Record<string, unknown> | undefined)?.['id']

// ---------- what each request says ----------

// The turn's text and images, in order: each image right after the block of the message it came with.
export function codexAppInput(turn: Pick<Turn, 'prompt' | 'blocks' | 'images'>): Record<string, unknown>[] {
  const images = (turn.images ?? []).filter((i) => existsSync(i.path))
  const blocks = turn.blocks?.length ? turn.blocks : [turn.prompt]
  const input: Record<string, unknown>[] = []
  blocks.forEach((text, i) => {
    if (text.trim()) input.push({ type: 'text', text, text_elements: [] })
    for (const img of images.filter((x) => x.block === i)) input.push({ type: 'localImage', path: img.path })
  })
  // Images whose block isn't there (a prompt with no blocks): after the text.
  for (const img of images.filter((x) => x.block >= blocks.length)) input.push({ type: 'localImage', path: img.path })
  if (!input.length) input.push({ type: 'text', text: turn.prompt, text_elements: [] })
  return input
}

export interface CodexAppSetup {
  // A thread's settings, for thread/start and thread/resume: model, effort, instructions, folder, web, gateway.
  thread(turn: TurnShape): Record<string, unknown>
}

// ---------- the engine's processes and threads ----------

// A thread kept after a reply waits this long for the next one loaded, with its gateway connection
// open, and only this many wait: past either it's unloaded, and the next reply resumes it from disk
// (in the same process, if it's still up). A process with no thread loaded closes after a while.
// Threads share their process (about 85 MB, a loaded thread adds little), so more wait than Claude Code's.
export const KEEP_IDLE_MS = 5 * 60_000
export const MAX_IDLE = 4
export const SPARE_MS = 2 * 60_000 // a thread started ahead of a turn with no session (the router's)
export const MAX_SPARES = 2
export const HOST_IDLE_MS = 2 * 60_000
const INTERRUPT_MS = 5_000 // a stopped turn that hasn't ended by then: its process goes

export interface Launch {
  key: string // the process's home, provider and variables: threads share a process only with the same
  home: string // CODEX_HOME
  args: string[] // what's the same for every thread (features off, skills, project docs, the provider)
  env: NodeJS.ProcessEnv
  cwd: string
}

interface Host {
  bin: string
  key: string
  home: string
  server: AppServer
  loaded: Set<string> // threads loaded in it
  turns: number
  timer?: NodeJS.Timeout
}

interface Kept {
  threadId: string
  home: string
  shape: TurnShape
  host?: Host // where it's loaded
  timer?: NodeJS.Timeout
  usedAt: number
  busy: Promise<void> // the turn or the resume going on
}

interface Spare {
  host: Host
  threadId: Promise<string>
  timer: NodeJS.Timeout
  at: number
}

// Why the app-server can't take a turn at all (an old CLI): then the turn goes to exec.
export class Unsupported extends Error {}

export class CodexApp {
  private hosts = new Map<string, Promise<Host>>()
  private servers = new Map<string, AppServer>() // each host's process, to tell a dead one before its exit comes
  private kept = new Map<string, Kept>() // by session id
  private spares = new Map<string, Spare>()
  private removing = new Set<Promise<void>>()
  private unsupported = new Set<string>() // binaries whose app-server didn't start
  private later: ((bin: string) => void) | undefined // a clean asked for before the CLI was found

  constructor(private readonly setup: CodexAppSetup) {}

  supports(bin: string): boolean {
    return !this.unsupported.has(bin)
  }

  // ---- processes ----

  private host(bin: string, l: Launch): Promise<Host> {
    const key = JSON.stringify([bin, l.key])
    const had = this.hosts.get(key)
    if (had && this.servers.get(key)?.alive !== false) return had
    const server = new AppServer({ bin, args: l.args, cwd: l.cwd, env: l.env })
    this.servers.set(key, server)
    const host: Host = { bin, key, home: l.home, server, loaded: new Set(), turns: 0 }
    const ready = server.ready.then(
      () => host,
      (e: unknown) => {
        if (this.hosts.get(key) === ready) this.hosts.delete(key)
        // It never answered initialize: this CLI has no app-server (or not this one).
        if (!(e instanceof RpcError) || e.code === undefined || e.code === METHOD_NOT_FOUND) this.unsupported.add(bin)
        throw new Unsupported(e instanceof Error ? e.message : String(e))
      }
    )
    this.hosts.set(key, ready)
    const later = this.later
    this.later = undefined
    later?.(bin)
    void server.exited().then(() => {
      if (this.hosts.get(key) === ready) this.hosts.delete(key)
      if (this.servers.get(key) === server) this.servers.delete(key)
      if (host.timer) clearTimeout(host.timer)
      for (const k of this.kept.values()) if (k.host === host) this.unpark(k)
      for (const [sk, s] of this.spares) if (s.host === host) this.dropSpare(sk)
    })
    this.idle(host)
    return ready
  }

  // A process with nothing loaded and no turn closes after a while.
  private idle(host: Host): void {
    if (host.timer) clearTimeout(host.timer)
    host.timer = undefined
    if (host.loaded.size || host.turns || !host.server.alive) return
    host.timer = setTimeout(() => {
      if (!host.loaded.size && !host.turns) host.server.kill()
    }, HOST_IDLE_MS)
    host.timer.unref()
  }

  // A new thread. Failing, it throws Unsupported: the turn can still go to exec, with everything.
  private async start(host: Host, shape: TurnShape, ephemeral: boolean): Promise<string> {
    let id: string | undefined
    try {
      const r = await host.server.request<{ thread?: { id?: string } }>('thread/start', { ...this.setup.thread(shape), ephemeral })
      id = r?.thread?.id
    } catch (e) {
      if (e instanceof RpcError && e.code === METHOD_NOT_FOUND) this.unsupported.add(host.bin)
      throw new Unsupported(e instanceof Error ? e.message : String(e))
    }
    if (!id) throw new Unsupported('thread/start: no thread id')
    host.loaded.add(id)
    this.idle(host)
    return id
  }

  private unload(host: Host | undefined, threadId: string): Promise<void> {
    if (!host) return Promise.resolve()
    host.loaded.delete(threadId)
    const gone = host.server.alive ? host.server.request('thread/unsubscribe', { threadId }).then(() => {}, () => {}) : Promise.resolve()
    this.idle(host)
    return gone
  }

  // ---- one turn on a loaded thread ----

  private async *turn(host: Host, threadId: string, turn: Turn, settled: (p: Promise<void>) => void): AsyncIterable<EngineEvent> {
    const parser = codexAppParser()
    const queue: RpcMessage[] = []
    let wake: (() => void) | null = null
    let turnId: string | undefined
    let ended!: () => void
    const completed = new Promise<void>((r) => (ended = r))
    settled(completed)
    const over = new Set<unknown>() // turns that ended, by id
    const off = host.server.listen(threadId, (m) => {
      if (m.method === 'turn/completed') over.add(turnOf(m))
      if (m.method === '$exit' || (turnId && over.has(turnId))) ended()
      queue.push(m)
      wake?.()
    })
    host.turns++
    if (host.timer) clearTimeout(host.timer)
    const interrupt = (): void => {
      wake?.()
      if (!turnId) return
      void host.server.request('turn/interrupt', { threadId, turnId }, INTERRUPT_MS).catch(() => {})
      // A turn that doesn't stop takes its process with it: a stop always ends the turn.
      const t = setTimeout(() => host.server.kill(), INTERRUPT_MS)
      t.unref()
      void completed.then(() => clearTimeout(t))
    }
    const finish = (): void => {
      off()
      ended()
      host.turns--
      this.idle(host)
    }
    try {
      if (turn.signal.aborted) return
      const started = await host.server
        .request<{ turn?: { id?: string } }>('turn/start', { threadId, input: codexAppInput(turn) })
        .then((r) => r?.turn?.id)
        .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
      if (started instanceof Error) {
        if (!turn.signal.aborted) yield { type: 'error', message: started.message }
        return
      }
      turnId = started
      if (over.has(turnId)) ended()
      if (turn.signal.aborted) return interrupt()
      turn.signal.addEventListener('abort', interrupt, { once: true })
      try {
        for (;;) {
          if (turn.signal.aborted) return
          const m = queue.shift()
          if (m) {
            if (m.method === '$exit') {
              yield* parser.end(host.server.exitCode ?? null, host.server.stderr)
              return
            }
            const id = turnOf(m)
            if (id !== undefined && id !== turnId) continue // a turn before this one, ending late
            yield* parser.message(m)
            if (parser.finished) return
            continue
          }
          await new Promise<void>((r) => (wake = r))
          wake = null
        }
      } finally {
        turn.signal.removeEventListener('abort', interrupt)
      }
    } finally {
      // Stopped: the listener stays until the turn has really ended, so the thread is free after.
      if (turn.signal.aborted && turnId && host.server.alive) void Promise.race([completed, host.server.exited()]).then(finish)
      else finish()
    }
  }

  // ---- what the engine calls ----

  // A turn with no session: a thread of its own, not written to disk, unloaded after.
  async *oneShot(bin: string, turn: Turn, l: Launch): AsyncIterable<EngineEvent> {
    const { prompt: _p, blocks: _b, images: _i, signal: _s, session: _n, ...shape } = turn
    const sk = JSON.stringify([bin, l.key, this.setup.thread(shape)])
    const spare = this.spares.get(sk)
    let host: Host
    let threadId: string
    if (spare?.host.server.alive) {
      this.spares.delete(sk)
      clearTimeout(spare.timer)
      host = spare.host
      try {
        threadId = await spare.threadId
      } catch {
        return yield* this.oneShot(bin, turn, l) // that one didn't start: a new one
      }
    } else {
      host = await this.host(bin, l)
      threadId = await this.start(host, shape, true)
    }
    try {
      yield* this.turn(host, threadId, turn, () => {})
    } finally {
      void this.unload(host, threadId)
    }
  }

  // A turn of a kept session: a new thread when it starts, the same one when it goes on.
  async *session(bin: string, turn: Turn & { session: NonNullable<Turn['session']> }, l: Launch): AsyncIterable<EngineEvent> {
    const { prompt: _p, blocks: _b, images: _i, signal: _s, session, ...shape } = turn
    let k = this.kept.get(session.id)
    if (!session.resume || !k) {
      if (session.resume) {
        yield { type: 'error', message: L('O Codex não tem mais essa conversa; ela recomeça na próxima resposta.', "Codex no longer has this conversation; it starts over on the next reply.") }
        return
      }
      if (k) this.release(bin, session.id, async () => l)
      const host = await this.host(bin, l)
      const threadId = await this.start(host, shape, false)
      k = { threadId, home: l.home, shape, host, usedAt: Date.now(), busy: Promise.resolve() }
      this.kept.set(session.id, k)
    } else {
      await k.busy // a rewarm resuming it, or a stopped turn still ending
      if (this.kept.get(session.id) !== k) {
        yield { type: 'error', message: L('O Codex não tem mais essa conversa; ela recomeça na próxima resposta.', "Codex no longer has this conversation; it starts over on the next reply.") }
        return
      }
      k.shape = shape
      const err = await this.load(bin, k, l)
      if (err) {
        yield { type: 'error', message: err }
        return
      }
    }
    if (k.timer) clearTimeout(k.timer)
    k.timer = undefined // in a turn, not waiting
    const current = k
    const host = current.host!
    let done = false
    try {
      for await (const ev of this.turn(host, current.threadId, turn, (p) => (current.busy = p))) {
        if (ev.type === 'done') done = true
        yield ev
      }
    } finally {
      if (this.kept.get(session.id) === current) {
        if (done && session.keep && !turn.signal.aborted && host.server.alive) this.park(current)
        else
          void current.busy.then(() => {
            if (this.kept.get(session.id) === current && current.host === host) this.unpark(current)
          })
      }
    }
  }

  // The thread loaded in a process with this turn's settings: as it is, or resumed from disk.
  private async load(bin: string, k: Kept, l: Launch): Promise<string | undefined> {
    const key = JSON.stringify([bin, l.key])
    if (k.host?.server.alive && k.host.key === key) return
    if (k.host) {
      this.unpark(k) // another process (the provider changed): it leaves that one first
      await k.busy
    }
    try {
      const host = await this.host(bin, l)
      await host.server.request('thread/resume', { threadId: k.threadId, ...this.setup.thread(k.shape) })
      host.loaded.add(k.threadId)
      k.host = host
      this.idle(host)
      return
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  private park(k: Kept): void {
    if (k.timer) clearTimeout(k.timer)
    k.usedAt = Date.now()
    k.timer = setTimeout(() => this.unpark(k), KEEP_IDLE_MS)
    k.timer.unref()
    // Waiting past the cap: the one waiting longest is unloaded.
    const idle = [...this.kept.values()].filter((x) => x.host && x.timer).sort((a, b) => a.usedAt - b.usedAt)
    for (const x of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) this.unpark(x)
  }

  // Unloaded; what comes next for the thread waits for that (a resume, its deletion).
  private unpark(k: Kept): void {
    if (k.timer) clearTimeout(k.timer)
    k.timer = undefined
    const host = k.host
    k.host = undefined
    if (!host) return
    const gone = this.unload(host, k.threadId)
    k.busy = Promise.all([k.busy, gone]).then(() => {})
  }

  warm(bin: string, shape: TurnShape, l: Launch): void {
    const sk = JSON.stringify([bin, l.key, this.setup.thread(shape)])
    const had = this.spares.get(sk)
    if (had?.host.server.alive) {
      clearTimeout(had.timer)
      had.timer = setTimeout(() => this.spares.get(sk) === had && this.dropSpare(sk), SPARE_MS)
      had.timer.unref()
      return
    }
    if (had) this.dropSpare(sk)
    void this.host(bin, l).then(
      (host) => {
        if (this.spares.has(sk)) return
        const threadId = this.start(host, shape, true)
        threadId.catch(() => this.spares.get(sk) === spare && this.dropSpare(sk))
        const spare: Spare = { host, threadId, at: Date.now(), timer: setTimeout(() => this.spares.get(sk) === spare && this.dropSpare(sk), SPARE_MS) }
        spare.timer.unref()
        this.spares.set(sk, spare)
        const oldest = [...this.spares].sort((a, b) => a[1].at - b[1].at)
        for (const [o] of oldest.slice(0, Math.max(0, oldest.length - MAX_SPARES))) this.dropSpare(o)
      },
      () => {}
    )
  }

  private dropSpare(sk: string): void {
    const s = this.spares.get(sk)
    if (!s) return
    this.spares.delete(sk)
    clearTimeout(s.timer)
    void s.threadId.then(
      (id) => this.unload(s.host, id),
      () => {}
    )
  }

  // The session's thread loaded again ahead of its next turn, if it was unloaded.
  rewarm(bin: string, sessionId: string, launch: (shape: TurnShape) => Promise<Launch>): void {
    const k = this.kept.get(sessionId)
    if (!k) return
    if (k.host?.server.alive) {
      if (k.timer) this.park(k) // loaded and waiting: it waits a while longer
      return
    }
    const step = k.busy.then(async () => {
      if (this.kept.get(sessionId) !== k || k.host) return
      if (!(await this.load(bin, k, await launch(k.shape)))) this.park(k)
    })
    k.busy = step.catch(() => {})
  }

  // A session that won't be resumed: its thread leaves the process and the disk.
  release(bin: string | undefined, sessionId: string, launch: (shape: TurnShape) => Promise<Launch>): void {
    const k = this.kept.get(sessionId)
    if (!k) return
    this.kept.delete(sessionId)
    if (k.timer) clearTimeout(k.timer)
    const gone = k.busy
      .then(async () => {
        const host = k.host?.server.alive ? k.host : bin ? await this.host(bin, await launch(k.shape)) : undefined
        if (!host) return
        k.host = undefined
        host.loaded.delete(k.threadId)
        await host.server.request('thread/unsubscribe', { threadId: k.threadId }).catch(() => {})
        await host.server.request('thread/delete', { threadId: k.threadId }).catch(() => {})
        this.idle(host)
      })
      .catch(() => {})
    this.removing.add(gone)
    void gone.finally(() => this.removing.delete(gone))
  }

  // Threads an earlier run of the app left on disk, of the agents under workDir: deleted through
  // a process of their home's, which takes the thread's history out of its databases too.
  clean(bin: string | undefined, workDir: string, homes: string[], launch: (home: string) => Launch): void {
    if (!bin) {
      this.later = (b) => this.clean(b, workDir, homes, launch) // at the app's start the CLI may not be found yet
      return
    }
    const dir = resolve(workDir)
    const mine = new Set([...this.kept.values()].map((k) => k.threadId))
    for (const home of homes) {
      const left = leftThreads(home).filter((t) => t.cwd && resolve(dirname(t.cwd)) === dir && !mine.has(t.id))
      if (!left.length) continue
      const gone = this.host(bin, launch(home))
        .then(async (host) => {
          for (const t of left) await host.server.request('thread/delete', { threadId: t.id }).catch(() => {})
          this.idle(host)
        })
        .catch(() => {})
      this.removing.add(gone)
      void gone.finally(() => this.removing.delete(gone))
    }
  }

  async settle(): Promise<void> {
    await Promise.all([...this.removing])
  }

  dispose(): void {
    for (const k of this.kept.values()) if (k.timer) clearTimeout(k.timer)
    for (const s of this.spares.values()) clearTimeout(s.timer)
    this.kept.clear()
    this.spares.clear()
    for (const h of this.hosts.values()) void h.then((host) => host.server.killNow(), () => {})
    this.hosts.clear()
  }
}

// The threads written to a Codex home (CODEX_HOME), with the folder each ran in, from the first
// line of its file (sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl).
export function leftThreads(home: string): { id: string; cwd?: string; file: string }[] {
  const out: { id: string; cwd?: string; file: string }[] = []
  const walk = (d: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(d, n)
      if (depth < 3) walk(p, depth + 1)
      else if (/^rollout-.*\.jsonl$/.test(n)) {
        const meta = parseJson(firstLine(p))
        const payload = (meta?.['payload'] ?? {}) as Record<string, unknown>
        if (meta?.['type'] !== 'session_meta' || typeof payload['id'] !== 'string') continue
        out.push({ id: payload['id'], ...(typeof payload['cwd'] === 'string' ? { cwd: payload['cwd'] } : {}), file: p })
      }
    }
  }
  walk(join(home, 'sessions'), 0)
  return out
}

// The first line of a file, read in pieces (the first line of a thread holds Codex's whole prompt).
function firstLine(file: string, max = 4 << 20): string {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(64 << 10)
    for (let read = 0; read < max; ) {
      const n = readSync(fd, buf, 0, buf.length, read)
      if (!n) break
      const nl = buf.subarray(0, n).indexOf(10)
      chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? n : nl)))
      if (nl >= 0) break
      read += n
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
