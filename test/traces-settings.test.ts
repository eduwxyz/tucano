// Settings › Connections › Traces through the real core: an admin points traces at a backend from the
// screen, with no OTEL_ variables and, on the desktop, no TUCANO_OTEL.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { flushTelemetry } from '../src/core/telemetry'
import type { ActivityEntry, Agent, TracesView } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'
import { until } from './helpers/node-link'
import { arrived, attrsOf, collector, type Received } from './helpers/otlp'

let sink: Awaited<ReturnType<typeof collector>>
let owner: Client
let member: Client
let admin: Client
let db: Db

const agent: Agent = { id: 'screen', name: 'Screen', handle: 'screen', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, grants: {} } as unknown as Agent
const base = (): string => sink.url.replace(/\/v1\/traces$/, '')
const replies = (name: string): number => sink.spans.filter((s) => s.span.name === `invoke_agent ${name}`).length

beforeAll(async () => {
  sink = await collector()
  delete process.env['TUCANO_OTEL']
  const core = await bootCore()
  owner = core.connect()
  db = new Db(join(core.dataDir, 'tucano.db'))
  db.addPerson({ id: 'screen-member', name: 'Bia', role: 'member', about: '' })
  member = core.connect('screen-member')
  db.addPerson({ id: 'screen-admin', name: 'Ana', role: 'admin', about: '' })
  admin = core.connect('screen-admin')
  db.saveAgent(agent)
  db.createConversation({ id: 'screen-dm', kind: 'dm', name: 'screen', members: ['screen'] })
  db.createConversation({ id: 'screen-geral', kind: 'channel', name: 'screen-geral', members: ['screen'] })
  db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'screen', members: ['screen'], owner: 'screen-member' })
}, 30_000)

afterAll(async () => {
  await sink.close()
})

describe('who reaches the traces settings', () => {
  it('refuses a member, to read them, change them or test them', async () => {
    await expect(member.call('traces')).rejects.toThrow()
    await expect(member.call('setTraces', { on: true, endpoint: 'https://otel.example.com' })).rejects.toThrow()
    await expect(member.call('testTraces', { endpoint: 'https://otel.example.com' })).rejects.toThrow()
  })
})

describe('where traces may go', () => {
  it('refuses plain http to another machine, and takes it on this one', async () => {
    await expect(owner.call('setTraces', { on: true, endpoint: 'http://otel.example.com' })).rejects.toThrow(/HTTPS/)
    for (const local of ['http://localhost:4318', 'http://127.0.0.1:3000/api/public/otel', 'http://[::1]:4318']) {
      expect((await owner.call<TracesView>('setTraces', { on: false, endpoint: local })).endpoint).toBe(local)
    }
    expect((await owner.call<TracesView>('setTraces', { on: false, endpoint: 'https://otel.example.com' })).endpoint).toBe('https://otel.example.com')
  })

  it('refuses what is not a web address', async () => {
    await expect(owner.call('setTraces', { on: true, endpoint: 'ftp://otel.example.com' })).rejects.toThrow()
    await expect(owner.call('setTraces', { on: true, endpoint: 'otel' })).rejects.toThrow()
  })
})

