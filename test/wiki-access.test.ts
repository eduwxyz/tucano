// The wiki for a restricted member (PersonAccess): the pages that took something from a conversation
// they don't see are out of their view, and out of the view of an agent replying to them.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { People } from '../src/core/people'
import { Runner } from '../src/core/runs'
import { pageKey, Wiki } from '../src/core/wiki'

let root: string
let wiki: Wiki

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tucano-wiki-access-'))
  wiki = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
  wiki.init(false)
})
afterEach(() => {
  wiki.close()
  rmSync(root, { recursive: true, force: true })
})

// A page the curator wrote from what was said in a conversation.
function fromConversation(title: string, text: string, conversationId: string): string {
  const src = wiki.addSource({ title, text, kind: 'conversation', origin: { conversationId, messageIds: [] }, by: 'auto' })
  wiki.applyChange(wiki.addChange({ ops: [{ op: 'create', page: title, text }], sourceId: src.id, by: 'auto' }).id, 'Curador')
  return src.id
}

describe('Wiki.outOfReach', () => {
  it('names the pages that took something from a conversation not seen, and only those', () => {
    fromConversation('Salários', 'Folha de novembro.', 'rh')
    fromConversation('Build', 'O build quebra no Windows.', 'eng')
    wiki.save({ title: 'Manual', body: 'Escrito à mão.', by: 'ana', byName: 'Ana' })
    const sees = (id: string): boolean => id === 'eng'
    expect([...wiki.outOfReach(sees)]).toEqual([pageKey('Salários')])
  })

  it('a page with one part from a conversation not seen is out, whatever else it has', () => {
    wiki.save({ title: 'Build', body: 'Escrito à mão.', by: 'ana', byName: 'Ana' })
    const src = wiki.addSource({ title: 'rh', text: 'x', kind: 'conversation', origin: { conversationId: 'rh', messageIds: [] }, by: 'auto' })
    wiki.applyChange(wiki.addChange({ ops: [{ op: 'append', page: 'Build', text: 'Do RH.' }], sourceId: src.id, by: 'auto' }).id, 'Curador')
    expect(wiki.outOfReach((id) => id === 'eng').has(pageKey('Build'))).toBe(true)
  })

  it('counts a part whose source is gone, or the curator\'s with no source, as not seen', () => {
    const gone = fromConversation('Antiga', 'De algum lugar.', 'eng')
    wiki.removeSource(gone)
    wiki.save({ title: 'Do curador', body: 'Sem fonte.', by: 'auto', byName: 'Curador' })
    const out = wiki.outOfReach(() => true)
    expect(out.has(pageKey('Antiga'))).toBe(true)
    expect(out.has(pageKey('Do curador'))).toBe(true)
  })

  it('keeps a page out after its source is deleted, also renamed, and one with no history at all', () => {
    const gone = fromConversation('Folha', 'Folha confidencial.', 'rh')
    wiki.removeSource(gone)
    expect(wiki.page('Folha')?.body).toContain('Folha confidencial')
    expect(wiki.outOfReach((id) => id === 'eng').has(pageKey('Folha'))).toBe(true)
    wiki.save({ title: 'Folha 2', body: 'Folha confidencial.', rename: 'Folha', by: 'ana', byName: 'Ana' })
    expect(wiki.outOfReach((id) => id === 'eng').has(pageKey('Folha 2'))).toBe(true)
    wiki.save({ title: 'Manual', body: 'Escrito à mão.', by: 'ana', byName: 'Ana' })
    expect(wiki.outOfReach(() => true).has(pageKey('Manual'))).toBe(false)
  })

  it('keeps out a page with no history at all (its source deleted before the wiki kept track)', () => {
    wiki.save({ title: 'Sem histórico', body: 'De algum lugar.', by: 'ana', byName: 'Ana' })
    // as an index from before this change left it: dropOrphans deleted the versions, nothing else
    ;(wiki as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db.prepare('DELETE FROM versions WHERE key = ?').run(pageKey('Sem histórico'))
    expect(wiki.outOfReach(() => true).has(pageKey('Sem histórico'))).toBe(true)
  })

  it('keeps the cut when the wiki moves to another folder (another folder, git connected)', () => {
    fromConversation('Salários', 'Folha de novembro.', 'rh')
    fromConversation('Build', 'O build quebra no Windows.', 'eng')
    const gone = fromConversation('Antiga', 'De algum lugar.', 'eng')
    wiki.removeSource(gone)
    wiki.save({ title: 'Sem histórico', body: 'De algum lugar.', by: 'ana', byName: 'Ana' })
    ;(wiki as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db.prepare('DELETE FROM versions WHERE key = ?').run(pageKey('Sem histórico'))
    const dir = join(root, 'wiki2')
    cpSync(join(root, 'wiki'), dir, { recursive: true })
    wiki.relocate(dir, join(root, 'wiki2.db'))
    expect(wiki.page('Salários')?.body).toContain('Folha de novembro')
    const out = wiki.outOfReach((id) => id === 'eng')
    expect(out.has(pageKey('Salários'))).toBe(true)
    expect(out.has(pageKey('Antiga'))).toBe(true)
    expect(out.has(pageKey('Sem histórico'))).toBe(true)
    expect(out.has(pageKey('Build'))).toBe(false)
    // and it follows a rename there, and a move made outside save (git moving a file aside)
    wiki.save({ title: 'Folha', body: 'Folha de novembro.', rename: 'Salários', by: 'ana', byName: 'Ana' })
    expect(wiki.outOfReach((id) => id === 'eng').has(pageKey('Folha'))).toBe(true)
    wiki.carryKey(pageKey('Folha'), pageKey('Folha (cópia)'))
    expect(wiki.outOfReach((id) => id === 'eng').has(pageKey('Folha (cópia)'))).toBe(true)
    expect(wiki.outOfReach((id) => id === 'eng' || id === 'rh').has(pageKey('Folha (cópia)'))).toBe(false)
  })
})

describe('an agent replying to a restricted member', () => {
  const lia: Agent = { id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, wiki: 'read' }

  async function ask(restrict: boolean): Promise<string> {
    const db = new Db(join(root, 'core.db'))
    const gateway = new Gateway()
    db.saveAgent(lia)
    db.createConversation({ id: 'eng', kind: 'channel', name: 'engenharia', members: [lia.id] })
    db.createConversation({ id: 'rh', kind: 'channel', name: 'rh', members: [lia.id] })
    fromConversation('Salários', 'Folha confidencial de novembro.', 'rh')
    fromConversation('Build', 'O build quebra no Windows.', 'eng')
    const people = new People(db)
    const joined = people.join(people.createInvite(db.owner(), { role: 'member' }).code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    if (restrict) db.setPersonAccess(joined.person.id, { mode: 'picked', sectors: [], agents: [lia.id], channels: ['eng'] })
    let out = ''
    const engine: Engine = {
      id: 'claude',
      async *run(turn: Turn) {
        for (const [name, args] of [['wiki_buscar', { busca: 'novembro' }], ['wiki_indice', {}], ['wiki_ler', { pagina: 'Salários' }]] as const) out += JSON.stringify(await callTool(turn.mcpUrl!, name, args))
        yield { type: 'done', text: 'Pronto.', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const ids: EngineId[] = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes']
    const engines = Object.fromEntries(ids.map((id) => [id, id === 'claude' ? engine : fakeEngine(id)])) as Record<EngineId, Engine>
    const settings = { workspaceName: 'Ana', context: '', routerModel: 'haiku', memoryModel: 'haiku', engines: Object.fromEntries(ids.map((id) => [id, { installed: true, loggedIn: true }])) } as Settings
    const runner = new Runner({ db, wiki, gateway, engines, settings: async () => settings, emit: () => {}, workDir: join(root, 'work') })
    try {
      await gateway.start()
      await runner.send('eng', '@lia o que a wiki diz?', [], undefined, joined.person.id)
      await runner.idle()
    } finally {
      await gateway.stop()
      db.close()
    }
    return out
  }

  it('reads only the pages from what the member sees', async () => {
    const out = await ask(true)
    expect(out).toContain('Build')
    expect(out).not.toContain('# Salários')
    expect(out).not.toContain('confidencial')
  })

  it('reads them all for a member who sees everything', async () => {
    const out = await ask(false)
    expect(out).toContain('confidencial')
  })
})
