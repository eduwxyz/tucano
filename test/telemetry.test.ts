import { readFileSync } from 'node:fs'
import http, { createServer } from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { attrsOf, collector, type Received } from './helpers/otlp'
import { ask, type ClassifierQuestion } from '../src/core/classifiers'
import type { ClassifierConfig } from '../src/shared/classifiers'
import type { Engine, Turn } from '../src/core/engines/types'
import { jevBox } from '../src/core/jev'
import { makeCertificate } from '../src/main/self-signed'
import { during, flushTelemetry, inReplyTool, loadTelemetry, operationEngines, otelConfig, reloadTelemetry, stopTelemetry, takeOtelEnv, traceReply, tracedEngines, tracesWanted, type OtelConfig, type Telemetry } from '../src/core/telemetry'
import { startTelemetry } from '../src/core/telemetry-sdk'

const jsonConfig = (url: string): OtelConfig => ({ url, protocol: 'http/json', headers: {} })
const about = { workspaceId: 'w1', version: '1.2.3', mode: 'desktop' as const }
const clara = { agent: { id: 'a1', name: 'Clara' }, engine: 'claude', model: 'opus', effort: 'high', conversationId: 'conv1', jobId: 'job1' }
const usage = { inputTokens: 8200, cacheReadTokens: 3000, outputTokens: 640, apiCostUsd: 0.12 }

describe('keeping the credentials away from agents', () => {
  it('takes every OTEL_ variable out of the environment and hands them over once', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=secret', otel_service_name: 'lower', HOTEL_NAME: 'kept' }

    const taken = takeOtelEnv(env)

    expect(taken).toEqual({ OTEL_EXPORTER_OTLP_HEADERS: 'authorization=secret', otel_service_name: 'lower' })
    expect(env).toEqual({ PATH: '/bin', HOTEL_NAME: 'kept' })
    expect(takeOtelEnv(env)).toEqual({})
  })
})

describe('a collector that fails', () => {
  it('is said once per streak of failures, with no header value in the log', async () => {
    let status = 500
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => res.writeHead(status, { 'content-type': 'application/json' }).end('{}'))
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`
    const said: string[] = []
    const t = startTelemetry({ url, protocol: 'http/json', headers: { authorization: 'Bearer s3cret-token' } }, { ...about, warn: (line) => void said.push(line) })
    const once = async (): Promise<void> => {
      t.reply(clara).end({ status: 'done' })
      await t.flush()
    }

    await once()
    await once()
    expect(said).toHaveLength(1)
    status = 200
    await once()
    status = 500
    await once()
    expect(said).toHaveLength(2)
    expect(said.join('\n')).not.toContain('s3cret-token')

    status = 200
    await t.shutdown()
    await new Promise((ok) => server.close(ok))
  })
})

describe('the wire format', () => {
  it('sends OTLP protobuf by default, with the headers it was given', async () => {
    const got: { type?: string; auth?: string; bytes: number }[] = []
    const server = createServer((req, res) => {
      let bytes = 0
      req.on('data', (c: Buffer) => (bytes += c.length))
      req.on('end', () => {
        got.push({ type: req.headers['content-type'], auth: req.headers['authorization'], bytes })
        res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end()
      })
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const config = otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20k' })!
    const t = startTelemetry(config, about)

    t.reply(clara).end({ status: 'done', usage })
    await t.shutdown()
    server.closeAllConnections()
    await new Promise((ok) => server.close(ok))

    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'application/x-protobuf', auth: 'Bearer k' })
    expect(got[0]!.bytes).toBeGreaterThan(0)
  })
})

describe('a company network', () => {
  const api = http as unknown as { setGlobalProxyFromEnv?: (env: Record<string, string>) => () => void }

  it.skipIf(!api.setGlobalProxyFromEnv)('sends traces through the same proxy as the core’s other requests', async () => {
    const seen: string[] = []
    const proxy = createServer((req, res) => {
      seen.push(req.url ?? '')
      req.resume()
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'))
    })
    await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok))
    const restore = api.setGlobalProxyFromEnv!({ HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, NO_PROXY: '' })
    try {
      const t = startTelemetry({ url: 'http://collector.invalid:4318/v1/traces', protocol: 'http/json', headers: {} }, { ...about, warn: () => {} })
      t.reply(clara).end({ status: 'done' })
      await t.shutdown()
    } finally {
      restore()
      proxy.closeAllConnections()
      await new Promise((ok) => proxy.close(ok))
    }
    expect(seen).toEqual(['http://collector.invalid:4318/v1/traces'])
  })
})

describe('a company network with its own certificates', () => {
  const api = tls as unknown as { getCACertificates?: (type?: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void }

  it.skipIf(!api.setDefaultCACertificates)('reaches an HTTPS collector signed by a root the core was told to trust', async () => {
    const { key, cert } = makeCertificate('localhost', ['localhost'])
    let got = 0
    const server = https.createServer({ key, cert }, (req, res) => {
      req.resume()
      req.on('end', () => {
        got++
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const before = api.getCACertificates!('default')
    api.setDefaultCACertificates!([...before, cert])
    try {
      const t = startTelemetry({ url: `https://localhost:${(server.address() as AddressInfo).port}/v1/traces`, protocol: 'http/json', headers: {} }, { ...about, warn: () => {} })
      t.reply(clara).end({ status: 'done' })
      await t.shutdown()
    } finally {
      api.setDefaultCACertificates!(before)
      server.closeAllConnections()
      await new Promise((ok) => server.close(ok))
    }
    expect(got).toBe(1)
  })
})

