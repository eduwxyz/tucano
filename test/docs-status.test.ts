// Documentos for agents (what an agent may use, for whom) and approval (what an agent saved waits for someone who looks
// after the folder). Real folder, real index; the agents and the people are the ones of a small team.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Docs } from '../src/core/docs'
import type { Requester } from '../src/shared/doc-access'
import type { Doc, DocFolder, FolderAccess } from '../src/shared/docs'
import { setLang } from '../src/shared/lang'
import type { Agent, Person } from '../src/shared/types'

const person = (id: string, role: Person['role'] = 'member'): Person => ({ id, name: id, role, about: '' })
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

const ana = person('ana', 'owner')
const adm = person('adm', 'admin')
const maria = person('maria')
const pedro = person('pedro')
const lia = person('lia')
const PEOPLE = [ana, adm, maria, pedro, lia]
// The finance sector (the head `fin`, `fina` under it) and the tech sector (`tec`, `bia`).
const fin = agent('fin', { sectorName: 'Financeiro' })
const fina = agent('fina', { reportsTo: 'fin' })
const tec = agent('tec', { sectorName: 'Técnico' })
const bia = agent('bia', { reportsTo: 'tec' })

let root: string
let docs: Docs
let agents: Agent[]
let reviews: string[]

beforeEach(async () => {
  setLang('pt')
  root = mkdtempSync(join(tmpdir(), 'tucano-docs-status-'))
  agents = [fin, fina, tec, bia]
  reviews = []
  docs = new Docs({ dir: join(root, 'documents'), indexPath: join(root, 'docs.db'), artifactsDir: join(root, 'artifacts'), agents: () => agents, people: () => PEOPLE, artifact: () => undefined, canSeeArtifact: () => true, emit: () => {}, onReview: (d) => void reviews.push(d.id) })
  docs.init()
  await docs.loaded
})
afterEach(() => {
  docs.close()
  rmSync(root, { recursive: true, force: true })
  setLang('pt')
})

const folder = (name: string): DocFolder => docs.index.folders().find((f) => f.name === name)!
const put = (who: Person, folderName: string, name: string, text: string): Promise<Doc> => docs.add(who, { folderId: folder(folderName).id, name, data: Buffer.from(text) })
const share = (name: string, people: FolderAccess['people']): void => {
  const f = folder(name)
  docs.saveFolder(ana, { id: f.id, parentId: f.parentId, name: f.name, rule: f.rule, access: { people, sectors: f.access?.sectors ?? {}, agents: {} } })
}
const sub = (parent: string, name: string, approval = false): DocFolder => docs.saveFolder(ana, { parentId: folder(parent).id, name, rule: '', ...(approval ? { needsApproval: true } : {}) })
const setApproval = (name: string, on: boolean): void => {
  const f = folder(name)
  docs.saveFolder(ana, { id: f.id, parentId: f.parentId, name: f.name, rule: f.rule, needsApproval: on })
}
// An agent saves a text file: `who` works for `requester`.
const save = (who: Agent, requester: Requester, folderRef: string, name: string, text: string, extra: Partial<Parameters<Docs['saveFor']>[2]> = {}) => docs.saveFor(who, requester, { folderId: folderRef, name, data: Buffer.from(text), summary: '', note: '', origin: {}, ...extra })
const failure = async (run: () => unknown): Promise<string> => {
  try {
    await run()
  } catch (e) {
    return (e as Error).message
  }
  return 'did not fail'
}
const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name).sort()
const stored = (id: string): Doc => docs.index.doc(id)!

