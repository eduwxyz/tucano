// The OpenTelemetry SDK and what makes spans with it. Imported only when traces are on (telemetry.ts).
// A span says what ran, for how long and at what cost. Nothing that was said ever goes in one.
import http from 'node:http'
import https from 'node:https'
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace, type Attributes, type Span } from '@opentelemetry/api'
import { OTLPTraceExporter as JsonExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPTraceExporter as ProtoExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, TracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace'
import type { Usage } from './engines/types'
import { activateTelemetry, deactivateTelemetry, warnLog, type OtelConfig, type ReplyTrace, type Telemetry, type TelemetryAbout } from './telemetry'

const QUIT_WAIT_MS = 2_000

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

export function startTelemetry(config: OtelConfig, about: TelemetryAbout): Telemetry {
  const Exporter = config.protocol === 'http/json' ? JsonExporter : ProtoExporter
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      ...config.resource,
      'service.name': config.serviceName || 'tucano',
      'service.version': about.version,
      'tucano.workspace.id': about.workspaceId,
      'tucano.mode': about.mode
    }),
    spanProcessors: [new BatchSpanProcessor({ exporter: saysWhenDown(new Exporter({ url: config.url, headers: config.headers, httpAgentOptions: coreAgent, ...(config.timeoutMs ? { timeoutMillis: config.timeoutMs } : {}) }), about.warn ?? warnLog) })]
  })
  const tracer = provider.getTracer('tucano', about.version)
  const replying = new Set<ReplyTrace>() // what's still running, for a quit to send as interrupted

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
      const handle: ReplyTrace = {
        ref: { traceId, spanId },
        movedTo(engine, model) {
          root.setAttributes({ 'tucano.harness': engine, 'gen_ai.response.model': model })
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
        end({ status, usage }) {
          if (!replying.delete(handle)) return // a quit already sent it
          for (const span of running) {
            span.setAttribute('tucano.tool.interrupted', true)
            span.end()
          }
          running.clear()
          root.setAttributes({ 'tucano.run.status': status, ...usageAttributes(usage) })
          if (status === 'failed') root.setStatus({ code: SpanStatusCode.ERROR })
          root.end()
        }
      }
      replying.add(handle)
      return handle
    },
    // A failed export was already said (saysWhenDown), and is nobody's problem here.
    flush: () => provider.forceFlush().catch(() => {}),
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
