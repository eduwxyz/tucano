// Tucano Team v1, what three stress batteries found: privacy between people (DMs, notes made in a
// DM, the wiki, the team's log, export, purge), who changes a channel, unread for one person exactly
// as before, routed replies in a busy channel, and the small things a person reads.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { CoreEvent } from '../src/shared/rpc'
import { personScope, type Agent, type EngineId, type Message, type Person, type Settings } from '../src/shared/types'
import { transcriptBlocks } from '../src/core/context'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Memories } from '../src/core/memory'
import { hashSecret, Hub, mayEditChannel, mentionedPeople, People, routineDetail, type PortLike } from '../src/core/people'
import { can, must } from '../src/core/policy-people'
import { handoffSystem, routerSystem } from '../src/core/router'
import { Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'
import { exportTeam, importTeam } from '../src/core/team'
import { Wiki } from '../src/core/wiki'
import { WikiCurator } from '../src/core/wiki-curator'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tucano-stress-'))
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const ready = { installed: true, loggedIn: true }
const settings = (name = 'Ana'): Settings => ({ workspaceName: name, context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'auto', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' })

class FakePort implements PortLike {
  got: CoreEvent[] = []
  postMessage(msg: unknown): void {
    const m = msg as { event?: CoreEvent }
    if (m.event) this.got.push(m.event)
  }
  close(): void {}
}

// Ana (owner), Bia (member), Dani (admin).
function team(file = ':memory:'): { db: Db; people: People; ana: Person; bia: Person; dani: Person } {
  const db = new Db(file)
  db.renamePerson(db.ownerId(), 'Ana')
  const people = new People(db)
  const ana = db.owner()
  const join1 = (name: string, role: 'member' | 'admin'): Person => {
    const r = people.join(people.createInvite(ana, { role }).code, name)
    if (!('person' in r)) throw new Error(r.error)
    return r.person
  }
  return { db, people, ana, bia: join1('Bia', 'member'), dani: join1('Dani', 'admin') }
}

let clock = 1_000_000
const say = (db: Db, conversationId: string, author: Message['author'], text: string, extra: Partial<Message> = {}): Message => {
  const m: Message = { id: `m${clock}`, conversationId, author, text, at: clock++, ...extra }
  db.saveMessage(m)
  return m
}

afterEach(() => setLang('pt'))

// ---------- privacy ----------

describe("an agent's thread tools, for the person a reply is for (2)", () => {
  let gateway: Gateway
  beforeEach(async () => {
    gateway = new Gateway()
    await gateway.start()
  })
  afterEach(async () => {
    await gateway.stop()
  })

  it("never find or read someone else's DM, nor list or cancel a routine that lives in one", async () => {
    const { db, ana, bia } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'], threads: true })
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: ana.id, threads: true })
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id, threads: true })
    const anas = say(db, 'ana-dm', { kind: 'person', id: ana.id }, 'SEGREDO DA ANA: o plano do salário')
    say(db, 'ana-dm', { kind: 'agent', id: 'a1' }, 'RESPOSTA PRIVADA sobre o plano', { threadId: anas.id })
    const team1 = say(db, 'ch', { kind: 'person', id: ana.id }, 'o plano do time')
    db.saveRoutine({ id: 'r-ana', name: 'Rotina secreta da Ana', agentId: 'a1', conversationId: 'ana-dm', prompt: 'PEDIDO PRIVADO', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: ana.id })
    const results: string[] = []
    const turns: Turn[] = []
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = {
      id: 'claude',
      async *run(t) {
        if (t.system !== routerSystem() && t.system !== handoffSystem() && t.mcpUrl) {
          turns.push(t)
          results.push(JSON.stringify(await callTool(t.mcpUrl, 'buscar_threads', { busca: 'plano' })))
          results.push(JSON.stringify(await callTool(t.mcpUrl, 'ler_thread', { id: anas.id })))
          results.push(JSON.stringify(await callTool(t.mcpUrl, 'cancelar_rotina', { id: 'r-ana' })))
          results.push(JSON.stringify(await callTool(t.mcpUrl, 'agendar_rotina', { substitui: 'r-ana', nome: 'x', pedido: 'y', horario: '10:00' })))
        }
        yield* base.run(t)
      }
    }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') } as Record<EngineId, Engine>
    const routines = new Routines({ db, runner: { runRoutine: async () => undefined }, emit: () => {} })
    const runner = new Runner({ db, engines, settings: async () => settings(), emit: () => {}, workDir: dir(), gateway, routines })
    void team1
    await runner.send('ch', '@lia e o plano?', [], undefined, bia.id)
    await runner.idle()

    const [found, read, cancel, replace] = results
    expect(found).toContain('o plano do time')
    expect(found).not.toContain('SEGREDO DA ANA')
    expect(found).not.toContain('RESPOSTA PRIVADA')
    expect(read).toContain('Não achei essa thread')
    expect(read).not.toContain('SEGREDO')
    expect(cancel).toContain('Não achei uma rotina sua')
    expect(replace).toContain('Não achei uma rotina sua')
    expect(db.routine('r-ana')).toMatchObject({ name: 'Rotina secreta da Ana', prompt: 'PEDIDO PRIVADO' })
    // The routine's name and request never reach Bia's prompt either.
    expect(turns[0]!.system).not.toContain('Rotina secreta da Ana')
    expect(turns[0]!.system).not.toContain('PEDIDO PRIVADO')

    // Ana's own reply in her DM still finds it all.
    results.length = 0
    await runner.send('ana-dm', 'e o plano?', [], anas.id, ana.id)
    await runner.idle()
    expect(results[0]).toContain('o plano do time')
  })
})

