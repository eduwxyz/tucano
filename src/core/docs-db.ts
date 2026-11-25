// The index of Documentos (docs.db): folders, documents, versions, history and the full-text search.
// The files on disk are the truth; this keeps what comes from them or watches over them. Rows in,
// rows out: no rules here (who may do what is in shared/doc-access.ts, the operations in docs-core.ts).
import { DatabaseSync } from 'node:sqlite'
import type { AgentLevel, Doc, DocAction, DocDate, DocEvent, DocFiling, DocFolder, DocKind, DocLevel, DocOrigin, DocStatus, DocVersion, FolderAccess } from '../shared/docs'

type Row = Record<string, unknown>

const json = <T,>(s: unknown, fallback: T): T => {
  try {
    const v = JSON.parse(String(s ?? '')) as T
    return v ?? fallback
  } catch {
    return fallback
  }
}

const plainObject = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {})
// A folder's access as stored, read defensively: what does not fit its shape is dropped; not an object at all: inherit (null).
const toAccess = (s: unknown): FolderAccess | null => {
  const raw = json<unknown>(s, null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const a = raw as Record<string, unknown>
  const levels = (x: unknown, ok: string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(plainObject(x))) if (typeof v === 'string' && ok.includes(v)) out[k] = v
    return out
  }
  const ev = a['everyone']
  const everyone: DocLevel | undefined = ev === 'view' || ev === 'edit' ? ev : undefined
  const aa = a['allAgents']
  const allAgents: AgentLevel | undefined = aa === 'read' || aa === 'write' ? aa : undefined
  return {
    ...(everyone ? { everyone } : {}),
    ...(allAgents ? { allAgents } : {}),
    people: levels(a['people'], ['view', 'edit']) as FolderAccess['people'],
    sectors: levels(a['sectors'], ['read', 'write']) as FolderAccess['sectors'],
    agents: levels(a['agents'], ['read', 'write']) as FolderAccess['agents']
  }
}
const toOrigin = (s: unknown): DocOrigin => plainObject(json<unknown>(s, {})) as DocOrigin

const toFolder = (r: Row): DocFolder => ({
  id: String(r['id']),
  parentId: r['parent_id'] == null ? null : String(r['parent_id']),
  name: String(r['name']),
  rule: String(r['rule'] ?? ''),
  access: r['access'] == null ? null : toAccess(r['access']),
  privateTo: r['private_to'] == null ? null : String(r['private_to']),
  needsApproval: Number(r['needs_approval'] ?? 0) === 1,
  createdBy: String(r['created_by']),
  createdAt: Number(r['created_at'])
})

const STATUSES: string[] = ['draft', 'review', 'official']
const toFiling = (s: unknown): DocFiling | null => {
  const f = plainObject(json<unknown>(s, null))
  const state = f['state']
  if ((state !== 'pending' && state !== 'filed' && state !== 'kept') || typeof f['by'] !== 'string' || typeof f['at'] !== 'number') return null
  return { state, by: f['by'], at: f['at'], ...(typeof f['note'] === 'string' ? { note: f['note'] } : {}) }
}
const orNull = (v: unknown): number | null => (v == null ? null : Number(v))

const toDoc = (r: Row): Doc => ({
  id: String(r['id']),
  folderId: String(r['folder_id']),
  name: String(r['name']),
  kind: String(r['kind']) as DocKind,
  summary: String(r['summary'] ?? ''),
  size: Number(r['size']),
  hash: String(r['hash']),
  version: Number(r['version']),
  origin: toOrigin(r['origin']),
  createdBy: String(r['created_by']),
  createdAt: Number(r['created_at']),
  updatedBy: String(r['updated_by']),
  updatedAt: Number(r['updated_at']),
  trashedAt: r['trashed_at'] == null ? null : Number(r['trashed_at']),
  status: STATUSES.includes(String(r['status'])) ? (String(r['status']) as DocStatus) : null,
  officialVersion: orNull(r['official_version']),
  statusBy: r['status_by'] == null ? null : String(r['status_by']),
  statusAt: orNull(r['status_at']),
  statusNote: String(r['status_note'] ?? ''),
  routineId: r['routine_id'] == null ? null : String(r['routine_id']),
  catalogedAt: orNull(r['cataloged_at']),
  filing: r['filing'] == null ? null : toFiling(r['filing'])
})

const toDate = (r: Row): DocDate => ({ id: String(r['id']), docId: String(r['doc_id']), date: String(r['date']), what: String(r['what']), state: r['state'] === 'reminded' || r['state'] === 'dismissed' ? r['state'] : 'open', routineId: r['routine_id'] == null ? null : String(r['routine_id']) })

