// Tucano Team v1, fourth round: the pieces under the core (memory, curator, people, limits).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Memories } from '../src/core/memory'
import { mentionedPeople, People } from '../src/core/people'
import { Wiki } from '../src/core/wiki'
import { WikiCurator } from '../src/core/wiki-curator'
import { MAX_FILE } from '../src/core/wiki-extract'
import { limitError, MAX_WIKI_FILE } from '../src/shared/rpc-shapes'
import { personScope, type ComputerInfo, type EngineId, type Message, type Person, type Settings } from '../src/shared/types'
import type { Engine } from '../src/core/engines/types'

const roots: string[] = []
// Best effort: on Windows a database still open keeps its folder busy.
afterAll(() => roots.forEach((r) => { try { rmSync(r, { recursive: true, force: true }) } catch {} }))
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tucano-r4-'))
  roots.push(d)
  return d
}
const settings = { workspaceName: 'Ana', wikiEdits: 'auto' } as Settings

// A Tucano of one (Ana, the owner): her DM with Lia, a channel, and a memory from her DM.
function solo(): { db: Db; memory: Memories } {
  const db = new Db(join(tmp(), 'tucano.db'))
  db.saveAgent({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
  db.renamePerson(db.ownerId(), 'Ana')
  db.createConversation({ id: 'dm-ana', kind: 'dm', name: 'a1', members: ['a1'], owner: db.ownerId() })
  db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
  db.saveMemory({ id: 'k1', scope: personScope(db.ownerId()), text: 'Ana tem consulta médica sexta', state: 'active', origin: 'extraction', messageIds: [], createdAt: 1, confirmedAt: 1, privateTo: db.ownerId() })
  return { db, memory: new Memories({ db, engines: {} as Record<EngineId, Engine>, settings: async () => settings, emit: () => {}, workDir: '' }) }
}

describe('A. a team from its first invite (before anyone joins)', () => {
  it("a DM memory stops reaching a channel's prompt once the heritage happened; alone, it reaches it as always", () => {
    const { db, memory } = solo()
    const lia = db.agent('a1')!
    const find = (): string => memory.forPrompt(lia, [db.ownerId()], db.conversation('ch')).aboutMe.map((m) => m.text).join()
    expect(find()).toContain('consulta') // one person, no invite: as before
    expect(db.teamMode()).toBe(false)
    db.setMeta('heritageAt', String(Date.now())) // the first invite (see inherit in core/index.ts)
    expect(db.teamMode()).toBe(true)
    expect(db.people().length).toBe(1)
    expect(find()).not.toContain('consulta')
    // her own DM still reads it
    expect(memory.forPrompt(lia, [db.ownerId()], db.conversation('dm-ana')).aboutMe.map((m) => m.text).join()).toContain('consulta')
  })

  it("the curator stops reading the owner's DM on its own from the first invite", async () => {
    const { db } = solo()
    const root = tmp()
    const wiki = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
    wiki.init(false)
    const said: Message[] = [{ id: 'm1', conversationId: 'dm-ana', author: { kind: 'person', id: db.ownerId() }, text: 'Decidimos: o orçamento da reforma fecha em 12000, com entrega em março e pagamento em três vezes sem juros. O engenheiro responsável é o Marcos Lima e a obra começa na segunda semana de janeiro.', at: 1 }]
    let asked = 0
    const curator = (): WikiCurator =>
      new WikiCurator({
        wiki,
        db: { conversation: (id) => db.conversation(id), messagesAfter: (id) => (id === 'dm-ana' ? said : []), messagesSaidAfter: (id) => (id === 'dm-ana' ? said : []), message: () => undefined, saveMessage: () => {}, agents: () => [], ownerId: () => db.ownerId(), people: (o) => db.people(o), teamMode: () => db.teamMode() },
        settings: () => settings,
        llm: async () => (asked++, JSON.stringify({ worth: false, reason: '', source_title: '', changes: [] })),
        emitMessage: () => {}
      })
    await curator().read('dm-ana')
    expect(asked).toBe(1) // alone: read as always
    wiki.setMark('dm-ana', 0)
    db.setMeta('heritageAt', String(Date.now()))
    await curator().read('dm-ana')
    expect(asked).toBe(1)
    wiki.close()
  })
})

describe('B. names that read the same are one name', () => {
  const people = (): { db: Db; people: People } => {
    const db = new Db(join(tmp(), 'tucano.db'))
    db.renamePerson(db.ownerId(), 'Ana')
    db.addPerson({ id: 'bia2', name: 'Bia Teste Silva', role: 'member', about: '' })
    db.addPerson({ id: 'bia1', name: 'Bia Teste', role: 'member', about: '' })
    return { db, people: new People(db) }
  }
  it('names that differ only by spaces, or whose @handle would be the same, collide', () => {
    const { people: p } = people()
    expect(p.nameTaken('Bia TesteSilva', 'bia1')).toBe(true)
    expect(p.nameTaken('BiaTeste Silva', 'bia1')).toBe(true)
    expect(p.nameTaken('Bia.Teste.Silva', 'bia1')).toBe(true) // @biatestesilva either way
    expect(p.nameTaken('Bia Teste Souza', 'bia1')).toBe(false)
  })
  it('"@biatestesilva" reaches Bia Teste Silva alone; a handle two people share reaches no one silently', () => {
    const { db } = people()
    expect(mentionedPeople('@biatestesilva oi (NHm)', db.people(), []).map((p) => p.id)).toEqual(['bia2'])
    // two that came in before the rule: neither is picked at random
    const twins = [{ id: 'x', name: 'Bia TesteSilva' }, { id: 'y', name: 'Bia Teste Silva' }] as Person[]
    expect(mentionedPeople('@biatestesilva oi', twins, []).length).not.toBe(1)
  })
})

describe('C. machine paths stay with the owner', () => {
  it("a computer's folder and the wiki's folder aren't sent to anyone else", () => {
    const db = new Db(join(tmp(), 'tucano.db'))
    db.addPerson({ id: 'bia', name: 'Bia', role: 'admin', about: '' })
    const p = new People(db)
    const c: ComputerInfo = { agentId: 'a1', state: 'stopped', folder: '/Users/ana/Library/Application Support/Tucano/computers/a1/work', services: [] }
    expect(p.computerFor(db.owner(), c).folder).toBe(c.folder)
    expect(p.computerFor(db.person('bia')!, c).folder).toBe('')
    const s = { workspaceName: 'Ana', wikiDir: '/Users/ana/Obsidian' } as Settings
    expect(p.settingsFor(db.owner(), s).wikiDir).toBe('/Users/ana/Obsidian')
    expect(p.settingsFor(db.person('bia')!, s).wikiDir).toBeUndefined()
  })
})

describe('D. the wiki file limit', () => {
  it('one number: what the door takes, what it says, and what the reader takes', () => {
    expect(MAX_FILE).toBe(MAX_WIKI_FILE)
    const b64 = (bytes: number): string => 'A'.repeat(Math.ceil(bytes / 3) * 4)
    expect(limitError('wikiAddFile', { name: 'a.pdf', data: b64(MAX_WIKI_FILE) })).toBeUndefined()
    const err = limitError('wikiAddFile', { name: 'a.pdf', data: b64(MAX_WIKI_FILE + 4096) })
    expect(err).toMatch(/20 MB/)
  })
})

describe('E. the router out of quota (e2e5 F: the plan hit its limit mid-run)', () => {
  it('says so in words, leaves no reply behind and nothing working', async () => {
    const { Runner } = await import('../src/core/runs')
    const { fakeEngine } = await import('../src/core/engines/fake')
    const { routerSystem } = await import('../src/core/router')
    const db = new Db(join(tmp(), 'tucano.db'))
    db.saveAgent({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    db.saveAgent({ id: 'a2', name: 'Theo', handle: 'theo', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', run: (t) => (t.system === routerSystem() ? (async function* () { yield { type: 'error' as const, message: "You've hit your 5-hour limit · resets 1:20am (America/Bahia)" } })() : base.run(t)) }
    const ready = { installed: true, loggedIn: true }
    const s = { workspaceName: 'Ana', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' } as Settings
    const r = new Runner({ db, engines: { claude, codex: base, opencode: base, pi: base, antigravity: base, cursor: base, grok: base, cline: base, hermes: base } as Record<EngineId, Engine>, settings: async () => s, emit: () => {}, workDir: tmp() })
    await r.send('c1', 'bom dia, quem me ajuda com o orçamento?')
    await r.idle()
    const msgs = db.messages()
    const note = msgs.find((m) => m.author.kind === 'system')!
    expect(note.text).toMatch(/Não consegui escolher quem responde/)
    expect(note.text).toMatch(/limite/) // the friendly words, as an agent's failure says them
    expect(note.text).not.toMatch(/You've hit/)
    expect(note.run).toBeUndefined()
    expect(msgs.filter((m) => m.author.kind === 'agent')).toEqual([])
  })
})
