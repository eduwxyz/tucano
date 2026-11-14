// Tucano Team v1, third round: the pieces under the core (wiki, people, memory, db), one by one.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Wiki } from '../src/core/wiki'
import { WikiCurator } from '../src/core/wiki-curator'
import { personScope, type Artifact, type BrowserView, type ComputerInfo, type Connector, type Memory, type Person, type EngineId, type Routine, type Settings, type Skill } from '../src/shared/types'
import { CORE_EVENT_TYPES, type CoreEvent } from '../src/shared/rpc'
import { errorFor } from '../src/shared/errors'
import { Db } from '../src/core/db'
import { Memories } from '../src/core/memory'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { cleanName, nameKey, People } from '../src/core/people'

const freshWiki = (deps: Partial<ConstructorParameters<typeof Wiki>[0]> = {}): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-r3-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db'), ...deps })
  w.init(false)
  return w
}

describe('B. a source with a long title', () => {
  it('two in the same minute get two files, and adding them always ends', () => {
    const w = freshWiki()
    const title = 'x'.repeat(300)
    const a = w.addSource({ title, text: 'um', kind: 'note', by: 'me' })
    const b = w.addSource({ title, text: 'dois', kind: 'note', by: 'me' })
    const c = w.addSource({ title, text: 'três', kind: 'note', by: 'me' })
    expect(new Set([a.file, b.file, c.file]).size).toBe(3)
    expect(w.source(b.id)!.text).toContain('dois')
    expect(w.source(c.id)!.text).toContain('três')
  })

  it('a long file name too', () => {
    const w = freshWiki()
    const name = `${'y'.repeat(300)}.pdf`
    const a = w.addSource({ title: name, text: 'um', kind: 'file', by: 'me', file: { name, data: Buffer.from('1') } })
    const b = w.addSource({ title: name, text: 'dois', kind: 'file', by: 'me', file: { name, data: Buffer.from('2') } })
    expect(a.origin.original).not.toBe(b.origin.original)
    expect(readFileSync(w.originalPath(b.id)!, 'utf8')).toBe('2')
  })
})