describe("an agent's note made in a DM (4)", () => {
  it("is that person's alone: not in others' snapshot, events or prompts, and only they change it", () => {
    const { db, people, ana, bia, dani } = team()
    const lia = agent('a1', 'lia')
    db.saveAgent(lia)
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id })
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: ana.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const memory = new Memories({ db, engines: {} as Record<EngineId, Engine>, settings: async () => settings(), emit: () => {}, workDir: dir() })
    const r = memory.remember(lia, db.conversation('bia-dm')!, { texto: 'Bia está negociando um aumento', sobre: 'agente' }, bia.id)
    expect(r.memory).toMatchObject({ scope: 'a1', privateTo: bia.id })
    const team1 = memory.remember(lia, db.conversation('ch')!, { texto: 'O time usa trunk-based', sobre: 'agente' }, ana.id)
    expect(team1.memory?.privateTo).toBeUndefined()

    const texts = (ms: { text: string }[]): string[] => ms.map((m) => m.text)
    // Prompts: in her DM, yes; in Ana's DM and in the channel (everyone reads), no.
    expect(texts(memory.forPrompt(lia, [bia.id], db.conversation('bia-dm')).own).sort()).toEqual(['Bia está negociando um aumento', 'O time usa trunk-based'])
    expect(texts(memory.forPrompt(lia, [ana.id], db.conversation('ana-dm')).own)).toEqual(['O time usa trunk-based'])
    expect(texts(memory.forPrompt(lia, [bia.id], db.conversation('ch')).own)).toEqual(['O time usa trunk-based'])
    // What each one sees.
    expect(people.canSeeMemory(bia, r.memory!)).toBe(true)
    for (const p of [ana, dani]) expect(people.canSeeMemory(p, r.memory!)).toBe(false)
    const hub = new Hub<FakePort>(people, db)
    const ports = { ana: new FakePort(), bia: new FakePort() }
    hub.add(ports.ana, null)
    hub.add(ports.bia, { person: bia.id })
    hub.emit({ type: 'memory', memory: r.memory! })
    expect([ports.ana.got.length, ports.bia.got.length]).toEqual([0, 1])
    // Changing it: hers only, not even the owner's.
    expect(can(bia, { kind: 'memory', scope: 'a1', privateTo: bia.id })).toBe(true)
    expect(can(ana, { kind: 'memory', scope: 'a1', privateTo: bia.id })).toBe(false)
    // Ana's run can't replace it by id.
    expect(memory.remember(lia, db.conversation('ana-dm')!, { texto: 'outra', sobre: 'agente', substitui: r.memory!.id }, ana.id).error).toBe(true)
  })

  it('with one person, comes into every prompt of theirs, as always', () => {
    const db = new Db(':memory:')
    const lia = agent('a1', 'lia')
    db.saveAgent(lia)
    db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const memory = new Memories({ db, engines: {} as Record<EngineId, Engine>, settings: async () => settings(), emit: () => {}, workDir: dir() })
    memory.remember(lia, db.conversation('dm')!, { texto: 'nota da DM', sobre: 'agente' })
    expect(memory.forPrompt(lia, undefined, db.conversation('ch')).own.map((m) => m.text)).toEqual(['nota da DM'])
    expect(memory.forPrompt(lia).own.map((m) => m.text)).toEqual(['nota da DM'])
  })

  it('from before this change: a DM note becomes its person\'s by the migration', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { MIGRATIONS } = await import('../src/core/db')
    const file = join(dir(), 'tucano.db')
    const raw = new DatabaseSync(file)
    const at = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE unread'))
    for (const m of MIGRATIONS.slice(0, at)) raw.exec(m)
    raw.exec(`PRAGMA user_version = ${at};
      INSERT INTO people (id, name, role, created_at) VALUES ('bia', 'Bia', 'member', 1);
      INSERT INTO conversations (id, kind, name, owner, created_at) VALUES ('bia-dm', 'dm', 'a1', 'bia', 1), ('ch', 'channel', 'geral', NULL, 2);
      INSERT INTO memories (id, scope, text, state, origin, conversation_id, created_at, confirmed_at) VALUES ('k1', 'a1', 'privada', 'active', 'agent', 'bia-dm', 1, 1), ('k2', 'a1', 'do time', 'active', 'agent', 'ch', 1, 1);`)
    raw.close()
    const db = new Db(file)
    expect(db.memory('k1')?.privateTo).toBe('bia')
    expect(db.memory('k2')?.privateTo).toBeUndefined()
    expect(db.conversation('ch')?.createdBy).toBe(db.ownerId())
  })
})

