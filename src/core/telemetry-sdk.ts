// The OpenTelemetry SDK and what makes spans with it. Imported only when traces are on (telemetry.ts).
// A span says what ran, for how long and at what cost. Nothing that was said ever goes in one.
import http from 'node:http'
import https from 'node:https'
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace, type Attributes, type Span } from '@opentelemetry/api'
import { OTLPTraceExporter as JsonExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPTraceExporter as ProtoExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, TracerProvider, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace'
import type { TracesTest } from '../shared/types'
import type { Usage } from './engines/types'
import { activateTelemetry, deactivateTelemetry, warnLog, type OtelConfig, type ReplyText, type ReplyTrace, type Telemetry, type TelemetryAbout } from './telemetry'

const QUIT_WAIT_MS = 2_000
const TEST_WAIT_MS = 5_000
const RETIRED_MAX_MS = 2 * 60 * 60_000 // a retired exporter's replies get this long to end before it closes anyway // the exporter retries what may pass (no answer, 429, 503) until then

// A harness that reports nothing says all zeros: that's no usage known, not a free reply.
const usageAttributes = (u: Usage | undefined): Attributes =>
  u && (u.inputTokens || u.outputTokens)
    ? {
        'gen_ai.usage.input_tokens': u.inputTokens,
        'gen_ai.usage.cache_read.input_tokens': u.cacheReadTokens,
        'gen_ai.usage.output_tokens': u.outputTokens,
        ...(u.apiCostUsd === undefined ? {} : { 'tucano.cost_usd': u.apiCostUsd })
      }
    : {}

// The same on a model call, where backends that price calls (Langfuse) look for it.
const callAttributes = (u: Usage | undefined): Attributes => {
  const counted = usageAttributes(u)
  return u?.apiCostUsd === undefined || !Object.keys(counted).length ? counted : { ...counted, 'gen_ai.usage.cost': u.apiCostUsd }
}

// The GenAI conventions' message shape, which backends show as a call's input and output.
const textAttributes = (text: ReplyText | undefined): Attributes =>
  text
    ? {
        ...(text.input ? { 'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: text.input }] }]) } : {}),
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: text.output }], finish_reason: 'stop' }])
      }
    : {}

const failed = (span: Span): void => {
  span.setStatus({ code: SpanStatusCode.ERROR })
  span.setAttribute('error.type', 'tool_error')
}

// The exporter would make an agent of its own, which skips the proxy the core set up (src/core/network.ts).
const coreAgent = (protocol: string): http.Agent | https.Agent => (protocol === 'http:' ? http.globalAgent : https.globalAgent)

