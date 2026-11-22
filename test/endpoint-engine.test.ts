import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import { endpointEngine, functionName, userContent } from '../src/core/engines/endpoint'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { cleanEndpoint } from '../src/core/harness'
import { Runner } from '../src/core/runs'
import { formatResults, parseExa } from '../src/core/web-tools'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'endpoint:acme/model-1', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

// An address in OpenAI's format, scripted: each call to /chat/completions gets the next answer, streamed
// as server-sent events, and what was sent is kept.
type Reply = { status?: number; error?: string; chunks?: object[] }
function provider(replies: ((body: { messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[]; tools?: { function: { name: string } }[]; model: string }) => Reply)[]) {
  const sent: { url: string; headers: Record<string, string>; body: Parameters<(typeof replies)[number]>[0] }[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    sent.push({ url: String(input), headers: init?.headers as Record<string, string>, body })
    const r = replies[sent.length - 1]?.(body) ?? { chunks: [{ choices: [{ delta: { content: 'fim' } }] }] }
    if (r.status && r.status !== 200) return new Response(JSON.stringify({ error: { message: r.error ?? 'no' } }), { status: r.status, headers: { 'content-type': 'application/json' } })
    const text = (r.chunks ?? []).map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { f, sent }
}
const words = (text: string, usage = { prompt_tokens: 100, completion_tokens: 10 }): Reply => ({ chunks: [...text.match(/.{1,5}/g)!.map((part) => ({ choices: [{ delta: { content: part } }] })), { choices: [], usage }] })
const call = (name: string, args: object, id = 'c1'): Reply => ({
  chunks: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(0, 8) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(8) } }] } }] },
    { choices: [], usage: { prompt_tokens: 80, completion_tokens: 5 } }
  ]
})

let db: Db
let events: CoreEvent[]
let settings: Settings
let gateway: Gateway

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: { ...ready, route: 'endpoint' } }, routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

function runner(endpoint: Engine, web?: { search: (q: string, n: number) => Promise<{ url: string; title?: string; text?: string }[]>; read: (url: string) => Promise<string> }): Runner {
  const engines: Record<EngineId, Engine> = { claude: fakeEngine('claude', { delayMs: 1 }), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway, ...(web ? { web } : {}) })
}
const reply = (): Message => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!