export class DocsIndex {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, rule TEXT NOT NULL DEFAULT '', access TEXT, private_to TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL, hash TEXT NOT NULL, version INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER);
      CREATE INDEX IF NOT EXISTS docs_by_folder ON docs (folder_id);
      CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, n INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL, hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS versions_by_doc ON versions (doc_id, n);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS events_by_doc ON events (doc_id, at);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, body, doc_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dates (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, date TEXT NOT NULL, what TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', routine_id TEXT);
      CREATE INDEX IF NOT EXISTS dates_by_doc ON dates (doc_id);
    `)
    // A docs.db made before these columns existed gets them here (rows read back as null / false / '').
    this.ensureColumn('folders', 'needs_approval', 'INTEGER NOT NULL DEFAULT 0')
    for (const [c, t] of [['status', 'TEXT'], ['official_version', 'INTEGER'], ['status_by', 'TEXT'], ['status_at', 'INTEGER'], ['status_note', "TEXT NOT NULL DEFAULT ''"], ['routine_id', 'TEXT'], ['cataloged_at', 'INTEGER'], ['filing', 'TEXT'], ['summary_auto', 'INTEGER NOT NULL DEFAULT 0']] as const) this.ensureColumn('docs', c, t)
    // The time on disk of a file read and found to be the bytes on record (see docs-scan.ts).
    this.ensureColumn('docs', 'disk_at', 'INTEGER')
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
    if (!cols.some((c) => c['name'] === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  close(): void {
    this.db.close()
  }

  // ---------- meta ----------
  meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined)?.['value'] as string | undefined
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ---------- folders ----------
  folders(): DocFolder[] {
    return (this.db.prepare('SELECT * FROM folders ORDER BY created_at, id').all() as Row[]).map(toFolder)
  }
  putFolder(f: DocFolder): void {
    this.db
      .prepare('INSERT INTO folders (id, parent_id, name, rule, access, private_to, needs_approval, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, rule = excluded.rule, access = excluded.access, private_to = excluded.private_to, needs_approval = excluded.needs_approval')
      .run(f.id, f.parentId, f.name, f.rule, f.access ? JSON.stringify(f.access) : null, f.privateTo, f.needsApproval ? 1 : 0, f.createdBy, f.createdAt)
  }
  dropFolder(id: string): void {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
  }

  // ---------- documents ----------
  docs(): Doc[] {
    return (this.db.prepare('SELECT * FROM docs ORDER BY created_at, id').all() as Row[]).map(toDoc)
  }
  doc(id: string): Doc | undefined {
    const r = this.db.prepare('SELECT * FROM docs WHERE id = ?').get(id) as Row | undefined
    return r ? toDoc(r) : undefined
  }
  putDoc(d: Doc): void {
    this.db
      .prepare(
        'INSERT INTO docs (id, folder_id, name, kind, summary, size, hash, version, origin, created_by, created_at, updated_by, updated_at, trashed_at, status, official_version, status_by, status_at, status_note, routine_id, cataloged_at, filing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET folder_id = excluded.folder_id, name = excluded.name, kind = excluded.kind, summary = excluded.summary, size = excluded.size, hash = excluded.hash, version = excluded.version, origin = excluded.origin, updated_by = excluded.updated_by, updated_at = excluded.updated_at, trashed_at = excluded.trashed_at, status = excluded.status, official_version = excluded.official_version, status_by = excluded.status_by, status_at = excluded.status_at, status_note = excluded.status_note, routine_id = excluded.routine_id, cataloged_at = excluded.cataloged_at, filing = excluded.filing'
      )
      .run(d.id, d.folderId, d.name, d.kind, d.summary, d.size, d.hash, d.version, JSON.stringify(d.origin), d.createdBy, d.createdAt, d.updatedBy, d.updatedAt, d.trashedAt, d.status, d.officialVersion, d.statusBy, d.statusAt, d.statusNote, d.routineId, d.catalogedAt, d.filing ? JSON.stringify(d.filing) : null)
  }
  // Files whose time on disk is newer than the last change on record, yet hold the same bytes (a restore
  // or a copy writes every file with the current time): the time they were checked at, so the scan reads
  // each of them once and not again at every pass.
  diskTimes(): Map<string, number> {
    return new Map((this.db.prepare('SELECT id, disk_at FROM docs WHERE disk_at IS NOT NULL').all() as Row[]).map((r) => [String(r['id']), Number(r['disk_at'])]))
  }
  setDiskAt(id: string, at: number): void {
    this.db.prepare('UPDATE docs SET disk_at = ? WHERE id = ?').run(at, id)
  }
  // Whether a document's summary is the automatic first-characters one (the cataloguer may replace it).
  summaryAuto(id: string): boolean {
    return Number((this.db.prepare('SELECT summary_auto AS a FROM docs WHERE id = ?').get(id) as Row | undefined)?.['a'] ?? 0) === 1
  }
  setSummaryAuto(id: string, auto: boolean): void {
    this.db.prepare('UPDATE docs SET summary_auto = ? WHERE id = ?').run(auto ? 1 : 0, id)
  }
  // Not yet looked at by the cataloguer, oldest first (the caller filters by kind and trash).
  uncataloged(limit: number): Doc[] {
    return (this.db.prepare("SELECT * FROM docs WHERE cataloged_at IS NULL AND trashed_at IS NULL AND kind NOT IN ('image') ORDER BY created_at, id LIMIT ?").all(limit) as Row[]).map(toDoc)
  }
  // The text kept for the search, for answering from it.
  body(docId: string): string {
    return String((this.db.prepare('SELECT body FROM fts WHERE doc_id = ?').get(docId) as Row | undefined)?.['body'] ?? '')
  }

  // ---------- dates found in documents ----------
  dates(docId: string): DocDate[] {
    return (this.db.prepare('SELECT * FROM dates WHERE doc_id = ? ORDER BY date, id').all(docId) as Row[]).map(toDate)
  }
  date(id: string): DocDate | undefined {
    const r = this.db.prepare('SELECT * FROM dates WHERE id = ?').get(id) as Row | undefined
    return r ? toDate(r) : undefined
  }
  // Open and reminded ones, soonest first (the caller filters by who sees the document).
  liveDates(): DocDate[] {
    return (this.db.prepare("SELECT * FROM dates WHERE state IN ('open', 'reminded') ORDER BY date, id").all() as Row[]).map(toDate)
  }
  openDates(): DocDate[] {
    return (this.db.prepare("SELECT * FROM dates WHERE state = 'open' ORDER BY date, id").all() as Row[]).map(toDate)
  }
  putDate(d: DocDate): void {
    this.db.prepare('INSERT INTO dates (id, doc_id, date, what, state, routine_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET date = excluded.date, what = excluded.what, state = excluded.state, routine_id = excluded.routine_id').run(d.id, d.docId, d.date, d.what, d.state, d.routineId)
  }
  dropOpenDates(docId: string): void {
    this.db.prepare("DELETE FROM dates WHERE doc_id = ? AND state = 'open'").run(docId)
  }
  // A document and everything kept about it, gone for good.
  dropDoc(id: string): void {
    for (const t of ['docs WHERE id', 'versions WHERE doc_id', 'events WHERE doc_id', 'fts WHERE doc_id', 'dates WHERE doc_id']) this.db.prepare(`DELETE FROM ${t} = ?`).run(id)
  }

  // ---------- versions and history ----------
  addVersion(v: Omit<DocVersion, 'id'>): void {
    this.db.prepare('INSERT INTO versions (doc_id, n, at, by, note, size, hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(v.docId, v.n, v.at, v.by, v.note, v.size, v.hash)
  }
  versions(docId: string): DocVersion[] {
    return (this.db.prepare('SELECT * FROM versions WHERE doc_id = ? ORDER BY n DESC').all(docId) as Row[]).map((r) => ({ id: Number(r['id']), docId, n: Number(r['n']), at: Number(r['at']), by: String(r['by']), note: String(r['note'] ?? ''), size: Number(r['size']), hash: String(r['hash']) }))
  }
  addEvent(e: DocEvent): void {
    this.db.prepare('INSERT INTO events (doc_id, at, by, action, detail) VALUES (?, ?, ?, ?, ?)').run(e.docId, e.at, e.by, e.action, e.detail)
  }
  events(docId: string): DocEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE doc_id = ? ORDER BY at DESC, id DESC LIMIT 200').all(docId) as Row[]).map((r) => ({ docId, at: Number(r['at']), by: String(r['by']), action: String(r['action']) as DocAction, detail: String(r['detail'] ?? '') }))
  }

  // ---------- search ----------
  // The name and the summary go with the title, the text of the file is the body.
  indexText(docId: string, title: string, body: string): void {
    this.db.prepare('DELETE FROM fts WHERE doc_id = ?').run(docId)
    this.db.prepare('INSERT INTO fts (title, body, doc_id) VALUES (?, ?, ?)').run(title, body, docId)
  }
  retitle(docId: string, title: string): void {
    this.db.prepare('UPDATE fts SET title = ? WHERE doc_id = ?').run(title, docId)
  }
  // Matches in the given folders only, trashed ones left out, best first (the filter is in the query:
  // a person who sees little still gets their hits).
  search(match: string, folderIds: string[], limit: number): { id: string; snippet: string }[] {
    if (!match || !folderIds.length) return []
    const rows = this.db
      .prepare(
        `SELECT d.id AS id, snippet(fts, 1, '**', '**', '…', 18) AS snip, bm25(fts, 6.0, 1.0) AS rank FROM fts JOIN docs d ON d.id = fts.doc_id WHERE fts MATCH ? AND d.trashed_at IS NULL AND d.folder_id IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT ?`
      )
      .all(match, JSON.stringify(folderIds), limit) as Row[]
    return rows.map((r) => ({ id: String(r['id']), snippet: String(r['snip'] ?? '') }))
  }
}
