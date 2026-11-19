// The index of Documentos (docs.db): folders, documents, versions, history and the full-text search.
// The files on disk are the truth; this keeps what comes from them or watches over them. Rows in,
// rows out: no rules here (who may do what is in shared/doc-access.ts, the operations in docs-core.ts).
import { DatabaseSync } from 'node:sqlite'
import type { Doc, DocAction, DocEvent, DocFolder, DocKind, DocLevel, DocOrigin, DocVersion, FolderAccess } from '../shared/docs'

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
  return {
    ...(everyone ? { everyone } : {}),
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
  createdBy: String(r['created_by']),
  createdAt: Number(r['created_at'])
})

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
  trashedAt: r['trashed_at'] == null ? null : Number(r['trashed_at'])
})

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
    `)
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
      .prepare('INSERT INTO folders (id, parent_id, name, rule, access, private_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, rule = excluded.rule, access = excluded.access, private_to = excluded.private_to')
      .run(f.id, f.parentId, f.name, f.rule, f.access ? JSON.stringify(f.access) : null, f.privateTo, f.createdBy, f.createdAt)
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
        'INSERT INTO docs (id, folder_id, name, kind, summary, size, hash, version, origin, created_by, created_at, updated_by, updated_at, trashed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET folder_id = excluded.folder_id, name = excluded.name, kind = excluded.kind, summary = excluded.summary, size = excluded.size, hash = excluded.hash, version = excluded.version, origin = excluded.origin, updated_by = excluded.updated_by, updated_at = excluded.updated_at, trashed_at = excluded.trashed_at'
      )
      .run(d.id, d.folderId, d.name, d.kind, d.summary, d.size, d.hash, d.version, JSON.stringify(d.origin), d.createdBy, d.createdAt, d.updatedBy, d.updatedAt, d.trashedAt)
  }
  // A document and everything kept about it, gone for good.
  dropDoc(id: string): void {
    for (const t of ['docs WHERE id', 'versions WHERE doc_id', 'events WHERE doc_id', 'fts WHERE doc_id']) this.db.prepare(`DELETE FROM ${t} = ?`).run(id)
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