describe('the queue', () => {
  it('holds a bounded number of spans, and drops the rest', async () => {
    const sink = await collector()
    const t = startTelemetry(jsonConfig(sink.url), about)

    for (let i = 0; i < 5_000; i++) t.reply(clara).end({ status: 'done' }) // all before the queue can leave
    await t.shutdown()
    await sink.close()

    expect(sink.spans.length).toBeGreaterThan(0)
    expect(sink.spans.length).toBeLessThanOrEqual(2_048 + 512) // the queue, and the batch already on its way out
  })

})

describe('docs/server.md', () => {
  it('names every variable, and says spans carry no content', () => {
    const docs = readFileSync(join(import.meta.dirname, '..', 'docs', 'server.md'), 'utf8')
    for (const v of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TIMEOUT', 'OTEL_SERVICE_NAME', 'OTEL_RESOURCE_ATTRIBUTES', 'OTEL_SDK_DISABLED', 'OTEL_TRACES_EXPORTER', 'TUCANO_OTEL']) expect(docs).toContain(v)
    expect(docs).toContain('Spans carry no content')
  })
})

describe('a collector that hangs', () => {
  it('holds neither a reply nor the quit', async () => {
    const server = createServer(() => {}) // takes the request and never answers
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`
    const t = startTelemetry({ url, protocol: 'http/json', headers: {} }, { ...about, warn: () => {} })

    const started = Date.now()
    const reply = t.reply(clara)
    reply.tool('bash').end({ ok: true })
    reply.end({ status: 'done', usage })
    expect(Date.now() - started).toBeLessThan(100)

    const quitting = Date.now()
    await t.shutdown()
    expect(Date.now() - quitting).toBeLessThan(3_000)

    server.closeAllConnections()
    await new Promise((ok) => server.close(ok))
  })
})

describe('a reply as a trace', () => {
  let telemetry: Telemetry | undefined
  let sink: Awaited<ReturnType<typeof collector>> | undefined

  afterEach(async () => {
    await telemetry?.shutdown()
    await sink?.close()
    telemetry = undefined
    sink = undefined
  })

  it('reaches the collector as one trace: the reply, its model call and a child span per tool', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    const reply = telemetry.reply(clara)
    reply.tool('bash').end({ ok: true })
    reply.tool('web_read').end({ ok: false })
    reply.end({ status: 'done', usage })
    await telemetry.shutdown()

    expect(sink.spans).toHaveLength(4)
    const root = sink.spans.find((s) => s.span.name === 'invoke_agent Clara')!
    const bash = sink.spans.find((s) => s.span.name === 'execute_tool bash')!
    const web = sink.spans.find((s) => s.span.name === 'execute_tool web_read')!
    expect(new Set(sink.spans.map((s) => s.span.traceId)).size).toBe(1)
    expect(root.span.parentSpanId || undefined).toBeUndefined()
    expect(bash.span.parentSpanId).toBe(root.span.spanId)
    expect(web.span.parentSpanId).toBe(root.span.spanId)
    expect(attrsOf(root)).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': 'a1',
      'gen_ai.agent.name': 'Clara',
      'gen_ai.request.model': 'opus',
      'gen_ai.conversation.id': 'conv1',
      'gen_ai.usage.input_tokens': 8200,
      'gen_ai.usage.cache_read.input_tokens': 3000,
      'gen_ai.usage.output_tokens': 640,
      'session.id': 'job1',
      'tucano.operation': 'reply',
      'tucano.harness': 'claude',
      'tucano.effort': 'high',
      'tucano.run.status': 'done',
      'tucano.cost_usd': 0.12
    })
    expect(attrsOf(bash)).toMatchObject({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'bash' })
    expect(bash.span.status?.code ?? 0).not.toBe(2)
    expect(web.span.status?.code).toBe(2)
    expect(root.resource).toMatchObject({ 'service.name': 'tucano', 'service.version': '1.2.3', 'tucano.workspace.id': 'w1', 'tucano.mode': 'desktop' })
  })

  it('gives each reply of a job its own trace in one session, linked to the reply that asked', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    const asking = telemetry.reply(clara)
    const asked = { traceId: asking.ref.traceId, spanId: asking.ref.spanId } // as stored on the run, across a restart
    asking.end({ status: 'done', usage })
    telemetry.reply({ ...clara, agent: { id: 'a2', name: 'Bento' }, linkedTo: asked }).end({ status: 'done', usage })
    await telemetry.shutdown()

    const first = sink.spans.find((s) => s.span.name === 'invoke_agent Clara')!
    const second = sink.spans.find((s) => s.span.name === 'invoke_agent Bento')!
    expect(second.span.traceId).not.toBe(first.span.traceId)
    expect(attrsOf(second)['session.id']).toBe(attrsOf(first)['session.id'])
    expect(second.span.links).toEqual([expect.objectContaining({ traceId: first.span.traceId, spanId: first.span.spanId })])
  })

  it('names the service and adds the resource attributes the standard variables give', async () => {
    sink = await collector()
    const config = otelConfig({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: sink.url,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_SERVICE_NAME: 'tucano-prod',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=prod,service.name=ignored,tucano.workspace.id=forged,team=a%20b',
      OTEL_EXPORTER_OTLP_TIMEOUT: '9000',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '1500'
    })!
    expect(config.timeoutMs).toBe(1500)
    telemetry = startTelemetry(config, about)

    telemetry.reply(clara).end({ status: 'done' })
    await telemetry.shutdown()

    expect(sink.spans[0]!.resource).toMatchObject({ 'service.name': 'tucano-prod', 'deployment.environment.name': 'prod', team: 'a b', 'tucano.workspace.id': 'w1' })
  })

  it('traces a model call made for an internal operation, and none outside one', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)
    const engine: Engine = {
      id: 'claude',
      async *run() {
        yield { type: 'text', delta: 'Clara' }
        yield { type: 'done', text: 'Clara', usage }
      }
    }
    const { claude } = tracedEngines({ claude: engine })
    const turn: Turn = { model: 'haiku', effort: 'low', system: 'pick one', prompt: 'who answers?', cwd: '/tmp', signal: new AbortController().signal }
    const read = async (): Promise<string[]> => {
      const seen: string[] = []
      for await (const ev of claude.run(turn)) seen.push(ev.type)
      return seen
    }

    const inside = await during({ operation: 'router', sessionId: 'job1', conversationId: 'conv1' }, read)
    const outside = await read() // the connection test in Settings
    await telemetry.shutdown()

    expect(inside).toEqual(['text', 'done'])
    expect(outside).toEqual(['text', 'done'])
    expect(sink.spans).toHaveLength(1)
    expect(sink.spans[0]!.span.name).toBe('chat haiku')
    expect(attrsOf(sink.spans[0]!)).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'haiku',
      'gen_ai.usage.input_tokens': 8200,
      'session.id': 'job1',
      'gen_ai.conversation.id': 'conv1',
      'tucano.operation': 'router',
      'tucano.harness': 'claude'
    })
    expect(JSON.stringify(sink.spans)).not.toContain('who answers?')
  })

  it('hands background work engines whose every call is traced as its operation, with no session', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)
    const engine: Engine = {
      id: 'claude',
      async *run() {
        yield { type: 'done', text: 'ok', usage }
      }
    }
    const turn: Turn = { model: 'haiku', effort: 'low', system: 's', prompt: 'p', cwd: '/tmp', signal: new AbortController().signal }
    const traced = tracedEngines({ claude: engine })

    for await (const _ of operationEngines(traced, { operation: 'memory' }).claude.run(turn)) void _
    await telemetry.shutdown()
    for await (const _ of operationEngines(traced, { operation: 'title' }).claude.run(turn)) void _ // traces are off now

    expect(sink.spans).toHaveLength(1)
    expect(attrsOf(sink.spans[0]!)['tucano.operation']).toBe('memory')
    expect(attrsOf(sink.spans[0]!)).not.toHaveProperty('session.id')
  })

  it('traces a classifier call under its operation, or as a classifier call of its own, and none that was never sent', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)
    const target: ClassifierConfig = { id: 'c1', provider: 'openai', name: 'Mini', model: 'gpt-mini' }
    const answer = async (): Promise<Response> => new Response(JSON.stringify({ answers: [{ name: 'who', value: 'clara' }] }), { status: 200 })
    const asking = { target, key: 'k', state: { pedido: 'quem responde' }, questions: [{ name: 'who', type: 'yesno', instructions: 'Who?' }] as ClassifierQuestion[], timeoutMs: 1000, fetch: answer as unknown as typeof fetch }

    await during({ operation: 'classifier', conversationId: 'conv1' }, () => ask(asking))
    await ask(asking) // what the browser asks, with no operation around it
    await jevBox({ key: 'k', target: 'o botão', classifier: target, jpeg: 'x', fetch: answer as unknown as typeof fetch }) // OpenAI can't: nothing is sent
    await telemetry.shutdown()

    expect(sink.spans).toHaveLength(2)
    for (const s of sink.spans) {
      expect(s.span.name).toBe('chat gpt-mini')
      expect(attrsOf(s)).toMatchObject({ 'tucano.operation': 'classifier', 'tucano.harness': 'openai', 'gen_ai.request.model': 'gpt-mini' })
    }
    expect(sink.spans.filter((s) => attrsOf(s)['gen_ai.conversation.id'] === 'conv1')).toHaveLength(1)
    expect(JSON.stringify(sink.spans)).not.toContain('quem responde')
  })

  it('marks only a failed reply as an error, and leaves out tokens a harness did not report', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    for (const status of ['failed', 'stopped', 'limit_reached', 'waiting_input']) telemetry.reply({ ...clara, agent: { id: status, name: status } }).end({ status, usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } })
    await telemetry.shutdown()

    const of = (name: string): Received => sink!.spans.find((s) => s.span.name === `invoke_agent ${name}`)!
    expect(of('failed').span.status?.code).toBe(2)
    for (const status of ['stopped', 'limit_reached', 'waiting_input']) {
      expect(of(status).span.status?.code ?? 0).not.toBe(2)
      expect(attrsOf(of(status))['tucano.run.status']).toBe(status)
    }
    expect(attrsOf(of('stopped'))).not.toHaveProperty('gen_ai.usage.input_tokens')
  })

  it('measures how long a tool really took', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    const reply = telemetry.reply(clara)
    const tool = reply.tool('bash')
    await new Promise((ok) => setTimeout(ok, 40))
    tool.end({ ok: true })
    reply.end({ status: 'done' })
    await telemetry.shutdown()

    const span = sink.spans.find((s) => s.span.name === 'execute_tool bash')!.span
    const ms = Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n)
    expect(ms).toBeGreaterThanOrEqual(30)
    expect(ms).toBeLessThan(2_000)
  })

  it('keeps the tool calls of parallel replies on the reply that made them', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    const a = telemetry.reply(clara)
    const b = telemetry.reply({ ...clara, agent: { id: 'a2', name: 'Bento' } })
    const fromA = a.tool('tool_a')
    const fromB = b.tool('tool_b')
    fromB.end({ ok: true })
    fromA.end({ ok: true })
    b.end({ status: 'done' })
    a.end({ status: 'done' })
    await telemetry.shutdown()

    const of = (name: string): Received => sink!.spans.find((s) => s.span.name === name)!
    expect(of('execute_tool tool_a').span.parentSpanId).toBe(of('invoke_agent Clara').span.spanId)
    expect(of('execute_tool tool_b').span.parentSpanId).toBe(of('invoke_agent Bento').span.spanId)
  })

  it('sends a reply still running at a quit as interrupted, once', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    telemetry.reply({ ...clara, agent: { id: 'a2', name: 'Bento' } }).end({ status: 'done' })
    const running = telemetry.reply(clara)
    await telemetry.shutdown()
    running.end({ status: 'done' }) // too late: it was already told

    expect(sink.spans).toHaveLength(2)
    expect(attrsOf(sink.spans.find((s) => s.span.name === 'invoke_agent Clara')!)['tucano.run.status']).toBe('interrupted')
  })

  it('names only the tool, not the connector: a connector can be named after a person', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    const reply = telemetry.reply(clara)
    reply.tool('gmail_da_ana__send').end({ ok: true })
    reply.end({ status: 'done' })
    await telemetry.shutdown()

    expect(JSON.stringify(sink.spans)).not.toContain('gmail_da_ana')
    expect(sink.spans.some((s) => s.span.name === 'execute_tool send')).toBe(true)
  })

  it('leaves what an engine says about its sessions live, as it changes', () => {
    let keeps = false
    const engine = {
      id: 'codex',
      get sessions() {
        return keeps
      },
      run: async function* () {}
    } as unknown as Engine
    const traced = tracedEngines({ codex: engine })
    const scoped = operationEngines(traced, { operation: 'memory' })

    keeps = true
    expect(traced.codex.sessions).toBe(true)
    expect(scoped.codex.sessions).toBe(true)
    keeps = false
    expect(traced.codex.sessions).toBe(false)
  })

  it('puts a classifier call made by a reply’s tool in that reply’s session', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)
    const target: ClassifierConfig = { id: 'c1', provider: 'openai', name: 'Mini', model: 'gpt-mini' }
    const answer = async (): Promise<Response> => new Response(JSON.stringify({ answers: [{ name: 'who', value: 'clara' }] }), { status: 200 })

    await inReplyTool({ sessionId: 'job1', conversationId: 'conv1' }, () => ask({ target, key: 'k', state: {}, questions: [{ name: 'who', type: 'yesno', instructions: 'Who?' }], timeoutMs: 1000, fetch: answer as unknown as typeof fetch }))
    await telemetry.shutdown()

    expect(attrsOf(sink.spans[0]!)).toMatchObject({ 'tucano.operation': 'classifier', 'session.id': 'job1', 'gen_ai.conversation.id': 'conv1' })
  })

  it('names the workspace of each core, so two workspaces read apart', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)
    const other = startTelemetry(jsonConfig(sink.url), { ...about, workspaceId: 'w2' })

    telemetry.reply(clara).end({ status: 'done' })
    other.reply(clara).end({ status: 'done' })
    await Promise.all([telemetry.shutdown(), other.shutdown()])

    expect(new Set(sink.spans.map((s) => s.resource['tucano.workspace.id']))).toEqual(new Set(['w1', 'w2']))
  })

  it('puts the model call inside the reply as a child span, with its tokens, cost and the model that answered', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    telemetry.reply(clara).end({ status: 'done', usage: { ...usage, responseModel: 'claude-opus-4-1-20250805' } })
    await telemetry.shutdown()

    const root = sink.spans.find((s) => s.span.name === 'invoke_agent Clara')!
    const call = sink.spans.find((s) => s.span.name === 'chat opus')!
    expect(call.span.parentSpanId).toBe(root.span.spanId)
    expect(attrsOf(call)).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'opus',
      'gen_ai.response.model': 'claude-opus-4-1-20250805',
      'gen_ai.usage.input_tokens': 8200,
      'gen_ai.usage.cache_read.input_tokens': 3000,
      'gen_ai.usage.output_tokens': 640,
      'gen_ai.usage.cost': 0.12
    })
    expect(attrsOf(root)).toMatchObject({ 'gen_ai.response.model': 'claude-opus-4-1-20250805' })
  })

  it('says which model really answered when a reply moved to its reserve', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    const reply = telemetry.reply(clara)
    reply.movedTo('codex', 'gpt-5.6-luna')
    reply.end({ status: 'done', usage })
    telemetry.reply({ ...clara, agent: { id: 'a2', name: 'Bento' } }).end({ status: 'done', usage })
    await telemetry.shutdown()

    expect(attrsOf(sink.spans.find((s) => s.span.name === 'invoke_agent Clara')!)).toMatchObject({ 'gen_ai.request.model': 'opus', 'gen_ai.response.model': 'gpt-5.6-luna', 'tucano.harness': 'codex' })
    expect(attrsOf(sink.spans.find((s) => s.span.name === 'invoke_agent Bento')!)).not.toHaveProperty('gen_ai.response.model')
  })

  it('ends a tool still running when its reply ends, marked as interrupted, and only once', async () => {
    sink = await collector()
    telemetry = startTelemetry(jsonConfig(sink.url), about)

    const reply = telemetry.reply(clara)
    const late = reply.tool('bash')
    reply.end({ status: 'stopped' })
    late.end({ ok: true })
    await telemetry.shutdown()

    const tools = sink.spans.filter((s) => s.span.name === 'execute_tool bash')
    expect(tools).toHaveLength(1)
    expect(attrsOf(tools[0]!)['tucano.tool.interrupted']).toBe(true)
  })

})

describe('turning OpenTelemetry on', () => {
  it('stays off when no OTLP endpoint is set', () => {
    expect(otelConfig({})).toBeUndefined()
  })

  it('sends to the traces path of the general endpoint, and to the signal endpoint exactly as written', () => {
    expect(otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/' })?.url).toBe('http://collector:4318/v1/traces')
    expect(
      otelConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://general:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example/custom'
      })?.url
    ).toBe('https://traces.example/custom')
  })

  it('stays off when the standard switches say so, even with an endpoint', () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }
    expect(otelConfig({ ...endpoint, OTEL_SDK_DISABLED: 'true' })).toBeUndefined()
    expect(otelConfig({ ...endpoint, OTEL_SDK_DISABLED: 'TRUE' })).toBeUndefined()
    expect(otelConfig({ ...endpoint, OTEL_TRACES_EXPORTER: 'none' })).toBeUndefined()
    expect(otelConfig({ ...endpoint, OTEL_SDK_DISABLED: 'false' })).toBeDefined()
  })

  it('reads headers, with the signal-specific value winning over the general one', () => {
    const config = otelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Basic%20general, x-team = core',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=Basic%20traces'
    })
    expect(config?.headers).toEqual({ authorization: 'Basic traces', 'x-team': 'core' })
  })

  it('uses protobuf unless JSON is asked for, with the signal-specific protocol winning', () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }
    expect(otelConfig(endpoint)?.protocol).toBe('http/protobuf')
    expect(otelConfig({ ...endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' })?.protocol).toBe('http/json')
    expect(otelConfig({ ...endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf' })?.protocol).toBe('http/protobuf')
  })

  it('says content capture is not supported when asked for, and goes on with metadata only', () => {
    const said: string[] = []
    const config = otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true' }, (line) => void said.push(line))
    expect(config).toBeDefined()
    expect(said).toEqual([expect.stringContaining("content capture isn't supported")])
  })

  it('says in the log where traces go, without any credentials in the address', async () => {
    const sink = await collector()
    const said: string[] = []
    const url = sink.url.replace('http://', 'http://user:s3cret@')

    await loadTelemetry({ url, protocol: 'http/json', headers: {} }, { ...about, warn: (line) => void said.push(line) })
    await stopTelemetry()
    await sink.close()

    expect(said.join('\n')).toContain(new URL(sink.url).origin)
    expect(said.join('\n')).not.toContain('s3cret')
  })

  it('on a desktop, an OTEL_ variable left for another tool is not enough: it takes TUCANO_OTEL=1', () => {
    expect(tracesWanted({}, false)).toBe(false)
    expect(tracesWanted({ TUCANO_OTEL: '0' }, false)).toBe(false)
    expect(tracesWanted({ TUCANO_OTEL: '1' }, false)).toBe(true)
    expect(tracesWanted({}, true)).toBe(true) // a server's environment is set for this server
  })

  it('stays off and says why for gRPC or an endpoint that is not an http address, without printing the address', () => {
    const said: string[] = []
    const warn = (line: string): void => void said.push(line)
    expect(otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, warn)).toBeUndefined()
    expect(otelConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'ftp://user:s3cret@collector' }, warn)).toBeUndefined()
    expect(otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }, warn)).toBeUndefined()
    expect(said).toHaveLength(3)
    expect(said[0]).toContain('grpc')
    expect(said.join('\n')).not.toContain('s3cret')
  })
})

describe('settings changed while a reply runs', () => {
  it('sends a reply begun before the change where it began, and the next one to the new address', async () => {
    const before = await collector()
    const after = await collector()
    try {
      await reloadTelemetry(jsonConfig(before.url), about)
      const running = traceReply(clara)!

      await reloadTelemetry(jsonConfig(after.url), about)
      running.end({ status: 'done', usage, text: { input: 'pergunta', output: 'resposta' } })
      traceReply({ ...clara, agent: { id: 'a2', name: 'Bento' } })!.end({ status: 'done' })
      await flushTelemetry()
      await new Promise((r) => setTimeout(r, 300))

      const begun = before.spans.find((s) => s.span.name === 'invoke_agent Clara')!
      expect(attrsOf(begun)['tucano.run.status']).toBe('done') // it ended as it really ended, not cut by the change
      expect(String(attrsOf(begun)['gen_ai.input.messages'])).toContain('pergunta')
      expect(after.spans.map((s) => s.span.name)).toEqual(['invoke_agent Bento'])
      expect(JSON.stringify(after.spans)).not.toContain('pergunta')
    } finally {
      await reloadTelemetry(undefined, about)
      await before.close()
      await after.close()
    }
  })
})
