import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { checkJevKey, routeJev } from '../src/core/jev'
import { Runner } from '../src/core/runs'

const agent = (id: string, handle: string, role: string): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role, color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false
})
const lia = agent('a1', 'lia', 'Engenharia')
const nina = agent('a2', 'nina', 'Conteúdo')
const theo = agent('a3', 'theo', 'Dados')
const messages = [{ id: 'm1', conversationId: 'c1', author: { kind: 'me' as const }, text: 'o build quebrou', at: 1 }]

// A stand-in for TypeSafe's API: records requests, answers with the given probabilities.
function typesafe(probabilities: Record<string, number> | number) {
  const requests: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    if (typeof probabilities === 'number') return new Response('{}', { status: probabilities })
    if (url.endsWith('/models')) return Response.json({ models: ['jev-latest'] })
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]
    return Response.json({ model: 'jev-1.13', answers: { who: { type: 'choice', choice, probabilities, confidence: 0.6 } }, usage: { input_tokens: 400, output_tokens: 3 } })
  }) as unknown as typeof fetch
  return { f, requests, body: (i = 0) => JSON.parse(requests[i]!.init.body as string) as { model: string; state: string; questions: { who: { type: string; criteria: Record<string, string> } } } }
}

describe('Jev router', () => {
  it('asks a typed choice among the channel agents, with the key, and calls the one it picks', async () => {
    const api = typesafe({ lia: 0.84, nina: 0.1, __ninguem: 0.06 })
    const r = await routeJev({ key: 'ts-key', messages, agents: [lia, nina], me: 'Edu', fetch: api.f })
    expect(r).toMatchObject({ agents: [lia], reason: 'Jev, 84%' })
    expect(api.requests[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(api.requests[0]!.init.headers).toMatchObject({ Authorization: 'Bearer ts-key' })
    const body = api.body()
    expect(body.model).toBe('jev-latest')
    expect(body.questions.who.type).toBe('choice')
    expect(Object.keys(body.questions.who.criteria)).toEqual(['lia', 'nina', '__ninguem'])
    expect(body.state).toContain('[Edu] o build quebrou')
  })

  it('calls a second agent only when it is close, and nobody when that wins', async () => {
    expect(await routeJev({ key: 'k', messages, agents: [lia, nina, theo], me: 'Edu', fetch: typesafe({ lia: 0.5, theo: 0.35, nina: 0.15 }).f })).toMatchObject({ agents: [lia, theo] })
    expect(await routeJev({ key: 'k', messages, agents: [lia, nina], me: 'Edu', fetch: typesafe({ lia: 0.2, nina: 0.1, __ninguem: 0.7 }).f })).toMatchObject({ agents: [], reason: 'Jev, 70%' })
  })

  it('says what went wrong instead of guessing', async () => {
    expect(await routeJev({ key: 'k', messages, agents: [lia], me: 'Edu', fetch: typesafe(401).f })).toMatchObject({ error: 'a chave do TypeSafe não vale mais' })
    expect(await routeJev({ key: 'k', messages, agents: [lia], me: 'Edu', fetch: typesafe({ ghost: 0.9 }).f })).toMatchObject({ error: 'o TypeSafe escolheu alguém fora do canal' })
    await expect(checkJevKey('bad', typesafe(401).f)).rejects.toThrow('O TypeSafe recusou essa chave.')
    await expect(checkJevKey('good', typesafe({}).f)).resolves.toBeUndefined()
  })
})

describe('in a channel', () => {
  const ready = { installed: true, loggedIn: true }
  let db: Db
  let routerTurns: number
  let settings: Settings
  const engines = (): Record<EngineId, Engine> => {
    const base = fakeEngine('claude', { delayMs: 1 })
    return { claude: { id: 'claude', run: (t) => (t.model === 'haiku' && routerTurns++, base.run(t)) }, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi') }
  }
  const runner = (f: typeof fetch, key: string | undefined): Runner =>
    new Runner({ db, engines: engines(), settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), jev: { key: async () => key, fetch: f } })
  const note = () => db.messages().find((m) => m.author.kind === 'system')!.text

  beforeEach(() => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-jev-')), 'test.db'))
    routerTurns = 0
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready }, routerModel: 'jev', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(lia)
    db.saveAgent(nina)
    db.createConversation({ id: 'c1', kind: 'channel', name: 'eng', members: ['a1', 'a2'] })
  })

  it('routes with Jev, without a CLI turn', async () => {
    const r = runner(typesafe({ lia: 0.9, nina: 0.05, __ninguem: 0.05 }).f, 'ts-key')
    await r.send('c1', 'o build quebrou')
    await r.idle()
    expect(note()).toMatch(/^Chamei \*\*Lia\*\* · Jev, 90%, \d+,\d s$/)
    expect(routerTurns).toBe(0)
    expect(db.messages().filter((m) => m.author.kind === 'agent')).toHaveLength(1)
  })

  it('falls back to Haiku when Jev fails or has no key, and says so', async () => {
    const r = runner(typesafe(429).f, 'ts-key')
    await r.send('c1', 'o build quebrou')
    await r.idle()
    expect(note()).toContain('o Jev falhou (o TypeSafe pediu pra esperar (limite de uso)), o Haiku decidiu')
    expect(routerTurns).toBe(1)

    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-jev-')), 'test.db'))
    db.saveAgent(lia)
    db.saveAgent(nina)
    db.createConversation({ id: 'c1', kind: 'channel', name: 'eng', members: ['a1', 'a2'] })
    const r2 = runner(typesafe({ lia: 1 }).f, undefined)
    await r2.send('c1', 'o build quebrou')
    await r2.idle()
    expect(note()).toContain('o Jev falhou (falta a chave do TypeSafe)')
  })
})