describe('E. a source removed while the curator reads it', () => {
  const curatorOver = (w: Wiki, llm: () => Promise<string>, conversations: Record<string, { id: string; kind: string; name: string }> = {}): WikiCurator =>
    new WikiCurator({
      wiki: w,
      db: { conversation: (id) => conversations[id], messagesAfter: () => [], messagesSaidAfter: () => [], message: () => undefined, saveMessage: () => {}, agents: () => [] },
      settings: () => ({ workspaceName: 'Ana', wikiEdits: 'auto' }) as Settings,
      llm,
      emitMessage: () => {}
    })
  const reply = JSON.stringify({ worth: true, reason: 'r', source_title: 't', changes: [{ op: 'create', page: 'Salário', kind: 'Assunto', text: 'O salário da Ana é 12000.' }] })

  it('writes nothing of it: no page, no change, no version', async () => {
    const w = freshWiki()
    const src = w.addSource({ title: 'nota', text: 'O salário da Ana é 12000.', kind: 'note', by: 'me' })
    const c = curatorOver(w, async () => {
      w.removeSource(src.id) // the person (or a purge) took it back while the model read it
      return reply
    })
    await c.ingest(src.id)
    expect(w.page('Salário')).toBeUndefined()
    expect(w.changes()).toEqual([])
    expect(w.recent(50)).toEqual([])
  })

  it("a conversation deleted meanwhile (a purge) doesn't become a source", async () => {
    const w = freshWiki()
    const convs: Record<string, { id: string; kind: string; name: string }> = { dm: { id: 'dm', kind: 'dm', name: 'x' } }
    const c = new WikiCurator({
      wiki: w,
      db: { conversation: (id) => convs[id], messagesAfter: () => [], messagesSaidAfter: () => [], message: (id) => (id === 'm1' ? { id: 'm1', conversationId: 'dm', author: { kind: 'person', id: 'p' }, text: 'O salário da Ana é 12000.', at: 1 } : undefined), saveMessage: () => {}, agents: () => [] },
      settings: () => ({ workspaceName: 'Ana', wikiEdits: 'auto' }) as Settings,
      llm: async () => {
        delete convs['dm']
        return reply
      },
      emitMessage: () => {}
    })
    expect(await c.keepMessage('m1')).toEqual([])
    expect(w.sources()).toEqual([])
    expect(w.page('Salário')).toBeUndefined()
  })

  it('what a removed source left behind goes after a curation too', async () => {
    const w = freshWiki()
    const src = w.addSource({ title: 'nota', text: 'a', kind: 'note', by: 'me' })
    const other = w.addSource({ title: 'outra', text: 'O salário da Ana é 12000.', kind: 'note', by: 'me' })
    w.addChange({ ops: [{ op: 'create', page: 'Velha', text: 'x' }], sourceId: src.id, by: 'auto' })
    // the row goes behind the wiki's back (another process, a crash between the two deletes)
    ;(w as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare('DELETE FROM sources WHERE id = ?').run(src.id)
    await curatorOver(w, async () => reply).ingest(other.id)
    expect(w.changes().some((c) => c.ops.some((o) => o.page === 'Velha'))).toBe(false)
  })
})

// A Tucano with its owner (Ana) and a member (Bruno): Ana's DM, a channel, Ana's private memory.
function twoPeople(): { db: Db; people: People; ana: Person; bruno: Person } {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-r3-')), 'tucano.db'))
  db.saveAgent({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
  db.renamePerson(db.ownerId(), 'Ana')
  db.addPerson({ id: 'bruno', name: 'Bruno', role: 'member', about: '' })
  db.createConversation({ id: 'dm-ana', kind: 'dm', name: 'a1', members: ['a1'], owner: db.ownerId() })
  db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
  return { db, people: new People(db), ana: db.owner(), bruno: db.person('bruno')! }
}

describe('G. every event reaches only who may see what it is about', () => {
  it('a private memory forgotten for good is no one else’s news, not even its id', () => {
    const { db, people, bruno, ana } = twoPeople()
    const events: CoreEvent[] = []
    const memory = new Memories({ db, engines: {} as never, settings: async () => ({}) as Settings, emit: (e) => void events.push(e), workDir: '' })
    memory.add(personScope(ana.id), 'Ana tem consulta médica sexta')
    const m = db.memories({ scope: personScope(ana.id) })[0]!
    memory.forget(m.id)
    memory.purge(m.id)
    const removed = events.find((e) => e.type === 'memory_removed')!
    expect(removed).toBeTruthy()
    expect(people.eventFor(removed, bruno)).toBeUndefined()
    expect(people.eventFor(removed, ana)).toMatchObject({ type: 'memory_removed', id: m.id })
  })

  it('each kind of event, for someone outside what it is about (the list is every CoreEvent there is)', () => {
    const { db, people, bruno, ana } = twoPeople()
    db.saveMessage({ id: 'm-dm', conversationId: 'dm-ana', author: { kind: 'person', id: ana.id }, text: 'segredo', at: 1 })
    const message = db.message('m-dm')!
    const settings = { workspaceName: 'Ana', theme: 'system', language: 'pt' } as Settings
    const memory = { id: 'k1', scope: personScope(ana.id), text: 'segredo', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1, privateTo: ana.id } as Memory
    const routine = { id: 'r1', conversationId: 'dm-ana', agentId: 'a1', name: 'segredo', task: 'segredo', trigger: { kind: 'schedule', cron: '0 9 * * *' }, enabled: true, scope: 'me', owner: ana.id } as unknown as Routine
    // hidden: Bruno gets nothing. shown: as it is. own: something of his own instead (his settings, his inbox, a view without the secret).
    const cases: Record<CoreEvent['type'], { event: CoreEvent; is: 'hidden' | 'shown' | 'own' }> = {
      voice: { event: { type: 'voice' }, is: 'shown' },
      message: { event: { type: 'message', message }, is: 'hidden' },
      delta: { event: { type: 'delta', id: 'm-dm', text: 'segredo' }, is: 'hidden' },
      agent: { event: { type: 'agent', agent: db.agent('a1')! }, is: 'shown' },
      conversation: { event: { type: 'conversation', conversation: db.conversation('dm-ana')! }, is: 'hidden' },
      settings: { event: { type: 'settings', settings }, is: 'own' },
      connector: { event: { type: 'connector', connector: { id: 'c1', name: 'Linear', kind: 'remote', status: 'connected', tools: [] } as unknown as Connector }, is: 'shown' },
      connector_removed: { event: { type: 'connector_removed', id: 'c1' }, is: 'shown' },
      approval: { event: { type: 'approval', approval: { id: 'p1', hash: 'h', agentId: 'a1', conversationId: 'dm-ana', messageId: 'm-dm', connectorId: 'c', connectorName: 'Linear', tool: 't', args: {}, why: 'segredo', highRisk: false, state: 'pending', createdAt: 1, expiresAt: Date.now() + 60_000, requestedBy: ana.id } }, is: 'hidden' },
      memory: { event: { type: 'memory', memory }, is: 'hidden' },
      memory_removed: { event: { type: 'memory_removed', id: 'k1', for: ana.id }, is: 'hidden' },
      computer: { event: { type: 'computer', computer: { agentId: 'a1', state: 'running', services: [{ name: 'segredo', port: 3000, conversationId: 'dm-ana' }] } as unknown as ComputerInfo }, is: 'own' },
      browser: { event: { type: 'browser', view: { agentId: 'a1', url: 'https://segredo', title: 'segredo', shown: true, log: [], at: 1, conversationId: 'dm-ana' } as BrowserView }, is: 'own' },
      browser_frame: { event: { type: 'browser_frame', agentId: 'a1', frame: 'data:segredo', conversationId: 'dm-ana' }, is: 'hidden' },
      artifact: { event: { type: 'artifact', artifact: { id: 'f1', conversationId: 'dm-ana', messageId: 'm-dm', agentId: 'a1', name: 'segredo.txt', mime: 'text/plain', size: 1, at: 1 } as unknown as Artifact }, is: 'hidden' },
      routine: { event: { type: 'routine', routine }, is: 'hidden' },
      routine_removed: { event: { type: 'routine_removed', id: 'r1', for: ana.id }, is: 'hidden' },
      conversation_removed: { event: { type: 'conversation_removed', id: 'dm-ana', for: ana.id }, is: 'hidden' },
      history_wiped: { event: { type: 'history_wiped', conversationIds: ['dm-ana'] }, is: 'hidden' },
      skill: { event: { type: 'skill', skill: { id: 's1', name: 'x' } as unknown as Skill }, is: 'shown' },
      skill_removed: { event: { type: 'skill_removed', id: 's1' }, is: 'shown' },
      wiki: { event: { type: 'wiki' }, is: 'shown' },
      people: { event: { type: 'people', people: db.people() }, is: 'shown' },
      inbox: { event: { type: 'inbox' }, is: 'own' },
      delegations: { event: { type: 'delegations' }, is: 'own' }
    }
    expect(Object.keys(cases).sort()).toEqual([...CORE_EVENT_TYPES].sort())
    for (const [type, c] of Object.entries(cases)) {
      const got = people.eventFor(c.event, bruno)
      if (c.is === 'hidden') expect(got, type).toBeUndefined()
      else if (c.is === 'shown') expect(got, type).toEqual(c.event)
      else expect(JSON.stringify(got ?? {}), type).not.toContain('segredo')
      // and the one it's about gets it
      expect(people.eventFor(c.event, ana), type).toBeTruthy()
    }
  })
})

describe('D. names people can tell apart', () => {
  it('folds invisible characters, other ways of writing letters, and lookalikes from other alphabets', () => {
    const k = nameKey('Bia')
    for (const twin of ['Bia​', 'B­ia', 'Bi‍a', '‮Bia', 'Bia️', 'Вiа' /* Cyrillic В, а */, 'Βια' /* Greek */, 'ＢＩＡ' /* full width */, 'Bía', '  bia  ']) expect(nameKey(twin), JSON.stringify(twin)).toBe(k)
    expect(nameKey('Bianca')).not.toBe(k)
  })

  it('a name of nothing but invisible characters is no name', () => {
    expect(cleanName('​‌⁠ ­')).toBe('')
    expect(cleanName('  Ana​   Souza ')).toBe('Ana Souza')
  })

  it("is taken by someone removed (who may come back) and by an agent's name or handle", () => {
    const { db, people } = twoPeople()
    db.addPerson({ id: 'carla', name: 'Carla', role: 'member', about: '' })
    db.removePerson('carla')
    expect(people.nameTaken('Cаrla')).toBe(true) // Cyrillic а
    expect(people.nameTaken('carla', 'carla')).toBe(false) // her own, coming back
    expect(people.nameTaken('Lia')).toBe(true) // the agent
    expect(people.nameTaken('LIA')).toBe(true)
    db.purgePerson('carla')
    expect(people.nameTaken('Carla')).toBe(false) // purged: she can only come back as someone new
  })

  it('an invite refuses a name that is empty once cleaned, or someone else’s twin', async () => {
    const { db, people, ana } = twoPeople()
    const { code } = people.createInvite(ana, { role: 'member' })
    expect(people.join(code, '​​')).toMatchObject({ error: expect.any(String) })
    expect(people.join(code, 'Brunо')).toMatchObject({ error: expect.stringContaining('Já tem alguém') }) // Cyrillic о
    const ok = people.join(code, 'Duda​')
    expect('person' in ok && ok.person.name).toBe('Duda')
    expect(db.people().some((p) => p.name.includes('​'))).toBe(false)
  })
})

// A memory model that records what it was asked and answers like the fake engine; `hold` keeps it
// waiting until released (to change things while it reads).
function recordingMemory(db: Db): { memory: Memories; prompts: string[]; hold: () => () => void } {
  const prompts: string[] = []
  let gate: Promise<void> | undefined
  const base = fakeEngine('claude', { delayMs: 1 })
  const claude: Engine = {
    id: 'claude',
    async *run(t) {
      prompts.push(t.prompt ?? '')
      if (gate) await gate
      yield* base.run(t)
    }
  }
  const ready = { installed: true, loggedIn: true }
  const settings = { workspaceName: 'Ana', memoryModel: 'haiku', memoryLearning: 'approve', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready } } as unknown as Settings
  const memory = new Memories({ db, engines: { claude } as Record<EngineId, Engine>, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'tucano-r3-')) })
  return {
    memory,
    prompts,
    hold: () => {
      let open!: () => void
      gate = new Promise((r) => (open = r))
      return () => (open(), (gate = undefined))
    }
  }
}

