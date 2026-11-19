// Documentos on a real folder and a real index: the first folders, what is stored, who sees what, who may change
// folders, and versions, names and the trash.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Docs } from '../src/core/docs'
import { MAX_DOC_BYTES, type Doc, type DocFolder, type FolderAccess } from '../src/shared/docs'
import { setLang } from '../src/shared/lang'
import type { Agent, Artifact, Person } from '../src/shared/types'

const person = (id: string, role: Person['role'] = 'member'): Person => ({ id, name: id, role, about: '' })
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

const ana = person('ana', 'owner')
const adm = person('adm', 'admin')
const maria = person('maria')
const pedro = person('pedro')
const lia = person('lia')
const PEOPLE = [ana, adm, maria, pedro, lia]

let root: string
let docs: Docs
let agents: Agent[]
let artifacts: Record<string, Artifact>
let canSee: boolean

const deps = () => ({ dir: join(root, 'documents'), indexPath: join(root, 'docs.db'), artifactsDir: join(root, 'artifacts'), agents: () => agents, people: () => PEOPLE, artifact: (id: string) => artifacts[id], canSeeArtifact: () => canSee, emit: () => {} })
const open = async (): Promise<Docs> => {
  const d = new Docs(deps())
  d.init()
  await d.loaded
  return d
}

beforeEach(async () => {
  setLang('pt')
  root = mkdtempSync(join(tmpdir(), 'tucano-docs-store-'))
  agents = [agent('fin', { sectorName: 'Financeiro' }), agent('fina', { reportsTo: 'fin' }), agent('tec', { sectorName: 'Técnico' }), agent('bia', { reportsTo: 'tec' })]
  artifacts = {}
  canSee = true
  docs = await open()
})
afterEach(() => {
  docs.close()
  rmSync(root, { recursive: true, force: true })
  setLang('pt')
})

const folder = (name: string): DocFolder => docs.index.folders().find((f) => f.name === name)!
const put = (who: Person, folderName: string, name: string, text: string): Promise<Doc> => docs.add(who, { folderId: folder(folderName).id, name, data: Buffer.from(text) })
// Shares a root folder with these people (the sector that owns it keeps its place).
const share = (name: string, people: FolderAccess['people']): void => {
  const f = folder(name)
  docs.saveFolder(ana, { id: f.id, parentId: f.parentId, name: f.name, rule: f.rule, access: { people, sectors: f.access?.sectors ?? {}, agents: {} } })
}
// What the call said when it failed, or that it did not.
const failure = async (run: () => unknown): Promise<string> => {
  try {
    await run()
  } catch (e) {
    return (e as Error).message
  }
  return 'did not fail'
}
const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id)
// The smallest PDF with one line of text (the same one the wiki's tests read).
const pdf = (line: string): Buffer => {
  const stream = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    'latin1'
  )
}