describe('the wiki and DMs (3)', () => {
  const curatorFor = (db: Db): { wiki: Wiki; curator: WikiCurator; asked: string[] } => {
    const root = dir()
    const wiki = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
    wiki.init()
    const asked: string[] = []
    const curator = new WikiCurator({ wiki, db, settings: () => settings(), emitMessage: () => {}, llm: async (_s, p) => (asked.push(p), '{"changes":[]}') })
    return { wiki, curator, asked }
  }

  it("with more than one person, the curator reads no DM, not even the owner's", async () => {
    const { db, ana } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: ana.id })
    for (let i = 0; i < 6; i++) say(db, 'ana-dm', { kind: 'person', id: ana.id }, `SALÁRIO e assuntos pessoais da Ana, parte ${i}, com texto suficiente pra valer a leitura do curador.`)
    const { curator, asked } = curatorFor(db)
    await curator.read('ana-dm')
    await curator.idle()
    expect(asked).toEqual([])
  })

  it('with one person, the DM is read as always', async () => {
    const db = new Db(':memory:')
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'] })
    for (let i = 0; i < 6; i++) say(db, 'dm', { kind: 'person', id: db.ownerId() }, `Decidimos usar Postgres no projeto, parte ${i}, com texto suficiente pra valer a leitura do curador.`)
    const { curator, asked } = curatorFor(db)
    await curator.read('dm')
    await curator.idle()
    expect(asked.length).toBeGreaterThan(0)
  })

  it("a source from a DM is its person's to see; an admin deletes a source for good (text and file)", () => {
    const { db, people, ana, bia } = team()
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: [], owner: ana.id })
    const { wiki } = curatorFor(db)
    const leaked = wiki.addSource({ title: 'da DM', text: 'segredo', kind: 'conversation', origin: { conversationId: 'ana-dm' }, by: 'curador', file: { name: 'a.txt', data: Buffer.from('x') } })
    expect(people.canSeeFrom(bia, wiki.source(leaked.id)?.origin.conversationId)).toBe(false)
    expect(people.canSeeFrom(ana, wiki.source(leaked.id)?.origin.conversationId)).toBe(true)
    const files = [join(wiki.dir, `${leaked.file}.md`), join(wiki.dir, wiki.source(leaked.id)!.origin.original!)]
    expect(files.every(existsSync)).toBe(true)
    expect(wiki.removeSource(leaked.id)).toBe(true)
    expect(wiki.source(leaked.id)).toBeUndefined()
    expect(files.some(existsSync)).toBe(false)
  })

  it('the core filters wikiSources/wikiSource by who can see; deleting is the admins\' (or the DM\'s person\'s), checked in the core', async () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'index.ts'), 'utf8')
    expect(src).toMatch(/wikiSources: \(_, ctx\) => wikiSourcesFor\(ctx\)/)
    expect(src).toMatch(/if \(people\.canSeeFrom\(ctx\.person, src\.origin\.conversationId\)\) return src/)
    expect(src).toMatch(/if \(!isAdmin\(ctx\.person\) && !theirs\) throw/) // see team-round2-core.test.ts
  })
})

describe("the team's log and DMs (5)", () => {
  it('keeps no routine name from a DM: "uma rotina pessoal"', () => {
    const { db, ana } = team()
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: [], owner: ana.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: [] })
    expect(routineDetail(db, { name: 'Lembrar do exame da minha mãe', conversationId: 'ana-dm', scope: 'me' })).toEqual({ name: 'uma rotina pessoal', scope: 'me' })
    expect(routineDetail(db, { name: 'Resumo do time', conversationId: 'ch', scope: 'channel' })).toEqual({ name: 'Resumo do time', scope: 'channel' })
    expect(routineDetail(db, undefined)).toEqual({ name: 'uma rotina pessoal', scope: 'me' })
  })

  it('every routine record in the core goes through it', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'index.ts'), 'utf8')
    const calls = [...src.matchAll(/record\(ctx, [^\n]*'routine\.[^\n]*/g)].map((m) => m[0])
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const c of calls) expect(c).toContain('routineDetail(db,')
  })
})

describe('exporting and importing the team (6)', () => {
  it("never takes someone else's DM routine along, nor drops one into someone else's DM", () => {
    const { db, ana, bia, dani } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id })
    db.createConversation({ id: 'dani-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: dani.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    db.saveRoutine({ id: 'r1', name: 'Rotina da Bia', agentId: 'a1', conversationId: 'bia-dm', prompt: 'PRIVADO DA BIA', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: bia.id })
    db.saveRoutine({ id: 'r2', name: 'Rotina da Dani', agentId: 'a1', conversationId: 'dani-dm', prompt: 'da dani', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: dani.id })
    db.saveRoutine({ id: 'r3', name: 'Rotina do canal', agentId: 'a1', conversationId: 'ch', prompt: 'do time', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: ana.id })
    const text = exportTeam(db, dani.id)
    expect(text).not.toContain('Rotina da Bia')
    expect(text).not.toContain('PRIVADO DA BIA')
    expect(text).toContain('Rotina da Dani')
    expect(text).toContain('Rotina do canal')

    // Into another Tucano where the agent has Bia's DM only: Dani's routine goes into a DM of Dani's own.
    const other = team()
    other.db.saveAgent(agent('a1', 'lia'))
    other.db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: other.bia.id })
    importTeam(other.db, text, 1000, other.dani.id)
    const dm = other.db.routines().find((r) => r.name === 'Rotina da Dani')!
    expect(other.db.conversation(dm.conversationId)).toMatchObject({ kind: 'dm', owner: other.dani.id })
    expect(dm.owner).toBe(other.dani.id)
    expect(other.db.routines().filter((r) => r.conversationId === 'bia-dm')).toEqual([])
  })

  it('with one person, everything goes, as always', () => {
    const db = new Db(':memory:')
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'] })
    db.saveRoutine({ id: 'r1', name: 'Minha rotina', agentId: 'a1', conversationId: 'dm', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1 })
    expect(exportTeam(db)).toContain('Minha rotina')
  })
})