describe('A1. the summaries, when the Tucano gets a second person', () => {
  const fill = (db: Db, n: number, threadId?: string): void => {
    for (let i = 0; i < n; i++) db.saveMessage({ id: `${threadId ?? 'c'}-${i}`, conversationId: 'ch', author: { kind: 'person', id: db.ownerId() }, text: `mensagem ${i} prefiro café`, at: 1000 + i, ...(threadId ? { threadId } : {}) })
  }

  it("a channel's summary is made again from its messages alone: no private memory, not the old summary, nothing learned twice", async () => {
    const { db, ana } = twoPeople()
    fill(db, 80)
    db.setSummary('ch', 'VELHO: Ana tem consulta médica sexta', 1050)
    db.saveMemory({ id: 'k1', scope: personScope(ana.id), text: 'Ana tem consulta médica sexta', state: 'active', origin: 'extraction', messageIds: [], createdAt: 1, confirmedAt: 1, privateTo: ana.id })
    const { memory, prompts } = recordingMemory(db)
    await memory.rebuild('ch')
    expect(prompts.length).toBeGreaterThan(1) // in parts, never one giant prompt
    for (const p of prompts) {
      expect(p).not.toContain('consulta')
      expect(p).not.toContain('VELHO')
    }
    const c = db.conversation('ch')!
    expect(c.summary).toContain('Resumo de teste')
    expect(c.summary).not.toContain('VELHO')
    expect(db.memories({ scope: personScope(ana.id) }).map((m) => m.id)).toEqual(['k1']) // nothing new learned
  })

  it("a thread's summary is made again the same way", async () => {
    const { db, ana } = twoPeople()
    db.saveMessage({ id: 'root', conversationId: 'ch', author: { kind: 'person', id: ana.id }, text: 'raiz', at: 999 })
    fill(db, 5, 'root')
    db.setThreadSummary('root', 'VELHO: consulta médica', 1003)
    db.saveMemory({ id: 'k1', scope: personScope(ana.id), text: 'Ana tem consulta médica sexta', state: 'active', origin: 'extraction', messageIds: [], createdAt: 1, confirmedAt: 1, privateTo: ana.id })
    const { memory, prompts } = recordingMemory(db)
    await memory.rebuild('ch')
    expect(prompts.join('\n')).not.toMatch(/consulta|VELHO/)
    expect(db.message('root')!.threadSummary!.text).toContain('Resumo de teste')
  })

  it("one being made while the Tucano had one person isn't kept once it has two", async () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-r3-')), 'tucano.db'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: [] })
    fill(db, 60)
    const { memory, hold } = recordingMemory(db)
    const release = hold()
    const running = memory.consolidate('ch', true)
    await new Promise((r) => setTimeout(r, 20))
    db.addPerson({ id: 'bruno', name: 'Bruno', role: 'member', about: '' })
    db.setMeta('heritageAt', String(Date.now()))
    release()
    await running
    expect(db.conversation('ch')!.summary ?? '').toBe('')
  })
})

