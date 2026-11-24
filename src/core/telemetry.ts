// OpenTelemetry traces of the agents' work, sent to whatever OTLP endpoint the person running this
// Tucano named in the standard OTEL_* variables. Off unless one is set. A span says what ran, for how
// long and at what cost, and carries nothing of what was said.
// This file is what every core loads. The SDK is in telemetry-sdk.ts, imported only when traces are on.
import { AsyncLocalStorage } from 'node:async_hooks'
import { pageOrigin } from '../shared/vault'
import type { Engine, EngineEvent, Turn, Usage } from './engines/types'

export interface TelemetryAbout {
  workspaceId: string
  version: string
  mode: 'desktop' | 'server'
  warn?: (line: string) => void
}

export interface ReplyStart {
  agent: { id: string; name: string }
  engine: string
  model: string
  effort?: string
  conversationId: string
  jobId: string
  linkedTo?: SpanRef // the reply of another agent that asked for this one
}

// Where a span is, kept on its run so a later reply can link to it after a restart.
export interface SpanRef {
  traceId: string
  spanId: string
}

export interface ToolTrace {
  end(outcome: { ok: boolean }): void
}

export interface ReplyTrace {
  ref: SpanRef
  tool(name: string): ToolTrace
  movedTo(engine: string, model: string): void // a reserve took over: who really answered
  end(outcome: { status: string; usage?: Usage | undefined }): void
}

// A model call Tucano makes for itself, outside a reply. A job's call carries its session; a background one has none.
export interface Operation {
  operation: 'router' | 'handoff' | 'chime' | 'title' | 'memory' | 'wiki' | 'classifier'
  sessionId?: string
  conversationId?: string
}

export interface CallStart {
  harness: string
  model: string
}

export interface CallTrace {
  end(outcome: { usage?: Usage | undefined; failed?: boolean }): void
}

export interface Telemetry {
  reply(start: ReplyStart): ReplyTrace
  call(op: Operation, start: CallStart): CallTrace
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export interface OtelConfig {
  url: string
  protocol: 'http/protobuf' | 'http/json'
  headers: Record<string, string>
  serviceName?: string
  resource?: Record<string, string>
  timeoutMs?: number
}

const decoded = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value // a stray % in a token: it's the token
  }
}

// `key=value,key2=value2`, percent-encoded: how the OpenTelemetry spec writes headers and resource attributes.
function parsePairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    const key = pair.slice(0, at).trim()
    if (key) out[key] = decoded(pair.slice(at + 1).trim())
  }
  return out
}

export const warnLog = (line: string): void => console.error(`[telemetry] ${line}`)

// A server's environment is set for that server. A desktop opened from a terminal inherits the person's,
// which may hold OTEL_* for another tool (a harness's own telemetry): those alone send nothing anywhere.
export const tracesWanted = (env: NodeJS.ProcessEnv, server: boolean): boolean => server || env['TUCANO_OTEL']?.trim() === '1'

export function otelConfig(env: NodeJS.ProcessEnv, warn: (line: string) => void = warnLog): OtelConfig | undefined {
  if (env['OTEL_SDK_DISABLED']?.trim().toLowerCase() === 'true') return undefined
  if (env['OTEL_TRACES_EXPORTER']?.trim().toLowerCase() === 'none') return undefined
  const general = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim()
  const url = env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']?.trim() || (general ? `${general.replace(/\/+$/, '')}/v1/traces` : undefined)
  if (!url) return undefined
  const protocol = (env['OTEL_EXPORTER_OTLP_TRACES_PROTOCOL']?.trim() || env['OTEL_EXPORTER_OTLP_PROTOCOL']?.trim() || 'http/protobuf').toLowerCase()
  if (protocol !== 'http/protobuf' && protocol !== 'http/json') {
    warn(`traces stay off: protocol "${protocol}" isn't supported (use http/protobuf or http/json)`)
    return undefined
  }
  if (pageOrigin(url) === undefined) {
    warn('traces stay off: the OTLP endpoint is not an http(s) address')
    return undefined
  }
  if (env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']?.trim().toLowerCase() === 'true') warn("content capture isn't supported: traces carry no prompts, replies or tool data")
  const resource = parsePairs(env['OTEL_RESOURCE_ATTRIBUTES'])
  const timeoutMs = Number(env['OTEL_EXPORTER_OTLP_TRACES_TIMEOUT']?.trim() || env['OTEL_EXPORTER_OTLP_TIMEOUT']?.trim())
  return {
    url,
    protocol,
    headers: { ...parsePairs(env['OTEL_EXPORTER_OTLP_HEADERS']), ...parsePairs(env['OTEL_EXPORTER_OTLP_TRACES_HEADERS']) },
    serviceName: env['OTEL_SERVICE_NAME']?.trim() || resource['service.name'],
    resource,
    ...(timeoutMs > 0 ? { timeoutMs } : {})
  }
}

// The OTEL_* variables can hold the backend's key, and every child process (a harness, an agent's
// command) inherits this environment. So they leave it here, once, and only telemetry keeps them.
export function takeOtelEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const taken: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    if (!/^OTEL_/i.test(key)) continue
    const value = env[key]
    if (value !== undefined) taken[key] = value
    delete env[key]
  }
  return taken
}