// One line when the collector stops taking spans, and another only after it came back and failed again.
// The exporter's error isn't printed: it can carry the address or what the collector answered.
function saysWhenDown(exporter: SpanExporter, warn: (line: string) => void): SpanExporter {
  let down = false
  return {
    export(spans, done) {
      exporter.export(spans, (result) => {
        const ok = result.code === 0 // ExportResultCode.SUCCESS
        if (!ok && !down) warn("couldn't send traces to the OTLP endpoint; replies go on, and spans may be dropped until it answers")
        down = !ok
        done(result)
      })
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve()
  }
}

const exporterOf = (config: OtelConfig): SpanExporter => {
  const Exporter = config.protocol === 'http/json' ? JsonExporter : ProtoExporter
  return new Exporter({ url: config.url, headers: config.headers, httpAgentOptions: coreAgent, ...(config.timeoutMs ? { timeoutMillis: config.timeoutMs } : {}) })
}

const resourceOf = (config: OtelConfig, about: TelemetryAbout) =>
  resourceFromAttributes({
    ...config.resource,
    'service.name': config.serviceName || 'tucano',
    'service.version': about.version,
    'tucano.workspace.id': about.workspaceId,
    'tucano.mode': about.mode
  })

// Settings › Traces › Test connection: one span, sent at once, and what the backend made of it.
// A refusal says its HTTP status; no answer at all says none.
export async function testExport(config: OtelConfig, about: TelemetryAbout): Promise<TracesTest> {
  const exporter = exporterOf({ ...config, timeoutMs: TEST_WAIT_MS })
  const ended: ReadableSpan[] = []
  const provider = new TracerProvider({ resource: resourceOf(config, about), spanProcessors: [{ onStart: () => {}, onEnd: (s) => void ended.push(s), forceFlush: async () => {}, shutdown: async () => {} }] })
  provider.getTracer('tucano', about.version).startSpan('tucano connection test', { attributes: { 'tucano.operation': 'test' } }, ROOT_CONTEXT).end()
  const result = await new Promise<{ code: number; error?: Error }>((done) => exporter.export(ended, done))
  await exporter.shutdown().catch(() => {})
  if (result.code === 0) return { ok: true }
  const status = (result.error as { code?: unknown } | undefined)?.code
  return typeof status === 'number' ? { ok: false, status } : { ok: false }
}

export function startTelemetry(config: OtelConfig, about: TelemetryAbout): Telemetry {
  const provider = new TracerProvider({
    resource: resourceOf(config, about),
    spanProcessors: [new BatchSpanProcessor({ exporter: saysWhenDown(exporterOf(config), about.warn ?? warnLog) })]
  })
  const tracer = provider.getTracer('tucano', about.version)
  const replying = new Set<ReplyTrace>() // what's still running, for a quit to send as interrupted
  let retired: (() => void) | undefined // settings moved on: close once the last reply here ends
  const close = (): void => {
    const done = retired
    retired = undefined
    void provider.shutdown().catch(() => {}).finally(() => done?.())
  }

  const telemetry: Telemetry = {
    call(op, start) {
      const span = tracer.startSpan(
        `chat ${start.model}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': start.model,
            'tucano.operation': op.operation,
            'tucano.harness': start.harness,
            ...(op.sessionId ? { 'session.id': op.sessionId } : {}),
            ...(op.conversationId ? { 'gen_ai.conversation.id': op.conversationId } : {})
          }
        },
        ROOT_CONTEXT
      )
      return {
        end({ usage, failed: callFailed }) {
          span.setAttributes(usageAttributes(usage))
          if (callFailed) span.setStatus({ code: SpanStatusCode.ERROR })
          span.end()
        }
      }
    },
    reply(start) {
      const root = tracer.startSpan(
        `invoke_agent ${start.agent.name}`,
        {
          kind: SpanKind.INTERNAL,
          ...(start.linkedTo ? { links: [{ context: { ...start.linkedTo, traceFlags: TraceFlags.SAMPLED, isRemote: true } }] } : {}),
          attributes: {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.id': start.agent.id,
            'gen_ai.agent.name': start.agent.name,
            'gen_ai.request.model': start.model,
            'gen_ai.conversation.id': start.conversationId,
            'session.id': start.jobId,
            'tucano.operation': 'reply',
            'tucano.harness': start.engine,
            ...(start.effort ? { 'tucano.effort': start.effort } : {})
          }
        },
        ROOT_CONTEXT
      )
      const inside = trace.setSpan(ROOT_CONTEXT, root)
      const { traceId, spanId } = root.spanContext()
      const running = new Set<Span>()
      const startedAt = Date.now()
      let model = start.model // the reserve's, once it took over
      const handle: ReplyTrace = {
        ref: { traceId, spanId },
        movedTo(engine, reserve) {
          model = reserve
          root.setAttributes({ 'tucano.harness': engine, 'gen_ai.response.model': reserve })
        },
        tool(called) {
          // A connector's tool is `connector__tool`, and a connector can be named after a person.
          const name = called.split('__').at(-1)!
          const span = tracer.startSpan(`execute_tool ${name}`, { kind: SpanKind.INTERNAL, attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name } }, inside)
          running.add(span)
          return {
            end({ ok }) {
              if (!running.delete(span)) return // its reply already ended it
              if (!ok) failed(span)
              span.end()
            }
          }
        },
        end({ status, usage, text }) {
          if (!replying.delete(handle)) return // a quit already sent it
          for (const span of running) {
            span.setAttribute('tucano.tool.interrupted', true)
            span.end()
          }
          running.clear()
          const answered = usage?.responseModel ? { 'gen_ai.response.model': usage.responseModel } : {}
          root.setAttributes({ 'tucano.run.status': status, ...usageAttributes(usage), ...answered, ...textAttributes(text) }) // the text once, where a backend shows the trace's input and output
          // The reply's model calls, as one: what it cost and who answered, where a backend counts usage.
          const counted = callAttributes(usage)
          if (Object.keys(counted).length) {
            tracer
              .startSpan(`chat ${model}`, { kind: SpanKind.CLIENT, startTime: startedAt, attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': model, ...answered, ...counted } }, inside)
              .end()
          }
          if (status === 'failed') root.setStatus({ code: SpanStatusCode.ERROR })
          root.end()
          if (retired && !replying.size) close()
        }
      }
      replying.add(handle)
      return handle
    },
    // A failed export was already said (saysWhenDown), and is nobody's problem here.
    flush: () => provider.forceFlush().catch(() => {}),
    // Replies already running here end here, as they really end; new ones go to the new settings.
    retire(closed) {
      deactivateTelemetry(telemetry)
      retired = closed
      if (!replying.size) close()
      else setTimeout(() => retired && void telemetry.shutdown().finally(closed), RETIRED_MAX_MS).unref()
    },
    // A quit waits for what's queued only this long: a collector that hangs doesn't hold it.
    shutdown() {
      deactivateTelemetry(telemetry)
      for (const reply of [...replying]) reply.end({ status: 'interrupted' })
      return Promise.race([
        provider.shutdown().catch(() => {}),
        new Promise<void>((done) => setTimeout(done, QUIT_WAIT_MS).unref())
      ])
    }
  }
  activateTelemetry(telemetry)
  return telemetry
}