describe("someone else's routine (7, 14)", () => {
  it("an admin can't move a routine out of a member's DM (the place it is now must be theirs too)", () => {
    const { db, people, bia, dani } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    db.saveRoutine({ id: 'r1', name: 'Da Bia', agentId: 'a1', conversationId: 'bia-dm', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: bia.id })
    expect(() => people.routineSave(dani, { id: 'r1', conversationId: 'ch' })).toThrow('Essa conversa é de outra pessoa.')
    expect(people.routineSave(bia, { id: 'r1', conversationId: 'bia-dm' })?.id).toBe('r1')
    expect(() => people.routineSave(bia, { id: 'r1', conversationId: 'ch', scope: 'channel' })).toThrow('Só um admin pode fazer isso.')
  })

  it('"me avise": only a channel routine, only by someone who reads that channel', () => {
    const { db, people, ana, bia } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: ana.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    db.saveRoutine({ id: 'mine', name: 'Da Ana', agentId: 'a1', conversationId: 'ana-dm', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: ana.id })
    db.saveRoutine({ id: 'personal-ch', name: 'Da Ana no canal', agentId: 'a1', conversationId: 'ch', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: ana.id })
    db.saveRoutine({ id: 'team', name: 'Do canal', agentId: 'a1', conversationId: 'ch', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, scope: 'channel' })
    expect(() => people.watch(bia, 'mine')).toThrow('Essa conversa é de outra pessoa.')
    expect(() => people.watch(bia, 'personal-ch')).toThrow('Só dá pra pedir aviso de uma rotina do canal.')
    expect(people.watch(bia, 'team').id).toBe('team')
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'index.ts'), 'utf8')
    expect(src).toMatch(/watchRoutine: \(\{ id, on \}, ctx\) => \{\n\s+people\.watch\(ctx\.person, id\)/)
    expect(src).toMatch(/saveRoutine: \(\{ routine \}, ctx\) => \{\n\s+const prev = people\.routineSave\(ctx\.person, routine\)/)
  })
})

