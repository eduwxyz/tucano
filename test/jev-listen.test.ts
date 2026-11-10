// Listen mode: an agent sits in a channel, reads everything and stays out of the roster until Jev
// says the message needs what only it does — and that whoever is in the room can't handle it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { listenJev } from '../src/core/jev'
import { Runner } from '../src/core/runs'

const agent = (id: string, handle: string, role: string): Agent => ({
  id,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  handle,
  role,
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'read',
  computer: false,
  archived: false
})
const lia = agent('a1', 'lia', 'Engenharia')
const nina = agent('a2', 'nina', 'Conteúdo')
const astra = agent('a3', 'astra', 'Auditoria de segurança e planos')
const said = (text: string): Message => ({ id: 'm1', conversationId: 'c1', author: { kind: 'person', id: 'me' }, text, at: 1 })

// A stand-in for TypeSafe: answers the listen question (who + needed) and the router's (who only),
// and records every request so the prompt can be read.
function typesafe(opts: { listen?: Record<string, number>; needed?: string; route?: Record<string, number> }) {
  const requests: { url: string; init: RequestInit }[] = []
  const top = (p: Record<string, number>): string => Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0]
  const f = (async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    const body = JSON.parse(init.body as string) as { questions: Record<string, { criteria: Record<string, string> }> }
    if (body.questions['needed']) {
      const choice = top(opts.listen ?? { __ninguem: 1 })
      return Response.json({ answers: { who: { type: 'choice', choice, probabilities: opts.listen ?? {} }, needed: { type: 'choice', choice: opts.needed ?? '__nao', probabilities: {} } } })
    }
    const choice = top(opts.route ?? { lia: 1 })
    return Response.json({ answers: { who: { type: 'choice', choice, probabilities: opts.route ?? {} } } })
  }) as unknown as typeof fetch
  const bodies = (): { model: string; state: string; questions: Record<string, { type: string; criteria: Record<string, string> }> }[] =>
    requests.map((r) => JSON.parse(r.init.body as string))
  return { f, requests, bodies }
}

describe('the listen question', () => {
  const ask = (api: ReturnType<typeof typesafe>, key = 'ts-key') =>
    listenJev({ key, messages: [], trigger: said('revise a autenticação do gateway'), listeners: [astra], answering: [lia, nina], me: 'Edu', fetch: api.f })

  it('offers only the listening agents, and says who is already in the room', async () => {
    const api = typesafe({ listen: { astra: 0.82, __ninguem: 0.18 }, needed: '__nao' })
    const r = await ask(api)
    expect(r).toMatchObject({ agents: [astra], reason: 'Astra, 82%' })
    const body = api.bodies()[0]!
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions['who']!.criteria)).toEqual(['astra', '__ninguem'])
    expect(body.questions['needed']!.type).toBe('choice')
    // The prompt carries both sides: what the listener does, and who would answer without it.
    expect(body.state).toContain('astra: Astra, Auditoria de segurança')
    expect(body.state).toContain('lia: Lia, Engenharia')
    expect(body.state).toContain('[Edu] revise a autenticação do gateway')
  })

  it('keeps it out when the room can do without it, and says so', async () => {
    const api = typesafe({ listen: { astra: 0.7, __ninguem: 0.3 }, needed: '__sim' })
    expect(await ask(api)).toMatchObject({ agents: [], reason: 'o Astra caberia, mas quem está no canal dá conta' })
  })

  it('keeps it out when the message asks nothing of it', async () => {
    expect(await ask(typesafe({ listen: { __ninguem: 0.9, astra: 0.1 } }))).toMatchObject({ agents: [], reason: '' })
  })

  it('says what went wrong instead of guessing', async () => {
    const failing = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    expect(await ask({ f: failing, requests: [], bodies: () => [] })).toMatchObject({ error: 'a chave do TypeSafe não vale mais' })
    const off = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    expect(await ask({ f: off, requests: [], bodies: () => [] })).toMatchObject({ error: 'resposta do TypeSafe fora do formato' })
  })
})