describe('the first folders', () => {
  it('makes one root per sector, for that sector to write, and a company folder everyone views', () => {
    const roots = docs.index.folders().filter((f) => !f.parentId)
    expect(roots.map((f) => f.name).sort()).toEqual(['Empresa', 'Financeiro', 'Técnico'])
    expect(folder('Financeiro').access).toEqual({ people: {}, agents: {}, sectors: { fin: 'write' } })
    expect(folder('Técnico').access).toEqual({ people: {}, agents: {}, sectors: { tec: 'write' } })
    expect(folder('Empresa').access).toMatchObject({ everyone: 'view', allAgents: 'read', sectors: { fin: 'read', tec: 'read' } })
    expect(docs.index.meta('companyRoot')).toBe(folder('Empresa').id)
    for (const f of roots) expect(existsSync(join(docs.root, f.name))).toBe(true)
  })

  it('makes them once: opening the same folder again adds nothing', async () => {
    const before = docs.index.folders().length
    docs.close()
    docs = await open()
    expect(docs.index.folders()).toHaveLength(before)
  })

  it('does not bring back a sector folder that was deleted', async () => {
    docs.removeFolder(ana, folder('Financeiro').id)
    docs.tree(ana)
    docs.close()
    docs = await open()
    docs.tree(ana)
    expect(docs.index.folders().some((f) => f.name === 'Financeiro')).toBe(false)
  })

  it('makes the folder of a sector that appears later, and lets that sector read the company folder', () => {
    agents.push(agent('ops', { sectorName: 'Operações' }), agent('opa', { reportsTo: 'ops' }))
    docs.tree(ana)
    expect(folder('Operações').access?.sectors).toEqual({ ops: 'write' })
    expect(folder('Empresa').access?.sectors['ops']).toBe('read')
  })

  it('makes a personal folder for a person the first time they look, and no one else\'s tree shows it', () => {
    const mine = docs.tree(maria)
    const personal = mine.folders.filter((f) => f.privateTo === 'maria')
    expect(personal).toHaveLength(1)
    expect(mine.can[personal[0]!.id]).toBe('edit')
    for (const other of [pedro, ana, adm]) expect(docs.tree(other).folders.some((f) => f.privateTo === 'maria')).toBe(false)
    docs.tree(maria)
    expect(docs.index.folders().filter((f) => f.privateTo === 'maria')).toHaveLength(1)
  })

  it('does not share a personal folder, even to its own person, and does not delete it', () => {
    const personal = docs.tree(maria).folders.find((f) => f.privateTo === 'maria')!
    const everyone: FolderAccess = { everyone: 'view', people: {}, sectors: {}, agents: {} }
    expect(() => docs.saveFolder(maria, { id: personal.id, parentId: null, name: personal.name, rule: '', access: everyone })).toThrow()
    expect(() => docs.saveFolder(ana, { id: personal.id, parentId: null, name: personal.name, rule: '', access: everyone })).toThrow()
    expect(() => docs.removeFolder(maria, personal.id)).toThrow()
  })
})

