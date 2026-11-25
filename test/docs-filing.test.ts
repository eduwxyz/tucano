// Documentos around the documents: files dropped for the cataloguer to put away, dates found in documents, the passages
// that answer a question, and what happens when the folder is changed outside Tucano or the index cannot be opened.
// Real folder, real index.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Docs } from '../src/core/docs'
import { DocsIndex } from '../src/core/docs-db'
import { checkZip, extractFile } from '../src/core/wiki-extract'
import { actorOfAgent, actorOfPerson, type Doc, type DocFolder, type FolderAccess } from '../src/shared/docs'
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

let root: string
let docs: Docs
let agents: Agent[]

const deps = () => ({ dir: join(root, 'documents'), indexPath: join(root, 'docs.db'), artifactsDir: join(root, 'artifacts'), agents: () => agents, people: () => PEOPLE, artifact: () => undefined, canSeeArtifact: () => true, emit: () => {} })
const open = async (): Promise<Docs> => {
  const d = new Docs(deps())
  d.init()
  await d.loaded
  return d
}

beforeEach(async () => {
  setLang('pt')
  root = mkdtempSync(join(tmpdir(), 'tucano-docs-filing-'))
  agents = [agent('fin', { sectorName: 'Financeiro' }), agent('fina', { reportsTo: 'fin' }), agent('tec', { sectorName: 'Técnico' }), agent('bia', { reportsTo: 'tec' })]
  docs = await open()
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
const sub = (parent: string, name: string): DocFolder => docs.saveFolder(ana, { parentId: folder(parent).id, name, rule: '' })
const setApproval = (name: string, on: boolean): void => {
  const f = folder(name)
  docs.saveFolder(ana, { id: f.id, parentId: f.parentId, name: f.name, rule: f.rule, needsApproval: on })
}
const drop = (who: Person, name: string, text: string): Promise<Doc> => docs.addInbox(who, { name, data: Buffer.from(text) })
const failure = async (run: () => unknown): Promise<string> => {
  try {
    await run()
  } catch (e) {
    return (e as Error).message
  }
  return 'did not fail'
}
const ids = (xs: { id: string }[]): string[] => xs.map((x) => x.id)
const stored = (id: string): Doc => docs.index.doc(id)!
// A day as the folder writes it: today plus `offset` days.
const day = (offset: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('files dropped for the cataloguer', () => {
  it('keeps the file in the personal folder of whoever dropped it, waiting, and shows it to no one else', async () => {
    const doc = await drop(maria, 'nota.md', 'uma nota sobre o tamandua')
    expect(doc.folderId).toBe(docs.personalRoot(docs.index.folders(), 'maria')!.id)
    expect(doc.filing).toMatchObject({ state: 'pending', by: 'maria' })
    for (const other of [ana, adm, pedro, lia]) {
      expect(docs.tree(other).docs.some((d) => d.id === doc.id)).toBe(false)
      expect(docs.search(other, 'tamandua')).toEqual([])
    }
    expect(docs.tree(maria).docs.map((d) => d.id)).toContain(doc.id)
  })

  it('lists, as places to put files, only the shared folders the person may edit', async () => {
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    sub('Financeiro', 'Relatórios')
    docs.tree(maria)
    expect(docs.foldersToFileInto(maria).map((w) => w.path).sort()).toEqual(['Financeiro', 'Financeiro/Relatórios'])
    expect(docs.foldersToFileInto(pedro)).toEqual([])
    expect(docs.foldersToFileInto(lia)).toEqual([])
    expect(docs.foldersToFileInto(ana).map((w) => w.path).sort()).toEqual(['Empresa', 'Financeiro', 'Financeiro/Relatórios', 'Técnico'])
  })

  it('puts a file away: it moves to the folder, is marked filed, and the move is in its history', async () => {
    share('Financeiro', { maria: 'edit' })
    const doc = await drop(maria, 'nota.md', 'texto')
    const filed = docs.fileInto(doc.id, folder('Financeiro').id, undefined, actorOfAgent('fina'))
    expect(filed.folderId).toBe(folder('Financeiro').id)
    expect(filed.filing).toMatchObject({ state: 'filed', by: 'maria' })
    expect(existsSync(join(docs.root, 'Financeiro', 'nota.md'))).toBe(true)
    expect(existsSync(join(docs.root, '.private', 'maria', 'nota.md'))).toBe(false)
    expect(docs.history(maria, doc.id).events.map((e) => e.action)).toEqual(expect.arrayContaining(['filed', 'moved']))
    expect(docs.tree(pedro).docs.some((d) => d.id === doc.id)).toBe(false) // pedro does not see Financeiro
  })

  it('keeps the extension when it is given a new name as it is put away', async () => {
    const doc = await drop(maria, 'scan-0042.md', 'texto')
    expect(docs.fileInto(doc.id, folder('Financeiro').id, 'recibo', actorOfAgent('fina')).name).toBe('recibo.md')
  })

  it('follows the approval rule of the folder it goes to', async () => {
    setApproval('Financeiro', true)
    const byAgent = await drop(maria, 'a.md', 'um')
    const byPerson = await drop(maria, 'b.md', 'dois')
    expect(docs.fileInto(byAgent.id, folder('Financeiro').id, undefined, actorOfAgent('fina')).status).toBe('review')
    expect(docs.fileInto(byPerson.id, folder('Financeiro').id, undefined, actorOfPerson('ana'))).toMatchObject({ status: 'official', officialVersion: 1 })
  })

  it('refuses to put a file in someone else\'s personal folder, or one that is not waiting', async () => {
    const pedros = docs.tree(pedro).folders.find((f) => f.privateTo === 'pedro')!
    const doc = await drop(maria, 'a.md', 'um')
    expect(() => docs.fileInto(doc.id, pedros.id, undefined, actorOfAgent('fina'))).toThrow()
    docs.fileInto(doc.id, folder('Financeiro').id, undefined, actorOfAgent('fina'))
    expect(() => docs.fileInto(doc.id, folder('Técnico').id, undefined, actorOfAgent('fina'))).toThrow() // already filed
    const kept = await drop(maria, 'b.md', 'dois')
    docs.keepUnfiled(kept.id, 'não sei onde isso vai')
    expect(stored(kept.id).filing).toMatchObject({ state: 'kept', note: 'não sei onde isso vai' })
    expect(() => docs.fileInto(kept.id, folder('Financeiro').id, undefined, actorOfAgent('fina'))).toThrow()
  })

  it('lets the person who dropped a file take it back to their personal folder, and no one else', async () => {
    share('Financeiro', { maria: 'edit' })
    const doc = await drop(maria, 'a.md', 'um')
    expect(() => docs.unfile(maria, doc.id)).toThrow() // still waiting: nothing to take back
    docs.fileInto(doc.id, folder('Financeiro').id, undefined, actorOfAgent('fina'))
    expect(() => docs.unfile(pedro, doc.id)).toThrow()
    expect(() => docs.unfile(ana, doc.id)).toThrow()
    const back = docs.unfile(maria, doc.id)
    expect(back.folderId).toBe(docs.personalRoot(docs.index.folders(), 'maria')!.id)
    expect(back.filing?.state).toBe('kept')
    expect(docs.history(maria, doc.id).events.map((e) => e.action)).toContain('unfiled')
    expect(existsSync(join(docs.root, '.private', 'maria', 'a.md'))).toBe(true)
    expect(() => docs.unfile(maria, doc.id)).toThrow() // it is back already
  })

  // Taking it back moves the document, with every version, to the person's own folder. It is theirs to
  // take only while they may still change it where it is.
  it('does not let them take back a file that has since left their reach', async () => {
    share('Financeiro', { maria: 'edit' })
    const moved = await drop(maria, 'a.md', 'um')
    docs.fileInto(moved.id, folder('Financeiro').id, undefined, actorOfAgent('fina'))
    docs.move(ana, moved.id, folder('Técnico').id)
    await docs.newVersion(ana, moved.id, { data: Buffer.from('o que a diretoria escreveu depois') })
    expect(() => docs.unfile(maria, moved.id)).toThrow()
    expect(stored(moved.id).folderId).toBe(folder('Técnico').id)
    expect((await docs.text(ana, moved.id)).text).toContain('diretoria')

    const lost = await drop(maria, 'b.md', 'dois')
    docs.fileInto(lost.id, folder('Financeiro').id, undefined, actorOfAgent('fina'))
    share('Financeiro', {})
    expect(() => docs.unfile(maria, lost.id)).toThrow()
    expect(stored(lost.id).folderId).toBe(folder('Financeiro').id)
  })

  it('takes at most 20 waiting files from a person, and counts each person on their own', async () => {
    for (let n = 0; n < 20; n++) await drop(maria, `f${n}.md`, `arquivo ${n}`)
    await expect(drop(maria, 'f20.md', 'um a mais')).rejects.toThrow()
    expect((await drop(pedro, 'dele.md', 'outro')).filing?.by).toBe('pedro')
    const first = docs.index.docs().find((d) => d.name === 'f0.md')!
    docs.fileInto(first.id, folder('Financeiro').id, undefined, actorOfAgent('fina'))
    await expect(drop(maria, 'f20.md', 'agora cabe')).resolves.toBeTruthy()
  }, 20_000)

  it('refuses a dropped file of a kind Documentos does not take', async () => {
    await expect(drop(maria, 'video.mp4', 'x')).rejects.toThrow()
    expect(docs.index.docs()).toHaveLength(0)
  })
})

describe('dates found in documents', () => {
  it('keeps only valid dates with something to say, once each, and at most six', async () => {
    const doc = await put(ana, 'Financeiro', 'contrato.md', 'vence em breve')
    docs.setDates(doc.id, [
      { date: day(10), what: 'Renovar contrato' },
      { date: '2026-13-40', what: 'mês que não existe' },
      { date: '2026-02-30', what: 'dia que não existe' },
      { date: 'amanhã', what: 'não é uma data' },
      { date: day(20), what: '   ' },
      { date: day(10), what: 'renovar CONTRATO' }
    ])
    expect(docs.dates(doc.id).map((d) => d.what)).toEqual(['Renovar contrato'])
    docs.setDates(doc.id, Array.from({ length: 9 }, (_, n) => ({ date: day(n + 1), what: `prazo ${n}` })))
    expect(docs.dates(doc.id)).toHaveLength(6)
  })

  it('replaces the open dates with the new ones', async () => {
    const doc = await put(ana, 'Financeiro', 'contrato.md', 'vence em breve')
    docs.setDates(doc.id, [{ date: day(10), what: 'Renovar' }])
    docs.setDates(doc.id, [{ date: day(15), what: 'Pagar' }])
    expect(docs.dates(doc.id).map((d) => d.what)).toEqual(['Pagar'])
  })

  it('does not add again a date that was dismissed or reminded', async () => {
    const doc = await put(ana, 'Financeiro', 'contrato.md', 'vence em breve')
    docs.setDates(doc.id, [{ date: day(10), what: 'Renovar' }, { date: day(11), what: 'Pagar' }])
    const [renew, pay] = docs.dates(doc.id)
    docs.dismissDate(ana, renew!.id)
    docs.markReminded(pay!.id, 'rotina-1')
    docs.setDates(doc.id, [{ date: day(10), what: 'renovar' }, { date: day(11), what: 'PAGAR' }])
    const now = docs.dates(doc.id)
    expect(now).toHaveLength(2)
    expect(now.find((d) => d.id === renew!.id)?.state).toBe('dismissed')
    expect(now.find((d) => d.id === pay!.id)).toMatchObject({ state: 'reminded', routineId: 'rotina-1' })
    expect(docs.datesFor(ana)).toEqual([]) // neither is open
  })

  it('lists only open dates to come, in the next year, soonest first, with the days left', async () => {
    const doc = await put(ana, 'Financeiro', 'contrato.md', 'vence em breve')
    docs.setDates(doc.id, [
      { date: day(30), what: 'em trinta dias' },
      { date: day(5), what: 'em cinco dias' },
      { date: day(-3), what: 'já passou' },
      { date: day(0), what: 'hoje' },
      { date: day(400), what: 'longe demais' }
    ])
    const coming = docs.datesFor(ana)
    expect(coming.map((c) => c.date.what)).toEqual(['hoje', 'em cinco dias', 'em trinta dias'])
    expect(coming.map((c) => c.daysLeft)).toEqual([0, 5, 30])
    expect(coming[0]).toMatchObject({ folderPath: ['Financeiro'], doc: { id: doc.id, name: 'contrato.md' } })
  })

  it('lists them only to people who may edit the document\'s folder, and not for a trashed document', async () => {
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    const doc = await put(ana, 'Financeiro', 'contrato.md', 'vence em breve')
    docs.setDates(doc.id, [{ date: day(5), what: 'prazo' }])
    expect(docs.datesFor(maria)).toHaveLength(1)
    expect(docs.datesFor(adm)).toHaveLength(1)
    expect(docs.datesFor(pedro)).toEqual([])
    expect(docs.datesFor(lia)).toEqual([])
    expect(docs.tree(maria).dates).toHaveLength(1)
    expect(docs.tree(lia).dates).toEqual([])
    docs.trash(ana, doc.id)
    expect(docs.datesFor(ana)).toEqual([])
    expect(docs.tree(ana).dates).toEqual([])
  })

  it('lets only someone who may edit dismiss a date, and a hidden one answers as a missing one', async () => {
    share('Financeiro', { maria: 'edit', pedro: 'view' })
    const doc = await put(ana, 'Financeiro', 'contrato.md', 'vence em breve')
    docs.setDates(doc.id, [{ date: day(5), what: 'prazo' }])
    const date = docs.dates(doc.id)[0]!
    expect(() => docs.dismissDate(pedro, date.id)).toThrow()
    const hidden = await failure(() => docs.dismissDate(lia, date.id))
    expect(hidden).not.toBe('did not fail')
    expect(hidden).toBe(await failure(() => docs.dismissDate(lia, 'nao-existe')))
    expect(docs.dates(doc.id)[0]!.state).toBe('open')
    docs.dismissDate(maria, date.id)
    expect(docs.dates(doc.id)[0]!.state).toBe('dismissed')
    expect(docs.tree(ana).dates).toEqual([])
  })
})

describe('passages that answer a question', () => {
  const contract = 'Contrato com a empresa Zorgon: multa de 10% por atraso.'

  it('finds the passage in what the person sees, and nothing in what they do not', async () => {
    const doc = await put(ana, 'Financeiro', 'contrato.md', contract)
    const out = docs.excerpts(ana, 'zorgon multa', {})
    expect(ids(out.map((o) => o.doc))).toEqual([doc.id])
    expect(out[0]!.text).toContain('Zorgon')
    expect(docs.excerpts(lia, 'zorgon multa', {})).toEqual([])
    expect(docs.excerpts(lia, 'zorgon', { folderId: folder('Financeiro').id })).toEqual([])
    expect(docs.excerpts(lia, 'zorgon', { docId: doc.id })).toEqual([])
    share('Financeiro', { maria: 'view' })
    expect(docs.excerpts(maria, 'zorgon', {})).toHaveLength(1)
    expect(docs.excerpts(maria, 'zorgon', { docId: doc.id })).toHaveLength(1)
  })

  it('stays inside the folder it is told to, with the folders under it', async () => {
    sub('Financeiro', 'Relatórios')
    await put(ana, 'Relatórios', 'contrato.md', contract)
    expect(docs.excerpts(ana, 'zorgon', { folderId: folder('Financeiro').id })).toHaveLength(1)
    expect(docs.excerpts(ana, 'zorgon', { folderId: folder('Relatórios').id })).toHaveLength(1)
    expect(docs.excerpts(ana, 'zorgon', { folderId: folder('Técnico').id })).toEqual([])
  })

  it('gives the start of a document when it is asked about it and the question matches nothing in it', async () => {
    const doc = await put(ana, 'Financeiro', 'contrato.md', contract)
    const out = docs.excerpts(ana, 'inexistente', { docId: doc.id })
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toContain('Zorgon')
  })

  it('gives nothing for a document in the trash', async () => {
    const doc = await put(ana, 'Financeiro', 'contrato.md', contract)
    docs.trash(ana, doc.id)
    expect(docs.excerpts(ana, 'zorgon', { docId: doc.id })).toEqual([])
    expect(docs.excerpts(ana, 'zorgon', {})).toEqual([])
  })
})

describe('the folder changed outside Tucano', () => {
  it('picks up a file dropped on disk, written by "outside"', async () => {
    writeFileSync(join(docs.root, 'Financeiro', 'solto.md'), 'uma palavra gloriosa')
    await docs.scan()
    const found = docs.index.docs().find((d) => d.name === 'solto.md')!
    expect(found.createdBy).toBe('outside')
    expect(ids(docs.search(ana, 'gloriosa').map((h) => h.doc))).toEqual([found.id])
  })

  it('takes a directory that appeared as a folder only the owner and admins see', async () => {
    mkdirSync(join(docs.root, 'Novo'))
    writeFileSync(join(docs.root, 'Novo', 'a.md'), 'dentro do novo')
    await docs.scan()
    expect(docs.tree(ana).folders.some((f) => f.name === 'Novo')).toBe(true)
    expect(docs.tree(adm).docs.some((d) => d.name === 'a.md')).toBe(true)
    expect(docs.tree(maria).folders.some((f) => f.name === 'Novo')).toBe(false)
    expect(docs.tree(maria).docs.some((d) => d.name === 'a.md')).toBe(false)
  })

  // A restore, or a copy, writes every file with the current time. The bytes are the ones on record:
  // each is read once to see that, and the time it was read at is kept, so the next scans leave it alone.
  it('reads once a file that only got a newer time, and still sees a later edit', async () => {
    const doc = await put(ana, 'Financeiro', 'a.md', 'primeiro')
    const path = join(docs.root, 'Financeiro', 'a.md')
    const later = new Date(Date.now() + 60_000)
    utimesSync(path, later, later)
    await docs.scan()
    expect(docs.index.doc(doc.id)!.version).toBe(1)
    expect(docs.index.diskTimes().get(doc.id)).toBe(Math.floor(statSync(path).mtimeMs))
    // The same time again: nothing to read. Proven by bytes that changed under that very time and size.
    writeFileSync(path, 'PRIMEIRO')
    utimesSync(path, later, later)
    await docs.scan()
    expect(docs.index.doc(doc.id)!.version).toBe(1)
    // A newer time, as any real edit brings: read, and a new version.
    const after = new Date(Date.now() + 120_000)
    utimesSync(path, after, after)
    await docs.scan()
    expect(docs.index.doc(doc.id)!.version).toBe(2)
    expect(readFileSync(path, 'utf8')).toBe('PRIMEIRO')
  })

  it('makes a new version of a file edited on disk', async () => {
    const doc = await put(ana, 'Financeiro', 'a.md', 'primeiro')
    writeFileSync(join(docs.root, 'Financeiro', 'a.md'), 'segundo texto, bem maior')
    await docs.scan()
    const now = docs.index.doc(doc.id)!
    expect(now.version).toBe(2)
    expect(now.updatedBy).toBe('outside')
    expect((await docs.text(ana, doc.id)).text).toBe('segundo texto, bem maior')
  })

  it('trashes a document whose file is gone', async () => {
    const doc = await put(ana, 'Financeiro', 'a.md', 'primeiro')
    rmSync(join(docs.root, 'Financeiro', 'a.md'))
    await docs.scan()
    expect(docs.index.doc(doc.id)?.trashedAt).toBeGreaterThan(0)
  }, 10_000)

  it('does not follow a link that points outside the folder', async () => {
    const outside = join(root, 'fora')
    mkdirSync(outside)
    writeFileSync(join(outside, 'segredo.md'), 'segredo do lado de fora')
    symlinkSync(outside, join(docs.root, 'Financeiro', 'atalho'))
    symlinkSync(join(outside, 'segredo.md'), join(docs.root, 'Financeiro', 'ln.md'))
    symlinkSync(outside, join(docs.root, 'Ligado'))
    await docs.scan()
    expect(docs.search(ana, 'segredo')).toEqual([])
    expect(docs.index.docs()).toHaveLength(0)
    expect(docs.index.folders().some((f) => f.name === 'Ligado' || f.name === 'atalho')).toBe(false)
  })

  it('keeps a file that came from outside, in a folder that asks for approval, waiting', async () => {
    const f = folder('Financeiro')
    docs.saveFolder(ana, { id: f.id, parentId: null, name: f.name, rule: f.rule, needsApproval: true })
    writeFileSync(join(docs.root, 'Financeiro', 'solto.md'), 'chegou de fora')
    await docs.scan()
    expect(docs.index.docs().find((d) => d.name === 'solto.md')).toMatchObject({ status: 'review', officialVersion: null })
  })
})

describe('when something is wrong with the files or the index', () => {
  it('reads an index made before the newer columns existed, and saves in it', async () => {
    docs.close()
    rmSync(join(root, 'docs.db'), { force: true })
    rmSync(docs.root, { recursive: true, force: true })
    mkdirSync(join(docs.root, 'Antiga'), { recursive: true })
    writeFileSync(join(docs.root, 'Antiga', 'velho.md'), 'texto velho')
    const old = new DatabaseSync(join(root, 'docs.db'))
    old.exec(`
      CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, rule TEXT NOT NULL DEFAULT '', access TEXT, private_to TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE docs (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL, hash TEXT NOT NULL, version INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER);
    `)
    old.prepare('INSERT INTO folders (id, parent_id, name, rule, access, private_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('f-old', null, 'Antiga', 'de antes', null, null, 'person:ana', 1)
    old.prepare('INSERT INTO docs (id, folder_id, name, kind, summary, size, hash, version, origin, created_by, created_at, updated_by, updated_at, trashed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('d-old', 'f-old', 'velho.md', 'markdown', 'texto velho', 11, 'x', 1, '{}', 'person:ana', 1, 'person:ana', Date.now() + 600_000, null)
    old.close()

    const index = new DocsIndex(join(root, 'docs.db'))
    expect(index.folders().find((f) => f.id === 'f-old')).toMatchObject({ needsApproval: false, access: null, privateTo: null })
    expect(index.doc('d-old')).toMatchObject({ status: null, officialVersion: null, statusBy: null, statusAt: null, statusNote: '', routineId: null, catalogedAt: null, filing: null, trashedAt: null })
    index.putDoc({ ...index.doc('d-old')!, status: 'review', officialVersion: null })
    expect(index.doc('d-old')?.status).toBe('review')
    index.close()

    docs = await open()
    const next = await docs.newVersion(ana, 'd-old', { data: Buffer.from('texto novo e maior') })
    expect(next.version).toBe(2)
    expect((await docs.text(ana, 'd-old', 1)).text).toBe('texto velho')
    expect(docs.tree(ana).folders.some((f) => f.id === 'f-old')).toBe(true)
  })

  it('opens with an index that cannot be opened: no crash, plain words for people, nothing for agents', async () => {
    docs.close()
    rmSync(join(root, 'docs.db'), { force: true })
    mkdirSync(join(root, 'docs.db')) // a folder where the file should be
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = new Docs(deps())
    expect(() => broken.init()).not.toThrow()
    log.mockRestore()
    await broken.loaded
    expect(broken.ready).toBe(false)
    expect(broken.failure).toBeTruthy()
    expect(broken.foldersFor(agents[1]!, null, 'read')).toEqual([])
    expect(broken.waitingFor(ana)).toEqual([])
    expect(broken.datesFor(ana)).toEqual([])
    expect(broken.docByArtifact(ana)).toEqual({})
    expect(broken.fileOf(ana, 'x')).toBeNull()
    expect(() => broken.tree(ana)).toThrow(/\S/)
    const message = await failure(() => broken.add(ana, { folderId: 'x', name: 'a.md', data: Buffer.from('x') }))
    expect(message).not.toBe('did not fail')
    expect(message).not.toContain(root)
    await expect(broken.scan()).resolves.toBeUndefined()
    docs = broken // afterEach closes it
  })

  it('refuses to read a Word file whose zip says it is huge inside, and still keeps it in the folder', async () => {
    const bomb = Buffer.alloc(46 + 22)
    bomb.writeUInt32LE(0x02014b50, 0) // one central directory entry…
    bomb.writeUInt32LE(300 * 1024 * 1024, 24) // …declaring 300 MB once opened (the limit is 200 MB)
    bomb.writeUInt32LE(0x06054b50, 46) // end of central directory
    bomb.writeUInt16LE(1, 46 + 10)
    bomb.writeUInt32LE(0, 46 + 16)
    expect(() => checkZip(bomb)).toThrow()
    await expect(extractFile('bomba.docx', bomb)).rejects.toThrow()
    const doc = await docs.add(ana, { folderId: folder('Financeiro').id, name: 'bomba.docx', data: bomb })
    expect(doc.kind).toBe('docx')
    await expect(docs.text(ana, doc.id)).rejects.toThrow()
  })

  it('refuses a zip with too many entries or a size it cannot count, and takes a small one', () => {
    const many = Buffer.alloc(22)
    many.writeUInt32LE(0x06054b50, 0)
    many.writeUInt16LE(6000, 10)
    expect(() => checkZip(many)).toThrow()
    const big = Buffer.alloc(46 + 22)
    big.writeUInt32LE(0x02014b50, 0)
    big.writeUInt32LE(0xffffffff, 24)
    big.writeUInt32LE(0x06054b50, 46)
    big.writeUInt16LE(1, 46 + 10)
    expect(() => checkZip(big)).toThrow()
    big.writeUInt32LE(1024, 24)
    expect(() => checkZip(big)).not.toThrow()
  })
})