describe('purging a removed person (8, 9, 10)', () => {
  it('takes their DM files, routines, approvals, services, notes and what was theirs alone; their name stays', () => {
    const { db, people, ana, bia } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const m = say(db, 'bia-dm', { kind: 'agent', id: 'a1' }, 'oi', { run: { status: 'done', steps: [] } })
    say(db, 'ch', { kind: 'person', id: bia.id }, 'no canal')
    db.recordActivity(m, new Map())
    db.saveArtifact({ id: 'f1', agentId: 'a1', conversationId: 'bia-dm', messageId: m.id, kind: 'file', name: 'x.txt', title: 'x', source: 'agente', size: 1, createdAt: 1 })
    db.saveArtifact({ id: 'f2', agentId: 'a1', conversationId: 'ch', messageId: m.id, kind: 'file', name: 'y.txt', title: 'y', source: 'agente', size: 1, createdAt: 1 })
    db.saveRoutine({ id: 'r1', name: 'Da Bia', agentId: 'a1', conversationId: 'bia-dm', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: bia.id })
    db.createApproval({ id: 'p1', hash: 'h', agentId: 'a1', conversationId: 'bia-dm', messageId: m.id, connectorId: 'c', connectorName: 'GitLab', tool: 't', args: { texto: 'PRIVADO' }, why: '', highRisk: false, state: 'refused', createdAt: 1, expiresAt: 2, requestedBy: bia.id })
    db.saveMemory({ id: 'k1', scope: 'a1', text: 'nota da DM', state: 'active', origin: 'agent', conversationId: 'bia-dm', privateTo: bia.id, messageIds: [], createdAt: 1, confirmedAt: 1 })
    db.saveMemory({ id: 'k2', scope: personScope(bia.id), text: 'sobre a Bia', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
    db.setPrefs(bia.id, { theme: 'dark' })
    people.remove(ana, bia.id)
    const out = people.purge(ana, bia.id)
    expect(out).toMatchObject({ person: bia.id, dms: ['bia-dm'], routines: [{ id: 'r1', conversationId: 'bia-dm' }], artifacts: [{ id: 'f1', name: 'x.txt' }] })
    expect(db.artifacts().map((a) => a.id)).toEqual(['f2'])
    expect(db.routine('r1')).toBeUndefined()
    expect(db.approval('p1')).toBeUndefined()
    expect(db.memories().map((x) => x.id)).toEqual([])
    expect(db.prefs(bia.id)).toEqual({})
    expect(db.formerPeople()).toEqual([{ id: bia.id, name: 'Bia' }])
    expect(db.message(m.id)).toBeUndefined()
  })

  it("can't be brought back as themselves once purged (the invite isn't spent); one restored is swept again after a new removal", () => {
    const { db, people, ana, bia } = team()
    const t0 = Date.now()
    people.remove(ana, bia.id, t0)
    const early = people.createInvite(ana, { role: 'member', restore: bia.id })
    people.purge(ana, bia.id)
    expect(() => people.createInvite(ana, { role: 'member', restore: bia.id })).toThrow('Os dados dessa pessoa já foram apagados')
    const r = people.join(early.code, 'Bia')
    expect(r).toHaveProperty('error') // the purge took the invites that would bring them back
    expect(db.person(bia.id)).toBeUndefined()

    // Restored (not purged), removed again: the sweep takes them after 30 days of the new removal.
    const { db: db2, people: p2, ana: a2, bia: b2 } = team()
    p2.remove(a2, b2.id)
    const back = p2.join(p2.createInvite(a2, { role: 'member', restore: b2.id }).code, 'Bia')
    expect('person' in back).toBe(true)
    db2.removePerson(b2.id)
    expect(p2.sweep(Date.now() + 31 * 86_400_000).map((x) => x.person)).toEqual([b2.id])
  })

  it("tells no one else the ids of what went (a DM's removal reaches only its person)", () => {
    const { db, people, ana, bia } = team()
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: [], owner: bia.id })
    const hub = new Hub<FakePort>(people, db)
    const ports = { ana: new FakePort(), bia: new FakePort() }
    hub.add(ports.ana, null)
    hub.add(ports.bia, { person: bia.id })
    hub.emit({ type: 'conversation_removed', id: 'bia-dm', for: bia.id })
    hub.emit({ type: 'routine_removed', id: 'r1', for: bia.id })
    hub.emit({ type: 'conversation_removed', id: 'ch' })
    expect(ports.ana.got).toEqual([{ type: 'conversation_removed', id: 'ch' }])
    expect(ports.bia.got).toEqual([{ type: 'conversation_removed', id: 'bia-dm' }, { type: 'routine_removed', id: 'r1' }, { type: 'conversation_removed', id: 'ch' }])
    // A routine removed from a DM says whose it was; the core's purge and deletes say so too.
    const events: CoreEvent[] = []
    db.saveAgent(agent('a1', 'lia'))
    db.saveRoutine({ id: 'r1', name: 'x', agentId: 'a1', conversationId: 'bia-dm', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1, owner: bia.id })
    new Routines({ db, runner: { runRoutine: async () => undefined }, emit: (e) => events.push(e) }).remove('r1')
    expect(events).toEqual([{ type: 'routine_removed', id: 'r1', for: bia.id }])
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'index.ts'), 'utf8')
    for (const m of src.matchAll(/emit\(\{ type: 'conversation_removed'[^\n]*/g)) expect(m[0]).toMatch(/for/)
    expect(src).toContain("for (const a of p.artifacts) rmSync(join(dataDir, 'artifacts', a.id), { recursive: true, force: true })")
  })
})

describe('who manages invites and people (13)', () => {
  it("an admin can't take back an admin invite (the owner's), and is told it's the owner's", () => {
    const { db, people, ana, bia, dani } = team()
    const adminInvite = people.createInvite(ana, { role: 'admin' })
    const memberInvite = people.createInvite(dani, { role: 'member' })
    const hash = (code: string): string => hashSecret(code)
    expect(() => people.revokeInvite(dani, hash(adminInvite.code))).toThrow('Só o dono do Tucano pode fazer isso.')
    expect(() => people.revokeInvite(bia, hash(memberInvite.code))).toThrow('Só um admin pode fazer isso.')
    people.revokeInvite(dani, hash(memberInvite.code))
    people.revokeInvite(ana, hash(adminInvite.code))
    expect(db.invites().filter((i) => !i.usedAt)).toEqual([])
    expect(db.activity({ kind: 'invite.revoked' })).toHaveLength(2)
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'index.ts'), 'utf8')
    expect(src).toContain('revokeInvite: ({ id }, ctx) => people.revokeInvite(ctx.person, id),')
  })

  it('an admin refused about a person reads that it is the owner’s, never "only an admin"', () => {
    const { people, ana, dani } = team()
    const other = people.join(people.createInvite(ana, { role: 'admin' }).code, 'Edu')
    if (!('person' in other)) throw new Error(other.error)
    expect(() => people.setRole(dani, other.person.id, 'member')).toThrow('Só o dono do Tucano pode fazer isso.')
    expect(() => must(dani, { kind: 'person', target: ana })).toThrow("O acesso do dono do Tucano não muda.")
    expect(() => people.setRole(dani, dani.id, 'member')).toThrow('Seu próprio acesso quem muda é o dono do Tucano.')
    expect(() => people.createInvite(dani, { role: 'admin' })).toThrow('Só o dono do Tucano pode fazer isso.')
    expect(() => people.remove(dani, other.person.id)).toThrow('Só o dono remove um admin.')
  })
})

describe('a new person (15)', () => {
  it("gets no read state for other people's DMs", () => {
    const db = new Db(':memory:')
    const people = new People(db)
    db.createConversation({ id: 'owner-dm', kind: 'dm', name: 'a1', members: [] })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: [] })
    const r = people.join(people.createInvite(db.owner(), { role: 'member' }).code, 'Bia')
    if (!('person' in r)) throw new Error(r.error)
    const raw = (db as unknown as { db: import('node:sqlite').DatabaseSync }).db
    expect(raw.prepare('SELECT conversation_id FROM read_state WHERE person_id = ?').all(r.person.id)).toEqual([])
    expect(db.conversation('ch', r.person.id)?.unread).toBe(0)
  })
})