describe('adding a file', () => {
  it('keeps the file on disk under the folder\'s name and finds it by a word only inside it', async () => {
    const doc = await put(ana, 'Financeiro', 'notas.md', '# Notas\n\nA zebrinha azul voltou.')
    expect(readFileSync(join(docs.root, 'Financeiro', 'notas.md'), 'utf8')).toContain('zebrinha')
    expect(docs.fileOf(ana, doc.id)?.path).toBe(join(docs.root, 'Financeiro', 'notas.md'))
    const hits = docs.search(ana, 'zebrinha')
    expect(ids(hits.map((h) => h.doc))).toEqual([doc.id])
    expect(hits[0]!.snippet).toContain('**')
    expect(docs.search(ana, 'nenhumapalavra')).toEqual([])
  })

  it('reads a Word file for the search too', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cláusula sobre o pangolim</w:t></w:r></w:p></w:body></w:document>')
    const doc = await docs.add(ana, { folderId: folder('Financeiro').id, name: 'contrato.docx', data: await zip.generateAsync({ type: 'nodebuffer' }) })
    expect(doc.kind).toBe('docx')
    expect(ids(docs.search(ana, 'pangolim').map((h) => h.doc))).toEqual([doc.id])
  })

  it('uses the first words of the text as the summary, or the one it was given', async () => {
    const auto = await put(ana, 'Financeiro', 'a.md', '# Notas\n\nzebrinha azul')
    expect(auto.summary).toBe('Notas zebrinha azul')
    const given = await docs.add(ana, { folderId: folder('Financeiro').id, name: 'b.md', data: Buffer.from('texto qualquer'), summary: 'Resumo do pangolim' })
    expect(given.summary).toBe('Resumo do pangolim')
    expect(ids(docs.search(ana, 'pangolim').map((h) => h.doc))).toEqual([given.id])
  })

  it('refuses a kind it does not take, and stores nothing', async () => {
    for (const name of ['video.mp4', 'a.zip', 'setup.exe', 'logo.svg', 'semextensao', '..']) await expect(docs.add(ana, { folderId: folder('Financeiro').id, name, data: Buffer.from('x') })).rejects.toThrow()
    expect(docs.index.docs()).toHaveLength(0)
  })

  it('refuses a file over the size limit and takes one at the limit', async () => {
    await expect(docs.add(ana, { folderId: folder('Financeiro').id, name: 'grande.txt', data: Buffer.alloc(MAX_DOC_BYTES + 1, 97) })).rejects.toThrow()
    expect(docs.index.docs()).toHaveLength(0)
    expect(existsSync(join(docs.root, 'Financeiro', 'grande.txt'))).toBe(false)
    const doc = await docs.add(ana, { folderId: folder('Financeiro').id, name: 'limite.png', data: Buffer.alloc(MAX_DOC_BYTES, 1) })
    expect(doc.size).toBe(MAX_DOC_BYTES)
  })

  it('numbers a name that is already there, case aside', async () => {
    const a = await put(ana, 'Financeiro', 'a.md', 'um')
    const b = await put(ana, 'Financeiro', 'a.md', 'dois')
    const c = await put(ana, 'Financeiro', 'A.md', 'tres')
    expect([a.name, b.name, c.name]).toEqual(['a.md', 'a (2).md', 'A (3).md'])
    expect(readFileSync(join(docs.root, 'Financeiro', 'a (2).md'), 'utf8')).toBe('dois')
    expect(docs.index.docs()).toHaveLength(3)
  })

  it('keeps every name inside the documents folder, whatever it tries', async () => {
    for (const name of ['../x.md', 'a/b.md', '.hidden.md', '/etc/passwd.txt', '..\\x.md', 'a/../../x.md']) {
      const doc = await put(ana, 'Financeiro', name, 'conteudo')
      const path = docs.fileOf(ana, doc.id)!.path
      expect(path.startsWith(docs.root + sep)).toBe(true)
      expect(basename(path)).toBe(doc.name)
      expect(doc.name).not.toMatch(/[/\\]/)
      expect(doc.name.startsWith('.')).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe('conteudo')
    }
    expect(existsSync(join(root, 'x.md'))).toBe(false)
    expect(existsSync(join(docs.root, 'x.md'))).toBe(false)
    expect(existsSync(join(docs.root, 'Financeiro', '..', '..', 'x.md'))).toBe(false)
  })

  it('keeps a folder name inside the documents folder too', () => {
    const f = docs.saveFolder(ana, { parentId: null, name: '../evil', rule: '' })
    expect(f.name).not.toContain('/')
    expect(existsSync(join(docs.root, f.name))).toBe(true)
    expect(existsSync(join(root, 'evil'))).toBe(false)
  })

  it('refuses a folder that is not there as it refuses one a person may not edit', async () => {
    const missing = await failure(() => docs.add(ana, { folderId: 'nao-existe', name: 'a.md', data: Buffer.from('x') }))
    const hidden = await failure(() => docs.add(lia, { folderId: folder('Financeiro').id, name: 'a.md', data: Buffer.from('x') }))
    expect(missing).not.toBe('did not fail')
    expect(hidden).toBe(missing)
    share('Financeiro', { pedro: 'view' })
    await expect(docs.add(pedro, { folderId: folder('Financeiro').id, name: 'a.md', data: Buffer.from('x') })).rejects.toThrow()
  })

  it('keeps a file an agent showed in a chat once, and only for someone who may see that chat', async () => {
    mkdirSync(join(root, 'artifacts', 'art1'), { recursive: true })
    writeFileSync(join(root, 'artifacts', 'art1', 'plano.md'), '# Plano\n\ntexto do plano')
    artifacts['art1'] = { id: 'art1', agentId: 'fina', conversationId: 'c1', messageId: 'm1', kind: 'markdown', name: 'plano.md', title: 'Plano', source: '', size: 20, createdAt: 1 }
    const first = await docs.saveFromArtifact(ana, 'art1', folder('Financeiro').id)
    const again = await docs.saveFromArtifact(ana, 'art1', folder('Financeiro').id)
    expect(again.id).toBe(first.id)
    expect(docs.index.docs()).toHaveLength(1)
    expect(first.origin).toMatchObject({ artifactId: 'art1', conversationId: 'c1' })
    canSee = false
    await expect(docs.saveFromArtifact(adm, 'art1', folder('Técnico').id)).rejects.toThrow()
  })
})