describe('A3. where each version of a page came from', () => {
  // ch: a channel; dm: the owner's DM; gone: a conversation deleted since (unknown).
  const dmOf = (id: string): string | null | undefined => (id === 'dm' ? 'owner' : id === 'ch' ? null : undefined)

  it('is kept from now on, even with one person, and says which pages came from a DM', () => {
    const w = freshWiki({ dmOf })
    const fromDm = w.addSource({ title: 'dm', text: 'x', kind: 'conversation', origin: { conversationId: 'dm' }, by: 'auto' })
    const fromCh = w.addSource({ title: 'ch', text: 'x', kind: 'conversation', origin: { conversationId: 'ch' }, by: 'auto' })
    w.save({ title: 'Salário', body: 'O salário da Ana é 12000.', by: 'auto', byName: 'Curador', sourceId: fromDm.id })
    w.save({ title: 'Cardápio', body: 'Sexta tem peixe.', by: 'auto', byName: 'Curador', sourceId: fromCh.id })
    w.save({ title: 'Manual', body: 'Escrito à mão.', by: 'owner', byName: 'Ana' })
    w.save({ title: 'Cardápio', body: 'Sexta tem peixe. E salário da Ana.', by: 'auto', byName: 'Curador', sourceId: fromDm.id })
    w.removeSource(fromDm.id) // its versions go; what it wrote on the pages, and where that came from, stays known
    expect(w.inherit('owner').sort()).toEqual(['Cardápio', 'Salário'])
    expect(w.held().map((h) => h.title).sort()).toEqual(['Cardápio', 'Salário'])
  })

  it('for pages from before it was kept: what the versions say, and the unknown counts as private', () => {
    const w = freshWiki({ dmOf })
    const raw = (w as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
    const fromCh = w.addSource({ title: 'ch', text: 'x', kind: 'conversation', origin: { conversationId: 'ch' }, by: 'auto' })
    const fromGone = w.addSource({ title: 'gone', text: 'x', kind: 'conversation', origin: { conversationId: 'gone' }, by: 'auto' })
    const fromDm = w.addSource({ title: 'dm', text: 'x', kind: 'conversation', origin: { conversationId: 'dm' }, by: 'auto' })
    const note = w.addSource({ title: 'nota', text: 'x', kind: 'note', by: 'me' })
    for (const [title, by, src] of [['Do canal', 'auto', fromCh.id], ['De uma conversa apagada', 'auto', fromGone.id], ['Da DM', 'auto', fromDm.id], ['Da nota', 'auto', note.id], ['Do curador sem fonte', 'auto', null], ['À mão', 'me', null], ['Do Obsidian', 'import', null]] as const) {
      w.save({ title, body: 'x', by, byName: 'x' })
      raw.prepare('UPDATE versions SET source_id = ? WHERE title = ?').run(src, title)
    }
    raw.prepare('DELETE FROM provenance').run() // as if written before provenance was kept
    expect(w.inherit('owner').sort()).toEqual(['Da DM', 'De uma conversa apagada', 'Do curador sem fonte'])
  })

  it('a page held for its owner is out of every view but theirs until released, renamed or not', () => {
    const w = freshWiki({ dmOf })
    const fromDm = w.addSource({ title: 'dm', text: 'x', kind: 'conversation', origin: { conversationId: 'dm' }, by: 'auto' })
    w.save({ title: 'Salário', body: 'O salário da Ana é 12000. Veja [[Cardápio]].', kind: 'Assunto', by: 'auto', byName: 'Curador', sourceId: fromDm.id })
    w.save({ title: 'Cardápio', body: 'Sexta tem peixe. Veja [[Salário]].', kind: 'Assunto', by: 'owner', byName: 'Ana' })
    w.inherit('owner')
    const team = w.view(w.heldTitles())
    expect(team.list().map((p) => p.title)).toEqual(['Cardápio'])
    expect(team.count()).toBe(1)
    expect(team.page('Salário')).toBeUndefined()
    expect(team.page('Cardápio')!.backlinks).toEqual([])
    expect(team.search('salário 12000').map((h) => h.title)).not.toContain('Salário')
    expect(team.indexText()).not.toContain('12000')
    expect(team.indexText()).not.toContain('[[Salário]]')
    expect(team.graph().nodes.map((n) => n.title)).not.toContain('Salário')
    expect(team.log().join('\n')).not.toContain('Salário')
    expect(team.recent(20).map((r) => r.title)).not.toContain('Salário')
    w.save({ title: 'Salário (Ana)', rename: 'Salário', body: 'O salário da Ana é 12000.', by: 'owner', byName: 'Ana' })
    expect(w.view(w.heldTitles()).page('Salário (Ana)')).toBeUndefined()
    expect(w.release('Salário (Ana)')).toBe(true)
    expect(w.view(w.heldTitles()).page('Salário (Ana)')!.body).toContain('12000')
    expect(w.held()).toEqual([])
  })
})

describe('I. what an error tells whoever asked', () => {
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/eduardo/.tucano/wiki/fontes/x.md'"), { code: 'ENOENT', path: '/Users/eduardo/.tucano/wiki/fontes/x.md' })
  it("the owner (it's their machine) gets it as always; anyone else never a path or a system's raw text", () => {
    expect(errorFor(enoent, true)).toContain('/Users/eduardo')
    expect(errorFor(enoent, false)).not.toMatch(/\/Users|ENOENT|tucano/)
    expect(errorFor(new TypeError("Cannot read properties of undefined (reading 'id')"), false)).not.toMatch(/Cannot read|undefined/)
    expect(errorFor(new Error('Essa pasta não existe: /srv/tucano/dados/segredo'), false)).not.toContain('/srv')
    expect(errorFor(new Error('Essa pasta não existe: /srv/tucano/dados/segredo'), false)).toContain('Essa pasta não existe')
    expect(errorFor(new Error('Só um admin pode fazer isso.'), false)).toBe('Só um admin pode fazer isso.')
    expect(errorFor(new Error('C:\\Users\\ana\\x.txt sumiu'), false)).not.toContain('C:\\')
  })
})

describe('K. a purge leaves nothing of the DMs on disk', () => {
  const onDisk = (file: string, text: string): boolean => [file, `${file}-wal`, `${file}-journal`].some((f) => existsSync(f) && readFileSync(f).includes(Buffer.from(text)))

  it("the database files hold none of a purged person's DM text, even what a reply once said and rewrote", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tucano-r3-')), 'tucano.db')
    const db = new Db(file)
    db.addPerson({ id: 'bia', name: 'Bia', role: 'member', about: '' })
    db.createConversation({ id: 'dm-bia', kind: 'dm', name: 'a1', members: [], owner: 'bia' })
    for (let i = 0; i < 50; i++) db.saveMessage({ id: `x${i}`, conversationId: 'dm-bia', author: { kind: 'person', id: 'bia' }, text: `SEGREDO-DA-BIA-${i} ${'z'.repeat(200)}`, at: i })
    db.saveMessage({ id: 'x0', conversationId: 'dm-bia', author: { kind: 'person', id: 'bia' }, text: 'reescrita', at: 0 }) // the old text was in the page
    db.saveMemory({ id: 'k1', scope: 'person:bia', text: 'SEGREDO-MEMORIA-BIA', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
    expect(onDisk(file, 'SEGREDO-DA-BIA-0')).toBe(true)
    db.removePerson('bia')
    new People(db).purge(db.owner(), 'bia')
    for (const marker of ['SEGREDO-DA-BIA-0', 'SEGREDO-DA-BIA-49', 'SEGREDO-MEMORIA-BIA']) expect(onDisk(file, marker), marker).toBe(false)
    expect(db.people({ removed: true }).some((p) => p.id === 'bia')).toBe(true) // her name stays
  })

  it("the wiki's file holds none of what a removed source proposed", () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-r3-'))
    const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
    w.init(false)
    const src = w.addSource({ title: 'dm', text: 'x', kind: 'conversation', origin: { conversationId: 'dm-bia' }, by: 'auto' })
    w.addChange({ ops: [{ op: 'create', page: 'Bia', text: `SEGREDO-WIKI-BIA ${'z'.repeat(500)}` }], sourceId: src.id, by: 'auto' })
    expect(onDisk(join(root, 'wiki.db'), 'SEGREDO-WIKI-BIA')).toBe(true)
    w.removeSource(src.id)
    w.scrub()
    expect(onDisk(join(root, 'wiki.db'), 'SEGREDO-WIKI-BIA')).toBe(false)
  })
})

describe("L. what someone says about another person isn't kept as a fact about anyone", () => {
  const ready = { installed: true, loggedIn: true }
  const settings = { workspaceName: 'Ana', memoryModel: 'haiku', memoryLearning: 'auto', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready } } as unknown as Settings
  const answering = (json: unknown): Engine => ({
    id: 'claude',
    async *run() {
      const text = JSON.stringify(json)
      yield { type: 'text', delta: text }
      yield { type: 'done', text, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    }
  } as Engine)

  it('extraction keeps what Bruno says about himself, not what he says about Ana', async () => {
    const { db } = twoPeople()
    for (let i = 0; i < 40; i++) db.saveMessage({ id: `b${i}`, conversationId: 'ch', author: { kind: 'person', id: 'bruno' }, text: i === 0 ? 'A Ana é alérgica a amendoim. Eu prefiro reuniões curtas.' : `oi ${i}`, at: 10 + i })
    const engine = answering({ summary: 's', memories: [{ op: 'add', text: 'Ana é alérgica a amendoim', evidence: [1] }, { op: 'add', text: 'Prefere reuniões curtas', evidence: [1] }] })
    const memory = new Memories({ db, engines: { claude: engine } as Record<EngineId, Engine>, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'tucano-r3-')) })
    await memory.consolidate('ch', true)
    expect(db.memories({ scope: personScope('bruno') }).map((m) => m.text)).toEqual(['Prefere reuniões curtas'])
    expect(db.memories({ scope: personScope(db.ownerId()) })).toEqual([])
  })

  it("lembrar about the person you talk to refuses a claim about someone else; alone, nothing changes", () => {
    const { db } = twoPeople()
    db.createConversation({ id: 'dm-bruno', kind: 'dm', name: 'a1', members: ['a1'], owner: 'bruno' })
    const memory = new Memories({ db, engines: {} as Record<EngineId, Engine>, settings: async () => settings, emit: () => {}, workDir: '' })
    const lia = db.agent('a1')!
    const r = memory.remember(lia, db.conversation('dm-bruno')!, { texto: 'Ana vai ser demitida', sobre: 'usuario' }, 'bruno')
    expect(r.memory).toBeUndefined()
    expect(r.error).toBe(true)
    expect(memory.remember(lia, db.conversation('dm-bruno')!, { texto: 'Prefere café', sobre: 'usuario' }, 'bruno').memory).toBeTruthy()
    // A Tucano of one: what the owner says about anyone is kept, as always.
    const solo = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-r3-')), 'tucano.db'))
    solo.saveAgent(lia)
    solo.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'] })
    const alone = new Memories({ db: solo, engines: {} as Record<EngineId, Engine>, settings: async () => settings, emit: () => {}, workDir: '' })
    expect(alone.remember(lia, solo.conversation('dm')!, { texto: 'A sócia dele, Bia, cuida do financeiro', sobre: 'usuario' }).memory).toBeTruthy()
  })
})

describe('D. a Tucano of one', () => {
  it("lets its owner be called like an agent (no person is ever called there): the introduction doesn't fail for a Nina", () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-r3-')), 'tucano.db'))
    db.saveAgent({ id: 'a1', name: 'Nina', handle: 'nina', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    expect(new People(db).nameTaken('Nina', db.ownerId())).toBe(false)
  })
})
