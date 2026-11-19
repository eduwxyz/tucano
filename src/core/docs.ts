// Documentos: the team's files in folders that say who sees them. The folder on disk is the truth, and
// docs.db (docs-db.ts) keeps what comes from it: the search, each document's versions and history.
// Two ways in, each checking access itself before it does anything (docs-core.ts does the work):
//  - a person (the pages): what the folder's access says for them, see shared/doc-access.ts;
//  - an agent (its tools): what the agent may AND the person it works for may, agentMayFor.
// Where a person or an agent is refused, the error says so in plain words; to a person who may not
// see a document it says it does not exist, as it would for one that doesn't.
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { agentFolderIds, cleanFolderAccess, personMay, visibleFolderIds, type Requester } from '../shared/doc-access'
import { actorOfAgent, actorOfPerson, docKind, folderPathWithin, type Doc, type DocEvent, type DocFolder, type DocHit, type DocKind, type DocLevel, type DocOrigin, type DocsTree, type DocVersion, type FolderAccess } from '../shared/docs'
import { UserError } from '../shared/errors'
import { L } from '../shared/lang'
import type { Agent, Person } from '../shared/types'
import { gone, noFolder, trashedError as trashed, unsupported } from './docs-core'
import { DocsIndex } from './docs-db'
import { DocsFiling } from './docs-filing'
import { looseName, safeJoin } from './docs-fs'
import { ensureRoots, scanDocs } from './docs-scan'
import { ftsQuery } from './wiki'

const isAdmin = (p: Pick<Person, 'role'>): boolean => p.role === 'owner' || p.role === 'admin'
const onlyAdmin = (): UserError => new UserError(L('Só o dono ou um admin faz isso.', 'Only the owner or an admin can do that.'))

// A folder as agents see it: with its path ("Financeiro/Relatórios").
export type AgentFolder = DocFolder & { path: string }
// A document as agents see it: with its path ("Financeiro/Relatórios/maio.pdf").
export type AgentDoc = Doc & { path: string }

export class Docs extends DocsFiling {
  loaded: Promise<void> = Promise.resolve() // the first scan of the folder
  failure: unknown = null // why it did not open
  private scanning = false
  private lastScan = 0