describe('the folders an agent may use', () => {
  it('gives an agent its own sector\'s folder and the company\'s, and no other sector\'s', () => {
    expect(names(docs.foldersFor(fina, null, 'read'))).toEqual(['Empresa', 'Financeiro'])
    expect(names(docs.foldersFor(fina, null, 'write'))).toEqual(['Financeiro'])
    expect(names(docs.foldersFor(bia, null, 'read'))).toEqual(['Empresa', 'Técnico'])
    for (const f of docs.foldersFor(fina, null, 'read')) expect(f.path).toBe(f.name)
  })

  it('gives an agent working for a member only what the agent and the member may both use', () => {
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    docs.tree(lia)
    expect(names(docs.foldersFor(fina, maria, 'read'))).toContain('Financeiro')
    expect(names(docs.foldersFor(fina, maria, 'write'))).toContain('Financeiro')
    expect(names(docs.foldersFor(fina, pedro, 'read'))).toContain('Financeiro')
    expect(names(docs.foldersFor(fina, pedro, 'write'))).not.toContain('Financeiro')
    expect(names(docs.foldersFor(fina, lia, 'read'))).toEqual(['Empresa', 'Só meus'])
    expect(names(docs.foldersFor(bia, maria, 'read'))).not.toContain('Financeiro') // the member may, the agent may not
  })

  it('opens a person\'s own personal folder to their agent, and never another person\'s', () => {
    docs.tree(maria)
    docs.tree(lia)
    const forLia = docs.foldersFor(fina, lia, 'write')
    expect(forLia.map((f) => f.privateTo)).toEqual(['lia'])
    expect(docs.foldersFor(fina, maria, 'read').filter((f) => f.privateTo).map((f) => f.privateTo)).toEqual(['maria'])
  })

  it('gives a channel only what every one of its readers may use, and no personal folder', () => {
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    docs.tree(maria)
    docs.tree(pedro)
    expect(names(docs.foldersFor(fina, [maria, pedro], 'read'))).toEqual(['Empresa', 'Financeiro'])
    expect(names(docs.foldersFor(fina, [maria, pedro], 'write'))).toEqual([])
    expect(names(docs.foldersFor(fina, [maria, lia], 'read'))).toEqual(['Empresa'])
    expect(docs.foldersFor(fina, [maria, pedro], 'read').some((f) => f.privateTo)).toBe(false)
  })
})

