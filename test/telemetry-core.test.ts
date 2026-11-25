// The real core with traces on: a message goes in, and spans reach a collector.
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { WINDOW } from '../src/core/memory'
import { stopTelemetry } from '../src/core/telemetry'
import type { Agent, TracesView } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'
import { until } from './helpers/node-link'
import { arrived, attrsOf, collector } from './helpers/otlp'

let sink: Awaited<ReturnType<typeof collector>>
let owner: Client
let db: Db
let envAfterBoot: string[]

const agent: Agent = { id: 'traced', name: 'Traced', handle: 'traced', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, grants: {} } as unknown as Agent

beforeAll(async () => {
  sink = await collector()
  process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = sink.url
  process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/json'
  process.env['OTEL_EXPORTER_OTLP_HEADERS'] = 'authorization=s3cret'
  process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = 'true' // asked for, and still nothing said may go
  process.env['TUCANO_WORKSPACE_ID'] = 'w-core'
  const core = await bootCore({ server: true })
  envAfterBoot = Object.keys(process.env).filter((k) => /^OTEL_/i.test(k))
  owner = core.connect()
  db = new Db(join(core.dataDir, 'tucano.db'))
  db.saveAgent(agent)
  db.createConversation({ id: 'traced-dm', kind: 'dm', name: 'traced', members: ['traced'] })
}, 30_000)

afterAll(async () => {
  await sink.close()
})

describe('the core with an OTLP endpoint set', () => {
  it('takes the OTEL_ variables out of what child processes inherit', () => {
    expect(envAfterBoot).toEqual([])
  })

  it('shows the environment as what configures traces, and keeps the screen from changing it', async () => {
    const view = await owner.call<TracesView>('traces')

    expect(view.fromEnv).toBe(new URL(sink.url).origin)
    await expect(owner.call('setTraces', { on: true, endpoint: 'https://otel.example.com' })).rejects.toThrow(/environment|ambiente/)
  })

  it('sends a reply as a trace, naming its workspace', async () => {
    await owner.call('sendMessage', { conversationId: 'traced-dm', text: 'bom dia, tudo certo?' })

    await arrived(() => sink.spans.some((s) => s.span.name === 'invoke_agent Traced'), 9_000)

    const reply = sink.spans.find((s) => s.span.name === 'invoke_agent Traced')!
    expect(attrsOf(reply)).toMatchObject({ 'gen_ai.conversation.id': 'traced-dm', 'tucano.operation': 'reply', 'tucano.run.status': 'done' })
    expect(reply.resource).toMatchObject({ 'tucano.workspace.id': 'w-core', 'tucano.mode': 'server', 'service.name': 'tucano' })
  }, 15_000)

  it('traces titles, memory and the wiki as their own operations, and not the connection test in Settings', async () => {
    const operations = (): Set<unknown> => new Set(sink.spans.map((s) => attrsOf(s)['tucano.operation']))
    await owner.call('sendMessage', { conversationId: 'traced-dm', text: 'Preciso que você revise o contrato da loja nova e me diga o que falta antes de assinar' })
    await until(() => db.messages().some((m) => m.conversationId === 'traced-dm' && m.author.kind === 'agent' && m.run?.status === 'done' && m.at > 0), 5_000)
    const answer = db.messages().filter((m) => m.conversationId === 'traced-dm' && m.author.kind === 'agent').at(-1)!

    // Enough history that there's a stretch older than the window the summary leaves out.
    for (let i = 0; i < WINDOW + 2; i++) db.saveMessage({ id: `old-${i}`, conversationId: 'traced-dm', author: { kind: 'person', id: db.ownerId() }, text: `mensagem ${i}`, at: i + 1 })
    await owner.call('summarizeNow', { conversationId: 'traced-dm' })
    await owner.call('wikiKeepMessage', { messageId: answer.id })
    await arrived(() => ['title', 'memory', 'wiki'].every((o) => operations().has(o)), 14_000)

    await owner.call('testEngine', { model: 'opus' }) // a model none of the calls above use
    await stopTelemetry()

    expect(sink.spans.some((s) => s.span.name === 'chat opus')).toBe(false)
    const sent = JSON.stringify(sink.spans)
    for (const said of ['bom dia', 'revise o contrato', 'mensagem 1']) expect(sent).not.toContain(said)
  }, 25_000)
})
