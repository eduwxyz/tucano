// Tucano Team v1, what the second round of stress batteries found: memories learned in a DM, the
// wiki's history, who manages a channel, a restored person's routines, names, crash-proof RPCs,
// the server's guess limiter, a moved engine, routing in a busy channel, questions answered by
// someone else, unread after the upgrade, and the words a person reads.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, EngineId, Message, Person, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Memories, memorySystem } from '../src/core/memory'
import { People } from '../src/core/people'
import { handoffSystem, routerSystem } from '../src/core/router'
import { Runner } from '../src/core/runs'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tucano-round2-'))
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const ready = { installed: true, loggedIn: true }
const settings = (name = 'Ana'): Settings => ({ workspaceName: name, context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'auto', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' })
const enginesWith = (claude: Engine): Record<EngineId, Engine> => ({ claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }) as Record<EngineId, Engine>

// Ana (owner), Bruno (member), Carla (admin).
function team(file = ':memory:'): { db: Db; people: People; ana: Person; bruno: Person; carla: Person } {
  const db = new Db(file)
  db.renamePerson(db.ownerId(), 'Ana')
  const people = new People(db)
  const ana = db.owner()
  const join1 = (name: string, role: 'member' | 'admin'): Person => {
    const r = people.join(people.createInvite(ana, { role }).code, name)
    if (!('person' in r)) throw new Error(r.error)
    return r.person
  }
  return { db, people, ana, bruno: join1('Bruno', 'member'), carla: join1('Carla', 'admin') }
}

let clock = 1_000_000
const say = (db: Db, conversationId: string, author: Message['author'], text: string, extra: Partial<Message> = {}): Message => {
  const m: Message = { id: `m${clock}`, conversationId, author, text, at: clock++, ...extra }
  db.saveMessage(m)
  return m
}

afterEach(() => setLang('pt'))

// ---------- 1. memories learned in a DM ----------

describe('1. a memory learned in a DM', () => {
  let gateway: Gateway
  beforeEach(async () => {
    gateway = new Gateway()
    await gateway.start()
  })
  afterEach(async () => {
    await gateway.stop()
  })

  it("never reaches a channel: not its agents' prompts, its search, nor its summary", async () => {
    const { db, ana, bruno } = team()
    const lia = agent('a1', 'lia')
    db.saveAgent(lia)
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: ana.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const systems: string[] = []
    const memoryPrompts: string[] = []
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = {
      id: 'claude',
      async *run(t: Turn) {
        if (t.system === memorySystem()) memoryPrompts.push(t.prompt)
        else if (t.system !== routerSystem() && t.system !== handoffSystem()) {
          systems.push(`${t.system}\n${t.prompt}`) // memories come in the live context, at the top of the prompt
          if (t.mcpUrl && /SEGREDO/.test(t.prompt)) await callTool(t.mcpUrl, 'lembrar', { texto: 'Ana está em tratamento SEGREDO-MÉDICO', sobre: 'usuario' })
        }
        yield* base.run(t)
      }
    }
    const memory = new Memories({ db, engines: enginesWith(claude), settings: async () => settings(), emit: () => {}, workDir: dir() })
    const runner = new Runner({ db, engines: enginesWith(claude), settings: async () => settings(), emit: () => {}, workDir: dir(), gateway, memory })
    // Ana, in her DM: the agent keeps it (lembrar), and the extraction learns another from her words.
    await runner.send('ana-dm', 'SEGREDO: estou em tratamento', [], undefined, ana.id)
    await runner.idle()
    for (let i = 0; i < 36; i++) say(db, 'ana-dm', { kind: 'person', id: ana.id }, i === 0 ? 'prefiro SEGREDO-DM nos fins de semana' : `conversa ${i}`)
    await memory.consolidate('ana-dm', true)
    const learned = db.memories({ scope: `person:${ana.id}` }).map((m) => m.text)
    expect(learned).toEqual(expect.arrayContaining(['Ana está em tratamento SEGREDO-MÉDICO', 'Prefere SEGREDO-DM nos fins de semana']))
    expect(db.memories({ scope: `person:${ana.id}` }).every((m) => m.privateTo === ana.id)).toBe(true)

    // In #geral, where Ana wrote too, Bruno asks the agent: nothing of it is in the prompt.
    say(db, 'ch', { kind: 'person', id: ana.id }, 'bom dia, time')
    systems.length = 0
    await runner.send('ch', '@lia qual o plano?', [], undefined, bruno.id)
    await runner.idle()
    expect(systems.length).toBeGreaterThan(0)
    for (const s of systems) expect(s).not.toContain('SEGREDO')
    // Nor in what the channel's agents find, or the channel's summary prompt.
    expect(memory.forPrompt(lia, [ana.id, bruno.id], db.conversation('ch')).aboutMe.map((m) => m.text).join()).not.toContain('SEGREDO')
    // Back in her DM, it's all there.
    systems.length = 0
    await runner.send('ana-dm', 'e aí?', [], undefined, ana.id)
    await runner.idle()
    expect(systems.at(-1)).toContain('SEGREDO-MÉDICO')
    for (let i = 0; i < 300; i++) memory.add(`person:${ana.id}`, `preferência pública número ${i} com texto suficiente pra encher o orçamento do prompt`)
    expect(memory.search(lia, 'SEGREDO tratamento', 10, [ana.id, bruno.id], db.conversation('ch')).map((m) => m.text).join()).not.toContain('SEGREDO')
    expect(memory.search(lia, 'SEGREDO tratamento', 10, [ana.id], db.conversation('ana-dm')).map((m) => m.text).join()).toContain('SEGREDO')
    for (let i = 0; i < 36; i++) say(db, 'ch', { kind: 'person', id: i % 2 ? ana.id : bruno.id }, `assunto do time ${i}`)
    memoryPrompts.length = 0
    await memory.consolidate('ch', true)
    expect(memoryPrompts.length).toBe(1)
    expect(memoryPrompts[0]).not.toContain('SEGREDO')
    expect(db.conversation('ch')?.summary ?? '').not.toContain('SEGREDO')

  })

  it('a memory learned in a channel, or written on the Memória page, goes to channels for the people there', () => {
    const { db, ana, bruno } = team()
    const lia = agent('a1', 'lia')
    db.saveAgent(lia)
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const memory = new Memories({ db, engines: {} as Record<EngineId, Engine>, settings: async () => settings(), emit: () => {}, workDir: dir() })
    memory.remember(lia, db.conversation('ch')!, { texto: 'Ana prefere reuniões curtas', sobre: 'usuario' }, ana.id)
    memory.add(`person:${ana.id}`, 'Ana cuida do financeiro')
    expect(memory.forPrompt(lia, [ana.id, bruno.id], db.conversation('ch')).aboutMe.map((m) => m.text).sort()).toEqual(['Ana cuida do financeiro', 'Ana prefere reuniões curtas'])
  })

  it('one person alone: a DM memory comes into every prompt of theirs, as always', () => {
    const db = new Db(':memory:')
    const lia = agent('a1', 'lia')
    db.saveAgent(lia)
    db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const memory = new Memories({ db, engines: {} as Record<EngineId, Engine>, settings: async () => settings(), emit: () => {}, workDir: dir() })
    memory.remember(lia, db.conversation('dm')!, { texto: 'Prefere café sem açúcar', sobre: 'usuario' })
    expect(memory.forPrompt(lia, undefined, db.conversation('ch')).aboutMe.map((m) => m.text)).toEqual(['Prefere café sem açúcar'])
  })

  it('from before: a memory from a DM, or from nowhere known, becomes its person\'s DMs only; the Memória page and channels stay', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { MIGRATIONS } = await import('../src/core/db')
    const file = join(dir(), 'tucano.db')
    const raw = new DatabaseSync(file)
    const at = MIGRATIONS.findIndex((m) => m.includes("SET private_to = substr(scope, 8)"))
    for (const m of MIGRATIONS.slice(0, at)) raw.exec(m)
    raw.exec(`PRAGMA user_version = ${at};
      INSERT INTO people (id, name, role, created_at) VALUES ('bia', 'Bia', 'member', 1);
      INSERT INTO conversations (id, kind, name, owner, created_at) VALUES ('bia-dm', 'dm', 'a1', 'bia', 1), ('ch', 'channel', 'geral', NULL, 2);
      INSERT INTO memories (id, scope, text, state, origin, conversation_id, created_at, confirmed_at) VALUES
        ('d1', 'person:bia', 'da DM', 'active', 'extraction', 'bia-dm', 1, 1),
        ('d2', 'person:bia', 'de uma conversa apagada', 'active', 'agent', 'gone', 1, 1),
        ('d3', 'person:bia', 'sem conversa', 'active', 'extraction', NULL, 1, 1),
        ('c1', 'person:bia', 'do canal', 'active', 'extraction', 'ch', 1, 1),
        ('p1', 'person:bia', 'escrita por ela', 'active', 'me', NULL, 1, 1);`)
    raw.close()
    const db = new Db(file)
    expect(['d1', 'd2', 'd3'].map((id) => db.memory(id)?.privateTo)).toEqual(['bia', 'bia', 'bia'])
    expect(['c1', 'p1'].map((id) => db.memory(id)?.privateTo)).toEqual([undefined, undefined])
  })
})

// ---------- 8. the server's guess limiter ----------

describe('8. signing in on a server', () => {
  const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
  const KEY = `p_${'a'.repeat(43)}`
  const DEAD = `p_${'d'.repeat(43)}`
  const lookup = async (key: string): Promise<{ person?: Person; removed?: boolean } | undefined> => (key === KEY ? { person: bia } : key === DEAD ? { removed: true } : undefined)
  const owner = (t?: string): boolean => t === 'the-owner-token-of-32-characters'

  it("a removed person's dead key is signed out, never a guess: it can't lock anyone out", async () => {
    const { Doors } = await import('../src/server/guard')
    const { signIn } = await import('../src/server/guard')
    const doors = new Doors()
    for (let i = 0; i < 50; i++) expect((await signIn({ cookie: DEAD, ip: '1.1.1.1', doors, isOwnerToken: owner, strongOwnerToken: true, lookup })).status).toBe('removed')
    expect(doors.blocked('signin', '1.1.1.1')).toBe(false)
    expect((await signIn({ cookie: 'the-owner-token-of-32-characters', ip: '1.1.1.1', doors, isOwnerToken: owner, strongOwnerToken: true, lookup })).status).toBe('owner')
  })

  it('after many wrong guesses the address waits, but a valid key or (server-made) token still opens; a weak chosen token waits too', async () => {
    const { Doors, signIn } = await import('../src/server/guard')
    const doors = new Doors()
    for (let i = 0; i < 25; i++) await signIn({ cookie: `p_${String(i).padStart(43, 'x')}`, ip: '2.2.2.2', doors, isOwnerToken: owner, strongOwnerToken: true, lookup })
    expect(doors.blocked('signin', '2.2.2.2')).toBe(true)
    const at = (o: Partial<Parameters<typeof signIn>[0]>) => signIn({ ip: '2.2.2.2', doors, isOwnerToken: owner, strongOwnerToken: true, lookup, ...o })
    expect((await at({ cookie: KEY })).status).toBe('person')
    expect((await at({ cookie: 'the-owner-token-of-32-characters' })).status).toBe('owner')
    expect((await at({ offered: 'the-owner-token-of-32-characters' })).status).toBe('link')
    // Every wrong one, of any kind, gets the same "wait": nothing says which were close.
    for (const o of [{ cookie: `p_${'z'.repeat(43)}` }, { cookie: 'garbage' }, { offered: 'nope' }, {}]) expect((await at(o)).status).toBe('blocked')
    // A token the operator chose (TUCANO_TOKEN) may be guessable: it waits like any guess.
    expect((await at({ cookie: 'the-owner-token-of-32-characters', strongOwnerToken: false })).status).toBe('blocked')
  })

  it('without a block, a wrong key is a guess and answers as any other unknown one', async () => {
    const { Doors, signIn } = await import('../src/server/guard')
    const doors = new Doors()
    expect((await signIn({ cookie: 'garbage', ip: '3.3.3.3', doors, isOwnerToken: owner, strongOwnerToken: true, lookup })).status).toBe('unauthorized')
    expect((await signIn({ cookie: `p_${'z'.repeat(43)}`, ip: '3.3.3.3', doors, isOwnerToken: owner, strongOwnerToken: true, lookup })).status).toBe('unauthorized')
    expect((await signIn({ ip: '3.3.3.3', doors, isOwnerToken: owner, strongOwnerToken: true, lookup })).status).toBe('unauthorized')
  })

  it("the core tells a removed person's key from an unknown one", () => {
    const { db, people, ana, bruno } = team()
    const { code } = people.createInvite(ana, { role: 'member' })
    const r = people.join(code, 'Edu')
    if (!('key' in r)) throw new Error('no key')
    people.remove(ana, r.person.id)
    expect(people.authenticate(r.key)).toBeUndefined()
    expect(people.removedKey(r.key)).toBe(true)
    expect(people.removedKey(`p_${'q'.repeat(43)}`)).toBe(false)
    void db
    void bruno
  })
})

// ---------- 9. an engine that moved ----------

describe('9. a harness whose binary moved (ENOENT)', () => {
  const turn = (): Turn => ({ model: 'sonnet', effort: 'low', system: 's', prompt: 'p', cwd: dir(), signal: new AbortController().signal })
  // A CLI run like cli.ts's: the binary missing is the spawn's ENOENT, as an error event.
  const cli = (bin: () => string | undefined): Engine => ({
    id: 'claude',
    async *run() {
      const path = bin()
      const { existsSync } = await import('node:fs')
      if (!path || !existsSync(path)) {
        yield { type: 'error', message: `spawn ${path} ENOENT` }
        return
      }
      yield { type: 'text', delta: `ran ${path}` }
    }
  })
  const collect = async (e: Engine): Promise<string[]> => {
    const out: string[] = []
    for await (const ev of e.run(turn())) out.push(ev.type === 'text' ? ev.delta : ev.type === 'error' ? `error: ${ev.message}` : ev.type)
    return out
  }

  it('looks for it again once and runs from where it is now', async () => {
    const { writeFileSync } = await import('node:fs')
    const { relocating } = await import('../src/core/engines/relocate')
    const moved = join(dir(), 'claude')
    writeFileSync(moved, '')
    let path: string | undefined = '/opt/homebrew/bin/claude-gone'
    let detects = 0
    const e = relocating(cli(() => path), { path: () => path, label: 'Claude Code', redetect: async () => void (detects++, (path = moved)) })
    expect(await collect(e)).toEqual([`ran ${moved}`])
    expect(detects).toBe(1)
    expect(await collect(e)).toEqual([`ran ${moved}`])
    expect(detects).toBe(1) // found: no more looking
  })

  it('an ENOENT in the middle of a run (moved after the check) retries once, after looking again', async () => {
    const { writeFileSync } = await import('node:fs')
    const { relocating } = await import('../src/core/engines/relocate')
    const moved = join(dir(), 'claude')
    writeFileSync(moved, '')
    let path = moved
    let calls = 0
    const flaky: Engine = { id: 'claude', async *run() { calls++; if (calls === 1) yield { type: 'error', message: `spawn ${path} ENOENT` }; else yield { type: 'text', delta: 'ok' } } }
    let detects = 0
    const e = relocating(flaky, { path: () => path, label: 'Claude Code', redetect: async () => void (detects++, (path = moved)) })
    expect(await collect(e)).toEqual(['ok'])
    expect(detects).toBe(1)
  })

  it('gone for good: says so plainly, once', async () => {
    const { relocating } = await import('../src/core/engines/relocate')
    let detects = 0
    const e = relocating(cli(() => '/nowhere/claude'), { path: () => '/nowhere/claude', label: 'Claude Code', redetect: async () => void detects++ })
    const out = await collect(e)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^error: Não encontrei o Claude Code em \/nowhere\/claude/)
    expect(detects).toBe(1)
  })

  it('the core wraps every harness with it (desktop and server alike)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'index.ts'), 'utf8')
    for (const id of ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok']) expect(src).toMatch(new RegExp(`${id}: relocating\\(${id}Engine\\(`))
  })
})

