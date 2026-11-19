// What Documentos does to files and rows, with no question of who asks (docs.ts checks that before
// calling any of this). The folder on disk is the truth: a document's current file is
// <dir>/<its folders' names>/<name>, the versions it replaced are <dir>/.versions/<id>/<n>-<name>, a
// trashed one is <dir>/.trash/<id>/<name>, and a personal folder lives in <dir>/.private/<person>.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { acceptsDoc, docKind, folderPath, MAX_DOC_BYTES, type Doc, type DocAction, type DocFolder, type DocKind, type DocOrigin, type FolderAccess } from '../shared/docs'
import { UserError } from '../shared/errors'
import { L } from '../shared/lang'
import type { Agent, Artifact, Person } from '../shared/types'
import { DocsIndex } from './docs-db'
import { cleanFileName, cleanName, safeJoin, sameName, uniqueName } from './docs-fs'
import { extractFile, MAX_TEXT } from './wiki-extract'

export interface DocsDeps {
  dir: string // <dataDir>/documents
  indexPath: string // <dataDir>/docs.db
  artifactsDir: string // <dataDir>/artifacts
  agents: () => Agent[]
  people: () => Person[]
  artifact: (id: string) => Artifact | undefined
  canSeeArtifact: (person: Person, artifact: Artifact) => boolean // the conversation it was shown in, as the person reads it
  emit: () => void
}