describe('what a person sees', () => {
  it('shows a member who has no access neither the folder nor what is in it', async () => {
    const doc = await put(ana, 'Financeiro', 'notas.md', 'A zebrinha azul voltou.')
    const tree = docs.tree(maria)
    expect(tree.folders.some((f) => f.name === 'Financeiro')).toBe(false)
    expect(tree.docs.some((d) => d.id === doc.id)).toBe(false)
    expect(docs.search(maria, 'zebrinha')).toEqual([])
    expect(docs.search(maria, 'zebrinha', folder('Financeiro').id)).toEqual([])
    expect(docs.fileOf(maria, doc.id)).toBeNull()
    expect(docs.excerpts(maria, 'zebrinha', {})).toEqual([])
  })

  it('shows it once access is given, as edit or view', async () => {
    const doc = await put(ana, 'Financeiro', 'notas.md', 'A zebrinha azul voltou.')
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    const mine = docs.tree(maria)
    expect(mine.can[folder('Financeiro').id]).toBe('edit')
    expect(mine.docs.map((d) => d.id)).toContain(doc.id)
    expect(docs.tree(pedro).can[folder('Financeiro').id]).toBe('view')
    expect(ids(docs.search(maria, 'zebrinha').map((h) => h.doc))).toEqual([doc.id])
    expect(docs.fileOf(maria, doc.id)?.name).toBe('notas.md')
    expect(docs.tree(lia).folders.some((f) => f.name === 'Financeiro')).toBe(false)
  })

  it('answers about a hidden document exactly as it answers about one that does not exist', async () => {
    const doc = await put(ana, 'Financeiro', 'notas.md', 'A zebrinha azul voltou.')
    const ghost = '00000000-0000-4000-8000-000000000000'
    const personal = docs.tree(lia).folders.find((f) => f.privateTo === 'lia')!
    const calls: [string, (id: string) => unknown][] = [
      ['text', (id) => docs.text(lia, id)],
      ['text of a version', (id) => docs.text(lia, id, 1)],
      ['history', (id) => docs.history(lia, id)],
      ['move', (id) => docs.move(lia, id, personal.id)],
      ['rename', (id) => docs.rename(lia, id, 'outro.md')],
      ['trash', (id) => docs.trash(lia, id)],
      ['restore', (id) => docs.restore(lia, id)],
      ['restoreVersion', (id) => docs.restoreVersion(lia, id, 1)],
      ['newVersion', (id) => docs.newVersion(lia, id, { data: Buffer.from('novo') })],
      ['decide', (id) => docs.decide(lia, id, true)],
      ['makeOfficial', (id) => docs.makeOfficial(lia, id)]
    ]
    for (const [name, call] of calls) {
      const hidden = await failure(() => call(doc.id))
      expect(hidden, name).not.toBe('did not fail')
      expect(hidden, name).toBe(await failure(() => call(ghost)))
    }
    expect(docs.fileOf(lia, doc.id)).toEqual(docs.fileOf(lia, ghost))
    expect(docs.index.doc(doc.id)?.trashedAt).toBeNull() // and none of them did anything
  })

  it('leaves a hidden document out of the list of what was kept from chats', async () => {
    const saved = await docs.saveFor(agents[1]!, null, { folderId: 'Financeiro', name: 'x.md', data: Buffer.from('x'), summary: '', note: '', origin: { artifactId: 'art-1' } })
    expect(docs.docByArtifact(ana)['art-1']).toEqual({ docId: saved.id, folderId: saved.folderId })
    expect(docs.docByArtifact(lia)).toEqual({})
    share('Financeiro', { lia: 'view' })
    expect(docs.docByArtifact(lia)['art-1']?.docId).toBe(saved.id)
  })

  it('puts a folder at the top for someone who sees it but not its parent', async () => {
    const parent = docs.saveFolder(ana, { parentId: null, name: 'Segredo', rule: '', access: { people: {}, sectors: {}, agents: {} } })
    const child = docs.saveFolder(ana, { parentId: parent.id, name: 'Aberto', rule: '', access: { people: { maria: 'view' }, sectors: {}, agents: {} } })
    const mine = docs.tree(maria)
    expect(mine.folders.some((f) => f.id === parent.id)).toBe(false)
    expect(mine.folders.find((f) => f.id === child.id)?.parentId).toBeNull()
  })

  it('takes a person who left: their personal folder and files go, and they leave every access', async () => {
    share('Financeiro', { maria: 'edit' })
    const personal = docs.tree(maria).folders.find((f) => f.privateTo === 'maria')!
    const kept = await docs.add(maria, { folderId: personal.id, name: 'meu.md', data: Buffer.from('so meu') })
    docs.purgePerson('maria')
    expect(docs.index.doc(kept.id)).toBeUndefined()
    expect(docs.index.folders().some((f) => f.privateTo === 'maria')).toBe(false)
    expect(folder('Financeiro').access?.people['maria']).toBeUndefined()
    expect(folder('Financeiro').access?.sectors).toEqual({ fin: 'write' })
  })
})