describe('testing the connection', () => {
  it('says the backend took the test trace, with the form as it stands and nothing saved', async () => {
    const saved = await owner.call<TracesView>('traces')

    const result = await owner.call('testTraces', { endpoint: base(), headers: 'Authorization: Bearer teste' })

    expect(result).toEqual({ ok: true })
    expect(sink.headers.at(-1)?.['authorization']).toBe('Bearer teste')
    expect(await owner.call('traces')).toEqual(saved)
  })

  it('never sends the saved key to an address other than the one it was saved for', async () => {
    await owner.call('setTraces', { on: true, endpoint: 'https://otel.example.com', headers: 'Authorization: Bearer so-para-o-salvo' })
    const before = sink.headers.length

    expect(await owner.call('testTraces', { endpoint: base() })).toEqual({ ok: true })

    expect(sink.headers.slice(before).map((h) => h['authorization'])).toEqual([undefined])
    await owner.call('setTraces', { on: false, endpoint: base(), headers: null })
  })

  it('says what the backend answered when it refused', async () => {
    const refusing = createServer((_req, res) => void res.writeHead(401).end('no'))
    await new Promise<void>((ok) => refusing.listen(0, '127.0.0.1', ok))
    try {
      expect(await owner.call('testTraces', { endpoint: `http://127.0.0.1:${(refusing.address() as AddressInfo).port}` })).toEqual({ ok: false, status: 401 })
    } finally {
      refusing.close()
    }
  })

  it('gives up on a backend that never answers, and says so', async () => {
    const hanging = createServer(() => {})
    await new Promise<void>((ok) => hanging.listen(0, '127.0.0.1', ok))
    try {
      expect(await owner.call('testTraces', { endpoint: `http://127.0.0.1:${(hanging.address() as AddressInfo).port}` })).toEqual({ ok: false })
    } finally {
      hanging.closeAllConnections()
      hanging.close()
    }
  }, 12_000)

  it('says it could not reach an address nobody answers', async () => {
    expect(await owner.call('testTraces', { endpoint: 'http://127.0.0.1:9' })).toEqual({ ok: false })
  }, 12_000)
})

describe('traces turned on from the screen', () => {
  it('sends the next reply to the endpoint, with no restart and no TUCANO_OTEL', async () => {
    await owner.call('setTraces', { on: true, endpoint: base() })

    await owner.call('sendMessage', { conversationId: 'screen-dm', text: 'oi' })

    await arrived(() => replies('Screen') > 0, 9_000)
    const reply = attrsOf(sink.spans.find((s) => s.span.name === 'invoke_agent Screen')!)
    expect(reply).not.toHaveProperty('gen_ai.input.messages') // the text stays home unless asked for
    expect(reply).not.toHaveProperty('gen_ai.output.messages')
    expect(JSON.parse(db.meta('traces')!)).toMatchObject({ on: true }) // in this workspace's own database: another workspace has its own
  }, 15_000)

  it('sends the saved headers with every trace, and never shows them back', async () => {
    const view = await owner.call<TracesView>('setTraces', { on: true, endpoint: base(), headers: 'Authorization: Basic cGs6c2s=\nx-scope=team a' })
    await owner.call('sendMessage', { conversationId: 'screen-dm', text: 'com chave' })

    await arrived(() => sink.headers.some((h) => h['authorization'] === 'Basic cGs6c2s='), 9_000)
    expect(sink.headers.at(-1)).toMatchObject({ authorization: 'Basic cGs6c2s=', 'x-scope': 'team a' })
    expect(view.headers).toBe(true)
    expect(db.getSecret('traces.headers')).toMatch(/^plain:/) // through the secret store's cipher (the test mode's marks it, instead of encrypting)
    expect(JSON.stringify(await owner.call('traces'))).not.toContain('cGs6c2s')
  }, 15_000)

  it('stops sending once turned off', async () => {
    await owner.call('setTraces', { on: false, endpoint: base() })
    const before = replies('Screen')

    await owner.call('sendMessage', { conversationId: 'screen-dm', text: 'de novo' })
    await until(() => db.messages().filter((m) => m.conversationId === 'screen-dm' && m.author.kind === 'agent' && m.run?.status === 'done').length >= 2, 9_000)
    await new Promise((r) => setTimeout(r, 300))

    expect(replies('Screen')).toBe(before)
  }, 15_000)
})

const replyTo = (text: string): Received | undefined => {
  const asked = db.messages().find((m) => m.text === text)
  const reply = asked && db.messages().find((m) => m.run?.replyTo === asked.id)
  return reply?.run?.trace && sink.spans.find((s) => s.span.spanId === reply.run!.trace!.spanId)
}