// ---------- channels ----------

describe('who changes a channel (product decision)', () => {
  it('whoever made it and the admins; everyone else only talks. One from before is the owner\'s', () => {
    const { db, people, ana, bia, dani } = team()
    const carl = people.join(people.createInvite(ana, { role: 'member' }).code, 'Carl')
    if (!('person' in carl)) throw new Error(carl.error)
    db.createConversation({ id: 'bias', kind: 'channel', name: 'da-bia', members: [], createdBy: bia.id })
    db.createConversation({ id: 'old', kind: 'channel', name: 'antigo', members: [] })
    const c = (id: string) => db.conversation(id)!
    expect(c('bias').createdBy).toBe(bia.id)
    expect(c('old').createdBy).toBe(ana.id)
    expect(mayEditChannel(bia, c('bias'), ana.id)).toBe(true)
    expect(mayEditChannel(carl.person, c('bias'), ana.id)).toBe(false)
    expect(mayEditChannel(dani, c('bias'), ana.id)).toBe(true)
    expect(mayEditChannel(ana, c('bias'), ana.id)).toBe(true)
    expect(mayEditChannel(bia, c('old'), ana.id)).toBe(false)
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'index.ts'), 'utf8')
    for (const m of ['renameChannel', 'setTopic', 'setChannelMembers']) expect(src).toMatch(new RegExp(`  ${m}: \\([^)]*\\}, ctx\\) => \\{\\n[^\\n]*\\n[^\\n]*\\n\\s+if \\(!mayEditChannel\\(ctx\\.person, conv, db\\.ownerId\\(\\)\\)\\) throw new Error\\(channelEditError\\(\\)\\)`))
    expect(src).toContain("createdBy: ctx.person.id, ...(threads ? { threads } : {})")
    expect(NEEDS_DELETE()).toBe('target')
  })
})
const NEEDS_DELETE = (): string => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'policy-people.ts'), 'utf8')
  return /deleteConversation: '(\w+)'/.exec(src)![1]!
}

// ---------- behavior ----------

describe('a routine thread, for one person (16)', () => {
  it('reads "por uma rotina de Edu", word for word as before', () => {
    const lia = agent('a1', 'lia')
    const root: Message = { id: 'r', conversationId: 'd1', author: { kind: 'routine', id: 'rt' }, text: 'Resumo do dia', at: 1, routine: { name: 'Resumo', scheduledAt: 1, late: false } }
    const reply: Message = { id: 'x', conversationId: 'd1', author: { kind: 'person', id: 'owner' }, text: 'e amanhã?', at: 2, threadId: 'r' }
    const { blocks } = transcriptBlocks({ agent: lia, conversation: { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }, messages: [root, reply], agents: [lia], me: 'Edu', routineOwner: () => 'Edu', thread: root })
    expect(blocks[0]).toContain('por uma rotina de Edu')
    expect(blocks.join('\n')).not.toContain('=>')
    // A channel's routine has no person: the channel's.
    const ch = transcriptBlocks({ agent: lia, conversation: { id: 'c1', kind: 'channel', name: 'geral', members: ['a1'] }, messages: [root], agents: [lia], me: 'Edu', routineOwner: () => undefined, thread: root })
    expect(ch.blocks[0]).toContain('por uma rotina do canal')
  })
})

// Main's unread rule, as it was, for the oracle: a notification row per (message, phase), unread
// when nobody looks and it's a new reply, or a completion with nothing unread there.
class MainUnread {
  rows = new Map<string, { conv: string; unread: boolean }>()
  count(conv: string): number {
    return [...this.rows.values()].filter((r) => r.conv === conv && r.unread).length
  }
  record(m: Message, viewing: string | null): boolean {
    if (m.author.kind !== 'agent' && m.author.kind !== 'routine') return false
    const phase = m.run?.status ?? 'message'
    if (phase !== 'message' && !['working', 'done', 'failed', 'limit_reached', 'waiting_input', 'waiting_approval'].includes(phase)) return false
    const unread = m.conversationId !== viewing && (phase === 'working' || phase === 'message' || this.count(m.conversationId) === 0)
    const key = `${m.id}:${phase}`
    if (this.rows.has(key)) return false
    this.rows.set(key, { conv: m.conversationId, unread })
    return unread
  }
  markRead(conv: string): void {
    for (const r of this.rows.values()) if (r.conv === conv) r.unread = false
  }
}