  // Opens the index and makes the first folders; the folder is read behind (`loaded`), never blocking the start.
  init(): void {
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      this.index = new DocsIndex(this.deps.indexPath)
      try {
        ensureRoots(this)
      } catch {}
      this.loaded = this.scan()
    } catch (e) {
      console.error('[docs] could not open', e)
      this.ready = false
      this.failure = e
    }
  }

  // Picks up what changed in the folder outside Tucano. Never throws; emits when something changed.
  async scan(): Promise<void> {
    if (!this.ready || this.scanning) return
    this.scanning = true
    try {
      if (await scanDocs(this)) this.deps.emit()
    } catch {} finally {
      this.scanning = false
      this.lastScan = Date.now()
    }
  }

  close(): void {
    try {
      this.index.close()
    } catch {}
  }

  // An error's text for a person: no disk paths in it, and a raw file-system error in plain words.
  cleanError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e)
    if (/\b(ENOENT|EACCES|EPERM|EEXIST|ENOTDIR|EISDIR|EBUSY)\b/.test(msg)) return L('Não consegui mexer neste arquivo agora. Tente de novo.', "I couldn't work with this file right now. Try again.")
    let out = msg
    for (const p of [this.root, dirname(this.root)]) if (p && p !== '/') out = out.split(p).join('')
    return out
  }

  // ---------- people ----------
  // What this person sees. Makes their personal folder the first time (and the folders of new sectors).
  tree(person: Person): DocsTree {
    this.need()
    let folders = this.index.folders()
    let made = false
    try {
      made = ensureRoots(this)
    } catch {}
    if (!this.personalRoot(this.index.folders(), person.id)) {
      this.createFolder({ parentId: null, name: L('Só meus', 'Only mine'), rule: L('Seus arquivos pessoais. Só você vê.', 'Your personal files. Only you can see them.'), access: null, privateTo: person.id, by: actorOfPerson(person.id) })
      made = true
    }
    if (made) {
      folders = this.index.folders()
      this.deps.emit() // each page reads again: it finds nothing more to make
    }
    if (Date.now() - this.lastScan > 60_000) void this.scan()
    const seen = visibleFolderIds(person, folders)
    // One whose parent this person doesn't see stands at the top for them.
    const mine = folders.filter((f) => seen.has(f.id)).map((f) => (f.parentId && !seen.has(f.parentId) ? { ...f, parentId: null } : f))
    const can: Record<string, DocLevel> = {}
    for (const f of mine) can[f.id] = personMay(person, folders, f.id, 'edit') ? 'edit' : 'view'
    const docs = this.index.docs().filter((d) => seen.has(d.folderId))
    const live = new Set(docs.filter((d) => !d.trashedAt).map((d) => d.id))
    return { folders: mine, docs, dates: this.index.liveDates().filter((d) => live.has(d.docId)), can }
  }

  // Makes a folder (no `id`) or changes one. `access`: left out keeps it; null makes it follow its parent. Only an owner or
  // an admin makes a folder at the top, or changes who sees one; a personal folder is never shared.
  saveFolder(person: Person, p: { id?: string; parentId: string | null; name: string; rule: string; access?: FolderAccess | null; needsApproval?: boolean }): DocFolder {
    this.need()
    const folders = this.index.folders()
    const clean = (a: FolderAccess): FolderAccess => cleanFolderAccess(a, this.deps.people().map((x) => x.id), this.deps.agents().map((x) => x.id))
    // Changing who sees a folder is an owner's or an admin's, and never for a personal folder (or one in it).
    const sharing = (under: string | null): void => {
      if (!isAdmin(person)) throw onlyAdmin()
      if (under && this.privateOf(folders, under)) throw new UserError(L('Uma pasta pessoal não se compartilha.', 'A personal folder cannot be shared.'))
    }
    if (!p.id) {
      if (p.parentId === null) {
        if (!isAdmin(person)) throw onlyAdmin()
      } else this.folderFor(person, p.parentId, 'edit')
      if (p.access) sharing(p.parentId)
      if (p.needsApproval) sharing(p.parentId)
      const f = this.createFolder({ parentId: p.parentId, name: p.name, rule: p.rule, access: p.access ? clean(p.access) : null, needsApproval: !!p.needsApproval, by: actorOfPerson(person.id) })
      this.deps.emit()
      return f
    }
    const f = this.folderFor(person, p.id, 'edit')
    const personal = !!f.privateTo && !f.parentId
    // A folder shown at the top because its parent is out of sight (see tree) stays where it is.
    const moving = !personal && p.parentId !== f.parentId && !(p.parentId === null && f.parentId && !personMay(person, folders, f.parentId, 'view'))
    // Moving a folder changes who sees everything inside it: as much as changing its access, so an owner or an admin only.
    if (moving) {
      if (!isAdmin(person)) throw onlyAdmin()
      if (p.parentId === null) {
        if (!isAdmin(person)) throw onlyAdmin()
      } else this.folderFor(person, p.parentId, 'edit')
    }
    // Only a real change of who sees the folder needs an admin (a page may send the access back as it was).
    const cleaned = p.access ? clean(p.access) : p.access
    const sameAccess = p.access === undefined || JSON.stringify(cleaned ?? null) === JSON.stringify(f.access ? clean(f.access) : null)
    if (!sameAccess) sharing(p.id)
    // Asking for approval is the owner's or an admin's too, and never for a personal folder.
    const approval = p.needsApproval !== undefined && p.needsApproval !== f.needsApproval ? p.needsApproval : undefined
    if (approval !== undefined) sharing(p.id)
    let next = personal ? f : this.changeFolder(f.id, { name: p.name, ...(moving ? { parentId: p.parentId } : {}) })
    next = this.setFolderInfo(f.id, { rule: p.rule, ...(!sameAccess ? { access: cleaned ?? null } : {}), ...(approval !== undefined ? { needsApproval: approval } : {}) })
    if (approval === false) this.clearApprovalUnder(f.id) // what waited or was approved there is a normal document again
    this.deps.emit()
    return next
  }
  private privateOf = (folders: DocFolder[], id: string): boolean => {
    for (let f = folders.find((x) => x.id === id), n = 0; f && n < 50; f = f.parentId ? folders.find((x) => x.id === f!.parentId) : undefined, n++) if (f.privateTo) return true
    return false
  }

  // Only a folder with nothing in it (no documents out of the trash, no subfolders), by an admin or whoever made it.
  removeFolder(person: Person, id: string): void {
    this.need()
    const folders = this.index.folders()
    const f = this.folderFor(person, id, 'edit')
    if (f.privateTo && !f.parentId) throw new UserError(L('Sua pasta pessoal fica.', 'Your personal folder stays.'))
    if (!isAdmin(person) && f.createdBy !== actorOfPerson(person.id)) throw new UserError(L('Só um admin, ou quem criou a pasta, pode apagá-la.', 'Only an admin, or whoever made the folder, can delete it.'))
    const docs = this.index.docs().filter((d) => d.folderId === id)
    if (folders.some((x) => x.parentId === id) || docs.some((d) => !d.trashedAt)) throw new UserError(L('Só dá pra apagar uma pasta vazia. Tire os arquivos e as pastas de dentro primeiro.', 'Only an empty folder can be deleted. Move its files and folders out first.'))
    if (!f.parentId && docs.length) throw new UserError(L('Essa pasta ainda tem arquivos na lixeira.', 'This folder still has files in the trash.'))
    this.dropFolder(id)
    this.deps.emit()
  }

  async add(person: Person, p: { folderId: string; name: string; data: Buffer; summary?: string }): Promise<Doc> {
    this.need()
    this.folderFor(person, p.folderId, 'edit')
    const doc = await this.create({ folderId: p.folderId, name: p.name, data: p.data, ...(p.summary ? { summary: p.summary } : {}), by: actorOfPerson(person.id) })
    this.deps.emit()
    return doc
  }

  // Keeps a file an agent showed in a chat. One kept already (the same artifact) comes back as it is.
  async saveFromArtifact(person: Person, artifactId: string, folderId: string): Promise<Doc> {
    this.need()
    const a = this.deps.artifact(artifactId)
    if (!a || !this.deps.canSeeArtifact(person, a)) throw new UserError(L('Esse arquivo não está mais disponível.', 'That file is no longer available.'))
    this.folderFor(person, folderId, 'edit')
    const folders = this.index.folders()
    const kept = this.index.docs().find((d) => !d.trashedAt && d.origin.artifactId === a.id && personMay(person, folders, d.folderId, 'view'))
    if (kept) return kept
    const path = safeJoin(this.deps.artifactsDir, a.id, a.name)
    let data: Buffer
    try {
      if (statSync(path).size > 20 * 1024 * 1024) throw unsupported()
      data = readFileSync(path)
    } catch (e) {
      if (e instanceof UserError) throw e
      throw new UserError(L('Não achei o arquivo. Ele pode ter sido apagado.', "I can't find the file. It may have been deleted."))
    }
    const doc = await this.create({ folderId, name: a.name, data, origin: { artifactId: a.id, conversationId: a.conversationId, messageId: a.messageId, agentId: a.agentId, askedBy: person.id }, by: actorOfPerson(person.id), action: 'saved-from-chat' })
    this.deps.emit()
    return doc
  }

  async newVersion(person: Person, docId: string, p: { data: Buffer; note?: string; name?: string }): Promise<Doc> {
    this.need()
    const d = this.docFor(person, docId, 'edit')
    if (d.trashedAt) throw trashed()
    const next = await this.revise(d, { data: p.data, by: actorOfPerson(person.id), ...(p.note ? { note: p.note } : {}), ...(p.name ? { name: p.name } : {}) })
    if (next !== d) this.deps.emit()
    return next
  }

  // To another folder (needs edit in both) and/or under another name.
  move(person: Person, docId: string, folderId: string, name?: string): Doc {
    this.need()
    const d = this.docFor(person, docId, 'edit')
    if (d.trashedAt) throw trashed()
    this.folderFor(person, folderId, 'edit')
    const next = this.moveDoc(d, folderId, name, actorOfPerson(person.id))
    this.deps.emit()
    return next
  }
  rename(person: Person, docId: string, name: string): Doc {
    this.need()
    return this.move(person, docId, this.docFor(person, docId, 'edit').folderId, name)
  }
  trash(person: Person, docId: string): Doc {
    this.need()
    const d = this.docFor(person, docId, 'edit')
    if (d.trashedAt) return d
    const next = this.trashDoc(d, actorOfPerson(person.id))
    this.deps.emit()
    return next
  }
  restore(person: Person, docId: string): Doc {
    this.need()
    const d = this.docFor(person, docId, 'edit')
    if (!d.trashedAt) return d
    const next = this.restoreDoc(d, actorOfPerson(person.id))
    this.deps.emit()
    return next
  }

  // What the file says, as text, for the viewer (`version`: an older one).
  async text(person: Person, docId: string, version?: number): Promise<{ text: string }> {
    this.need()
    const d = this.docFor(person, docId)
    const data = this.bytes(d, version)
    // The page draws these three itself (a table, Markdown, plain text), so it gets the file as written; the rest is read into text.
    if (d.kind === 'csv' || d.kind === 'markdown' || d.kind === 'text') return { text: data.toString('utf8') }
    return { text: await this.textOf(d.name, d.kind, data) }
  }

  history(person: Person, docId: string): { versions: DocVersion[]; events: DocEvent[] } {
    this.need()
    this.docFor(person, docId)
    return { versions: this.index.versions(docId), events: this.index.events(docId) }
  }

  // Goes back to an older version: its bytes become a new version (nothing is lost).
  async restoreVersion(person: Person, docId: string, n: number): Promise<Doc> {
    this.need()
    const d = this.docFor(person, docId, 'edit')
    if (d.trashedAt) throw trashed()
    if (n === d.version) throw new UserError(L('Essa já é a versão de agora.', 'That is already the current version.'))
    const next = await this.revise(d, { data: this.bytes(d, n), by: actorOfPerson(person.id), action: 'reverted', note: L(`Voltou à versão ${n}`, `Back to version ${n}`), detail: String(n) })
    this.deps.emit()
    return next
  }

  // In the folders this person sees (`folderId`: and under it), by the words of the name, the summary and the text. Matches are marked **like this**.
  search(person: Person, q: string, folderId?: string, limit = 20): DocHit[] {
    this.need()
    const folders = this.index.folders()
    const seen = visibleFolderIds(person, folders)
    if (folderId && !seen.has(folderId)) return []
    return this.find(folders, folderId ? [...this.subtree(folders, folderId)].filter((x) => seen.has(x)) : [...seen], q, limit)
  }
  private find(folders: DocFolder[], ids: string[], q: string, limit: number): DocHit[] {
    let rows: { id: string; snippet: string }[] = []
    try {
      rows = this.index.search(ftsQuery(q), ids, limit)
      if (!rows.length) rows = this.index.search(ftsQuery(q, true), ids, limit)
    } catch {}
    const out: DocHit[] = []
    for (const r of rows) {
      const doc = this.index.doc(r.id)
      if (doc && folders.some((f) => f.id === doc.folderId)) out.push({ doc, snippet: r.snippet.replace(/\s+/g, ' ').trim() })
    }
    return out
  }

  // Which artifacts were kept as documents (for "Guardado em…" under a file in the chat).
  docByArtifact(person: Person): Record<string, { docId: string; folderId: string }> {
    if (!this.ready) return {}
    const seen = visibleFolderIds(person, this.index.folders())
    const out: Record<string, { docId: string; folderId: string }> = {}
    for (const d of this.index.docs()) if (!d.trashedAt && d.origin.artifactId && seen.has(d.folderId)) out[d.origin.artifactId] = { docId: d.id, folderId: d.folderId }
    return out
  }

  // The file to serve for /doc/<id>/<name> (`version`: an older one). `person` null: the desktop's own, no check.
  fileOf(person: Person | null, docId: string, version?: number): { path: string; name: string; kind: DocKind } | null {
    if (!this.ready) return null
    const d = this.index.doc(docId)
    if (!d || (person && !personMay(person, this.index.folders(), d.folderId, 'view'))) return null
    const path = this.filePath(d, version)
    return path ? { path, name: d.name, kind: d.kind } : null
  }

  // A person who left: their personal folder and everything in it goes for good (no one else could see it), and their
  // name leaves every folder's access.
  purgePerson(personId: string): void {
    if (!this.ready) return
    const folders = this.index.folders()
    const mine = new Set<string>()
    for (const root of folders.filter((f) => f.privateTo === personId)) for (const id of this.subtree(folders, root.id)) mine.add(id)
    for (const d of this.index.docs()) if (mine.has(d.folderId)) this.purgeDoc(d)
    for (const f of folders.filter((x) => mine.has(x.id))) this.index.dropFolder(f.id)
    try {
      rmSync(safeJoin(this.root, '.private', personId.replace(/[^\w-]/g, '_')), { recursive: true, force: true })
    } catch {}
    for (const f of folders) if (f.access?.people[personId]) this.index.putFolder({ ...f, access: { ...f.access, people: Object.fromEntries(Object.entries(f.access.people).filter(([k]) => k !== personId)) } })
    this.deps.emit()
  }

  // ---------- agents ----------
  // Every call below is for an agent working for `requester` (null: a routine, working for no one); what it gets is
  // agentMayFor's. A folder or a document may be given by id or by path ("Financeiro/Relatórios", "Financeiro/maio.pdf"),
  // as the agent saw it listed, with no regard to case or accents.
  // The folders an agent may use: `ids` (for `need`), and `readable` (what it may read): the paths it is shown are made of
  // the folders it can read, so a folder under one it can't read starts the path at its own name.
  private reach(agent: Agent, requester: Requester, need: 'read' | 'write'): { folders: DocFolder[]; ids: Set<string>; readable: Set<string> } {
    this.need()
    const folders = this.index.folders()
    const readable = agentFolderIds(agent, this.deps.agents(), requester, folders, 'read')
    const ids = need === 'read' ? readable : agentFolderIds(agent, this.deps.agents(), requester, folders, 'write')
    return { folders, ids, readable }
  }
  private withPath = (folders: DocFolder[], f: DocFolder, readable: Set<string>): AgentFolder => ({ ...f, path: folderPathWithin(folders, f.id, readable).join('/') })
  private pathIn = (folders: DocFolder[], d: Pick<Doc, 'folderId' | 'name'>, readable: Set<string>): string => [...folderPathWithin(folders, d.folderId, readable), d.name].join('/')
  // A newest version nobody approved yet (or a draft): its summary and indexed text are the unapproved one's, so an agent is not shown them.
  private unapproved = (d: Doc): boolean => (d.status === 'review' || d.status === 'draft') && d.officialVersion !== d.version

  // A folder by id or path, among `allowedIds` (paths are read through `pathIds`: what the agent may read); undefined when none (or more than one) matches.
  resolveFolder(ref: string, allowedIds: Set<string>, folders?: DocFolder[], pathIds: Set<string> = allowedIds): DocFolder | undefined {
    this.need()
    const all = folders ?? this.index.folders()
    const text = ref.trim()
    const byId = all.find((f) => f.id === text && allowedIds.has(f.id))
    if (byId) return byId
    const want = text.split(/[/›>]/).map(looseName).filter(Boolean)
    if (!want.length) return undefined
    const mine = all.filter((f) => allowedIds.has(f.id)).map((f) => ({ f, path: folderPathWithin(all, f.id, pathIds).map(looseName) }))
    const exact = mine.filter((x) => x.path.length === want.length && x.path.every((s, i) => s === want[i]))
    if (exact.length) return exact.length === 1 ? exact[0]!.f : undefined
    const tail = mine.filter((x) => x.path.length >= want.length && want.every((s, i) => s === x.path[x.path.length - want.length + i]))
    return tail.length === 1 ? tail[0]!.f : undefined
  }

  // A document by id or path, in the folders of `allowedIds` (a trashed one is never found this way).
  resolveDoc(ref: string, allowedIds: Set<string>, folders?: DocFolder[], pathIds: Set<string> = allowedIds): Doc | undefined {
    this.need()
    const all = folders ?? this.index.folders()
    const text = ref.trim()
    const live = this.index.docs().filter((d) => !d.trashedAt && allowedIds.has(d.folderId))
    const byId = live.find((d) => d.id === text)
    if (byId) return byId
    const parts = text.split(/[/›>]/).map((s) => s.trim()).filter(Boolean)
    const name = looseName(parts.pop() ?? '')
    if (!name) return undefined
    const folder = parts.length ? this.resolveFolder(parts.join('/'), allowedIds, all, pathIds) : undefined
    if (parts.length && !folder) return undefined
    const named = live.filter((d) => looseName(d.name) === name && (!folder || d.folderId === folder.id))
    return named.length === 1 ? named[0] : undefined
  }

  // The folders the agent may use (`read`, or `write`), each with its path and rule.
  foldersFor(agent: Agent, requester: Requester, need: 'read' | 'write'): AgentFolder[] {
    if (!this.ready) return []
    const { folders, ids, readable } = this.reach(agent, requester, need)
    return folders.filter((f) => ids.has(f.id)).map((f) => this.withPath(folders, f, readable))
  }

  // What is in a folder (its documents and subfolders); without `folder`, the documents of every folder it may read, newest first (up to 200).
  listFor(agent: Agent, requester: Requester, folder?: string): { folders: AgentFolder[]; docs: AgentDoc[] } {
    const { folders, ids, readable } = this.reach(agent, requester, 'read')
    const at = folder ? this.resolveFolder(folder, ids, folders, readable) : undefined
    if (folder && !at) throw noFolder()
    const sub = folders.filter((f) => ids.has(f.id) && (at ? f.parentId === at.id : true)).map((f) => this.withPath(folders, f, readable))
    const docs = this.index.docs().filter((d) => !d.trashedAt && (at ? d.folderId === at.id : ids.has(d.folderId))).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)
    return { folders: sub, docs: docs.map((d) => ({ ...d, path: this.pathIn(folders, d, readable), ...(this.unapproved(d) ? { summary: '' } : {}) })) }
  }

  searchFor(agent: Agent, requester: Requester, q: string, folder?: string, limit = 8): { doc: AgentDoc; snippet: string }[] {
    const { folders, ids, readable } = this.reach(agent, requester, 'read')
    const at = folder ? this.resolveFolder(folder, ids, folders, readable) : undefined
    if (folder && !at) throw noFolder()
    return this.find(folders, at ? [...this.subtree(folders, at.id)].filter((x) => ids.has(x)) : [...ids], q, limit).map((h) => {
      const hidden = this.unapproved(h.doc)
      return { doc: { ...h.doc, path: this.pathIn(folders, h.doc, readable), ...(hidden ? { summary: '' } : {}) }, snippet: hidden ? '' : h.snippet }
    })
  }

  // A document and what it says. A scanned PDF or a picture has no text: `text` says so.
  // What waits for approval is not what holds: an agent gets the official version's text (with a note saying so), or the newest
  // with a note that it is not official yet.
  async readFor(agent: Agent, requester: Requester, ref: string): Promise<{ doc: AgentDoc; text: string; note?: string }> {
    const { folders, ids, readable } = this.reach(agent, requester, 'read')
    const d = this.resolveDoc(ref, ids, folders, readable)
    if (!d) throw gone()
    let note: string | undefined
    let version: number | undefined
    // A newer version that is a draft or waits for approval does not count: the official one is read, whenever there is one.
    if (typeof d.officialVersion === 'number' && d.officialVersion < d.version && d.status !== 'official') {
      version = d.officialVersion
      note = L(`Esta é a versão oficial (${d.officialVersion}). A versão ${d.version} é um rascunho ou está esperando aprovação; ela ainda não vale.`, `This is the official version (${d.officialVersion}). Version ${d.version} is a draft or is waiting for approval; it doesn't count yet.`)
    } else if (d.status === 'review') note = L('Este documento está esperando aprovação e ainda não é oficial.', 'This document is waiting for approval and is not official yet.')
    else if (d.status === 'draft') note = L('Este documento é um rascunho.', 'This document is a draft.')
    let text: string
    try {
      const bytes = (() => {
        try {
          return this.bytes(d, version)
        } catch {
          // The official version's file is gone: the newest, with the note changed to say so.
          version = undefined
          note = L('Este documento está esperando aprovação e ainda não é oficial.', 'This document is waiting for approval and is not official yet.')
          return this.bytes(d)
        }
      })()
      text = await this.textOf(d.name, d.kind, bytes)
    } catch (e) {
      text = e instanceof Error ? e.message : String(e)
    }
    return { doc: { ...d, path: this.pathIn(folders, d, readable), ...(this.unapproved(d) ? { summary: '' } : {}) }, text, ...(note ? { note } : {}) }
  }

  // Saves a document in a folder the agent may write (`folderId`: id or path), or, with `replaces`, as the next version of
  // that one. Where it came from goes in `origin`: the caller's own fields are kept as they are; the agent is added, and the
  // person it asked for only when it works for exactly one person (a channel has no single one to name).
  async saveFor(agent: Agent, requester: Requester, p: { folderId: string; name: string; data: Buffer; summary: string; note: string; replaces?: string; draft?: boolean; origin: DocOrigin }): Promise<AgentDoc> {
    const { folders, ids, readable } = this.reach(agent, requester, 'write')
    const by = actorOfAgent(agent.id)
    const single = requester && !Array.isArray(requester) ? requester : undefined
    let doc: Doc
    if (p.replaces) {
      const d = this.resolveDoc(p.replaces, ids, folders, readable)
      if (!d) throw gone()
      doc = await this.revise(d, { data: p.data, by, note: p.note, routineId: p.origin.routineId ?? null, ...(p.draft ? { draft: true } : {}), ...(docKind(p.name) && docKind(p.name) !== d.kind ? { name: p.name } : {}), ...(p.summary ? { summary: p.summary } : {}) })
    } else {
      const f = this.resolveFolder(p.folderId, ids, folders, readable)
      if (!f) throw new UserError(L('Não posso guardar nessa pasta: ela não existe ou o acesso não deixa.', "I can't save in that folder: it doesn't exist or access doesn't allow it."))
      const askedBy = p.origin.askedBy ?? single?.id
      doc = await this.create({ folderId: f.id, name: p.name, data: p.data, summary: p.summary, note: p.note, origin: { ...p.origin, agentId: agent.id, ...(askedBy ? { askedBy } : {}) }, by, ...(p.draft ? { draft: true } : {}) })
    }
    this.deps.emit()
    return { ...doc, path: this.pathIn(folders, doc, readable) }
  }

  moveFor(agent: Agent, requester: Requester, ref: string, folder: string, name?: string): AgentDoc {
    const { folders, ids, readable } = this.reach(agent, requester, 'write')
    const d = this.resolveDoc(ref, ids, folders, readable)
    if (!d) throw gone()
    const to = this.resolveFolder(folder, ids, folders, readable)
    if (!to) throw noFolder()
    const next = this.moveDoc(d, to.id, name, actorOfAgent(agent.id))
    this.deps.emit()
    return { ...next, path: this.pathIn(folders, next, readable) }
  }
}