describe('the conversation text', () => {
  beforeEach(async () => {
    await owner.call('setTraces', { on: true, endpoint: base(), text: false }) // each test turns it on as someone
  })

  it('goes with a reply once turned on: what was asked as input, the final reply as output', async () => {
    await owner.call('setTraces', { on: true, endpoint: base(), text: true })

    await owner.call('sendMessage', { conversationId: 'screen-dm', text: 'qual o prazo do contrato?' })
    await arrived(() => replyTo('qual o prazo do contrato?') !== undefined, 9_000)

    const span = attrsOf(replyTo('qual o prazo do contrato?')!)
    const reply = db.messages().find((m) => m.run?.replyTo === db.messages().find((x) => x.text === 'qual o prazo do contrato?')!.id)!
    expect(JSON.parse(String(span['gen_ai.input.messages']))).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'qual o prazo do contrato?' }] }])
    expect(JSON.parse(String(span['gen_ai.output.messages']))).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: reply.text }], finish_reason: 'stop' }])
  }, 15_000)

  it('stays home for a conversation the admin who turned it on can’t read', async () => {
    await owner.call('setTraces', { on: true, endpoint: base(), text: true })

    await member.call('sendMessage', { conversationId: 'bia-dm', text: 'minha senha do banco é outra coisa' })
    await arrived(() => replyTo('minha senha do banco é outra coisa') !== undefined, 9_000)

    const span = attrsOf(replyTo('minha senha do banco é outra coisa')!)
    expect(span['tucano.run.status']).toBe('done')
    expect(span).not.toHaveProperty('gen_ai.input.messages')
    expect(span).not.toHaveProperty('gen_ai.output.messages')
  }, 15_000)

  it('stops once the admin who turned it on is no longer an admin', async () => {
    await admin.call('setTraces', { on: true, endpoint: base(), text: true })
    await owner.call('sendMessage', { conversationId: 'screen-geral', text: '@Screen enquanto ela é admin' })
    await arrived(() => replyTo('@Screen enquanto ela é admin') !== undefined, 9_000)
    expect(attrsOf(replyTo('@Screen enquanto ela é admin')!)).toHaveProperty('gen_ai.input.messages')

    await owner.call('setRole', { id: 'screen-admin', role: 'member' })
    await owner.call('sendMessage', { conversationId: 'screen-geral', text: '@Screen depois que deixou de ser' })
    await arrived(() => replyTo('@Screen depois que deixou de ser') !== undefined, 9_000)

    expect(attrsOf(replyTo('@Screen depois que deixou de ser')!)).not.toHaveProperty('gen_ai.input.messages')
    await owner.call('setRole', { id: 'screen-admin', role: 'admin' })
  }, 20_000)

  it('masks every Vault key and every token it recognizes before the text leaves', async () => {
    await owner.call('saveVaultKey', { key: { name: 'STRIPE_SECRET', value: 'rk_live_51Hx9QzLmNoPqRsT', agents: [], approve: false } })
    await owner.call('setTraces', { on: true, endpoint: base(), text: true })
    const asked = 'usa a chave rk_live_51Hx9QzLmNoPqRsT e o token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    await owner.call('sendMessage', { conversationId: 'screen-dm', text: asked })
    await arrived(() => replyTo(asked) !== undefined, 9_000)

    const input = String(attrsOf(replyTo(asked)!)['gen_ai.input.messages'])
    expect(input).toContain('[cofre:STRIPE_SECRET]')
    expect(input).not.toContain('rk_live_51Hx9QzLmNoPqRsT')
    expect(input).not.toContain('ghp_aaaa')
  }, 15_000)

  it('goes only on the reply’s own span, never on its model call or a tool it called', async () => {
    await owner.call('setTraces', { on: true, endpoint: base(), text: true })
    await owner.call('sendMessage', { conversationId: 'screen-dm', text: 'quais os próximos passos?' })
    await arrived(() => sink.spans.some((s) => s.span.name === 'execute_tool next_steps'), 9_000)
    await flushTelemetry()

    const withText = sink.spans.filter((s) => 'gen_ai.input.messages' in attrsOf(s) || 'gen_ai.output.messages' in attrsOf(s))
    expect(withText.length).toBeGreaterThan(0)
    for (const s of withText) {
      const a = attrsOf(s)
      expect(a['gen_ai.operation.name']).toBe('invoke_agent')
    }
  }, 15_000)

  it('turns off when the endpoint changes, and the log keeps who changed what, without the headers', async () => {
    await owner.call('setTraces', { on: true, endpoint: base(), text: true, headers: 'Authorization: Bearer nao-vai-pro-log' })

    const moved = await owner.call<TracesView>('setTraces', { on: true, endpoint: 'https://otel.example.com/api/public/otel', text: true })

    expect(moved.text).toBe(false)
    const log = await owner.call<ActivityEntry[]>('activity', { kind: 'traces.changed' })
    expect(log[0]).toMatchObject({ personId: db.ownerId(), kind: 'traces.changed', detail: { endpoint: 'https://otel.example.com', text: false } })
    expect(JSON.stringify(await owner.call('activity', {}))).not.toContain('nao-vai-pro-log')
    expect((await owner.call<TracesView>('setTraces', { on: true, endpoint: base(), text: true })).text).toBe(true) // turned on now, for the address it's saved with
  })

  it('takes the text on in the same save as a first address', async () => {
    await owner.call('setTraces', { on: false, endpoint: '', text: false })

    const first = await owner.call<TracesView>('setTraces', { on: true, endpoint: base(), text: true })

    expect(first.text).toBe(true)
  })

  it('stays off the app’s own model calls, like the router’s', async () => {
    db.saveAgent({ ...agent, id: 'screen2', name: 'Outro', handle: 'outro' } as Agent)
    db.createConversation({ id: 'screen-dois', kind: 'channel', name: 'screen-dois', members: ['screen', 'screen2'] })
    await owner.call('setTraces', { on: true, endpoint: base(), text: true })
    const own = (): Received[] => sink.spans.filter((s) => ['router', 'chime', 'handoff', 'title'].includes(String(attrsOf(s)['tucano.operation'])))
    const before = own().length

    await owner.call('sendMessage', { conversationId: 'screen-dois', text: 'alguém consegue revisar o orçamento de março?' })
    await arrived(() => own().length > before, 9_000)

    for (const s of own()) expect(Object.keys(attrsOf(s)).filter((k) => k.endsWith('.messages'))).toEqual([])
  }, 15_000)

  it('goes with a reply that failed: what was asked, and whatever it had said', async () => {
    await owner.call('setTraces', { on: true, endpoint: base(), text: true })

    await owner.call('sendMessage', { conversationId: 'screen-dm', text: 'acabou o limite?' })
    await arrived(() => replyTo('acabou o limite?') !== undefined, 9_000)

    const span = attrsOf(replyTo('acabou o limite?')!)
    expect(span['tucano.run.status']).toBe('failed')
    expect(String(span['gen_ai.input.messages'])).toContain('acabou o limite?')
    expect(span).toHaveProperty('gen_ai.output.messages')
  }, 15_000)

  it('goes again with the same request when the reply is tried again', async () => {
    await owner.call('setTraces', { on: true, endpoint: base(), text: true })
    await owner.call('sendMessage', { conversationId: 'screen-dm', text: 'acabou o limite de novo?' })
    await arrived(() => replyTo('acabou o limite de novo?') !== undefined, 9_000)
    const first = replyTo('acabou o limite de novo?')!
    const reply = db.messages().find((m) => m.run?.trace?.spanId === first.span.spanId)!

    await owner.call('retryRun', { messageId: reply.id })
    await arrived(() => {
      const now = replyTo('acabou o limite de novo?')
      return !!now && now.span.spanId !== first.span.spanId
    }, 9_000)

    const again = attrsOf(replyTo('acabou o limite de novo?')!)
    expect(again['gen_ai.input.messages']).toBe(attrsOf(first)['gen_ai.input.messages'])
  }, 20_000)

  it('turns off when only the headers change: another account at the same backend', async () => {
    await owner.call('setTraces', { on: true, endpoint: base(), text: true })

    const swapped = await owner.call<TracesView>('setTraces', { on: true, endpoint: base(), text: true, headers: 'Authorization: Bearer outra-conta' })

    expect(swapped.text).toBe(false)
  })
})