export const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const stripHtml = (h: string): string => h.slice(0, 2_000_000).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
// The first words of a text, on one line, as a document's summary when no one wrote one.
export const summaryOf = (text: string): string => text.replace(/^#+\s*/gm, '').replace(/[|*_`>]+/g, ' ').replace(/(^|\s)-{3,}(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
const safeSegment = (id: string): string => id.replace(/[^\w-]/g, '_')

export const unsupported = (): UserError => new UserError(L('Esse tipo de arquivo não cabe em Documentos. Use PDF, Word, planilha, texto, página web ou imagem.', "That kind of file doesn't fit in Documents. Use a PDF, Word, spreadsheet, text, web page or picture."))

export class DocsCore {
  index!: DocsIndex
  readonly root: string

  constructor(readonly deps: DocsDeps) {
    this.root = resolve(deps.dir)
  }

  // ---------- where things are on disk ----------
  segments(folders: DocFolder[], id: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (let f = folders.find((x) => x.id === id); f && !seen.has(f.id); f = f.parentId ? folders.find((x) => x.id === f!.parentId) : undefined) {
      seen.add(f.id)
      if (f.privateTo && !f.parentId) {
        out.unshift('.private', safeSegment(f.privateTo))
        break
      }
      out.unshift(f.name)
    }
    return out
  }
  folderDir(folders: DocFolder[], id: string): string {
    const parts = this.segments(folders, id)
    if (!parts.length) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    return safeJoin(this.root, ...parts)
  }
  docPath(folders: DocFolder[], d: Doc): string {
    return safeJoin(this.folderDir(folders, d.folderId), d.name)
  }
  trashPath = (d: Doc): string => safeJoin(this.root, '.trash', d.id, d.name)
  private versionDir = (docId: string): string => safeJoin(this.root, '.versions', docId)
  private versionPath = (d: Doc, n: number): string => safeJoin(this.versionDir(d.id), `${n}-${d.name}`)
  private versionFile(docId: string, n: number): string | null {
    try {
      const f = readdirSync(this.versionDir(docId)).find((x) => x.startsWith(`${n}-`))
      return f ? safeJoin(this.versionDir(docId), f) : null
    } catch {
      return null
    }
  }
  // The file of a document (`version`: an older one), when it is there.
  filePath(d: Doc, version?: number): string | null {
    try {
      const p = version && version !== d.version ? this.versionFile(d.id, version) : d.trashedAt ? this.trashPath(d) : this.docPath(this.index.folders(), d)
      return p && existsSync(p) && statSync(p).isFile() ? p : null
    } catch {
      return null
    }
  }
  pathOf(folders: DocFolder[], d: Pick<Doc, 'folderId' | 'name'>): string {
    return [...folderPath(folders, d.folderId), d.name].join('/')
  }

  // ---------- text ----------
  // What a file says, as text (throws as extractFile does: a scanned PDF has none).
  async textOf(name: string, kind: DocKind, data: Buffer): Promise<string> {
    if (kind === 'image') return ''
    if (kind === 'html') return stripHtml(data.toString('utf8'))
    return extractFile(name, data)
  }
  async indexable(name: string, kind: DocKind, data: Buffer): Promise<string> {
    try {
      return await this.textOf(name, kind, data)
    } catch {
      return '' // a scanned PDF still belongs in the folder; it is found by its name
    }
  }
  reindex(d: Doc, text: string): void {
    this.index.indexText(d.id, d.name, `${d.summary}\n${text}`)
  }

  // ---------- folders ----------
  createFolder(p: { parentId: string | null; name: string; rule?: string; access: FolderAccess | null; privateTo?: string | null; by: string }): DocFolder {
    const folders = this.index.folders()
    const parent = p.parentId ? folders.find((f) => f.id === p.parentId) : undefined
    if (p.parentId && !parent) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    const base = cleanName(p.name)
    if (!base) throw new UserError(L('Dê um nome à pasta.', 'Give the folder a name.'))
    const parentDir = parent ? this.folderDir(folders, parent.id) : this.root
    const personal = !!p.privateTo && !p.parentId // lives by the person's id: its name is only a label
    const name = personal ? base : uniqueName(base, (n) => folders.some((f) => f.parentId === p.parentId && !f.privateTo && sameName(f.name) === sameName(n)) || existsSync(join(parentDir, n)))
    const folder: DocFolder = { id: randomUUID(), parentId: p.parentId, name, rule: (p.rule ?? '').trim(), access: p.access, privateTo: p.privateTo ?? null, createdBy: p.by, createdAt: Date.now() }
    mkdirSync(this.folderDir([...folders, folder], folder.id), { recursive: true, mode: 0o700 })
    this.index.putFolder(folder)
    return folder
  }

  // Renames and/or moves a folder (its directory goes with it, and everything under it).
  changeFolder(id: string, p: { name?: string; parentId?: string | null }): DocFolder {
    const folders = this.index.folders()
    const f = folders.find((x) => x.id === id)
    if (!f) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    const parentId = p.parentId === undefined ? f.parentId : p.parentId
    for (let up = parentId; up; up = folders.find((x) => x.id === up)?.parentId ?? null) if (up === id) throw new UserError(L('Uma pasta não vai pra dentro dela mesma.', "A folder can't go inside itself."))
    const base = p.name === undefined ? f.name : cleanName(p.name)
    if (!base) throw new UserError(L('Dê um nome à pasta.', 'Give the folder a name.'))
    const before = this.folderDir(folders, id)
    const parentDir = parentId ? this.folderDir(folders, parentId) : this.root
    const unchanged = parentId === f.parentId && sameName(base) === sameName(f.name)
    const name = f.privateTo && !f.parentId ? base : unchanged ? base : uniqueName(base, (n) => folders.some((x) => x.id !== id && x.parentId === parentId && !x.privateTo && sameName(x.name) === sameName(n)) || existsSync(join(parentDir, n)))
    const next: DocFolder = { ...f, name, parentId }
    const after = this.folderDir(folders.map((x) => (x.id === id ? next : x)), id)
    if (after !== before) {
      mkdirSync(dirname(after), { recursive: true, mode: 0o700 })
      if (existsSync(before)) renameSync(before, after)
      else mkdirSync(after, { recursive: true, mode: 0o700 })
    }
    this.index.putFolder(next)
    return next
  }

  // The folder's rule and access, apart from where it is.
  setFolderInfo(id: string, p: { rule?: string; access?: FolderAccess | null }): DocFolder {
    const f = this.index.folders().find((x) => x.id === id)
    if (!f) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    const next: DocFolder = { ...f, ...(p.rule !== undefined ? { rule: p.rule.trim() } : {}), ...(p.access !== undefined ? { access: p.access } : {}) }
    this.index.putFolder(next)
    return next
  }

  // A folder with nothing in it: its trashed documents go for good (moving them up would widen who sees them);
  // its directory goes if empty.
  dropFolder(id: string): void {
    const folders = this.index.folders()
    const f = folders.find((x) => x.id === id)
    if (!f) return
    for (const d of this.index.docs()) if (d.folderId === id && d.trashedAt) this.purgeDoc(d)
    try {
      rmdirSync(this.folderDir(folders, id)) // only if empty: a file Tucano doesn't know is never deleted here
    } catch {}
    this.index.dropFolder(id)
  }

  // ---------- documents ----------
  private nameTaken(folders: DocFolder[], folderId: string, self?: Doc): (n: string) => boolean {
    const dir = this.folderDir(folders, folderId)
    const docs = this.index.docs().filter((d) => d.folderId === folderId && !d.trashedAt && d.id !== self?.id)
    const mine = self && self.folderId === folderId && !self.trashedAt ? sameName(self.name) : ''
    return (n) => docs.some((d) => sameName(d.name) === sameName(n)) || (sameName(n) !== mine && existsSync(join(dir, n)))
  }

  private checkFile(name: string, data: Buffer): { name: string; kind: DocKind } {
    const clean = cleanFileName(name)
    const kind = clean ? docKind(clean) : null
    if (!kind || !acceptsDoc(clean)) throw unsupported()
    if (data.length > MAX_DOC_BYTES) throw new UserError(L(`O arquivo passa de ${MAX_DOC_BYTES / 1024 / 1024} MB.`, `The file is over ${MAX_DOC_BYTES / 1024 / 1024} MB.`))
    return { name: clean, kind }
  }

  async create(p: { folderId: string; name: string; data: Buffer; summary?: string; origin?: DocOrigin; by: string; note?: string; action?: Extract<DocAction, 'created' | 'saved-from-chat'> }): Promise<Doc> {
    const file = this.checkFile(p.name, p.data)
    const folders = this.index.folders()
    if (!folders.some((f) => f.id === p.folderId)) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    const text = await this.indexable(file.name, file.kind, p.data)
    const name = uniqueName(file.name, this.nameTaken(folders, p.folderId))
    const path = safeJoin(this.folderDir(folders, p.folderId), name)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, p.data, { mode: 0o600 })
    return this.record({ folderId: p.folderId, name, kind: file.kind, data: p.data, text, summary: p.summary, origin: p.origin ?? {}, by: p.by, note: p.note ?? '', action: p.action ?? 'created' })
  }

  // A file already in place (found by the scan, or just written): indexed as version 1.
  record(p: { folderId: string; name: string; kind: DocKind; data: Buffer; text: string; summary?: string; origin?: DocOrigin; by: string; note?: string; action: DocAction; at?: number }): Doc {
    const at = p.at ?? Date.now()
    const doc: Doc = { id: randomUUID(), folderId: p.folderId, name: p.name, kind: p.kind, summary: (p.summary?.trim() || summaryOf(p.text)).slice(0, 500), size: p.data.length, hash: sha(p.data), version: 1, origin: p.origin ?? {}, createdBy: p.by, createdAt: at, updatedBy: p.by, updatedAt: at, trashedAt: null }
    this.index.putDoc(doc)
    this.index.addVersion({ docId: doc.id, n: 1, at, by: p.by, note: p.note ?? '', size: doc.size, hash: doc.hash })
    this.index.addEvent({ docId: doc.id, at, by: p.by, action: p.action, detail: p.note ?? '' })
    this.reindex(doc, p.text)
    return doc
  }

  // New content for a document: the current file is kept as the version it was, then replaced.
  async revise(stale: Doc, p: { data: Buffer; by: string; note?: string; name?: string; summary?: string; action?: Extract<DocAction, 'version' | 'reverted'>; detail?: string }): Promise<Doc> {
    const file = this.checkFile(p.name && cleanFileName(p.name) ? p.name : stale.name, p.data)
    const renamedBefore = !!p.name && sameName(file.name) !== sameName(stale.name)
    if (!renamedBefore && sha(p.data) === stale.hash) return stale
    const text = await this.indexable(file.name, file.kind, p.data)
    // Read again after the await: a save that came meanwhile has moved the version on (nothing runs between this read and the write).
    const d = this.index.doc(stale.id)
    if (!d || d.trashedAt) throw new UserError(L('Esse documento não existe, ou você não tem acesso a ele.', "That document doesn't exist, or you don't have access to it."))
    const folders = this.index.folders()
    const renamed = !!p.name && sameName(file.name) !== sameName(d.name)
    const name = renamed ? uniqueName(file.name, this.nameTaken(folders, d.folderId, d)) : d.name
    const current = this.docPath(folders, d)
    if (existsSync(current)) {
      mkdirSync(this.versionDir(d.id), { recursive: true, mode: 0o700 })
      copyFileSync(current, this.versionPath(d, d.version))
    }
    const path = safeJoin(this.folderDir(folders, d.folderId), name)
    writeFileSync(path, p.data, { mode: 0o600 })
    if (renamed && path !== current) rmSync(current, { force: true })
    const at = Date.now()
    const next: Doc = { ...d, name, kind: file.kind, size: p.data.length, hash: sha(p.data), version: d.version + 1, summary: (p.summary?.trim() || (d.summary ? d.summary : summaryOf(text))).slice(0, 500), updatedBy: p.by, updatedAt: at }
    this.index.putDoc(next)
    this.index.addVersion({ docId: d.id, n: next.version, at, by: p.by, note: p.note ?? '', size: next.size, hash: next.hash })
    this.index.addEvent({ docId: d.id, at, by: p.by, action: p.action ?? 'version', detail: p.detail ?? p.note ?? '' })
    this.reindex(next, text)
    return next
  }

  // Moves a document to another folder and/or gives it another name. The event's detail: the new folder's path (moved) or the old name (renamed).
  // The kind never changes: the name keeps the document's own extension (a typed one that differs is kept, with it added: "relatorio.html.pdf").
  moveDoc(d: Doc, folderId: string, name: string | undefined, by: string): Doc {
    const folders = this.index.folders()
    if (!folders.some((f) => f.id === folderId)) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    const original = extname(d.name)
    let clean = cleanFileName(name ?? d.name)
    if (!clean) throw unsupported()
    if (extname(clean).toLowerCase() !== original.toLowerCase()) clean = `${clean}${original}`
    const wanted = sameName(clean) === sameName(d.name) && folderId === d.folderId ? d.name : uniqueName(clean, this.nameTaken(folders, folderId, d))
    const from = this.docPath(folders, d)
    const next: Doc = { ...d, folderId, name: wanted, updatedBy: by, updatedAt: Date.now() }
    const to = this.docPath(folders, next)
    if (from !== to) {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
      renameSync(from, to)
    }
    this.index.putDoc(next)
    const moved = folderId !== d.folderId
    this.index.addEvent({ docId: d.id, at: next.updatedAt, by, action: moved ? 'moved' : 'renamed', detail: moved ? folderPath(folders, folderId).join(' › ') : d.name })
    this.index.retitle(d.id, next.name)
    return next
  }

  trashDoc(d: Doc, by: string): Doc {
    const from = this.docPath(this.index.folders(), d)
    const to = this.trashPath(d)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    if (existsSync(from)) renameSync(from, to)
    const next: Doc = { ...d, trashedAt: Date.now(), updatedBy: by, updatedAt: Date.now() }
    this.index.putDoc(next)
    this.index.addEvent({ docId: d.id, at: next.updatedAt, by, action: 'trashed', detail: '' })
    return next
  }

  restoreDoc(d: Doc, by: string): Doc {
    const folders = this.index.folders()
    if (!folders.some((f) => f.id === d.folderId)) throw new UserError(L('A pasta dele não existe mais.', 'Its folder no longer exists.'))
    const from = this.trashPath(d)
    if (!existsSync(from)) throw new UserError(L('O arquivo não está mais no disco.', 'The file is no longer on the disk.'))
    const name = uniqueName(d.name, this.nameTaken(folders, d.folderId, { ...d, trashedAt: Date.now() }))
    const next: Doc = { ...d, name, trashedAt: null, updatedBy: by, updatedAt: Date.now() }
    const to = this.docPath(folders, next)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    renameSync(from, to)
    rmSync(dirname(from), { recursive: true, force: true })
    this.index.putDoc(next)
    this.index.addEvent({ docId: d.id, at: next.updatedAt, by, action: 'restored', detail: '' })
    return next
  }

  // The bytes of a document (`version`: an older one).
  bytes(d: Doc, version?: number): Buffer {
    const p = this.filePath(d, version)
    if (!p) throw new UserError(L('Não achei o arquivo desse documento.', "I can't find this document's file."))
    return readFileSync(p)
  }

  // A document and its files, gone for good (a removed person's personal folder, or a folder removed with its trash).
  purgeDoc(d: Doc): void {
    try {
      rmSync(this.versionDir(d.id), { recursive: true, force: true })
    } catch {}
    try {
      rmSync(safeJoin(this.root, '.trash', d.id), { recursive: true, force: true })
    } catch {}
    this.index.dropDoc(d.id)
  }
}