describe('changing folders', () => {
  it('lets a member who may edit a folder make a subfolder in it that follows its access, and rename it', () => {
    share('Financeiro', { maria: 'edit' })
    const sub = docs.saveFolder(maria, { parentId: folder('Financeiro').id, name: 'Relatórios', rule: 'o que sai todo mês' })
    expect(sub.access).toBeNull()
    expect(docs.tree(maria).folders.some((f) => f.id === sub.id)).toBe(true)
    const renamed = docs.saveFolder(maria, { id: sub.id, parentId: folder('Financeiro').id, name: 'Relatórios 2', rule: 'o que sai todo mês' })
    expect(renamed.name).toBe('Relatórios 2')
    expect(existsSync(join(docs.root, 'Financeiro', 'Relatórios 2'))).toBe(true)
  })

  it('lets only the owner and admins widen access, ask for approval, make a top folder or move one', () => {
    share('Financeiro', { maria: 'edit' })
    const fin = folder('Financeiro')
    const sub = docs.saveFolder(maria, { parentId: fin.id, name: 'Relatórios', rule: '' })
    const wide: FolderAccess = { everyone: 'edit', people: {}, sectors: {}, agents: {} }
    expect(() => docs.saveFolder(maria, { id: sub.id, parentId: fin.id, name: sub.name, rule: '', access: wide })).toThrow()
    expect(() => docs.saveFolder(maria, { id: sub.id, parentId: fin.id, name: sub.name, rule: '', needsApproval: true })).toThrow()
    expect(() => docs.saveFolder(maria, { parentId: fin.id, name: 'Outra', rule: '', access: wide })).toThrow()
    expect(() => docs.saveFolder(maria, { parentId: null, name: 'Topo', rule: '' })).toThrow()
    expect(() => docs.saveFolder(maria, { id: sub.id, parentId: null, name: sub.name, rule: '' })).toThrow()
    expect(docs.index.folders().find((f) => f.id === sub.id)).toMatchObject({ access: null, needsApproval: false, parentId: fin.id })
    expect(docs.saveFolder(adm, { id: sub.id, parentId: fin.id, name: sub.name, rule: '', access: wide }).access?.everyone).toBe('edit')
  })

  it('lets an admin move a folder, and what is in it goes along', async () => {
    const sub = docs.saveFolder(ana, { parentId: folder('Financeiro').id, name: 'Relatórios', rule: '' })
    const doc = await docs.add(ana, { folderId: sub.id, name: 'maio.md', data: Buffer.from('maio') })
    docs.saveFolder(adm, { id: sub.id, parentId: folder('Técnico').id, name: sub.name, rule: '' })
    expect(docs.fileOf(ana, doc.id)?.path).toBe(join(docs.root, 'Técnico', 'Relatórios', 'maio.md'))
    expect(existsSync(join(docs.root, 'Financeiro', 'Relatórios'))).toBe(false)
  })

  it('does not put a folder inside itself', () => {
    const sub = docs.saveFolder(ana, { parentId: folder('Financeiro').id, name: 'Relatórios', rule: '' })
    expect(() => docs.saveFolder(ana, { id: folder('Financeiro').id, parentId: sub.id, name: 'Financeiro', rule: '' })).toThrow()
  })

  it('removes only an empty folder, by an admin or whoever made it, and its trashed files go for good', async () => {
    share('Financeiro', { maria: 'edit' })
    const sub = docs.saveFolder(maria, { parentId: folder('Financeiro').id, name: 'Temp', rule: '' })
    const doc = await docs.add(maria, { folderId: sub.id, name: 'a.md', data: Buffer.from('a') })
    expect(() => docs.removeFolder(maria, sub.id)).toThrow() // not empty
    docs.trash(maria, doc.id)
    expect(existsSync(join(docs.root, '.trash', doc.id))).toBe(true)
    docs.removeFolder(maria, sub.id)
    expect(docs.index.doc(doc.id)).toBeUndefined()
    expect(existsSync(join(docs.root, '.trash', doc.id))).toBe(false)
    expect(docs.index.folders().some((f) => f.id === sub.id)).toBe(false)
    // someone else's subfolder: a member may not delete it
    const other = docs.saveFolder(ana, { parentId: folder('Financeiro').id, name: 'Dela', rule: '' })
    expect(() => docs.removeFolder(maria, other.id)).toThrow()
  })
})

