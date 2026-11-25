// What Documentos does to files and rows, with no question of who asks (docs.ts checks that before
// calling any of this). The folder on disk is the truth: a document's current file is
// <dir>/<its folders' names>/<name>, the versions it replaced are <dir>/.versions/<id>/<n>-<name>, a
// trashed one is <dir>/.trash/<id>/<name>, and a personal folder lives in <dir>/.private/<person>.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { approvalNeeded, mayApprove, personMay } from '../shared/doc-access'
import { acceptsDoc, docKind, folderPath, MAX_DOC_BYTES, OUTSIDE, parseActor, type Doc, type DocAction, type DocFolder, type DocKind, type DocLevel, type DocOrigin, type FolderAccess } from '../shared/docs'
import { UserError } from '../shared/errors'
import { L } from '../shared/lang'
import type { Agent, Artifact, Person } from '../shared/types'
import { DocsIndex } from './docs-db'
import { cleanFileName, cleanName, isInside, safeJoin, sameName, uniqueName } from './docs-fs'
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
  onSaved?: (doc: Doc, why: 'created' | 'version' | 'outside') => void // after every new document or new version (the cataloguer listens)
  onReview?: (doc: Doc, folder: DocFolder) => void // a document just began waiting for approval
}

export const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
// A web page's text, read once from start to end. A pattern that looks for the end of each script, style
// or tag goes over the rest of the file again for every opening that has none, and a small file made only
// of openings then holds the whole app: so a block is cut by where it starts and where it ends, and a
// tag never reads past the next "<".
function withoutBlocks(h: string): string {
  const open = /<(script|style)\b/gi
  let out = ''
  let at = 0
  for (let m = open.exec(h); m; m = open.exec(h)) {
    out += `${h.slice(at, m.index)} `
    const close = new RegExp(`</${m[1]}\\s*>`, 'gi')
    close.lastIndex = open.lastIndex
    if (!close.exec(h)) return out // it never ends: the rest is the block's, not the page's
    at = close.lastIndex
    open.lastIndex = at
  }
  return out + h.slice(at)
}
const stripHtml = (h: string): string => withoutBlocks(h.slice(0, 2_000_000)).replace(/<[^<>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
// The first words of a text, on one line, as a document's summary when no one wrote one.
export const summaryOf = (text: string): string => text.replace(/^#+\s*/gm, '').replace(/[|*_`>]+/g, ' ').replace(/(^|\s)-{3,}(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
const safeSegment = (id: string): string => id.replace(/[^\w-]/g, '_')

export const gone = (): UserError => new UserError(L('Esse documento não existe, ou você não tem acesso a ele.', "That document doesn't exist, or you don't have access to it."))
export const noFolder = (): UserError => new UserError(L('Essa pasta não existe, ou você não tem acesso a ela.', "That folder doesn't exist, or you don't have access to it."))
export const readOnly = (): UserError => new UserError(L('Você pode ver, mas não mudar o que está nessa pasta.', "You can see what's in this folder, but not change it."))
export const trashedError = (): UserError => new UserError(L('Esse documento está na lixeira. Restaure antes de mudar.', 'This document is in the trash. Restore it before changing it.'))

// What a save or a move leaves a document's approval in.
export type StatusFields = Pick<Doc, 'status' | 'officialVersion' | 'statusBy' | 'statusAt' | 'statusNote'>
export const NO_STATUS: StatusFields = { status: null, officialVersion: null, statusBy: null, statusAt: null, statusNote: '' }

export const unsupported = (): UserError => new UserError(L('Esse tipo de arquivo não cabe em Documentos. Use PDF, Word, planilha, texto, página web ou imagem.', "That kind of file doesn't fit in Documents. Use a PDF, Word, spreadsheet, text, web page or picture."))

export class DocsCore {
  index!: DocsIndex
  readonly root: string
  ready = true // false when the index could not open: the app runs on, Documentos says so

  // Every public call starts here: when Documentos did not open, the people and the agents are told so, plainly.
  need(): void {
    if (!this.ready) throw new Error(L('Os documentos não abriram neste computador. Reinicie o Tucano; se continuar, avise quem cuida dele.', 'Documents did not open on this computer. Restart Tucano; if it goes on, tell whoever looks after it.'))
  }

  // ---------- lookups with access (a person) ----------
  docFor(person: Person, id: string, need: DocLevel = 'view'): Doc {
    const doc = this.index.doc(id)
    const folders = this.index.folders()
    if (!doc || !personMay(person, folders, doc.folderId, 'view')) throw gone()
    if (need === 'edit' && !personMay(person, folders, doc.folderId, 'edit')) throw readOnly()
    return doc
  }
  folderFor(person: Person, id: string, need: DocLevel): DocFolder {
    const folders = this.index.folders()
    const f = folders.find((x) => x.id === id)
    if (!f || !personMay(person, folders, id, 'view')) throw noFolder()
    if (need === 'edit' && !personMay(person, folders, id, 'edit')) throw readOnly()
    return f
  }
  subtree(folders: DocFolder[], id: string): Set<string> {
    const out = new Set([id])
    for (let grew = true; grew; ) {
      grew = false
      for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) out.add(f.id), (grew = true)
    }
    return out
  }
  personalRoot = (folders: DocFolder[], personId: string): DocFolder | undefined => folders.find((f) => f.privateTo === personId && !f.parentId)

  // ---------- approval ----------
  // The person an actor is, when it is one still here.
  personOf(by: string): Person | undefined {
    const a = parseActor(by)
    return a.kind === 'person' ? this.deps.people().find((x) => x.id === a.id) : undefined
  }
  // Where a document stands after being saved (a new one, or a new version) in `folderId` by `by`: in a folder that asks for approval,
  // an approver's own save is official and anyone else's (an agent, the scan) waits; elsewhere there is no status, or a draft when
  // the agent says so. `prev`: the document before, whose official version stays while a new one waits.
  statusOnSave(folders: DocFolder[], folderId: string, by: string, version: number, o: { draft?: boolean; prev?: Doc } = {}): StatusFields {
    const at = Date.now()
    if (approvalNeeded(folders, folderId)) {
      const person = this.personOf(by)
      if (person && mayApprove(person, folders, folderId)) return { status: 'official', officialVersion: version, statusBy: by, statusAt: at, statusNote: '' }
      // A document from before approval was switched on has no status: an agent's or the scan's new version leaves its version as the official one.
      const fromAgent = parseActor(by).kind !== 'person'
      const official = o.prev?.officialVersion ?? (fromAgent && o.prev?.status === null ? o.prev.version : null)
      return { status: 'review', officialVersion: official, statusBy: by, statusAt: at, statusNote: '' }
    }
    return o.draft ? { status: 'draft', officialVersion: null, statusBy: by, statusAt: at, statusNote: '' } : NO_STATUS
  }
  // Where a document stands after being moved to `folderId` by `by`.
  statusOnMove(folders: DocFolder[], d: Doc, folderId: string, by: string): StatusFields {
    const keep: StatusFields = { status: d.status, officialVersion: d.officialVersion, statusBy: d.statusBy, statusAt: d.statusAt, statusNote: d.statusNote }
    if (folderId === d.folderId) return keep
    if (approvalNeeded(folders, folderId)) {
      if (d.status) return keep
      const person = this.personOf(by)
      const ok = !!person && mayApprove(person, folders, folderId)
      return { status: ok ? 'official' : 'review', officialVersion: ok ? d.version : d.officialVersion, statusBy: by, statusAt: Date.now(), statusNote: '' }
    }
    // Out of an approval folder: nothing waits any more (a draft is still a draft).
    return d.status === 'review' || d.status === 'official' ? NO_STATUS : keep
  }
  // Tells the cataloguer and the approvers about a document just saved (never lets their trouble reach the save).
  saved(doc: Doc, why: 'created' | 'version' | 'outside', waiting: boolean): void {
    try {
      this.deps.onSaved?.(doc, why)
    } catch (e) {
      console.warn('[docs] onSaved', e)
    }
    if (waiting) this.askReview(doc)
  }
  askReview(doc: Doc): void {
    try {
      const folder = this.index.folders().find((f) => f.id === doc.folderId)
      if (folder) this.deps.onReview?.(doc, folder)
    } catch (e) {
      console.warn('[docs] onReview', e)
    }
  }

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
  // Where a file is about to be written or moved to: its folder made, and inside the documents folder by
  // the folders as they are on the disk, with no link standing where the file goes. safeJoin compares
  // names; a link in a folder's place passes it and leads the write out.
  private place(path: string): string {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!isInside(realpathSync(this.root), realpathSync(dir)) || lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new UserError(L('Esse caminho não vale.', 'That path is not valid.'))
    return path
  }
  // The file of a document (`version`: an older one), when it is there: a file of its own, inside the
  // documents folder. A link put in its place, or in the place of a folder above it, is not one,
  // wherever it leads: what is read and served from here is only what was kept here.
  filePath(d: Doc, version?: number): string | null {
    try {
      const p = version && version !== d.version ? this.versionFile(d.id, version) : d.trashedAt ? this.trashPath(d) : this.docPath(this.index.folders(), d)
      if (!p || !existsSync(p) || !lstatSync(p).isFile()) return null
      return isInside(realpathSync(this.root), realpathSync(p)) ? p : null
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
  createFolder(p: { parentId: string | null; name: string; rule?: string; access: FolderAccess | null; privateTo?: string | null; needsApproval?: boolean; by: string }): DocFolder {
    const folders = this.index.folders()
    const parent = p.parentId ? folders.find((f) => f.id === p.parentId) : undefined
    if (p.parentId && !parent) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    const base = cleanName(p.name)
    if (!base) throw new UserError(L('Dê um nome à pasta.', 'Give the folder a name.'))
    const parentDir = parent ? this.folderDir(folders, parent.id) : this.root
    const personal = !!p.privateTo && !p.parentId // lives by the person's id: its name is only a label
    const name = personal ? base : uniqueName(base, (n) => folders.some((f) => f.parentId === p.parentId && !f.privateTo && sameName(f.name) === sameName(n)) || existsSync(join(parentDir, n)))
    const folder: DocFolder = { id: randomUUID(), parentId: p.parentId, name, rule: (p.rule ?? '').trim(), access: p.access, privateTo: p.privateTo ?? null, needsApproval: !!p.needsApproval && !p.privateTo, createdBy: p.by, createdAt: Date.now() }
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
  setFolderInfo(id: string, p: { rule?: string; access?: FolderAccess | null; needsApproval?: boolean }): DocFolder {
    const f = this.index.folders().find((x) => x.id === id)
    if (!f) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    const next: DocFolder = { ...f, ...(p.rule !== undefined ? { rule: p.rule.trim() } : {}), ...(p.access !== undefined ? { access: p.access } : {}), ...(p.needsApproval !== undefined ? { needsApproval: p.needsApproval } : {}) }
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

  async create(p: { folderId: string; name: string; data: Buffer; summary?: string; origin?: DocOrigin; by: string; note?: string; draft?: boolean; filing?: Doc['filing']; action?: Extract<DocAction, 'created' | 'saved-from-chat'> }): Promise<Doc> {
    const file = this.checkFile(p.name, p.data)
    const folders = this.index.folders()
    if (!folders.some((f) => f.id === p.folderId)) throw new UserError(L('Essa pasta não existe mais.', 'That folder no longer exists.'))
    const text = await this.indexable(file.name, file.kind, p.data)
    const name = uniqueName(file.name, this.nameTaken(folders, p.folderId))
    const path = this.place(safeJoin(this.folderDir(folders, p.folderId), name))
    writeFileSync(path, p.data, { mode: 0o600 })
    return this.record({ folderId: p.folderId, name, kind: file.kind, data: p.data, text, summary: p.summary, origin: p.origin ?? {}, by: p.by, note: p.note ?? '', action: p.action ?? 'created', ...(p.draft ? { draft: true } : {}), ...(p.filing ? { filing: p.filing } : {}) })
  }

  // A file already in place (found by the scan, or just written): indexed as version 1.
  record(p: { folderId: string; name: string; kind: DocKind; data: Buffer; text: string; summary?: string; origin?: DocOrigin; by: string; note?: string; action: DocAction; at?: number; draft?: boolean; filing?: Doc['filing'] }): Doc {
    const at = p.at ?? Date.now()
    const auto = !p.summary?.trim()
    const origin = p.origin ?? {}
    const doc: Doc = { id: randomUUID(), folderId: p.folderId, name: p.name, kind: p.kind, summary: (p.summary?.trim() || summaryOf(p.text)).slice(0, 500), size: p.data.length, hash: sha(p.data), version: 1, origin, createdBy: p.by, createdAt: at, updatedBy: p.by, updatedAt: at, trashedAt: null, ...this.statusOnSave(this.index.folders(), p.folderId, p.by, 1, { ...(p.draft ? { draft: true } : {}) }), routineId: origin.routineId ?? null, catalogedAt: null, filing: p.filing ?? null }
    this.index.putDoc(doc)
    this.index.setSummaryAuto(doc.id, auto)
    this.index.addVersion({ docId: doc.id, n: 1, at, by: p.by, note: p.note ?? '', size: doc.size, hash: doc.hash })
    this.index.addEvent({ docId: doc.id, at, by: p.by, action: p.action, detail: p.note ?? '' })
    this.reindex(doc, p.text)
    this.saved(doc, p.by === OUTSIDE ? 'outside' : 'created', doc.status === 'review')
    return doc
  }

  // New content for a document: the current file is kept as the version it was, then replaced.
  async revise(stale: Doc, p: { data: Buffer; by: string; note?: string; name?: string; summary?: string; draft?: boolean; routineId?: string | null; action?: Extract<DocAction, 'version' | 'reverted'>; detail?: string }): Promise<Doc> {
    const file = this.checkFile(p.name && cleanFileName(p.name) ? p.name : stale.name, p.data)
    const renamedBefore = !!p.name && sameName(file.name) !== sameName(stale.name)
    if (!renamedBefore && sha(p.data) === stale.hash) return stale
    const text = await this.indexable(file.name, file.kind, p.data)
    // Read again after the await: a save that came meanwhile has moved the version on (nothing runs between this read and the write).
    const d = this.index.doc(stale.id)
    if (!d || d.trashedAt) throw new UserError(L('Esse documento não existe, ou você não tem acesso a ele.', "That document doesn't exist, or you don't have access to it."))
    // The bytes changed (the check above only saw `stale`): the new version is catalogued again, so its dates are found.
    const bytesChanged = sha(p.data) !== d.hash
    const folders = this.index.folders()
    const renamed = !!p.name && sameName(file.name) !== sameName(d.name)
    const name = renamed ? uniqueName(file.name, this.nameTaken(folders, d.folderId, d)) : d.name
    const current = this.docPath(folders, d)
    // The version kept is the document's own file: not what a link in its place leads to.
    if (this.filePath(d)) copyFileSync(current, this.place(this.versionPath(d, d.version)))
    const path = this.place(safeJoin(this.folderDir(folders, d.folderId), name))
    writeFileSync(path, p.data, { mode: 0o600 })
    if (renamed && path !== current) rmSync(current, { force: true })
    const at = Date.now()
    const keepSummary = !p.summary?.trim() && !!d.summary
    const next: Doc = { ...d, name, kind: file.kind, size: p.data.length, hash: sha(p.data), version: d.version + 1, summary: (p.summary?.trim() || (d.summary ? d.summary : summaryOf(text))).slice(0, 500), updatedBy: p.by, updatedAt: at, ...this.statusOnSave(folders, d.folderId, p.by, d.version + 1, { prev: d, ...(p.draft ? { draft: true } : {}) }), routineId: p.routineId ?? null, catalogedAt: bytesChanged ? null : d.catalogedAt }
    this.index.putDoc(next)
    if (!keepSummary) this.index.setSummaryAuto(d.id, !p.summary?.trim())
    this.index.addVersion({ docId: d.id, n: next.version, at, by: p.by, note: p.note ?? '', size: next.size, hash: next.hash })
    this.index.addEvent({ docId: d.id, at, by: p.by, action: p.action ?? 'version', detail: p.detail ?? p.note ?? '' })
    this.reindex(next, text)
    this.saved(next, p.by === OUTSIDE ? 'outside' : 'version', next.status === 'review')
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
    const next: Doc = { ...d, folderId, name: wanted, updatedBy: by, updatedAt: Date.now(), ...this.statusOnMove(folders, d, folderId, by) }
    const to = this.docPath(folders, next)
    if (from !== to) renameSync(from, this.place(to))
    this.index.putDoc(next)
    const moved = folderId !== d.folderId
    this.index.addEvent({ docId: d.id, at: next.updatedAt, by, action: moved ? 'moved' : 'renamed', detail: moved ? folderPath(folders, folderId).join(' › ') : d.name })
    this.index.retitle(d.id, next.name)
    if (next.status === 'review' && d.status !== 'review') this.askReview(next)
    return next
  }

  trashDoc(d: Doc, by: string): Doc {
    const from = this.docPath(this.index.folders(), d)
    const to = this.place(this.trashPath(d))
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
    const to = this.place(this.docPath(folders, next))
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