describe('reading and finding as an agent', () => {
  it('finds a folder by its id or by its path, with no regard to case or accents', async () => {
    const reports = sub('Financeiro', 'Relatórios')
    const may = await put(ana, 'Relatórios', 'maio.md', 'faturamento de maio')
    for (const ref of ['financeiro/RELATORIOS', reports.id, 'Relatorios', 'Financeiro › Relatórios']) {
      const out = docs.listFor(fina, null, ref)
      expect(out.docs.map((d) => d.id), ref).toEqual([may.id])
      expect(out.docs[0]!.path).toBe('Financeiro/Relatórios/maio.md')
    }
    expect(docs.listFor(fina, null, 'Financeiro').folders.map((f) => f.path)).toEqual(['Financeiro/Relatórios'])
  })

  it('lists the documents of every folder it may read when no folder is given', async () => {
    await put(ana, 'Financeiro', 'a.md', 'um')
    await put(ana, 'Empresa', 'regras.md', 'dois')
    await put(ana, 'Técnico', 'servidor.md', 'tres')
    expect(docs.listFor(fina, null).docs.map((d) => d.path).sort()).toEqual(['Empresa/regras.md', 'Financeiro/a.md'])
  })

  it('reads a document by id or by path, and a name alone only when it is the only one', async () => {
    sub('Financeiro', 'Relatórios')
    sub('Financeiro', 'Outros')
    const may = await put(ana, 'Relatórios', 'maio.md', 'faturamento de maio')
    expect((await docs.readFor(fina, null, may.id)).text).toContain('faturamento')
    expect((await docs.readFor(fina, null, 'financeiro/relatorios/MAIO.md')).doc.path).toBe('Financeiro/Relatórios/maio.md')
    expect((await docs.readFor(fina, null, 'maio.md')).doc.id).toBe(may.id)
    await put(ana, 'Outros', 'maio.md', 'outro maio')
    await expect(docs.readFor(fina, null, 'maio.md')).rejects.toThrow() // two of them: say which
    expect((await docs.readFor(fina, null, 'Outros/maio.md')).text).toContain('outro')
  })

  it('does not find a document in the trash', async () => {
    const a = await put(ana, 'Financeiro', 'a.md', 'texto')
    docs.trash(ana, a.id)
    await expect(docs.readFor(fina, null, 'Financeiro/a.md')).rejects.toThrow()
    expect(docs.listFor(fina, null, 'Financeiro').docs).toEqual([])
  })

  it('searches only what the agent may read for the requester, and can scope the search to a folder', async () => {
    sub('Financeiro', 'Relatórios')
    const may = await put(ana, 'Relatórios', 'maio.md', 'faturamento de maio')
    await put(ana, 'Técnico', 'deploy.md', 'faturamento do deploy')
    const hits = docs.searchFor(fina, null, 'faturamento')
    expect(hits.map((h) => h.doc.id)).toEqual([may.id])
    expect(hits[0]!.doc.path).toBe('Financeiro/Relatórios/maio.md')
    expect(docs.searchFor(fina, null, 'faturamento', 'Financeiro/Relatórios')).toHaveLength(1)
    expect(docs.searchFor(bia, null, 'faturamento').map((h) => h.doc.path)).toEqual(['Técnico/deploy.md'])
    expect(docs.searchFor(fina, lia, 'faturamento')).toEqual([]) // the sector may, lia may not
    share('Financeiro', { lia: 'view' })
    expect(docs.searchFor(fina, lia, 'faturamento')).toHaveLength(1)
  })

  it('answers about a folder or a document it may not use exactly as about one that does not exist', async () => {
    await put(ana, 'Técnico', 'deploy.md', 'segredo do deploy')
    await put(ana, 'Financeiro', 'folha.md', 'segredo da folha')
    const folderOf = (ref: string): Promise<string> => failure(() => docs.listFor(fina, null, ref))
    expect(await folderOf('Técnico')).not.toBe('did not fail')
    expect(await folderOf('Técnico')).toBe(await folderOf('Inexistente'))
    expect(await failure(() => docs.searchFor(fina, null, 'segredo', 'Técnico'))).toBe(await folderOf('Inexistente'))
    const docOf = (who: Agent, requester: Requester, ref: string): Promise<string> => failure(() => docs.readFor(who, requester, ref))
    expect(await docOf(fina, null, 'Técnico/deploy.md')).not.toBe('did not fail')
    expect(await docOf(fina, null, 'Técnico/deploy.md')).toBe(await docOf(fina, null, 'Nada/deploy.md'))
    expect(await docOf(fina, lia, 'Financeiro/folha.md')).toBe(await docOf(fina, lia, 'Nada/folha.md'))
    expect(docs.searchFor(bia, null, 'folha')).toEqual([])
  })

  it('never shows the name of a folder above one it may read but cannot read itself', async () => {
    const secret = docs.saveFolder(ana, { parentId: null, name: 'Segredo', rule: '', access: { people: {}, sectors: { fin: 'write' }, agents: {} } })
    docs.saveFolder(ana, { parentId: secret.id, name: 'Aberto', rule: '', access: { people: {}, sectors: {}, agents: { bia: 'write' } } })
    await put(ana, 'Aberto', 'x.md', 'palavra aberta')
    const seen = docs.foldersFor(bia, null, 'read')
    expect(seen.find((f) => f.name === 'Aberto')?.path).toBe('Aberto')
    expect(JSON.stringify(seen)).not.toContain('Segredo')
    expect(docs.listFor(bia, null).docs.map((d) => d.path)).toEqual(['Aberto/x.md'])
    expect(JSON.stringify(docs.searchFor(bia, null, 'aberta'))).not.toContain('Segredo')
    expect((await docs.readFor(bia, null, 'Aberto/x.md')).doc.path).toBe('Aberto/x.md')
    expect((await save(bia, null, 'Aberto', 'y.md', 'outro')).path).toBe('Aberto/y.md')
    expect(() => docs.listFor(bia, null, 'Segredo/Aberto')).toThrow() // the parent's name is not a way in
    expect(names(docs.foldersFor(fina, null, 'read'))).toContain('Segredo')
  })
})

