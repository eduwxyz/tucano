import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { tracedEngines, type Telemetry } from '../src/core/telemetry'
import { startTelemetry } from '../src/core/telemetry-sdk'
import { ENGINE_IDS as IDS, type Agent, type EngineId, type Settings } from '../src/shared/types'
import { attrsOf, collector, type Received } from './helpers/otlp'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, grants: {}, ...extra }) as Agent

describe('what the runner traces', () => {
  let db: Db
  let gateway: Gateway
  let sink: Awaited<ReturnType<typeof collector>>
  let telemetry: Telemetry

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'otel-db-')), 'test.db'))
    db.saveAgent(agent('orion'))
    db.saveAgent(agent('clara', { reportsTo: 'orion' }))
    db.createConversation({ id: 'dm', kind: 'dm', name: 'orion', members: ['orion'] })
    gateway = new Gateway()
    await gateway.start()
    sink = await collector()
    telemetry = startTelemetry({ url: sink.url, protocol: 'http/json', headers: {} }, { workspaceId: 'w1', version: '1.2.3', mode: 'desktop' })
  })

  afterEach(async () => {
    await telemetry.shutdown()
    await sink.close()
    await gateway.stop()
  })

  const runner = (wrap: (e: Engine) => Engine = (e) => e): Runner => {
    const engines = tracedEngines(Object.fromEntries(IDS.map((id) => [id, wrap(fakeEngine(id, { delayMs: 1 }))])) as Record<EngineId, Engine>)
    const settings = { workspaceName: 'Edu', context: '', engines: Object.fromEntries(IDS.map((id) => [id, ready])), routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
    return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'otel-work-')), gateway })
  }
  const replies = (name: string): Received[] => sink.spans.filter((s) => s.span.name === `invoke_agent ${name}`)

  it('makes a request between two agents two traces of one session, linked, with the tool call inside', async () => {
    const r = runner()

    await r.send('dm', 'delegue a clara: responda o Fulano')
    await r.idle()
    await telemetry.shutdown()

    const asking = replies('Orion')[0]!
    const asked = replies('Clara')[0]!
    expect(asked.span.traceId).not.toBe(asking.span.traceId)
    expect(attrsOf(asked)['session.id']).toBe(attrsOf(asking)['session.id'])
    expect(attrsOf(asking)).toMatchObject({ 'gen_ai.conversation.id': 'dm', 'tucano.run.status': 'done', 'tucano.harness': 'claude' })
    expect(asked.span.links).toEqual([expect.objectContaining({ traceId: asking.span.traceId, spanId: asking.span.spanId })])
    const pedir = sink.spans.find((s) => s.span.name === 'execute_tool pedir')!
    expect(pedir.span.traceId).toBe(asking.span.traceId)
    expect(pedir.span.parentSpanId).toBe(asking.span.spanId)
  })

  it('traces the model that really answered, while the receipt keeps the one the agent asked for', async () => {
    const answers = (e: Engine): Engine => ({
      ...e,
      run: (t) =>
        (async function* () {
          for await (const ev of e.run(t)) yield ev.type === 'done' ? { ...ev, usage: { ...ev.usage, inputTokens: 10, outputTokens: 2, responseModel: 'claude-sonnet-4-5-20250929' } } : ev
        })()
    })
    const r = runner(answers)

    await r.send('dm', 'oi')
    await r.idle()
    await telemetry.shutdown()

    const reply = db.messages().find((m) => m.author.kind === 'agent')!
    expect(reply.run?.receipt?.model).toBe('sonnet')
    expect(attrsOf(sink.spans.find((s) => s.span.name === 'chat sonnet')!)).toMatchObject({ 'gen_ai.response.model': 'claude-sonnet-4-5-20250929' })
  })

  it('makes a retry a new trace of the same session, still linked to who asked after a restart', async () => {
    let broken = true
    const claraFails = (e: Engine): Engine => ({
      ...e,
      run: (t) =>
        broken && t.system.includes('Você é Clara')
          ? (async function* () {
              yield { type: 'error' as const, message: 'quebrou' }
            })()
          : e.run(t)
    })
    const first = runner(claraFails)
    await first.send('dm', 'delegue a clara: responda o Fulano')
    await first.idle()
    const failed = db.messages().find((m) => m.author.kind === 'agent' && m.author.id === 'clara' && m.run?.status === 'failed')!
    await telemetry.shutdown()

    broken = false
    telemetry = startTelemetry({ url: sink.url, protocol: 'http/json', headers: {} }, { workspaceId: 'w1', version: '1.2.3', mode: 'desktop' })
    const restarted = runner(claraFails)
    restarted.retry(failed.id)
    await restarted.idle()
    await telemetry.shutdown()

    const asking = replies('Orion')[0]!
    const [tried, again] = replies('Clara')
    expect(attrsOf(tried!)['tucano.run.status']).toBe('failed')
    expect(attrsOf(again!)['tucano.run.status']).toBe('done')
    expect(again!.span.traceId).not.toBe(tried!.span.traceId)
    expect(attrsOf(again!)['session.id']).toBe(attrsOf(tried!)['session.id'])
    expect(again!.span.links).toEqual([expect.objectContaining({ traceId: asking.span.traceId, spanId: asking.span.spanId })])
  })

  it('with no endpoint, a reply makes no span, sends nothing and keeps no trace on its run', async () => {
    await telemetry.shutdown() // the same as never having had an endpoint
    const r = runner()

    await r.send('dm', 'bom dia')
    await r.idle()

    const reply = db.messages().find((m) => m.author.kind === 'agent' && m.author.id === 'orion')!
    expect(reply.run?.status).toBe('done')
    expect(reply.run?.trace).toBeUndefined()
    expect(sink.spans).toEqual([])
  })

  it('sends none of what was said by default, in a real reply with a tool call', async () => {
    const r = runner()

    await r.send('dm', 'delegue a clara: MARCADOR-9d2c responda')
    await r.idle()
    await telemetry.shutdown()

    expect(replies('Orion').length).toBeGreaterThan(0)
    expect(JSON.stringify(sink.spans)).not.toContain('MARCADOR-9d2c')
  })

  it('goes on from a reply cut at a restart in a new trace of the same session', async () => {
    const first = runner()
    await first.send('dm', 'delegue a clara: responda o Fulano')
    await first.idle()
    const cut = db.messages().find((m) => m.author.kind === 'agent' && m.author.id === 'orion' && m.run?.steps.some((s) => s.status === 'done'))!
    db.saveMessage({ ...cut, run: { ...cut.run!, status: 'interrupted' } })
    await telemetry.shutdown()
    const before = replies('Orion').length

    telemetry = startTelemetry({ url: sink.url, protocol: 'http/json', headers: {} }, { workspaceId: 'w1', version: '1.2.3', mode: 'desktop' })
    const restarted = runner()
    await restarted.continue(cut.id, 'restart')
    await restarted.idle()
    await telemetry.shutdown()

    const after = replies('Orion').slice(before)
    expect(after.length).toBeGreaterThan(0)
    expect(after[0]!.span.traceId).not.toBe(replies('Orion')[0]!.span.traceId)
    expect(attrsOf(after[0]!)['session.id']).toBe(cut.run!.job)
  })

  it('links a reply an agent handed the turn to with @, to the reply that handed it', async () => {
    db.saveAgent(agent('bento'))
    db.createConversation({ id: 'eng', kind: 'channel', name: 'eng', members: ['clara', 'bento'] })
    const claraHandsOff = (e: Engine): Engine => ({
      ...e,
      run: (t) =>
        t.system.includes('Você é Clara')
          ? (async function* () {
              yield { type: 'done' as const, text: '@bento pode olhar isso?', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
            })()
          : e.run(t)
    })
    const r = runner(claraHandsOff)

    await r.send('eng', '@clara olha isso')
    await r.idle()
    await telemetry.shutdown()

    const asking = replies('Clara')[0]!
    const asked = replies('Bento')[0]!
    expect(asked.span.links).toEqual([expect.objectContaining({ traceId: asking.span.traceId, spanId: asking.span.spanId })])
  })

  it('finishes a reply the same way with the collector down', async () => {
    await telemetry.shutdown()
    telemetry = startTelemetry({ url: 'http://127.0.0.1:9/v1/traces', protocol: 'http/json', headers: {} }, { workspaceId: 'w1', version: '1.2.3', mode: 'desktop', warn: () => {} })
    const r = runner()

    await r.send('dm', 'bom dia')
    await r.idle() // the exporter is still retrying behind it: nothing here waits for that

    const reply = db.messages().find((m) => m.author.kind === 'agent' && m.author.id === 'orion')!
    expect(reply.run?.status).toBe('done')
    expect(reply.text.length).toBeGreaterThan(0)
  })

  it('traces the router as its own operation in the session of the message it routes', async () => {
    db.saveAgent(agent('bento'))
    db.createConversation({ id: 'eng', kind: 'channel', name: 'eng', members: ['clara', 'bento'] })
    const r = runner()

    await r.send('eng', 'alguém olha isso?')
    await r.idle()
    await telemetry.shutdown()

    const router = sink.spans.find((s) => attrsOf(s)['tucano.operation'] === 'router')!
    const reply = sink.spans.find((s) => attrsOf(s)['tucano.operation'] === 'reply')!
    expect(router.span.traceId).not.toBe(reply.span.traceId)
    expect(attrsOf(router)).toMatchObject({ 'gen_ai.conversation.id': 'eng', 'session.id': attrsOf(reply)['session.id'] })
  })
})