describe('an agent on an endpoint, with no harness', () => {
  it('streams the answer from /chat/completions with the key, and keeps the tokens', async () => {
    db.saveAgent(agent('lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'lia', members: ['lia'] })
    const p = provider([() => words('Oi! Tudo certo por aqui.')])
    const r = runner(endpointEngine(async () => ({ baseUrl: 'https://openrouter.ai/api/v1/', key: 'sk-or-123' }), p.f))
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply()).toMatchObject({ text: 'Oi! Tudo certo por aqui.', run: { status: 'done' } })
    expect(p.sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(p.sent[0]!.headers['authorization']).toBe('Bearer sk-or-123')
    expect(p.sent[0]!.body.model).toBe('acme/model-1')
    expect(p.sent[0]!.body.messages[0]).toMatchObject({ role: 'system' })
    expect(p.sent[0]!.body.messages[1]).toMatchObject({ role: 'user' })
    // The app's own tools go with it: the agent can ask the person, as on any harness.
    expect(p.sent[0]!.body.tools!.map((t) => t.function.name)).toContain('ask_user')
    expect(reply().run?.receipt).toMatchObject({ inputTokens: 100, outputTokens: 10 })
  })

  it('runs the tools the model asks for through the app, and goes on until it answers in words', async () => {
    db.saveAgent(agent('orion'))
    db.saveAgent(agent('clara', { reportsTo: 'orion', modelId: 'sonnet' }))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'orion', members: ['orion'] })
    db.createConversation({ id: 'clientes', kind: 'channel', name: 'clientes', members: ['clara'] })
    const p = provider([() => call('pedir', { para: 'clara', pedido: 'responda o Fulano' }), () => ({ chunks: [{ choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 1 } }] })])
    const r = runner(endpointEngine(async () => ({ baseUrl: 'http://localhost:11434/v1' }), p.f))
    await r.send('d1', 'pede pra Clara responder o Fulano')
    await r.idle()
    // The request really went out, through the gateway, in Orion's name: Clara isn't in this DM, so it went to hers.
    const dm = db.conversations().find((c) => c.kind === 'dm' && c.name === 'clara')!
    expect(db.messages().some((m) => m.conversationId === dm.id && m.text.includes('@clara, um pedido'))).toBe(true)
    // The second call carried the tool call and its result, as OpenAI's format has them.
    const second = p.sent[1]!.body.messages
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'pedir', arguments: JSON.stringify({ para: 'clara', pedido: 'responda o Fulano' }) } }] })
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: expect.stringContaining('entregue a Clara') })
    // No key, no header: a local server.
    expect(p.sent[0]!.headers['authorization']).toBeUndefined()
  })

  it('searches the web and reads a page with the app\'s own tools, only for an agent with Web on', async () => {
    db.saveAgent(agent('lia', { web: true }))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'lia', members: ['lia'] })
    const searched: string[] = []
    const p = provider([() => call('buscar_na_web', { busca: 'preço do dólar hoje' }), () => call('ler_pagina', { url: 'https://example.com/dolar' }, 'c2'), () => words('O dólar fechou a R$ 5,40.')])
    const r = runner(endpointEngine(async () => ({ baseUrl: 'https://openrouter.ai/api/v1', key: 'k' }), p.f), {
      search: async (q) => (searched.push(q), [{ url: 'https://example.com/dolar', title: 'Dólar hoje', text: 'O dólar fechou em alta.' }]),
      read: async (url) => `# Dólar hoje\n${url}\n\nFechou a R$ 5,40.`
    })
    await r.send('d1', 'quanto tá o dólar?')
    await r.idle()
    expect(searched).toEqual(['preço do dólar hoje'])
    expect(p.sent[0]!.body.tools!.map((t) => t.function.name)).toEqual(expect.arrayContaining(['buscar_na_web', 'ler_pagina']))
    expect(p.sent[1]!.body.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('1. Dólar hoje\nhttps://example.com/dolar') })
    expect(p.sent[2]!.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c2', content: expect.stringContaining('Fechou a R$ 5,40.') })
    expect(reply().text).toBe('O dólar fechou a R$ 5,40.')
    expect(reply().run?.steps.map((s) => s.label)).toEqual(expect.arrayContaining(['Buscou na web', 'Leu a página']))
  })

  it('gives the web tools to no agent with Web off', async () => {
    db.saveAgent(agent('lia', { web: false }))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'lia', members: ['lia'] })
    const p = provider([() => words('ok')])
    const r = runner(endpointEngine(async () => ({ baseUrl: 'https://x.test/v1' }), p.f))
    await r.send('d1', 'oi')
    await r.idle()
    expect(p.sent[0]!.body.tools!.map((t) => t.function.name)).not.toContain('buscar_na_web')
  })

  it('says why when the endpoint refuses, in its own words', async () => {
    db.saveAgent(agent('lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'lia', members: ['lia'] })
    const p = provider([() => ({ status: 401, error: 'Invalid API key' })])
    const r = runner(endpointEngine(async () => ({ baseUrl: 'https://x.test/v1', key: 'bad' }), p.f))
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run).toMatchObject({ status: 'failed', error: 'O endpoint recusou a chave. Confira a chave dele em Configurações › Modelos.', errorDetail: expect.stringContaining('Invalid API key') })
  })

  it('fails plainly with no endpoint set up', async () => {
    db.saveAgent(agent('lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'lia', members: ['lia'] })
    const r = runner(endpointEngine(async () => undefined, provider([]).f))
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
  })
})

describe('the pieces', () => {
  it('cleans an address as people paste it', () => {
    expect(cleanEndpoint(' https://openrouter.ai/api/v1/ ')).toBe('https://openrouter.ai/api/v1')
    expect(cleanEndpoint('http://localhost:11434/v1/chat/completions')).toBe('http://localhost:11434/v1')
    expect(() => cleanEndpoint('openrouter.ai')).toThrow()
    expect(() => cleanEndpoint('ftp://x.test/v1')).toThrow()
    expect(() => cleanEndpoint('https://user:pass@x.test/v1')).toThrow()
  })

  it('keeps function names in the shape OpenAI takes', () => {
    expect(functionName('tarefas__delete_task')).toBe('tarefas__delete_task')
    expect(functionName('google.drive/search')).toBe('google_drive_search')
    expect(functionName('x'.repeat(80))).toHaveLength(64)
  })

  it('sends the images of the conversation after the words', () => {
    const content = userContent({ prompt: 'veja', images: [{ block: 0, path: '/a.png', mime: 'image/png' }] }, () => Buffer.from('png'))
    expect(content).toEqual([{ type: 'text', text: 'veja' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` } }])
    expect(userContent({ prompt: 'só texto' })).toBe('só texto')
  })

  it('reads Exa\'s results and writes them for the model', () => {
    const text = 'Title: Dólar hoje\nURL: https://example.com/d\nPublished: 2026-11-15T10:00:00.000Z\nAuthor: N/A\nHighlights:\nO dólar fechou em alta.\n\n---\n\nTitle: Outra\nURL: https://example.com/o\nPublished: N/A\nText: Mais texto.'
    const found = parseExa(text)
    expect(found).toEqual([
      { url: 'https://example.com/d', title: 'Dólar hoje', published: '2026-11-15', text: 'O dólar fechou em alta.' },
      { url: 'https://example.com/o', title: 'Outra', text: 'Mais texto.' }
    ])
    expect(formatResults('dólar', found)).toBe('1. Dólar hoje\nhttps://example.com/d\nPublicado: 2026-11-15\nO dólar fechou em alta.\n\n2. Outra\nhttps://example.com/o\nMais texto.')
  })
})