describe('saving and moving as an agent', () => {
  it('saves in a folder the agent and its person may write, saying who made it and for whom', async () => {
    share('Financeiro', { maria: 'edit' })
    sub('Financeiro', 'Relatórios')
    const doc = await save(fina, maria, 'Financeiro/Relatórios', 'maio.md', 'faturamento de maio', { origin: { conversationId: 'c1' } })
    expect(doc.path).toBe('Financeiro/Relatórios/maio.md')
    expect(doc.createdBy).toBe('agent:fina')
    expect(doc.origin).toMatchObject({ agentId: 'fina', askedBy: 'maria', conversationId: 'c1' })
    expect(existsSync(join(docs.root, 'Financeiro', 'Relatórios', 'maio.md'))).toBe(true)
    expect(docs.search(maria, 'faturamento')).toHaveLength(1)
  })

  it('names no one as the asker when it works for a channel', async () => {
    share('Financeiro', { maria: 'edit' })
    const doc = await save(fina, [maria, ana], 'Financeiro', 'a.md', 'texto')
    expect(doc.origin.askedBy).toBeUndefined()
    expect(doc.origin.agentId).toBe('fina')
  })

  it('refuses where the agent or the person it works for may not write, and saves nothing', async () => {
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    const hidden = await failure(() => save(fina, lia, 'Financeiro', 'a.md', 'x'))
    expect(hidden).not.toBe('did not fail')
    expect(hidden).toBe(await failure(() => save(fina, lia, 'Inexistente', 'a.md', 'x')))
    await expect(save(bia, maria, 'Financeiro', 'a.md', 'x')).rejects.toThrow() // another sector's agent
    await expect(save(fina, pedro, 'Financeiro', 'a.md', 'x')).rejects.toThrow() // the person only views
    await expect(save(fina, [maria, pedro], 'Financeiro', 'a.md', 'x')).rejects.toThrow() // so does one in the channel
    await expect(save(fina, [maria, lia], 'Financeiro', 'a.md', 'x')).rejects.toThrow() // and an outsider
    await expect(save(fina, null, 'Empresa', 'a.md', 'x')).rejects.toThrow() // it may only read the company folder
    expect(docs.index.docs()).toHaveLength(0)
  })

  it('saves as the next version of a document it may write, and not of one it may not', async () => {
    const first = await save(fina, null, 'Financeiro', 'a.md', 'um')
    const next = await save(fina, null, 'Financeiro', 'a.md', 'dois', { replaces: 'Financeiro/a.md', note: 'revisão' })
    expect(next.id).toBe(first.id)
    expect(next.version).toBe(2)
    await expect(save(bia, null, 'Técnico', 'a.md', 'tres', { replaces: 'Financeiro/a.md' })).rejects.toThrow()
    expect(stored(first.id).version).toBe(2)
  })

  it('moves a document between two folders it may write, and no further', async () => {
    sub('Financeiro', 'Outros')
    const doc = await save(fina, null, 'Financeiro', 'a.md', 'um')
    const moved = docs.moveFor(fina, null, 'Financeiro/a.md', 'Financeiro/Outros')
    expect(moved.path).toBe('Financeiro/Outros/a.md')
    expect(existsSync(join(docs.root, 'Financeiro', 'Outros', 'a.md'))).toBe(true)
    expect(() => docs.moveFor(fina, null, 'Financeiro/Outros/a.md', 'Técnico')).toThrow()
    expect(() => docs.moveFor(bia, null, 'Financeiro/Outros/a.md', 'Técnico')).toThrow()
    expect(stored(doc.id).folderId).toBe(folder('Outros').id)
  })
})