describe('unread, for one person (17)', () => {
  const phases = ['working', 'done', 'failed', 'waiting_input', 'waiting_approval', 'limit_reached', 'stopped', 'message'] as const

  it("is main's rule exactly, over random sequences (counts and what recordActivity returns)", () => {
    let seed = 7
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    for (let round = 0; round < 40; round++) {
      const db = new Db(':memory:')
      const main = new MainUnread()
      const convs = ['c1', 'c2', 'c3']
      for (const c of convs) db.createConversation({ id: c, kind: c === 'c3' ? 'dm' : 'channel', name: c, members: [] })
      const msgs: Message[] = []
      let viewing: string | null = null
      for (let step = 0; step < 120; step++) {
        const op = rnd(10)
        if (op < 6) {
          const reuse = msgs.length && rnd(2) === 0
          const base = reuse ? msgs[rnd(msgs.length)]! : { id: `m${round}-${step}`, conversationId: convs[rnd(3)]!, author: rnd(5) === 0 ? { kind: 'person' as const, id: db.ownerId() } : { kind: 'agent' as const, id: 'a1' }, text: 't', at: step }
          const phase = phases[rnd(phases.length)]!
          const m: Message = { ...base, ...(phase === 'message' ? { run: undefined } : { run: { status: phase as never, steps: [] } }) }
          if (!reuse) msgs.push(m)
          db.saveMessage(m)
          expect(db.recordActivity(m, viewing), `round ${round} step ${step}`).toBe(main.record(m, viewing))
        } else if (op < 8) {
          const c = convs[rnd(3)]!
          db.markRead(c)
          main.markRead(c)
        } else viewing = rnd(2) ? convs[rnd(3)]! : null
        for (const c of convs) expect(db.conversation(c)?.unread, `round ${round} step ${step} ${c}`).toBe(main.count(c))
      }
    }
  })

  it('a reply finishing where the person is looking writes nothing and says nothing', () => {
    const db = new Db(':memory:')
    db.createConversation({ id: 'c', kind: 'channel', name: 'c', members: [] })
    const m: Message = { id: 'r', conversationId: 'c', author: { kind: 'agent', id: 'a1' }, text: '', at: 1, run: { status: 'working', steps: [] } }
    db.saveMessage(m)
    expect(db.recordActivity(m, 'c')).toBe(false)
    expect(db.recordActivity({ ...m, run: { status: 'done', steps: [] } }, new Map([[db.ownerId(), 'c']]))).toBe(false)
    expect(db.conversation('c')?.unread).toBe(0)
  })

  it('with people, each one by the same rule (a DM only for its person)', () => {
    const { db, ana, bia } = team()
    db.createConversation({ id: 'ch', kind: 'channel', name: 'c', members: [] })
    db.createConversation({ id: 'bia-dm', kind: 'dm', name: 'a1', members: [], owner: bia.id })
    const run = (id: string, conv: string, status: 'working' | 'done'): Message => ({ id, conversationId: conv, author: { kind: 'agent', id: 'a1' }, text: '', at: 1, run: { status, steps: [] } })
    for (const m of [run('r1', 'ch', 'working'), run('r2', 'ch', 'working'), run('d1', 'bia-dm', 'working')]) db.saveMessage(m)
    db.recordActivity(run('r1', 'ch', 'working'), new Map())
    db.recordActivity(run('r2', 'ch', 'working'), new Map())
    db.markRead('ch', bia.id)
    // Both finish: for Bia (who read meanwhile) the first completion is news, the second isn't; Ana still has her two.
    db.recordActivity(run('r1', 'ch', 'done'), new Map())
    db.recordActivity(run('r2', 'ch', 'done'), new Map())
    expect([db.conversation('ch', ana.id)?.unread, db.conversation('ch', bia.id)?.unread]).toEqual([2, 1])
    db.recordActivity(run('d1', 'bia-dm', 'working'), new Map())
    expect([db.conversation('bia-dm', ana.id)?.unread, db.conversation('bia-dm', bia.id)?.unread]).toEqual([0, 1])
  })
})

describe('the people who left (18)', () => {
  it("keep their names in the snapshot (apart), so their messages don't read as someone else's", () => {
    const { db, people, ana, bia } = team()
    people.remove(ana, bia.id)
    const snap = people.snapshotFor(ana, { settings: settings(), agents: [], messages: [], connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [] } as never)
    expect(snap.people.map((p) => p.name)).toEqual(['Ana', 'Dani'])
    expect(snap.former).toEqual([{ id: bia.id, name: 'Bia' }])
  })
})