// A core is one workspace, so it has one telemetry at most.
let active: Telemetry | undefined
export const activateTelemetry = (t: Telemetry): void => void (active = t)
export const deactivateTelemetry = (t: Telemetry): void => {
  if (active === t) active = undefined
}
export const tracing = (): boolean => active !== undefined
export const traceReply = (start: ReplyStart): ReplyTrace | undefined => active?.reply(start)
export const stopTelemetry = async (): Promise<void> => active?.shutdown()
export const flushTelemetry = async (): Promise<void> => active?.flush()

// Traces on: the SDK loads now, and nobody else pays for it. Where they go is said once, in the log, so
// an endpoint nobody meant to set (a shell profile a server was started from) doesn't go unnoticed.
export async function loadTelemetry(config: OtelConfig, about: TelemetryAbout): Promise<void> {
  const { startTelemetry } = await import('./telemetry-sdk')
  startTelemetry(config, about)
  ;(about.warn ?? warnLog)(`sending traces to ${pageOrigin(config.url)}`)
}

// The operation running here, if any. An engine call outside one and outside a reply (the connection
// test in Settings) makes no span.
const inOperation = new AsyncLocalStorage<Operation>()
export const during = <T>(op: Operation, work: () => T): T => inOperation.run(op, work)

const startCall = (start: CallStart): CallTrace | undefined => {
  const op = inOperation.getStore()
  return op && active?.call(op, start)
}

// A reply's tool at work: a classifier it asks (the browser's, to find what to click) is in that reply's session.
const inTool = new AsyncLocalStorage<Pick<Operation, 'sessionId' | 'conversationId'>>()
export const inReplyTool = <T>(reply: Pick<Operation, 'sessionId' | 'conversationId'>, work: () => T): T => inTool.run(reply, work)

// One call to a classifier: under the operation it's part of, or as a classifier call of its own.
export async function classifierCall<T>(start: CallStart, work: () => Promise<T>): Promise<T> {
  const call = active?.call(inOperation.getStore() ?? { operation: 'classifier', ...inTool.getStore() }, start)
  try {
    const answer = await work()
    call?.end({ failed: typeof (answer as { error?: unknown }).error === 'string' })
    return answer
  } catch (e) {
    call?.end({ failed: true })
    throw e
  }
}

async function* observed(events: AsyncIterable<EngineEvent>, call: CallTrace): AsyncIterable<EngineEvent> {
  let usage: Usage | undefined
  let failed = false
  try {
    for await (const ev of events) {
      if (ev.type === 'done') usage = ev.usage
      else if (ev.type === 'error') failed = true
      yield ev
    }
  } catch (e) {
    failed = true
    throw e
  } finally {
    call.end({ usage, failed })
  }
}

// Copied by descriptor, not spread: a spread would freeze a getter like Codex's `sessions`, which has to stay live.
const withRun = (engine: Engine, run: Engine['run']): Engine =>
  Object.defineProperties({} as Engine, { ...Object.getOwnPropertyDescriptors(engine), run: { value: run, enumerable: true, writable: true, configurable: true } })

const mapRuns = <K extends string>(engines: Record<K, Engine>, run: (engine: Engine, turn: Turn) => AsyncIterable<EngineEvent>): Record<K, Engine> =>
  Object.fromEntries(Object.entries<Engine>(engines).map(([k, e]) => [k, withRun(e, (turn) => run(e, turn))])) as Record<K, Engine>

// The same engines, with each call made inside an operation traced. A reply traces itself.
export const tracedEngines = <K extends string>(engines: Record<K, Engine>): Record<K, Engine> =>
  mapRuns(engines, (engine, turn) => {
    const call = startCall({ harness: engine.id, model: turn.model })
    const events = engine.run(turn)
    return call ? observed(events, call) : events
  })

// Engines for work that isn't a reply (memory, titles): every call is traced as `op`.
export const operationEngines = <K extends string>(engines: Record<K, Engine>, op: Operation): Record<K, Engine> =>
  mapRuns(engines, (engine, turn) => during(op, () => engine.run(turn)))