describe('what waits for approval', () => {
  it('holds what an agent saves for review, and makes official what someone who may approve saves', async () => {
    setApproval('Financeiro', true)
    share('Financeiro', { maria: 'edit' })
    const byAgent = await save(fina, null, 'Financeiro', 'a.md', 'do agente')
    expect(byAgent).toMatchObject({ status: 'review', officialVersion: null, statusBy: 'agent:fina' })
    expect(reviews).toEqual([byAgent.id])
    expect(await put(ana, 'Financeiro', 'b.md', 'do dono')).toMatchObject({ status: 'official', officialVersion: 1 })
    expect(await put(maria, 'Financeiro', 'c.md', 'de quem edita')).toMatchObject({ status: 'official', officialVersion: 1 })
    expect(reviews).toHaveLength(1)
  })

  it('does not ask for approval where the folder does not', async () => {
    const doc = await save(fina, null, 'Financeiro', 'a.md', 'texto')
    expect(doc.status).toBeNull()
    expect(reviews).toEqual([])
  })

  it('asks for it in a subfolder too, and a subfolder cannot switch that off', async () => {
    setApproval('Financeiro', true)
    sub('Financeiro', 'Relatórios')
    expect((await save(fina, null, 'Financeiro/Relatórios', 'a.md', 'x')).status).toBe('review')
    setApproval('Relatórios', false)
    expect((await save(fina, null, 'Financeiro/Relatórios', 'b.md', 'y')).status).toBe('review')
  })

  it('makes a document official when it is approved, and keeps that in its history', async () => {
    setApproval('Financeiro', true)
    const doc = await save(fina, null, 'Financeiro', 'a.md', 'texto')
    const { doc: approved, tell } = docs.decide(ana, doc.id, true)
    expect(approved).toMatchObject({ status: 'official', officialVersion: 1, statusBy: 'person:ana' })
    expect(tell).toBeUndefined()
    expect(docs.history(ana, doc.id).events.map((e) => e.action)).toContain('approved')
    expect(() => docs.decide(ana, doc.id, true)).toThrow() // it no longer waits
  })

  it('needs the reason when changes are asked for, then sends the document back to draft with it', async () => {
    setApproval('Financeiro', true)
    const doc = await save(fina, null, 'Financeiro', 'a.md', 'texto')
    expect(() => docs.decide(ana, doc.id, false)).toThrow()
    expect(() => docs.decide(ana, doc.id, false, '   ')).toThrow()
    expect(stored(doc.id).status).toBe('review')
    const { doc: back, tell } = docs.decide(ana, doc.id, false, 'falta o total')
    expect(back).toMatchObject({ status: 'draft', statusNote: 'falta o total', officialVersion: null })
    expect(tell).toBeUndefined() // it did not come from a conversation
    expect(docs.history(ana, doc.id).events.map((e) => e.action)).toContain('changes-asked')
  })

  it('tells the agent that made it, in its conversation, only when there is one and the agent is still there', async () => {
    setApproval('Financeiro', true)
    const doc = await save(fina, null, 'Financeiro', 'relatorio.md', 'texto', { origin: { conversationId: 'c1', threadId: 't1' } })
    const { tell } = docs.decide(ana, doc.id, false, 'refazer com o total')
    expect(tell).toMatchObject({ conversationId: 'c1', threadId: 't1', agentId: 'fina' })
    expect(tell!.text).toContain('@fina')
    expect(tell!.text).toContain('refazer com o total')
    expect(tell!.text).toContain('relatorio.md')
    const gone = await save(fina, null, 'Financeiro', 'outro.md', 'texto', { origin: { conversationId: 'c2' } })
    agents = agents.filter((a) => a.id !== 'fina')
    expect(docs.decide(ana, gone.id, false, 'refazer').tell).toBeUndefined()
  })

  it('lets only someone who looks after the folder decide, and shows the rest nothing about it', async () => {
    setApproval('Financeiro', true)
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    const doc = await save(fina, null, 'Financeiro', 'a.md', 'texto')
    expect(() => docs.decide(pedro, doc.id, true)).toThrow() // sees it, may not decide
    expect(stored(doc.id).status).toBe('review')
    const hidden = await failure(() => docs.decide(lia, doc.id, true))
    expect(hidden).not.toBe('did not fail')
    expect(hidden).toBe(await failure(() => docs.decide(lia, '00000000-0000-4000-8000-000000000000', true)))
    expect(docs.decide(maria, doc.id, true).doc.status).toBe('official')
  })

  it('does not approve a version the person did not see', async () => {
    setApproval('Financeiro', true)
    const doc = await save(fina, null, 'Financeiro', 'a.md', 'um')
    await save(fina, null, 'Financeiro', 'a.md', 'dois, outra versão', { replaces: 'Financeiro/a.md' })
    expect(() => docs.decide(ana, doc.id, true, undefined, 1)).toThrow()
    expect(stored(doc.id).status).toBe('review')
    expect(docs.decide(ana, doc.id, true, undefined, 2).doc).toMatchObject({ status: 'official', officialVersion: 2 })
  })

  it('lets what holds stay what holds while a new version waits: the agent reads the official text', async () => {
    setApproval('Financeiro', true)
    await put(ana, 'Financeiro', 'politica.md', 'Regra antiga')
    const next = await save(fina, null, 'Financeiro', 'politica.md', 'Regra nova zebra', { replaces: 'Financeiro/politica.md' })
    expect(next).toMatchObject({ version: 2, status: 'review', officialVersion: 1 })
    const read = await docs.readFor(fina, null, 'Financeiro/politica.md')
    expect(read.text).toContain('Regra antiga')
    expect(read.text).not.toContain('zebra')
    expect(read.note).toBeTruthy()
    expect(read.doc.summary).toBe('')
    const hit = docs.searchFor(fina, null, 'zebra')[0]!
    expect(hit.doc.summary).toBe('')
    expect(hit.snippet).toBe('')
    expect(docs.listFor(fina, null, 'Financeiro').docs[0]!.summary).toBe('')
    docs.decide(ana, next.id, true)
    const after = await docs.readFor(fina, null, 'Financeiro/politica.md')
    expect(after.text).toContain('zebra')
    expect(after.note).toBeUndefined()
  })

  it('gives draft where asked and ignores it where approval is asked', async () => {
    const draft = await save(fina, null, 'Financeiro', 'rascunho.md', 'texto', { draft: true })
    expect(draft).toMatchObject({ status: 'draft', officialVersion: null })
    expect((await docs.readFor(fina, null, 'Financeiro/rascunho.md')).note).toBeTruthy()
    setApproval('Financeiro', true)
    expect((await save(fina, null, 'Financeiro', 'outro.md', 'texto', { draft: true })).status).toBe('review')
  })

  it('puts a document an agent moves into an approval folder in review, and takes it out of review when it leaves', async () => {
    sub('Financeiro', 'Rascunhos')
    sub('Financeiro', 'Oficiais', true)
    const doc = await save(fina, null, 'Financeiro/Rascunhos', 'a.md', 'texto')
    expect(doc.status).toBeNull()
    expect(docs.moveFor(fina, null, 'Financeiro/Rascunhos/a.md', 'Financeiro/Oficiais').status).toBe('review')
    expect(reviews).toEqual([doc.id])
    expect(docs.moveFor(fina, null, 'Financeiro/Oficiais/a.md', 'Financeiro/Rascunhos').status).toBeNull()
  })

  it('makes official what a person who may approve moves into an approval folder', async () => {
    sub('Financeiro', 'Rascunhos')
    const approval = sub('Financeiro', 'Oficiais', true)
    const doc = await put(ana, 'Rascunhos', 'a.md', 'texto')
    expect(docs.move(ana, doc.id, approval.id)).toMatchObject({ status: 'official', officialVersion: 1 })
  })

  it('makes a draft or a waiting document official by a person\'s say, or a normal one where nothing is asked', async () => {
    const draft = await save(fina, null, 'Financeiro', 'a.md', 'texto', { draft: true })
    expect(docs.makeOfficial(ana, draft.id).status).toBeNull() // no approval here: it is simply a normal document
    expect(() => docs.makeOfficial(ana, draft.id)).toThrow() // already counts
    setApproval('Financeiro', true)
    const waiting = await save(fina, null, 'Financeiro', 'b.md', 'texto')
    share('Financeiro', { pedro: 'view' })
    expect(() => docs.makeOfficial(pedro, waiting.id)).toThrow()
    expect(docs.makeOfficial(ana, waiting.id)).toMatchObject({ status: 'official', officialVersion: 1 })
    expect(docs.history(ana, waiting.id).events.map((e) => e.action)).toContain('made-official')
  })

  it('clears review and official when approval is turned off', async () => {
    setApproval('Financeiro', true)
    const waiting = await save(fina, null, 'Financeiro', 'a.md', 'agente')
    const official = await put(ana, 'Financeiro', 'b.md', 'dono')
    setApproval('Financeiro', false)
    for (const d of [waiting, official]) expect(stored(d.id)).toMatchObject({ status: null, officialVersion: null })
    expect(folder('Financeiro').needsApproval).toBe(false)
  })

  it('lets only the owner and admins switch approval on or off', async () => {
    share('Financeiro', { maria: 'edit' })
    const f = folder('Financeiro')
    expect(() => docs.saveFolder(maria, { id: f.id, parentId: null, name: f.name, rule: f.rule, needsApproval: true })).toThrow()
    expect(folder('Financeiro').needsApproval).toBe(false)
    expect(docs.saveFolder(adm, { id: f.id, parentId: null, name: f.name, rule: f.rule, needsApproval: true }).needsApproval).toBe(true)
    expect(() => docs.saveFolder(maria, { id: f.id, parentId: null, name: f.name, rule: f.rule, needsApproval: false })).toThrow()
  })

  it('lists what waits only for people who may approve it, and not what is in the trash', async () => {
    setApproval('Financeiro', true)
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    const waiting = await save(fina, null, 'Financeiro', 'a.md', 'texto')
    const trashed = await save(fina, null, 'Financeiro', 'b.md', 'texto')
    docs.trash(ana, trashed.id)
    for (const who of [ana, adm, maria]) {
      const inbox = docs.waitingFor(who)
      expect(inbox.map((i) => i.doc.id)).toEqual([waiting.id])
      expect(inbox[0]!.folderPath).toEqual(['Financeiro'])
    }
    expect(docs.waitingFor(pedro)).toEqual([])
    expect(docs.waitingFor(lia)).toEqual([])
  })
})