describe('a busy channel (20)', () => {
  it('each routed reply answers the message that called it; an agent already replying there is called once more, not twice', async () => {
    const db = new Db(':memory:')
    db.renamePerson(db.ownerId(), 'Ana')
    db.saveAgent(agent('a1', 'lia'))
    db.saveAgent(agent('a2', 'theo'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
    const prompts: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let first = true
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = {
      id: 'claude',
      async *run(t) {
        if (t.system !== routerSystem() && t.system !== handoffSystem()) {
          prompts.push(t.prompt)
          if (first) {
            first = false
            await gate
          }
        }
        yield* base.run(t)
      }
    }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') } as Record<EngineId, Engine>
    const runner = new Runner({ db, engines, settings: async () => settings(), emit: () => {}, workDir: dir() })
    const wait = async (ok: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
    }
    await runner.send('ch', 'PRIMEIRA pergunta', [])
    await wait(() => prompts.length === 1)
    await runner.send('ch', 'SEGUNDA pergunta', [])
    await runner.send('ch', 'TERCEIRA pergunta', [])
    await new Promise((r) => setTimeout(r, 50))
    // The first reply, still running, read only up to its message; nothing else started beside it.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('PRIMEIRA')
    expect(prompts[0]).not.toContain('SEGUNDA')
    release()
    await runner.idle()
    // One more reply, after it, for what came while it worked.
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('TERCEIRA')
    const replies = db.messages().filter((m) => m.author.kind === 'agent')
    expect(replies).toHaveLength(2)
  })

  it('a reply queued for an older message reads it as the last one, even when newer ones came', async () => {
    const db = new Db(':memory:')
    db.saveAgent(agent('a1', 'lia'))
    db.saveAgent(agent('a2', 'theo'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
    const prompts: string[] = []
    const base = fakeEngine('claude', { delayMs: 1 })
    let routing: () => void = () => {}
    const routed = new Promise<void>((r) => (routing = r))
    let held = false
    const claude: Engine = {
      id: 'claude',
      async *run(t) {
        if (t.system === routerSystem() && !held) {
          held = true
          await routed // the router takes a while: a newer message arrives meanwhile
        }
        if (t.system !== routerSystem() && t.system !== handoffSystem()) prompts.push(t.prompt)
        yield* base.run(t)
      }
    }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') } as Record<EngineId, Engine>
    const runner = new Runner({ db, engines, settings: async () => settings(), emit: () => {}, workDir: dir() })
    await runner.send('ch', 'ANTIGA pergunta', [])
    await new Promise((r) => setTimeout(r, 20))
    say(db, 'ch', { kind: 'person', id: db.ownerId() }, 'NOVA mensagem que chegou depois', { at: Date.now() })
    routing()
    await runner.idle()
    expect(prompts[0]).toContain('ANTIGA')
    expect(prompts[0]).not.toContain('NOVA mensagem')
  })
})

describe('a question two people answer (21)', () => {
  it('the second hears who answered first, and nothing of theirs is posted', async () => {
    const { db, ana, bia, dani } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const asked = say(db, 'ch', { kind: 'agent', id: 'a1' }, 'Qual o prazo?', { run: { status: 'waiting_input', steps: [], question: 'Qual o prazo?', askedTo: bia.id } })
    db.saveQuestion({ id: asked.id, conversationId: 'ch', agentId: 'a1', text: 'Qual o prazo?', askedTo: bia.id, requestedBy: ana.id, state: 'open', deadlineAt: Date.now() + 3_600_000, createdAt: 1 })
    const runner = new Runner({ db, engines: { claude: fakeEngine('claude', { delayMs: 1 }), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }, settings: async () => settings(), emit: () => {}, workDir: dir() })
    await runner.answer(asked.id, 'sexta', bia)
    await runner.idle()
    const before = db.messages().length
    await expect(runner.answer(asked.id, 'segunda', dani)).rejects.toThrow('Essa pergunta já foi respondida por Bia.')
    expect(db.messages()).toHaveLength(before)
    expect(db.messages().some((m) => m.text === 'segunda')).toBe(false)
  })

  it('the page keeps what was typed when the answer fails', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'components', 'Conversation.tsx'), 'utf8')
    expect(src).toMatch(/answerQuestion\(id, text\.trim\(\)\)\.then\(\n\s+\(\) => setText\(''\),\n\s+\(e: unknown\) => \(setError/)
    expect(src).toContain("{text.trim() && (")
  })
})

describe('calling a person by the whole name (22)', () => {
  it('"@Ana Teste" is Ana Teste and "@Ana" is Ana, when both are here', () => {
    const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
    const anaT: Person = { id: 'anat', name: 'Ana Teste', role: 'member', about: '' }
    const all = [ana, anaT]
    expect(mentionedPeople('@Ana Teste, pode ver?', all, []).map((p) => p.id)).toEqual(['anat'])
    expect(mentionedPeople('oi @ana teste', all, []).map((p) => p.id)).toEqual(['anat'])
    expect(mentionedPeople('@Ana, pode ver?', all, []).map((p) => p.id)).toEqual(['ana'])
    expect(mentionedPeople('@Ana Testes', all, []).map((p) => p.id)).toEqual(['ana'])
    expect(mentionedPeople('@anateste e @Ana', all, []).map((p) => p.id)).toEqual(['anat', 'ana'])
    expect(mentionedPeople('@ana Téste', all, []).map((p) => p.id)).toEqual(['anat'])
  })
})

describe('what the owner alone sees (23, 24)', () => {
  it("the phone tab and the missions are the owner's", async () => {
    const { settingsStructure } = await import('../src/renderer/src/settings-structure')
    expect(settingsStructure({ admin: true, owner: false, team: true, servers: true }).find(s => s.id === 'connections-phone')!.visible).toBe(false)
    expect(settingsStructure({ admin: true, owner: true, team: true, servers: true }).find(s => s.id === 'connections-phone')!.visible).toBe(true)
    const sidebar = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'components', 'Sidebar.tsx'), 'utf8')
    expect(sidebar).toMatch(/const owner = amOwner\(/)
    expect(sidebar).toMatch(/\{owner && settings\.onboarding\?\.done && !settings\.onboarding\.checklistHidden && <MissionsCard \/>\}/)
  })

  it('a locked channel routine says "Me avise" is all a member changes there', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'components', 'Routines.tsx'), 'utf8')
    expect(src).toContain('O que você muda aqui é só o “Me avise”, que vale só pra você.')
  })
})