describe('in a channel with an agent listening', () => {
  const ready = { installed: true, loggedIn: true }
  let db: Db
  let settings: Settings
  const engines = (): Record<EngineId, Engine> => ({
    claude: fakeEngine('claude', { delayMs: 1 }),
    codex: fakeEngine('codex', { delayMs: 1 }),
    opencode: fakeEngine('opencode'),
    pi: fakeEngine('pi'),
    antigravity: fakeEngine('antigravity'),
    cursor: fakeEngine('cursor'),
    grok: fakeEngine('grok'),
    cline: fakeEngine('cline')
  })
  const runner = (f: typeof fetch, key: string | undefined): Runner =>
    new Runner({ db, engines: engines(), settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), jev: { key: async () => key, fetch: f } })
  const notes = (): string[] => db.messages().filter((m) => m.author.kind === 'system').map((m) => m.text)
  const answered = (): string[] =>
    db
      .messages()
      .filter((m) => m.author.kind === 'agent' && m.run?.status === 'done')
      .map((m) => (m.author.kind === 'agent' ? m.author.id : ''))

  const seed = (): void => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-listen-')), 'test.db'))
    db.saveAgent(lia)
    db.saveAgent(nina)
    db.saveAgent(astra)
    db.createConversation({ id: 'c1', kind: 'channel', name: 'eng', members: ['a1', 'a2', 'a3'] })
  }

  beforeEach(() => {
    seed()
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'jev', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  })

  it('keeps one mode per agent, and drops the mode of whoever leaves the channel', () => {
    db.setMembers('c1', ['a1', 'a2', 'a3'], ['a1'], ['a3'])
    expect(db.conversation('c1')).toMatchObject({ mentionOnly: ['a1'], listen: ['a3'] })
    // Naming the same agent in both: listen wins, it isn't in two modes at once.
    db.setMembers('c1', ['a1', 'a2', 'a3'], ['a3'], ['a3'])
    expect(db.conversation('c1')).toMatchObject({ listen: ['a3'] })
    expect(db.conversation('c1')?.mentionOnly).toBeUndefined()
    // Out of the channel, out of listen mode; and left out, each agent keeps what it had.
    db.setMembers('c1', ['a1', 'a2'], ['a1'])
    expect(db.conversation('c1')?.listen).toBeUndefined()
    db.setMembers('c1', ['a1', 'a2'])
    expect(db.conversation('c1')?.mentionOnly).toEqual(['a1'])
  })

  it('answers through the listener when Jev says the message needs it, and says why', async () => {
    db.setMembers('c1', ['a1', 'a2', 'a3'], [], ['a3'])
    const api = typesafe({ listen: { astra: 0.88, __ninguem: 0.12 }, needed: '__nao', route: { astra: 0.9, lia: 0.05, nina: 0.05 } })
    const r = runner(api.f, 'ts-key')
    await r.send('c1', 'preciso de uma auditoria de segurança do gateway antes do deploy')
    await r.idle()
    expect(answered()).toEqual(['a3'])
    // The routing note carries why an agent nobody mentioned was called.
    expect(notes().some((t) => t.startsWith('Chamei **Astra**') && t.includes('o Jev trouxe Astra, 88%'))).toBe(true)
    // Two questions were asked: the listen one, and then the router's.
    expect(api.bodies().filter((b) => b.questions['needed'])).toHaveLength(1)
  })

  it('leaves it out when the room handles the message', async () => {
    db.setMembers('c1', ['a1', 'a2', 'a3'], [], ['a3'])
    const api = typesafe({ listen: { astra: 0.6, __ninguem: 0.4 }, needed: '__sim', route: { lia: 0.9 } })
    const r = runner(api.f, 'ts-key')
    await r.send('c1', 'o build quebrou ontem, alguém olha?')
    await r.idle()
    expect(answered()).toEqual(['a1'])
    // It stayed out and the room answered: no line about it, nothing to explain.
    expect(notes().some((t) => t.includes('Astra'))).toBe(false)
  })

  it('answers alone through the listener when it is the only one in the room, and says why', async () => {
    db.setMembers('c1', ['a3'], [], ['a3'])
    const api = typesafe({ listen: { astra: 0.91, __ninguem: 0.09 }, needed: '__nao' })
    const r = runner(api.f, 'ts-key')
    await r.send('c1', 'preciso de uma auditoria de segurança do gateway')
    await r.idle()
    expect(answered()).toEqual(['a3'])
    // Nobody else was there to route among, so a line says who is answering and why.
    expect(notes().some((t) => t.includes('trouxe **Astra** (Astra, 91%)'))).toBe(true)
  })

  it('with no TypeSafe key, the listener stays out and the app says why', async () => {
    db.setMembers('c1', ['a3'], [], ['a3'])
    const api = typesafe({})
    const r = runner(api.f, undefined)
    await r.send('c1', 'preciso de uma auditoria de segurança')
    await r.idle()
    expect(answered()).toEqual([])
    expect(api.bodies().filter((b) => b.questions['needed'])).toHaveLength(0)
    expect(notes().some((t) => t.includes('falta a chave do TypeSafe'))).toBe(true)
  })

  it('still wakes it with an @mention, like any agent in the room', async () => {
    db.setMembers('c1', ['a1', 'a2', 'a3'], [], ['a3'])
    const r = runner(typesafe({}).f, 'ts-key')
    await r.send('c1', '@astra pode revisar isto?')
    await r.idle()
    expect(answered()).toEqual(['a3'])
  })
})