describe('versions, names and the trash', () => {
  it('keeps the old bytes readable when a new version comes', async () => {
    const doc = await put(ana, 'Financeiro', 'plano.md', 'versao um')
    const next = await docs.newVersion(ana, doc.id, { data: Buffer.from('versao dois, mais longa'), note: 'revisão' })
    expect(next.version).toBe(2)
    expect((await docs.text(ana, doc.id)).text).toBe('versao dois, mais longa')
    expect((await docs.text(ana, doc.id, 1)).text).toBe('versao um')
    expect(readFileSync(docs.fileOf(ana, doc.id, 1)!.path, 'utf8')).toBe('versao um')
    expect(readFileSync(docs.fileOf(ana, doc.id)!.path, 'utf8')).toBe('versao dois, mais longa')
  })

  it('does not make a version out of the same bytes', async () => {
    const doc = await put(ana, 'Financeiro', 'plano.md', 'igual')
    const same = await docs.newVersion(ana, doc.id, { data: Buffer.from('igual') })
    expect(same.version).toBe(1)
    expect(docs.history(ana, doc.id).versions).toHaveLength(1)
  })

  it('goes back to an old version as a new one, losing nothing', async () => {
    const doc = await put(ana, 'Financeiro', 'plano.md', 'versao um')
    await docs.newVersion(ana, doc.id, { data: Buffer.from('versao dois') })
    const back = await docs.restoreVersion(ana, doc.id, 1)
    expect(back.version).toBe(3)
    expect((await docs.text(ana, doc.id)).text).toBe('versao um')
    expect((await docs.text(ana, doc.id, 2)).text).toBe('versao dois')
    await expect(docs.restoreVersion(ana, doc.id, 3)).rejects.toThrow() // it is the current one
  })

  it('lists the versions, newest first, and what happened to the document', async () => {
    const doc = await put(ana, 'Financeiro', 'plano.md', 'versao um')
    await docs.newVersion(ana, doc.id, { data: Buffer.from('versao dois') })
    await docs.restoreVersion(ana, doc.id, 1)
    const { versions, events } = docs.history(ana, doc.id)
    expect(versions.map((v) => v.n)).toEqual([3, 2, 1])
    expect(versions[0]!.by).toBe('person:ana')
    expect(events.map((e) => e.action)).toEqual(['reverted', 'version', 'created'])
  })

  it('keeps the extension when it is renamed, so the kind does not change', async () => {
    const saved = await docs.add(ana, { folderId: folder('Financeiro').id, name: 'relatorio.pdf', data: pdf('Relatorio mensal') })
    expect(saved.kind).toBe('pdf')
    const renamed = docs.rename(ana, saved.id, 'x.html')
    expect(renamed.name).toBe('x.html.pdf')
    expect(renamed.kind).toBe('pdf')
    expect(docs.rename(ana, saved.id, 'final').name).toBe('final.pdf')
    expect(existsSync(join(docs.root, 'Financeiro', 'final.pdf'))).toBe(true)
    expect(existsSync(join(docs.root, 'Financeiro', 'relatorio.pdf'))).toBe(false)
    expect(docs.history(ana, saved.id).events[0]!.action).toBe('renamed')
  })

  it('numbers a new name that is taken', async () => {
    await put(ana, 'Financeiro', 'a.md', 'um')
    const b = await put(ana, 'Financeiro', 'b.md', 'dois')
    expect(docs.rename(ana, b.id, 'a.md').name).toBe('a (2).md')
  })

  it('moves a document to another folder, with the file, when the person may edit both', async () => {
    const doc = await put(ana, 'Financeiro', 'a.md', 'um')
    const to = docs.saveFolder(ana, { parentId: folder('Técnico').id, name: 'Destino', rule: '' })
    const moved = docs.move(ana, doc.id, to.id)
    expect(moved.folderId).toBe(to.id)
    expect(docs.fileOf(ana, doc.id)?.path).toBe(join(docs.root, 'Técnico', 'Destino', 'a.md'))
    expect(docs.history(ana, doc.id).events[0]!.action).toBe('moved')
    share('Financeiro', { maria: 'edit' })
    const mine = await put(ana, 'Financeiro', 'b.md', 'dois')
    // maria edits the first folder but cannot see the second
    expect(() => docs.move(maria, mine.id, to.id)).toThrow()
    expect(docs.index.doc(mine.id)?.folderId).toBe(folder('Financeiro').id)
  })

  it('hides a trashed document and brings it back', async () => {
    const doc = await put(ana, 'Financeiro', 'a.md', 'a zebrinha azul')
    docs.trash(ana, doc.id)
    expect(docs.tree(ana).docs.find((d) => d.id === doc.id)?.trashedAt).toBeGreaterThan(0)
    expect(docs.search(ana, 'zebrinha')).toEqual([])
    expect(existsSync(join(docs.root, 'Financeiro', 'a.md'))).toBe(false)
    await expect(docs.newVersion(ana, doc.id, { data: Buffer.from('x') })).rejects.toThrow()
    expect(() => docs.move(ana, doc.id, folder('Financeiro').id)).toThrow()
    docs.restore(ana, doc.id)
    expect(docs.tree(ana).docs.find((d) => d.id === doc.id)?.trashedAt).toBeNull()
    expect(ids(docs.search(ana, 'zebrinha').map((h) => h.doc))).toEqual([doc.id])
    expect(existsSync(join(docs.root, 'Financeiro', 'a.md'))).toBe(true)
  })
})