// ---------- 10. routing in a busy channel ----------

describe('10. routed replies in a busy channel', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  // The router picks by a word in the last message ("leo:", "nico:"...) after `routerMs`; each agent
  // takes `agentMs` and records the prompt it got. A message with "falha" makes that reply fail.
  function rig(db: Db, opts: { routerMs?: number; agentMs?: number } = {}) {
    const prompts: { agent: string; prompt: string }[] = []
    let routerCalls = 0
    const claude: Engine = {
      id: 'claude',
      async *run(t: Turn) {
        if (t.system === routerSystem()) {
          routerCalls++
          await sleep(opts.routerMs ?? 0)
          const lines = t.prompt.split('\n').filter((l) => l.startsWith('['))
          const last = lines.at(-1) ?? ''
          const handle = /\b(leo|nico|bia|tom):/.exec(last)?.[1]
          yield { type: 'done', text: JSON.stringify({ handles: handle ? [handle] : [], reason: 'teste' }), usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
          return
        }
        if (t.system === handoffSystem() || t.system === memorySystem()) {
          yield { type: 'done', text: '{"handles":[],"reason":"x","summary":"x","memories":[]}', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
          return
        }
        const who = /Você é (\w+)/.exec(t.system)?.[1] ?? '?'
        prompts.push({ agent: who, prompt: t.prompt })
        await sleep(opts.agentMs ?? 0)
        const answering = /a esta mensagem de [^:]+: “([^”]*)”/.exec(t.prompt)?.[1] ?? ''
        if (/falha/.test(answering)) {
          yield { type: 'error', message: 'quebrou' }
          return
        }
        yield { type: 'text', delta: `${who} responde: ${answering}` }
        yield { type: 'done', text: `${who} responde: ${answering}`, usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const runner = new Runner({ db, engines: enginesWith(claude), settings: async () => settings(), emit: () => {}, workDir: dir() })
    return { runner, prompts, routerCalls: () => routerCalls }
  }
  // The transcript blocks of a prompt: "[Author · hh:mm]\ntext", in order.
  const lines = (prompt: string): string[] => prompt.split('\n\n').filter((b) => b.startsWith('[')).map((b) => b.replace(/^\[([^·\]]+)[^\]]*\]\n/, '$1: ').trim())

  it('a message to people only (@Bia oi, @someone who left) never calls the agents', async () => {
    const { db, people, ana, bruno } = team()
    for (const [id, h] of [['a1', 'leo'], ['a2', 'nico'], ['a3', 'tom']] as const) db.saveAgent(agent(id, h))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1', 'a2', 'a3'] })
    const bia = people.join(people.createInvite(ana, { role: 'member' }).code, 'Bia')
    if (!('person' in bia)) throw new Error('no bia')
    const edu = people.join(people.createInvite(ana, { role: 'member' }).code, 'Edu')
    if (!('person' in edu)) throw new Error('no edu')
    people.remove(ana, edu.person.id)
    const { runner, prompts, routerCalls } = rig(db)
    await runner.send('ch', '@Bia oi', [], undefined, ana.id)
    await runner.send('ch', '@bia, bom dia!', [], undefined, bruno.id)
    await runner.send('ch', '@Edu tudo bem?', [], undefined, ana.id) // removed
    await runner.send('ch', '@Bia oi', [], undefined, bia.person.id) // herself
    await runner.idle()
    expect(routerCalls()).toBe(0)
    expect(prompts).toEqual([])
  })

  it('two messages 150 ms apart (one person): each reply ends at its own message and is told which one it answers', async () => {
    const db = new Db(':memory:')
    db.saveAgent(agent('a1', 'leo'))
    db.saveAgent(agent('a2', 'nico'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
    const { runner, prompts } = rig(db, { routerMs: 250, agentMs: 100 })
    await runner.send('ch', 'leo: pergunta A sobre deploy')
    await sleep(150)
    await runner.send('ch', 'leo: pergunta B sobre testes')
    await runner.idle()
    expect(prompts.map((p) => p.agent)).toEqual(['Leo', 'Leo'])
    const [first, second] = prompts.map((p) => lines(p.prompt))
    expect(first!.at(-1)).toMatch(/pergunta A sobre deploy$/)
    expect(first!.join('\n')).not.toContain('pergunta B')
    // The second ends at B, not at Leo's own first reply (which came in after B), and says so.
    expect(second!.at(-1)).toMatch(/pergunta B sobre testes$/)
    expect(second!.join('\n')).toContain('Leo responde: leo: pergunta A sobre deploy')
    expect(prompts[1]!.prompt).toContain('Você responde a esta mensagem de Ana: “leo: pergunta B sobre testes”')
    // A mention, a DM: no such line, the prompt reads as always.
    prompts.length = 0
    await runner.send('ch', '@nico oi')
    await runner.idle()
    expect(prompts[0]!.prompt).not.toContain('Você responde a esta mensagem')
  })

  it('a reply that failed is not answered by the next routed reply', async () => {
    const db = new Db(':memory:')
    db.saveAgent(agent('a1', 'leo'))
    db.saveAgent(agent('a2', 'nico'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
    const { runner, prompts } = rig(db)
    await runner.send('ch', 'leo: isso vai dar falha')
    await runner.idle()
    await runner.send('ch', 'leo: e o relatório de vendas?')
    await runner.idle()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]!.prompt).toContain('Você responde a esta mensagem de Ana: “leo: e o relatório de vendas?”')
    expect(prompts[1]!.prompt).toMatch(/ficou sem resposta por uma falha, não é pra responder de novo/)
    expect(lines(prompts[1]!.prompt).at(-1)).toMatch(/e o relatório de vendas\?$/)
  })

  it('four people at once: every routed reply ends at its message, with no one\'s later words in it', async () => {
    const { db, people, ana, bruno, carla } = team()
    const davi = people.join(people.createInvite(ana, { role: 'member' }).code, 'Davi')
    if (!('person' in davi)) throw new Error('no davi')
    for (const [id, h] of [['a1', 'leo'], ['a2', 'nico'], ['a3', 'bia'], ['a4', 'tom']] as const) db.saveAgent(agent(id, h))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1', 'a2', 'a3', 'a4'] })
    const { runner, prompts } = rig(db, { routerMs: 120, agentMs: 60 })
    const said: [string, string][] = [
      [ana.id, 'leo: ANA-1 o deploy quebrou'],
      [bruno.id, 'nico: BRUNO-1 qual a meta?'],
      [carla.id, 'leo: CARLA-1 e o rollback?'],
      [davi.person.id, 'tom: DAVI-1 manda o post'],
      [ana.id, 'nico: ANA-2 e a receita?'],
      [bruno.id, 'bia: BRUNO-2 revisa o texto']
    ]
    for (const [who, text] of said) {
      await runner.send('ch', text, [], undefined, who)
      await sleep(40)
    }
    await runner.idle()
    expect(prompts.length).toBeGreaterThanOrEqual(5)
    for (const p of prompts) {
      const shown = lines(p.prompt)
      const target = /a esta mensagem de [^:]+: “([^”]*)”/.exec(p.prompt)?.[1]
      expect(target, p.prompt).toBeTruthy()
      expect(shown.at(-1)).toContain(target!)
      // Nothing a person said after it.
      const at = said.findIndex(([, t]) => t === target)
      for (const [, later] of said.slice(at + 1)) expect(p.prompt, `${p.agent} answering ${target}`).not.toContain(later.split(' ')[1]!)
    }
  })

  it('the router, with more than one person, knows a greeting or note between people needs no agent; alone it reads as always', async () => {
    const { routerPrompt } = await import('../src/core/router')
    const db = new Db(':memory:')
    db.saveAgent(agent('a1', 'leo'))
    const m: Message = { id: 'x', conversationId: 'ch', author: { kind: 'person', id: db.ownerId() }, text: 'bom dia, pessoal', at: 1 }
    const solo = routerPrompt({ messages: [m], agents: [agent('a1', 'leo')], me: 'Ana' })
    expect(solo).not.toMatch(/entre as pessoas/)
    const teamPrompt = routerPrompt({ messages: [m], agents: [agent('a1', 'leo')], me: 'Ana', team: true })
    expect(teamPrompt).toMatch(/Um cumprimento ou recado entre as pessoas/)
  })
})

// ---------- 11. a question someone else answered ----------

describe('11. a question answered by someone else', () => {
  function asked(db: Db, to: Person, requester: Person): Message {
    const ask = say(db, 'ch', { kind: 'agent', id: 'a1' }, '', { run: { status: 'waiting_input', steps: [], question: 'Qual o orçamento do Q3?', askedTo: to.id } })
    db.saveQuestion({ id: ask.id, conversationId: 'ch', agentId: 'a1', text: 'Qual o orçamento do Q3?', askedTo: to.id, requestedBy: requester.id, state: 'open', deadlineAt: Date.now() + 3_600_000, createdAt: Date.now() })
    return ask
  }

  it('the agent goes on knowing who answered for whom; the card and the inbox say who', async () => {
    const { db, people, ana, bruno, carla } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    say(db, 'ch', { kind: 'person', id: ana.id }, '@lia monta o plano do Q3')
    const q = asked(db, bruno, ana)
    const prompts: string[] = []
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', async *run(t) { if (t.system !== routerSystem() && t.system !== handoffSystem()) prompts.push(t.prompt); yield* base.run(t) } }
    const runner = new Runner({ db, engines: enginesWith(claude), settings: async () => settings(), emit: () => {}, workDir: dir() })
    await runner.answer(q.id, '50 mil', carla)
    await runner.idle()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Carla (admin) respondeu no lugar de Bruno')
    expect(prompts[0]).toContain('pergunta enviada a Bruno pela ferramenta ask_user')
    expect(prompts[0]).not.toContain('pergunta enviada a Carla')
    expect(db.message(q.id)?.run).toMatchObject({ status: 'done', answeredBy: carla.id })
    // Bruno, who was typing, finds it answered (by Carla) in his inbox for a while.
    expect(people.inbox(bruno).answered).toMatchObject([{ id: q.id, answeredBy: carla.id }])
    expect(people.inbox(carla).answered ?? []).toEqual([])
    await expect(runner.answer(q.id, 'outra', bruno)).rejects.toThrow('Essa pergunta já foi respondida por Carla.')
  })
})

// ---------- 12. unread after the upgrade ----------

describe('12. unread right after upgrading from main', () => {
  it("is exactly what main showed, over random databases main recorded", async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { MIGRATIONS } = await import('../src/core/db')
    const mainCount = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE people'))
    expect(mainCount).toBeGreaterThan(0)
    const phases = ['working', 'done', 'failed', 'waiting_input', 'waiting_approval', 'limit_reached', 'message'] as const
    let seed = 11
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    const mismatches: string[] = []
    // Each round builds a database on disk: Windows' disk is slow enough that fewer rounds keep it in time.
    // A pull request's CI runs a few (TUCANO_QUICK_TESTS); main runs them all.
    const rounds = process.env['TUCANO_QUICK_TESTS'] ? 5 : process.platform === 'win32' ? 20 : 150
    for (let round = 0; round < rounds; round++) {
      const file = join(dir(), 'tucano.db')
      const raw = new DatabaseSync(file)
      for (const m of MIGRATIONS.slice(0, mainCount)) raw.exec(m)
      raw.exec(`PRAGMA user_version = ${mainCount}`)
      const convs = ['c1', 'c2', 'c3']
      for (const c of convs) raw.prepare('INSERT INTO conversations (id, kind, name, created_at) VALUES (?, ?, ?, 1)').run(c, c === 'c3' ? 'dm' : 'channel', c)
      // Main's recordActivity and markRead, writing its own table as it did.
      const count = (c: string): number => (raw.prepare('SELECT COUNT(*) AS n FROM message_notifications n JOIN messages m ON m.id = n.message_id WHERE n.unread = 1 AND m.conversation_id = ?').get(c) as { n: number }).n
      const ids: { id: string; conv: string }[] = []
      let viewing: string | null = null
      for (let step = 0; step < 60; step++) {
        const op = rnd(10)
        if (op < 6) {
          const reuse = ids.length > 0 && rnd(2) === 0
          const m = reuse ? ids[rnd(ids.length)]! : { id: `m${round}-${step}`, conv: convs[rnd(3)]! }
          if (!reuse) {
            ids.push(m)
            raw.prepare("INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at) VALUES (?, ?, 'agent', 'a1', 't', ?)").run(m.id, m.conv, step)
          }
          const phase = phases[rnd(phases.length)]!
          const unread = m.conv !== viewing && (phase === 'working' || phase === 'message' || count(m.conv) === 0)
          raw.prepare('INSERT OR IGNORE INTO message_notifications (message_id, phase, unread) VALUES (?, ?, ?)').run(m.id, phase, unread ? 1 : 0)
        } else if (op < 8) raw.prepare('UPDATE message_notifications SET unread = 0 WHERE unread = 1 AND message_id IN (SELECT id FROM messages WHERE conversation_id = ?)').run(convs[rnd(3)]!)
        else viewing = rnd(2) ? convs[rnd(3)]! : null
      }
      const shown = Object.fromEntries(convs.map((c) => [c, count(c)]))
      raw.close()
      const db = new Db(file)
      for (const c of convs) if (db.conversation(c)?.unread !== shown[c]) mismatches.push(`round ${round} ${c}: main ${shown[c]}, team ${db.conversation(c)?.unread}`)
      db.close()
    }
    expect(mismatches).toEqual([])
  }, 180_000)
})
