// The wiki (an LLM wiki, after Karpathy's idea): what the team knows, as linked pages.
// The pages are plain Markdown files in a folder Obsidian opens as is (pages/, plus esquema.md,
// índice.md and registro.md); that folder is the truth. A SQLite file next to the data keeps
// only what comes from it or watches over it: the search, the links, and each page's history.
// A page changed outside Tucano (Obsidian, git, any editor) is picked up and indexed again;
// a save made from an older copy of a page is refused instead of overwriting the newer one.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { L, locale } from '../shared/lang'
import { UserError } from '../shared/errors'
import type { WikiChange, WikiFinding, WikiHit, WikiImport, WikiOp, WikiPage, WikiPageInfo, WikiSource, WikiVersion } from '../shared/types'
import type { ToolDef } from './gateway'

const PAGES = 'pages'
const SOURCES = 'fontes'
const SCHEMA = 'esquema.md'
const INDEX = 'índice.md'
const LOG = 'registro.md'
const CHUNK = 1500 // characters per search chunk: a long page answers with the right part
const KIND_OTHER = () => L('Outros', 'Other')

export class WikiConflict extends UserError {
  constructor() {
    super(L('Essa página mudou desde que foi aberta. Recarregue e faça a mudança de novo.', 'This page changed since it was opened. Reload it and make the change again.'))
  }
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)
// [[Clientes/Marcos Lima]] and [[Marcos Lima.md]] are the page Marcos Lima, as in Obsidian.
export const pageName = (target: string): string => target.replace(/\.md$/i, '').split('/').pop()!.trim()
// A page's file name is its title, minus what file systems refuse.
export const fileOf = (title: string): string => `${clip(title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/^\.+/, '').trim()) || 'sem-titulo'}.md`
// Format characters (zero width, soft hyphen, bidi controls), controls (NUL and the rest of C0/C1),
// variation selectors, the combining grapheme joiner, and the blank letters some scripts have.
const INVISIBLE = /[\p{Cf}\p{Cc}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\uffa0\ufe00-\ufe0f]|\udb40[\udd00-\uddef]/gu
// A title as the wiki keeps it: one way of writing its letters (NFC), nothing that can't be seen,
// single spaces. Empty when nothing visible is left. Every title (a save, a rename, a note's, a
// file's, the curator's) comes through here; ordinary titles come out as they went in.
export const cleanTitle = (t: string): string => t.normalize('NFC').replace(/\s+/g, ' ').replace(INVISIBLE, '').trim()
// What tells one page from another: its file name, the way a title becomes one (NFC, case folded).
// Whatever goes by a page (held, where it came from, its history, its links) goes by this, so no other
// spelling of its title (" Title", "Title\n", "A/b" for "A-b", NFD, a zero width inside) reads around it.
export const pageKey = (title: string): string => fileOf(cleanTitle(title)).slice(0, -3).normalize('NFC').toLowerCase()
// A line's text the same way (no cut), to find a key in it.
const keyText = (s: string): string => cleanTitle(s).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').toLowerCase()
// A name cut to what a file system takes: 120 characters, 200 bytes (an accent or an emoji is more than one).
export function clip(s: string, chars = 120, bytes = 200): string {
  let out = [...s].slice(0, chars).join('')
  while (Buffer.byteLength(out) > bytes) out = [...out].slice(0, -1).join('')
  return out.trim()
}

// "---\nkey: value\n---\nbody": the frontmatter Obsidian shows as Properties.
export function parsePage(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  let list: string | null = null // a key whose value is the "  - item" lines under it (Obsidian's tags, aliases)
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && list) {
      meta[list] = [meta[list], item[1]!.replace(/^["']|["']$/g, '').trim()].filter(Boolean).join(', ')
      continue
    }
    const kv = /^([\wÀ-ɏ-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!.toLowerCase()
    const v = kv[2]!.trim()
    list = v ? null : key
    meta[key] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean).join(', ') : v.replace(/^["']|["']$/g, '').trim()
  }
  return { meta, body: text.slice(m[0].length) }
}

// Changes some keys of a page's frontmatter and leaves every other line as it was (lists,
// aliases, whatever Obsidian or its plugins keep there).
export function withFront(text: string | undefined, set: Record<string, string>, body: string): string {
  const m = text ? /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text) : null
  const lines = m ? m[1]!.split(/\r?\n/) : []
  for (const [k, v] of Object.entries(set)) {
    const at = lines.findIndex((l) => new RegExp(`^${k}:`, 'i').test(l))
    const line = `${k}: ${/[:#[\]{}]/.test(v) ? JSON.stringify(v) : v}`
    if (at >= 0) lines[at] = line
    else lines.push(line)
  }
  const clean = body.replace(/^\n+/, '')
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n${clean}` : clean
}

const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules'])
// Every file under a folder, as paths relative to it, leaving out Obsidian's own folder and the like.
function walk(root: string, keep: (rel: string) => boolean = () => true): string[] {
  const out: string[] = []
  const go = (rel: string): void => {
    for (const e of readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (keep(`${r}/`)) go(r)
      } else if (keep(r)) out.push(r)
    }
  }
  if (existsSync(root)) go('')
  return out
}
// The same, with each file's mtime, read without blocking: a big vault has thousands of files.
async function walkTimes(root: string, keep: (rel: string) => boolean): Promise<[string, number][]> {
  const out: [string, number][] = []
  const go = async (rel: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch {
      return // gone since it was listed
    }
    await Promise.all(
      entries.map(async (e) => {
        if (e.name.startsWith('.') || SKIP.has(e.name)) return
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (keep(`${r}/`)) await go(r)
        } else if (keep(r)) {
          const at = await stat(join(root, r)).then((st) => Math.round(st.mtimeMs), () => undefined)
          if (at !== undefined) out.push([r, at])
        }
      })
    )
  }
  if (existsSync(root)) await go('')
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
const pageText = (meta: Record<string, string>, body: string): string => {
  const keys = Object.entries(meta).filter(([, v]) => v !== '')
  return (keys.length ? `---\n${keys.map(([k, v]) => `${k}: ${/[:#[\]{}]/.test(v) ? JSON.stringify(v) : v}`).join('\n')}\n---\n\n` : '') + body.replace(/^\n+/, '')
}

// [[Page]], [[Page|shown]], [[Page#section]]: the titles a body links to, outside code.
export function linksIn(body: string): string[] {
  const text = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const out = new Set<string>()
  for (const m of text.matchAll(/(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const target = m[2]!.trim()
    if (target.startsWith(`${SOURCES}/`)) continue
    if (m[1] && /\.(?!md$)[a-z0-9]{2,5}$/i.test(target)) continue // ![[foto.png]]: an attachment, not a page
    out.add(pageName(target))
  }
  return [...out]
}

// The first line worth reading: what the index shows next to a title.
export function summaryOf(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('|') && !l.startsWith('```'))
  if (!line) return ''
  const plain = line.replace(/^[-*>]\s+/, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[*_`]/g, '')
  return plain.length > 140 ? `${plain.slice(0, 137).trimEnd()}…` : plain
}

function chunks(body: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const para of body.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > CHUNK) (out.push(cur), (cur = ''))
    cur = cur ? `${cur}\n\n${para}` : para
    while (cur.length > CHUNK * 1.5) (out.push(cur.slice(0, CHUNK)), (cur = cur.slice(CHUNK)))
  }
  if (cur.trim()) out.push(cur)
  return out.length ? out : ['']
}

// A search hit's text as one plain line: its **marks** stay, the Markdown around them goes.
export const plainSnippet = (s: string): string =>
  s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#+|[-*>]|\d+\.)\s+/, '').trim())
    .filter(Boolean)
    .join(' · ')

// Words of a search, as FTS5 terms: each word a prefix, all of them needed.
export function ftsQuery(q: string, any = false): string {
  const words = q
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 12)
  return words.map((w) => `"${w}"*`).join(any ? ' OR ' : ' ')
}

const defaultSchema = (): string =>
  L(
    `# Esquema da wiki

As regras desta wiki, pra quem escreve nela (você e os agentes). Mude à vontade: os agentes leem esta página.

## Tipos de página
- **Pessoa**: alguém com quem você fala (cliente, colega, família). Seções: Quem é, Contato, Histórico.
- **Projeto**: um trabalho com começo e fim. Seções: Objetivo, Situação, Decisões, Próximos passos.
- **Assunto**: um tema que vale entender (uma ferramenta, um processo, uma área). Seções: Resumo, Detalhes, Links.
- **Decisão**: o que se decidiu, quando, por quê e quem decidiu.

## Como escrever
- Uma página por pessoa, projeto ou assunto. O nome do arquivo é o título.
- Ligue páginas com [[Título]]: é assim que a wiki vira uma rede.
- No começo da página, uma frase que resume. O índice mostra essa frase.
- Escreva o que é durável. O que só importa numa conversa fica na conversa.
- Quando uma informação vier de algum lugar (um e-mail, um documento, uma conversa), diga de onde.
`,
    `# Wiki schema

This wiki's rules, for whoever writes in it (you and the agents). Change them freely: the agents read this page.

## Kinds of page
- **Person**: someone you deal with (a client, a colleague, family). Sections: Who, Contact, History.
- **Project**: a piece of work with a start and an end. Sections: Goal, Status, Decisions, Next steps.
- **Topic**: something worth understanding (a tool, a process, an area). Sections: Summary, Details, Links.
- **Decision**: what was decided, when, why and by whom.

## How to write
- One page per person, project or topic. The file name is the title.
- Link pages with [[Title]]: that's how the wiki becomes a web.
- At the top of the page, one sentence that sums it up. The index shows that sentence.
- Write what lasts. What matters only in one conversation stays in the conversation.
- When a piece of information comes from somewhere (an email, a document, a conversation), say where.
`
  )

export interface WikiDeps {
  dir: string // the folder of Markdown files: the truth
  indexPath: string // the SQLite file with the search, the links and the history
  onChange?: () => void
  // Whose DM a conversation is: a person's id, null for one that isn't a DM, undefined when it's
  // not known (gone). Where each version of a page came from is kept with it (see `inherit`).
  dmOf?: (conversationId: string) => string | null | undefined
  // A page written, renamed or deleted here (by a person, the curator, an import): the git sync
  // commits it a few seconds later (see wiki-git.ts). Not called for changes seen in the folder.
  onWrite?: (w: { title: string; byName: string }) => void
  // Why the wiki takes no writes now (a repository whose key can only read), or undefined.
  readOnly?: () => string | undefined
}

// What someone may read of the wiki: everything but the pages held for someone else (see `inherit`).
export type WikiView = Pick<Wiki, 'count' | 'list' | 'kinds' | 'page' | 'search' | 'indexText' | 'graph' | 'log' | 'recent'>

export class Wiki {
  dir: string
  private db!: DatabaseSync
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private onChange: () => void

  constructor(private deps: WikiDeps) {
    this.dir = deps.dir
    this.onChange = deps.onChange ?? (() => {})
  }

  // Where the pages are: pages/ in a wiki Tucano made; the folder itself when it's an Obsidian
  // vault the person pointed it to (notes at its root, in folders of its own).
  private root = ''
  private importing = false
  // Bumped when the index closes: a scan still reading the old folder drops what it found.
  private gen = 0
  private scanning = false
  private rescanAfter = false
  // The map and the log, as last read: the wiki screen asks for both on every change.
  private indexed = 0
  private graphKept?: { at: number; graph: ReturnType<Wiki['graph']> }
  private logKept?: { key: string; lines: string[] }
  // The folder's first read, when it runs behind (init with `background`).
  loaded: Promise<void> = Promise.resolve()
  private get pagesDir(): string {
    return this.root
  }
  // Where the pages are (the folder itself, or its pages/), for whoever copies pages in.
  get pagesRoot(): string {
    return this.root
  }
  // While git changes the folder (a pull, a rebase), what the watcher sees waits: a file half
  // written by a rebase isn't a change. Once it's done, the folder is read again, once.
  private quietDepth = 0
  quiet(on: boolean): void {
    this.quietDepth = Math.max(0, this.quietDepth + (on ? 1 : -1))
    if (!on && !this.quietDepth && this.rescanAfter && !this.scanning) (this.rescanAfter = false), this.rescan()
  }
  // The folder read again now (after a pull), and what changed shown: after any read under way, never two at once.
  async refresh(): Promise<void> {
    while (this.scanning) await new Promise((r) => setTimeout(r, 20))
    const gen = this.gen
    this.scanning = true
    this.rescanAfter = false
    try {
      if ((await this.scanAsync()) && gen === this.gen) (this.writeIndex(), this.onChange())
    } finally {
      this.scanning = false
      if (this.rescanAfter && gen === this.gen && !this.quietDepth) (this.rescanAfter = false), this.rescan()
    }
  }
  // Refused when the wiki takes no writes (see WikiDeps.readOnly).
  private writable(): void {
    const why = this.deps.readOnly?.()
    if (why) throw new UserError(why)
  }
  readOnly(): string | undefined {
    return this.deps.readOnly?.()
  }
  private pickRoot(): string {
    const pages = join(this.dir, PAGES)
    if (existsSync(pages) || !existsSync(this.dir)) return pages
    const vault = existsSync(join(this.dir, '.obsidian')) || readdirSync(this.dir).some((f) => f.endsWith('.md') && ![SCHEMA, INDEX, LOG].includes(f))
    return vault ? this.dir : pages
  }
  // A file under the root that's a page: Markdown, and not one of Tucano's own files.
  private isPage = (rel: string): boolean => (rel.endsWith('/') ? !(this.root === this.dir && rel === `${SOURCES}/`) : rel.endsWith('.md') && !(this.root === this.dir && [SCHEMA, INDEX, LOG].includes(rel)))

  // `background`: the folder is read without blocking (a big vault takes a while); `loaded` says when.
  init(watchFolder = true, background = false): void {
    this.root = this.pickRoot()
    mkdirSync(this.pagesDir, { recursive: true })
    mkdirSync(join(this.dir, SOURCES), { recursive: true })
    if (!existsSync(join(this.dir, SCHEMA))) writeFileSync(join(this.dir, SCHEMA), defaultSchema())
    if (!existsSync(join(this.dir, LOG))) writeFileSync(join(this.dir, LOG), L('# Registro\n\nO que mudou na wiki, do mais antigo pro mais novo.\n\n', '# Log\n\nWhat changed in the wiki, oldest first.\n\n'))
    this.db = new DatabaseSync(this.deps.indexPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (file TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, mtime INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, target TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS links_by_target ON links (target);
      CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT, reason TEXT);
      CREATE INDEX IF NOT EXISTS versions_by_title ON versions (title, at);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, body, file UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, file TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, source_id TEXT, at INTEGER NOT NULL, by TEXT NOT NULL, state TEXT NOT NULL, ops TEXT NOT NULL, base TEXT NOT NULL, before TEXT, reason TEXT, decided_at INTEGER);
      CREATE TABLE IF NOT EXISTS marks (conversation_id TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, pages TEXT NOT NULL, text TEXT NOT NULL, name TEXT, change_id TEXT, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provenance (title TEXT NOT NULL, at INTEGER NOT NULL, origin TEXT NOT NULL, private_to TEXT);
      CREATE INDEX IF NOT EXISTS provenance_by_title ON provenance (title COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS held (title TEXT PRIMARY KEY COLLATE NOCASE, person TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS held_log (title TEXT PRIMARY KEY, person TEXT NOT NULL);
    `)
    for (const col of ['status TEXT', 'error TEXT', 'changes INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE sources ADD COLUMN ${col}`)
      } catch {
        // already there
      }
    }
    // What the resolver made of a finding it couldn't settle (src/core/wiki-resolver.ts): a sentence,
    // or the question only the person can answer.
    try {
      this.db.exec('ALTER TABLE findings ADD COLUMN note TEXT')
    } catch {
      // already there
    }
    // Which source a version came from (a change the curator made of it): it's seen by whoever sees
    // the source, and goes with it.
    try {
      this.db.exec('ALTER TABLE versions ADD COLUMN source_id TEXT')
      // The versions from before: the ones a source's change wrote (same author, its pages, when it was applied).
      for (const c of this.db.prepare("SELECT source_id, by, ops, decided_at FROM changes WHERE source_id IS NOT NULL AND state IN ('applied', 'undone') AND decided_at IS NOT NULL").all() as { source_id: string; by: string; ops: string; decided_at: number }[]) {
        const pages = [...new Set((JSON.parse(c.ops) as WikiOp[]).map((o) => o.page.toLowerCase()))]
        for (const page of pages)
          this.db.prepare('UPDATE versions SET source_id = ? WHERE source_id IS NULL AND by = ? AND lower(title) = ? AND at BETWEEN ? AND ?').run(c.source_id, c.by, page, c.decided_at - 5000, c.decided_at + 1000)
      }
    } catch {
      // already there
    }
    // Each page and version by its key (see pageKey); what was kept by a title before, by its key now.
    for (const col of ['pages ADD COLUMN key TEXT', 'versions ADD COLUMN key TEXT', 'versions ADD COLUMN held_for TEXT']) {
      try {
        this.db.exec(`ALTER TABLE ${col}`)
      } catch {
        // already there
      }
    }
    for (const r of this.db.prepare('SELECT file, title FROM pages WHERE key IS NULL').all() as { file: string; title: string }[]) this.db.prepare('UPDATE pages SET key = ? WHERE file = ?').run(pageKey(r.title), r.file)
    for (const r of this.db.prepare('SELECT id, title FROM versions WHERE key IS NULL').all() as { id: number; title: string }[]) this.db.prepare('UPDATE versions SET key = ? WHERE id = ?').run(pageKey(r.title), r.id)
    for (const r of this.db.prepare('SELECT rowid, title FROM provenance').all() as { rowid: number; title: string }[]) if (pageKey(r.title) !== r.title) this.db.prepare('UPDATE provenance SET title = ? WHERE rowid = ?').run(pageKey(r.title), r.rowid)
    for (const r of this.db.prepare('SELECT title FROM held').all() as { title: string }[]) if (pageKey(r.title) !== r.title) this.db.prepare('UPDATE OR REPLACE held SET title = ? WHERE title = ?').run(pageKey(r.title), r.title)
    this.db.exec('CREATE INDEX IF NOT EXISTS pages_by_key ON pages (key); CREATE INDEX IF NOT EXISTS versions_by_key ON versions (key, at)')
    // Every key ever held (see everHeld): what was held before this was kept, and the pages gone whose versions say so.
    this.db.exec('INSERT OR IGNORE INTO held_log (title, person) SELECT title, person FROM held; INSERT OR IGNORE INTO held_log (title, person) SELECT DISTINCT key, held_for FROM versions WHERE held_for IS NOT NULL')
    // A source deleted before its changes went with it: they go now.
    this.dropOrphans()
    this.indexed++
    if (!background) {
      this.scan()
      this.linksByKey()
      this.writeIndex()
      if (watchFolder) this.watchFolder()
      return
    }
    const gen = this.gen
    this.loaded = this.scanAsync()
      .then((changed) => {
        if (gen !== this.gen) return
        this.linksByKey()
        this.writeIndex()
        if (watchFolder) this.watchFolder()
        if (changed) this.onChange()
      })
      .catch((e: unknown) => console.error('[wiki]', e))
  }

  // Links kept by the target's lowercase title before: by its key now (see pageKey), once. After a scan.
  private linksByKey(): void {
    if (this.getMeta('linksByKey')) return
    for (const r of this.db.prepare('SELECT file FROM pages').all() as { file: string }[]) {
      const path = join(this.pagesDir, r.file)
      if (existsSync(path)) this.indexLinks(r.file, parsePage(readFileSync(path, 'utf8')))
    }
    this.setMeta('linksByKey', '1')
  }

  // Another folder: the index is that folder's own; what was in the old one stays there.
  relocate(dir: string, indexPath: string): void {
    this.close()
    this.dir = dir
    this.deps = { ...this.deps, dir, indexPath }
    this.init()
    this.onChange()
  }

  close(): void {
    this.gen++
    this.watcher?.close()
    if (this.timer) clearTimeout(this.timer)
    this.db?.close()
  }

  // Changes made outside Tucano: indexed again, and kept in the history as such.
  private watchFolder(): void {
    try {
      this.watcher = watch(this.pagesDir, { recursive: true }, (_e, name) => {
        if (this.importing) return
        // git's own files (a fetch writes many): not pages
        if (typeof name === 'string' && /^\.git([\\/]|$)/.test(name)) return
        if (this.quietDepth) return void (this.rescanAfter = true)
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => this.rescan(), 250)
      })
    } catch {
      // Some file systems can't be watched: pages written by the app still index right away.
    }
  }

  // A change seen in the folder: read again behind, one read at a time.
  private rescan(): void {
    if (this.scanning || this.quietDepth) return void (this.rescanAfter = true)
    this.scanning = true
    const gen = this.gen
    void this.scanAsync()
      .then((changed) => {
        if (changed && gen === this.gen) (this.writeIndex(), this.onChange())
      })
      .catch((e: unknown) => console.error('[wiki]', e))
      .finally(() => {
        this.scanning = false
        if (this.rescanAfter && gen === this.gen && !this.quietDepth) (this.rescanAfter = false), this.rescan()
      })
  }

  // Brings the index in line with the folder. True when something changed.
  scan(): boolean {
    const found: [string, number][] = walk(this.pagesDir, this.isPage).map((file) => [file, Math.round(statSync(join(this.pagesDir, file)).mtimeMs)])
    const logs: string[] = []
    const changed = this.tx(() => this.applyFiles(found, false, logs))
    const left = this.tx(() => this.removeMissing(found, new Set(), false, logs))
    this.appendLog(...logs)
    return changed || left
  }

  // The same without blocking: the folder is read in the background, and the index brought in line
  // a few hundred files at a time (each batch one transaction), with a turn for the rest between.
  async scanAsync(): Promise<boolean> {
    const gen = this.gen
    const found = await walkTimes(this.pagesDir, this.isPage)
    const logs: string[] = []
    const gone = new Set<string>()
    let changed = false
    for (let i = 0; i < found.length; i += 200) {
      if (gen !== this.gen) return false
      if (this.tx(() => this.applyFiles(found.slice(i, i + 200), true, logs, gone))) changed = true
      await new Promise((r) => setImmediate(r))
    }
    if (gen !== this.gen) return false
    if (this.tx(() => this.removeMissing(found, gone, true, logs))) changed = true
    this.appendLog(...logs)
    return changed
  }

  // `late`: the files were listed a moment ago, so what the app wrote since is checked again
  // instead of taken for a change made outside (or for a page that left the folder).
  private applyFiles(found: [string, number][], late: boolean, logs: string[], gone = new Set<string>()): boolean {
    let changed = false
    for (const [file, seen] of found) {
      const path = join(this.pagesDir, file)
      const k = this.db.prepare('SELECT hash, mtime FROM pages WHERE file = ?').get(file) as { hash: string; mtime: number } | undefined
      let mtime = seen
      if (late && k?.mtime !== mtime) {
        try {
          mtime = Math.round(statSync(path).mtimeMs)
        } catch {
          gone.add(file) // deleted since: it leaves the index below
          continue
        }
      }
      if (k && k.mtime === mtime) continue
      const text = readFileSync(path, 'utf8')
      if (k && k.hash === sha(text)) {
        this.db.prepare('UPDATE pages SET mtime = ? WHERE file = ?').run(mtime, file)
        continue
      }
      const before = k ? this.bodyOf(file) : null
      this.indexFile(file, text, mtime, 'outside')
      this.version(this.titleOf(file, text), 'outside', k ? 'edit' : 'create', before, parsePage(text).body)
      logs.push(k ? L(`[[${this.titleOf(file, text)}]] mudou fora do Tucano`, `[[${this.titleOf(file, text)}]] changed outside Tucano`) : L(`[[${this.titleOf(file, text)}]] apareceu na pasta`, `[[${this.titleOf(file, text)}]] showed up in the folder`))
      changed = true
    }
    return changed
  }

  // The pages indexed but no longer in the folder.
  private removeMissing(found: [string, number][], gone: Set<string>, late: boolean, logs: string[]): boolean {
    const listed = new Set(found.map(([f]) => f))
    let changed = false
    for (const { file } of this.db.prepare('SELECT file FROM pages').all() as { file: string }[]) {
      if (listed.has(file) && !gone.has(file)) continue
      if (late && existsSync(join(this.pagesDir, file))) continue // written by the app after the listing
      const title = (this.db.prepare('SELECT title FROM pages WHERE file = ?').get(file) as { title: string } | undefined)?.title ?? file
      this.version(title, 'outside', 'delete', this.bodyOf(file), null)
      logs.push(L(`${title} saiu da pasta`, `${title} left the folder`))
      this.unindex(file)
      this.release(title, true)
      changed = true
    }
    return changed
  }

  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // A page is called by its file's name, as in Obsidian (that's what [[links]] point to).
  private titleOf(file: string, _text?: string): string {
    return file.split('/').pop()!.replace(/\.md$/, '')
  }
  // Its kind: the tipo it says; else the folder it's in (an Obsidian vault's "Clientes/"); else its first tag.
  private kindOf(file: string, meta: Record<string, string>, own = true): string {
    const said = own ? meta['tipo'] || meta['type'] || meta['kind'] : ''
    if (said) return said
    const folder = file.includes('/') ? file.split('/')[0]! : ''
    if (folder) return folder
    const tag = (meta['tags'] || meta['tag'] || '').split(',')[0]?.trim().replace(/^#/, '').split('/').pop()
    return tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : KIND_OTHER()
  }
  private bodyOf(file: string): string | null {
    return (this.db.prepare('SELECT body FROM pages WHERE file = ?').get(file) as { body: string } | undefined)?.body ?? null
  }

  private indexFile(file: string, text: string, mtime: number, by: string): void {
    this.indexed++
    const { meta, body } = parsePage(text)
    const title = this.titleOf(file, text)
    this.unindex(file)
    this.db.prepare('INSERT INTO pages (file, title, key, kind, summary, body, hash, mtime, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(file, title, pageKey(title), this.kindOf(file, meta), summaryOf(body), body, sha(text), mtime, Date.now(), by)
    this.indexLinks(file, { meta, body })
    for (const c of chunks(body)) this.db.prepare('INSERT INTO fts (title, body, file) VALUES (?, ?, ?)').run(title, c, file)
  }
  // The pages a page links to, by their keys (see pageKey: "[[ÍNSULA]]" is the page Ínsula, past what
  // SQLite's lower() folds). Links in the properties count too, as in Obsidian (cliente: "[[Marcos Lima]]").
  private indexLinks(file: string, { meta, body }: { meta: Record<string, string>; body: string }): void {
    this.db.prepare('DELETE FROM links WHERE src = ?').run(file)
    for (const target of new Set([...linksIn(body), ...linksIn(Object.values(meta).join('\n'))].map(pageKey))) this.db.prepare('INSERT INTO links (src, target) VALUES (?, ?)').run(file, target)
  }
  private unindex(file: string): void {
    this.indexed++
    this.db.prepare('DELETE FROM pages WHERE file = ?').run(file)
    this.db.prepare('DELETE FROM links WHERE src = ?').run(file)
    this.db.prepare('DELETE FROM fts WHERE file = ?').run(file)
  }
  private version(title: string, by: string, action: WikiVersion['action'], before: string | null, after: string | null, reason?: string, sourceId?: string): void {
    const at = Date.now()
    this.db.prepare('INSERT INTO versions (title, key, at, by, action, before, after, reason, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(title, pageKey(title), at, by, action, before, after, reason ?? null, sourceId ?? null)
    if (action === 'delete') return
    const [origin, privateTo] = this.originOf(by, sourceId)
    this.db.prepare('INSERT INTO provenance (title, at, origin, private_to) VALUES (?, ?, ?, ?)').run(pageKey(title), at, origin, privateTo)
  }

  // Where a version came from: a DM (whose: only they read it), a channel, a file, a link or a note
  // brought in, a hand, another app. '?' is "may have come from a DM": not known any more.
  private originOf(by: string, sourceId?: string): [string, string | null] {
    if (sourceId) {
      const src = this.source(sourceId)
      if (!src) return ['source', '?']
      const conv = src.origin.conversationId
      if (!conv) return [src.kind, null]
      const dm = this.deps.dmOf?.(conv)
      return dm ? ['dm', dm] : dm === null ? ['channel', null] : ['conversation', '?']
    }
    if (by === 'outside' || by === 'import' || by === 'review') return [by, null]
    return by === 'auto' ? ['auto', '?'] : ['hand', null]
  }

  // ---------- pages held for one person ----------

  // The Tucano got its second person: the pages that hold what came from its owner's DMs (all its
  // DMs were theirs) stay theirs alone until they release each one. What a page's history says
  // decides it: where each version came from (kept since then), and before that, each version's
  // source; a version that may have come from a DM counts as one. Returns the pages held.
  inherit(owner: string, at = Date.now()): string[] {
    const held: string[] = []
    for (const p of this.list()) {
      const key = pageKey(p.title)
      const kept = this.db.prepare('SELECT 1 FROM provenance WHERE title = ? AND private_to IS NOT NULL LIMIT 1').get(key)
      const old = (this.db.prepare('SELECT by, source_id FROM versions WHERE key = ?').all(key) as { by: string; source_id: string | null }[]).some((v) => {
        if (!v.source_id) return v.by === 'auto'
        const src = this.source(v.source_id)
        const conv = src?.origin.conversationId
        if (!src) return true
        return !!conv && this.deps.dmOf?.(conv) !== null
      })
      if (!kept && !old) continue
      this.hold(key, owner, at)
      held.push(p.title)
    }
    // Where the log stood: what it says from here on is the team's; before, the owner's.
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('logAtSwitch', String(this.logLines().length))
    if (held.length) this.onChange()
    return held
  }

  // A page held for someone (its key), and written down as ever held (see everHeld).
  private hold(key: string, person: string, at = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO held (title, person, at) VALUES (?, ?, ?)').run(key, person, at)
    this.db.prepare('INSERT OR IGNORE INTO held_log (title, person) VALUES (?, ?)').run(key, person)
  }

  // The keys (see pageKey) of the pages held for someone other than `person`: out of their view.
  heldTitles(person?: string): Set<string> {
    const rows = this.db.prepare('SELECT title, person FROM held').all() as { title: string; person: string }[]
    return new Set(rows.filter((r) => r.person !== person).map((r) => r.title))
  }

  // Every key ever held for someone other than `person`, released ones apart: a held page deleted or
  // renamed leaves its title here, so nothing that names it (the log) reaches anyone else.
  everHeld(person?: string): Set<string> {
    const rows = this.db.prepare('SELECT title, person FROM held_log').all() as { title: string; person: string }[]
    return new Set(rows.filter((r) => r.person !== person).map((r) => r.title))
  }

  // Every page held, by its key, with whom for (to carry the holds into another folder's index).
  heldKeys(): { key: string; person: string }[] {
    return (this.db.prepare('SELECT title, person FROM held').all() as { title: string; person: string }[]).map((r) => ({ key: r.title, person: r.person }))
  }
  holdKey(key: string, person: string): void {
    this.hold(key, person)
  }
  // The files (relative to the wiki's folder, with /) of the pages held for anyone: never committed to git.
  heldFiles(): string[] {
    const held = new Set(this.heldKeys().map((h) => h.key))
    return (this.db.prepare('SELECT file, key FROM pages').all() as { file: string; key: string }[]).filter((r) => held.has(r.key)).map((r) => relative(this.dir, join(this.pagesDir, r.file)).split(sep).join('/'))
  }

  // The pages held, that still exist (`person`: only the ones held for them), by their titles.
  held(person?: string): { title: string; at: number }[] {
    const rows = new Map((this.db.prepare('SELECT title, person, at FROM held').all() as { title: string; person: string; at: number }[]).filter((r) => person === undefined || r.person === person).map((r) => [r.title, Number(r.at)]))
    return this.list().flatMap((p) => (rows.has(pageKey(p.title)) ? [{ title: p.title, at: rows.get(pageKey(p.title))! }] : []))
  }

  // "Liberar pro time": the page is everyone's from now on. `gone`: the page went, and what was
  // held of it stays its person's (its versions), so a page made later under that name is seen.
  release(title: string, gone = false): boolean {
    const key = pageKey(title)
    const row = this.db.prepare('SELECT person FROM held WHERE title = ?').get(key) as { person: string } | undefined
    if (!row) return false
    if (gone) this.db.prepare('UPDATE versions SET held_for = ? WHERE key = ? AND held_for IS NULL').run(row.person, key)
    else this.db.prepare('DELETE FROM held_log WHERE title = ?').run(key) // released: its name is the team's, log lines and all
    this.db.prepare('DELETE FROM held WHERE title = ?').run(key)
    this.onChange()
    return true
  }

  // The wiki as someone reads it: the pages in `hidden` (keys) aren't there, nor anything that
  // names them (links from them, the log's lines, the map). `viewer`: who reads (what was held for
  // them of a page gone is theirs); `afterSwitch`: the log from the heritage on only; `everHidden`:
  // keys (ever held, see everHeld) no log line may name, even of a page gone or renamed since.
  view(hidden: Set<string>, opts: { viewer?: string; afterSwitch?: boolean; everHidden?: Set<string> } = {}): WikiView {
    const from = opts.afterSwitch ? Number((this.db.prepare("SELECT value FROM meta WHERE key = 'logAtSwitch'").get() as { value: string } | undefined)?.value ?? 0) : 0
    const unnamed = new Set([...hidden, ...(opts.everHidden ?? [])])
    if (!hidden.size && !unnamed.size && !from && opts.viewer === undefined) return this
    const shown = (t: string): boolean => !hidden.has(pageKey(t))
    const list = (): WikiPageInfo[] => this.list().filter((p) => shown(p.title))
    return {
      count: () => list().length,
      list,
      kinds: () => this.kinds(list()),
      page: (title) => {
        const p = shown(title) ? this.page(title) : undefined
        return p && { ...p, backlinks: p.backlinks.filter(shown), missing: [...new Set([...p.missing, ...p.links.filter((t) => !shown(t))])] }
      },
      search: (q, limit = 8) => this.search(q, limit, hidden),
      indexText: () => this.indexFor(list()),
      graph: () => {
        const g = this.graph()
        return { nodes: g.nodes.filter((n) => shown(n.title)), edges: g.edges.filter(([a, b]) => shown(a) && shown(b)) }
      },
      log: (limit = 30) =>
        this.logLines()
          .slice(from)
          .reverse()
          .filter((l) => ![...unnamed].some((k) => keyText(l).includes(k)))
          .slice(0, limit),
      recent: (limit = 12, sees = () => true, since) => this.recent(limit, sees, since, hidden, opts.viewer)
    }
  }

  // When a version was written, and of which page (its key: the page it's of now, renames and all).
  versionInfo(id: number): { at: number; title: string; key: string; heldFor?: string } | undefined {
    const r = this.db.prepare('SELECT at, title, key, held_for FROM versions WHERE id = ?').get(id) as { at: number; title: string; key: string; held_for: string | null } | undefined
    return r && { at: Number(r.at), title: String(r.title), key: String(r.key), ...(r.held_for ? { heldFor: String(r.held_for) } : {}) }
  }

  // The source a version came from, if any (see `sees` below).
  versionSource(id: number): string | undefined {
    const r = this.db.prepare('SELECT source_id FROM versions WHERE id = ?').get(id) as { source_id: string | null } | undefined
    return r?.source_id ?? undefined
  }

  // What a source gone for good left behind (its changes, their findings, the versions they wrote) goes too.
  dropOrphans(): void {
    const gone = (this.db.prepare('SELECT id FROM changes WHERE source_id IS NOT NULL AND source_id NOT IN (SELECT id FROM sources)').all() as { id: string }[]).map((r) => r.id)
    for (const id of gone) this.db.prepare('DELETE FROM findings WHERE change_id = ?').run(id)
    this.db.prepare('DELETE FROM changes WHERE source_id IS NOT NULL AND source_id NOT IN (SELECT id FROM sources)').run()
    this.db.prepare('DELETE FROM versions WHERE source_id IS NOT NULL AND source_id NOT IN (SELECT id FROM sources)').run()
  }

  // ---------- reading ----------

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n
  }

  list(): WikiPageInfo[] {
    return (this.db.prepare('SELECT title, kind, summary, updated_at, updated_by FROM pages ORDER BY title COLLATE NOCASE').all() as Record<string, unknown>[]).map((r) => ({
      title: String(r['title']),
      kind: String(r['kind']),
      summary: String(r['summary']),
      updatedAt: Number(r['updated_at']),
      updatedBy: String(r['updated_by'])
    }))
  }

  kinds(pages: WikiPageInfo[] = this.list()): string[] {
    return [...new Set(pages.map((p) => p.kind))].sort((a, b) => (a === KIND_OTHER() ? 1 : b === KIND_OTHER() ? -1 : a.localeCompare(b, locale())))
  }

  private fileFor(title: string): string | undefined {
    const r = this.db.prepare('SELECT file FROM pages WHERE key = ?').get(pageKey(title)) as { file: string } | undefined
    return r?.file
  }

  page(title: string): WikiPage | undefined {
    const file = this.fileFor(title)
    if (!file) return undefined
    const path = join(this.pagesDir, file)
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf8')
    const { meta, body } = parsePage(text)
    const r = this.db.prepare('SELECT title, kind, updated_at, updated_by FROM pages WHERE file = ?').get(file) as Record<string, unknown>
    const backlinks = (this.db.prepare('SELECT DISTINCT p.title FROM links l JOIN pages p ON p.file = l.src WHERE l.target = ? AND l.src != ? ORDER BY p.title').all(pageKey(String(r['title'])), file) as { title: string }[]).map((x) => x.title)
    const known = new Set(this.list().map((p) => pageKey(p.title)))
    return {
      title: String(r['title']),
      kind: String(r['kind']),
      summary: summaryOf(body),
      body,
      meta,
      hash: sha(text),
      updatedAt: Number(r['updated_at']),
      updatedBy: String(r['updated_by']),
      links: linksIn(body),
      missing: linksIn(body).filter((t) => !known.has(pageKey(t))),
      backlinks,
      file: relative(this.dir, join(this.pagesDir, file)).split(sep).join('/')
    }
  }

  // `skip`: titles (lowercase) left out, as if they weren't there.
  search(q: string, limit = 8, skip?: Set<string>): WikiHit[] {
    const run = (match: string): WikiHit[] =>
      match
        ? (this.db
            .prepare(`SELECT p.title, p.kind, snippet(fts, 1, '**', '**', '…', 18) AS snip, bm25(fts, 6.0, 1.0) AS rank FROM fts JOIN pages p ON p.file = fts.file WHERE fts MATCH ? ORDER BY rank LIMIT ?`)
            .all(match, (limit + (skip?.size ?? 0)) * 3) as Record<string, unknown>[])
            .map((r) => ({ title: String(r['title']), kind: String(r['kind']), snippet: plainSnippet(String(r['snip'])) }))
            .filter((h) => !skip?.has(pageKey(h.title)))
        : []
    let hits: WikiHit[] = []
    try {
      hits = run(ftsQuery(q))
      if (!hits.length) hits = run(ftsQuery(q, true))
    } catch {
      hits = []
    }
    const seen = new Set<string>()
    return hits.filter((h) => !seen.has(h.title) && seen.add(h.title)).slice(0, limit)
  }

  // `sees`: whether the one asking may see what came from a source (a DM's is its person's alone).
  // `since`: only versions from then on (what came before is someone else's to see). `viewer`: who
  // asks (the versions held for someone else of a page gone aren't theirs).
  history(title: string, sees: (sourceId: string) => boolean = () => true, since = 0, viewer?: string): WikiVersion[] {
    return (this.db.prepare('SELECT * FROM versions WHERE key = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT 100').all(pageKey(title), since) as Record<string, unknown>[]).filter((r) => (!r['source_id'] || sees(String(r['source_id']))) && (viewer === undefined || !r['held_for'] || r['held_for'] === viewer)).map((r) => ({
      id: Number(r['id']),
      title: String(r['title']),
      at: Number(r['at']),
      by: String(r['by']),
      action: String(r['action']) as WikiVersion['action'],
      before: r['before'] == null ? null : String(r['before']),
      after: r['after'] == null ? null : String(r['after']),
      ...(r['reason'] ? { reason: String(r['reason']) } : {})
    }))
  }

  schema(): string {
    const p = join(this.dir, SCHEMA)
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }
  saveSchema(text: string): void {
    this.writable()
    writeFileSync(join(this.dir, SCHEMA), text)
    this.deps.onWrite?.({ title: SCHEMA.replace(/\.md$/, ''), byName: '' })
    this.onChange()
  }

  indexText(): string {
    const p = join(this.dir, INDEX)
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }

  // The latest lines of the log, newest first. Read again only when the file changed: it only grows.
  log(limit = 30): string[] {
    const lines = this.logLines()
    if (this.logShown?.from !== lines || this.logShown.limit !== limit) this.logShown = { from: lines, limit, list: lines.slice(-limit).reverse() }
    return this.logShown.list
  }
  private logShown?: { from: string[]; limit: number; list: string[] }
  // All of the log's lines, oldest first.
  private logLines(): string[] {
    const p = join(this.dir, LOG)
    let key: string
    try {
      const st = statSync(p)
      key = `${p}|${st.mtimeMs}|${st.size}`
    } catch {
      return []
    }
    if (this.logKept?.key === key) return this.logKept.lines
    const lines = readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2))
    this.logKept = { key, lines }
    return lines
  }

  // ---------- writing ----------

  // Creates or changes a page. expectedHash: the copy the change was made on; a page that moved on since is refused.
  save(p: { title: string; body: string; kind?: string; by: string; byName: string; expectedHash?: string; rename?: string; reason?: string; sourceId?: string }): WikiPage {
    this.writable()
    const title = cleanTitle(p.title)
    if (!title) throw new Error(L('A página precisa de um título.', 'The page needs a title.'))
    if (p.rename !== undefined) p = { ...p, rename: cleanTitle(p.rename) }
    // Its file is its title: one longer than a file name holds would be cut, and be another page.
    if (title.length > 120 || Buffer.byteLength(title) > 200) throw new Error(L('Título longo demais: use até 120 caracteres.', 'Title too long: use up to 120 characters.'))
    const oldFile = this.fileFor(p.rename ?? title)
    // a page in a folder stays in it, renamed or not
    const folder = oldFile?.includes('/') ? oldFile.slice(0, oldFile.lastIndexOf('/') + 1) : ''
    // the same title in another spelling of its letters (a file named in NFD, as a Mac may write it):
    // the file keeps its own name, so the folder (and a git repository) sees an edit, not a rename
    const file = oldFile && this.titleOf(oldFile).normalize('NFC') === title ? oldFile : folder + fileOf(title)
    const existing = oldFile ? readFileSync(join(this.pagesDir, oldFile), 'utf8') : undefined
    if (existing !== undefined && p.expectedHash !== undefined && sha(existing) !== p.expectedHash) throw new WikiConflict()
    if (existing === undefined && p.expectedHash) throw new WikiConflict()
    const other = this.fileFor(title)
    if (other && other !== oldFile) throw new Error(L(`Já existe uma página chamada "${title}".`, `There's already a page called "${title}".`))
    // A new page whose title is another spelling of one that's there ("A/b" for "A-b", "foo" for
    // "Foo") isn't that page: one never overwrites the other.
    if (oldFile && !p.rename && p.expectedHash === undefined && this.titleOf(oldFile) !== title) {
      const there = this.titleOf(oldFile)
      throw new Error(L(`Já existe uma página chamada "${there}".`, `There's already a page called "${there}".`))
    }
    const day = new Date().toISOString().slice(0, 10)
    const prev = existing ? parsePage(existing).meta : {}
    const body = p.body.replace(/\r\n/g, '\n').trimEnd() + '\n'
    // A page Tucano writes says its kind and dates; one that came from elsewhere keeps its
    // frontmatter as it was, and only gets a kind when it's changed to one it didn't have.
    const set: Record<string, string> = {}
    if (existing === undefined) Object.assign(set, { tipo: p.kind || KIND_OTHER(), criada: day, atualizada: day })
    else {
      if (p.kind && p.kind !== this.kindOf(file, prev, !!prev['tipo'])) set['tipo'] = p.kind
      if ('atualizada' in prev) set['atualizada'] = day
    }
    const text = withFront(existing, set, body)
    if (oldFile && oldFile !== file) {
      renameSync(join(this.pagesDir, oldFile), join(this.pagesDir, file)) // Obsidian's links by name follow it
      this.unindex(oldFile)
      // Where it came from, whom it's held for and its history go with it.
      const [was, now] = [pageKey(this.titleOf(oldFile)), pageKey(title)]
      if (was !== now) {
        this.db.prepare('UPDATE provenance SET title = ? WHERE title = ?').run(now, was)
        this.db.prepare('UPDATE OR REPLACE held SET title = ? WHERE title = ?').run(now, was)
        this.db.prepare('INSERT OR IGNORE INTO held_log (title, person) SELECT ?, person FROM held_log WHERE title = ?').run(now, was) // the old name stays unnamed too
        this.db.prepare('UPDATE versions SET key = ? WHERE key = ?').run(now, was)
      }
    }
    writeFileSync(join(this.pagesDir, file), text)
    this.indexFile(file, text, Math.round(statSync(join(this.pagesDir, file)).mtimeMs), p.by)
    const before = existing !== undefined ? parsePage(existing).body : null
    this.version(title, p.by, existing === undefined ? 'create' : 'edit', before, parsePage(text).body, p.reason, p.sourceId)
    this.appendLog(existing === undefined ? L(`**${p.byName}** criou [[${title}]]`, `**${p.byName}** created [[${title}]]`) : p.rename && p.rename !== title ? L(`**${p.byName}** renomeou [[${p.rename}]] pra [[${title}]]`, `**${p.byName}** renamed [[${p.rename}]] to [[${title}]]`) : L(`**${p.byName}** editou [[${title}]]`, `**${p.byName}** edited [[${title}]]`))
    this.writeIndex()
    this.deps.onWrite?.({ title, byName: p.byName })
    this.onChange()
    return this.page(title)!
  }

  remove(raw: string, by: string, byName: string, sourceId?: string): void {
    const title = cleanTitle(raw) // as save and rename keep it: what the history and the log say
    const file = this.fileFor(title)
    if (!file) return
    this.writable()
    const path = join(this.pagesDir, file)
    const before = existsSync(path) ? parsePage(readFileSync(path, 'utf8')).body : this.bodyOf(file)
    if (existsSync(path)) rmSync(path)
    this.unindex(file)
    this.version(title, by, 'delete', before, null, undefined, sourceId)
    this.release(title, true)
    this.appendLog(L(`**${byName}** apagou ${title}`, `**${byName}** deleted ${title}`))
    this.writeIndex()
    this.deps.onWrite?.({ title, byName })
    this.onChange()
  }

  // An Obsidian vault (or any folder of Markdown) brought in as it is: notes, folders and
  // attachments copied under the pages, untouched; the vault itself stays where it was. A file
  // already here isn't overwritten. The agents read it all from then on.
  importVault(src: string, byName: string): WikiImport {
    this.writable()
    const from = resolve(src)
    if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(L('Essa pasta não existe.', "That folder doesn't exist."))
    if (from === resolve(this.dir) || resolve(this.pagesDir).startsWith(from + sep) || from.startsWith(resolve(this.dir) + sep)) throw new Error(L('Essa pasta é a própria wiki, ou está dentro dela.', "That folder is the wiki itself, or inside it."))
    const files = walk(from)
    const notes = files.filter((f) => f.endsWith('.md'))
    if (!notes.length) throw new Error(L('Não achei nenhuma nota (.md) nessa pasta.', 'I found no notes (.md) in that folder.'))
    const skipped: string[] = []
    const copied: string[] = []
    this.importing = true
    try {
      for (const f of files) {
        const to = join(this.pagesDir, f)
        if (existsSync(to)) {
          skipped.push(f)
          continue
        }
        mkdirSync(join(to, '..'), { recursive: true })
        copyFileSync(join(from, f), to)
        copied.push(f)
      }
      for (const f of copied.filter((x) => x.endsWith('.md'))) {
        const text = readFileSync(join(this.pagesDir, f), 'utf8')
        this.indexFile(f, text, Math.round(statSync(join(this.pagesDir, f)).mtimeMs), 'import')
        this.version(this.titleOf(f), 'import', 'create', null, parsePage(text).body, L('importada do Obsidian', 'imported from Obsidian'))
      }
    } finally {
      this.importing = false
    }
    const pages = copied.filter((f) => f.endsWith('.md'))
    const graph = this.graph()
    const kinds = new Map<string, number>()
    for (const f of pages) {
      const k = (this.db.prepare('SELECT kind FROM pages WHERE file = ?').get(f) as { kind: string } | undefined)?.kind
      if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1)
    }
    const name = basename(from)
    this.appendLog(L(`**${byName}** importou ${pages.length} ${pages.length === 1 ? 'nota' : 'notas'} de ${name}`, `**${byName}** imported ${pages.length} ${pages.length === 1 ? 'note' : 'notes'} from ${name}`))
    this.writeIndex()
    this.deps.onWrite?.({ title: L(`${pages.length} notas de ${name}`, `${pages.length} notes from ${name}`), byName })
    this.onChange()
    return {
      from: name ?? from,
      pages: pages.length,
      attachments: copied.length - pages.length,
      skipped,
      links: graph.edges.length,
      missing: graph.nodes.filter((n) => n.missing).length,
      kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1])
    }
  }

  // Puts a page back as it was after a version (or before it, for a deletion). `reheld`: the text
  // came from a DM (the version was held, or its provenance says so) and the page wasn't held: it is
  // now, for that person, instead of that text going public under a name someone else may have taken.
  restore(versionId: number, by: string, byName: string): WikiPage & { reheld?: boolean } {
    const v = this.db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId) as Record<string, unknown> | undefined
    if (!v) throw new Error(L('Essa versão não existe mais.', 'That version no longer exists.'))
    const body = v['action'] === 'delete' ? v['before'] : v['after']
    if (body == null) throw new Error(L('Não há texto pra restaurar nessa versão.', 'There is no text to restore in that version.'))
    // The page as it's called now (it may have been renamed since that version).
    const current = (this.db.prepare('SELECT title FROM pages WHERE key = ?').get(String(v['key'])) as { title: string } | undefined)?.title
    const page = current ? this.page(current) : undefined
    const saved = this.save({ title: current ?? String(v['title']), body: String(body), by, byName, ...(page ? { expectedHash: page.hash } : {}), reason: L('restaurou uma versão anterior', 'restored an earlier version') })
    // Whose the text is: the person it was held for, or the DM's (unknown: whoever restores, the owner).
    const team = !!this.getMeta('logAtSwitch') // only once there are people to hold pages from
    const origin = team ? (this.db.prepare('SELECT private_to FROM provenance WHERE title = ? AND at = ? AND private_to IS NOT NULL').get(String(v['key']), Number(v['at'])) as { private_to: string } | undefined) : undefined
    const whose = v['held_for'] ? String(v['held_for']) : origin ? (origin.private_to === '?' ? by : origin.private_to) : undefined
    const key = pageKey(saved.title)
    if (!whose || this.db.prepare('SELECT 1 FROM held WHERE title = ?').get(key)) return saved
    this.hold(key, whose)
    this.onChange()
    return { ...saved, reheld: true }
  }

  // Several lines at once, as a scan has them: the file is rewritten once, not once per page.
  private appendLog(...lines: string[]): void {
    if (!lines.length) return
    const when = new Date().toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })
    writeFileSync(join(this.dir, LOG), `${existsSync(join(this.dir, LOG)) ? readFileSync(join(this.dir, LOG), 'utf8').replace(/\n*$/, '\n') : ''}${lines.map((l) => `- ${when} · ${l}\n`).join('')}`)
  }

  // índice.md: every page by kind, with its first line. Kept by Tucano, read by the agents.
  private writeIndex(): void {
    const text = this.indexFor(this.list())
    const path = join(this.dir, INDEX)
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text)
  }

  // The index of these pages, as índice.md writes it.
  private indexFor(pages: WikiPageInfo[]): string {
    const byKind = new Map<string, WikiPageInfo[]>()
    for (const p of pages) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p])
    const head = L(`# Índice\n\n${pages.length === 1 ? '1 página' : `${pages.length} páginas`}. Mantido pelo Tucano: não precisa editar.\n`, `# Index\n\n${pages.length === 1 ? '1 page' : `${pages.length} pages`}. Kept by Tucano: no need to edit it.\n`)
    const body = this.kinds(pages)
      .map((k) => `\n## ${k}\n${byKind.get(k)!.map((p) => `- [[${p.title}]]${p.summary ? `: ${p.summary}` : ''}`).join('\n')}\n`)
      .join('')
    return head + body
  }

  // ---------- sources: what the wiki is made from, kept as it came ----------

  addSource(p: { title: string; text: string; kind: WikiSource['kind']; origin?: WikiSource['origin']; by: string; file?: { name: string; data: Buffer }; status?: WikiSource['status'] }): WikiSource {
    p = { ...p, title: cleanTitle(p.title) || L('Fonte', 'Source') }
    const at = Date.now()
    const d = new Date(at)
    const stamp = `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    // The title is what gets cut, never the number that tells two apart: this always ends.
    const base = fileOf(`${stamp} ${p.title}`).slice(0, -3)
    let file = `${base}.md`
    for (let k = 2; existsSync(join(this.dir, SOURCES, file)); k++) file = `${base} ${k}.md`
    const origin: WikiSource['origin'] = { ...(p.origin ?? {}) }
    // The file as it came, next to its text: fontes/arquivos/<date> <name>.
    if (p.file) {
      mkdirSync(join(this.dir, SOURCES, 'arquivos'), { recursive: true })
      const safe = clip(p.file.name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/^\.+/, ''), 120, 180) || 'arquivo'
      let name = `${stamp} ${safe}`
      for (let k = 2; existsSync(join(this.dir, SOURCES, 'arquivos', name)); k++) name = `${stamp} ${k} ${safe}`
      writeFileSync(join(this.dir, SOURCES, 'arquivos', name), p.file.data)
      origin.original = `${SOURCES}/arquivos/${name}`
    }
    const meta: Record<string, string> = { tipo: L('fonte', 'source'), origem: p.kind, adicionada: d.toISOString().slice(0, 16).replace('T', ' '), ...(origin.url ? { link: origin.url } : {}), ...(origin.original ? { arquivo: `[[${origin.original}]]` } : {}) }
    writeFileSync(join(this.dir, SOURCES, file), pageText(meta, `# ${p.title}\n\n${p.text.trim()}\n`))
    const src: WikiSource = { id: sha(file + at), file: `${SOURCES}/${file.replace(/\.md$/, '')}`, title: p.title, kind: p.kind, origin, addedBy: p.by, addedAt: at, ...(p.status ? { status: p.status } : {}) }
    this.db.prepare('INSERT INTO sources (id, file, title, kind, origin, added_by, added_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(src.id, src.file, src.title, src.kind, JSON.stringify(src.origin), src.addedBy, src.addedAt, p.status ?? null)
    this.onChange()
    return src
  }

  private toSource(r: Record<string, unknown>): WikiSource {
    return {
      id: String(r['id']),
      file: String(r['file']),
      title: String(r['title']),
      kind: String(r['kind']) as WikiSource['kind'],
      origin: JSON.parse(String(r['origin'])) as WikiSource['origin'],
      addedBy: String(r['added_by']),
      addedAt: Number(r['added_at']),
      ...(r['status'] ? { status: String(r['status']) as WikiSource['status'] } : {}),
      ...(r['error'] ? { error: String(r['error']) } : {}),
      ...(r['changes'] != null ? { changes: Number(r['changes']) } : {})
    }
  }
  setSourceStatus(id: string, status: NonNullable<WikiSource['status']>, p: { error?: string; changes?: number } = {}): void {
    this.db.prepare('UPDATE sources SET status = ?, error = ?, changes = ? WHERE id = ?').run(status, p.error ?? null, p.changes ?? null, id)
    this.onChange()
  }
  // Where a source's original file is, on disk (to open it).
  originalPath(id: string): string | undefined {
    const s = this.source(id)
    return s?.origin.original ? join(this.dir, s.origin.original) : undefined
  }

  sources(limit = 100): WikiSource[] {
    return (this.db.prepare('SELECT * FROM sources ORDER BY added_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => this.toSource(r))
  }
  source(idOrFile: string): (WikiSource & { text: string }) | undefined {
    const r = this.db.prepare('SELECT * FROM sources WHERE id = ? OR file = ?').get(idOrFile, idOrFile) as Record<string, unknown> | undefined
    if (!r) return undefined
    const src = this.toSource(r)
    const path = join(this.dir, `${src.file}.md`)
    return { ...src, text: existsSync(path) ? parsePage(readFileSync(path, 'utf8')).body : '' }
  }

  // A source gone for good: its text and the file as it came, and the changes made of it with the
  // versions they wrote (the pages made from it stay; they are the team's). Its messages count as read no more.
  removeSource(id: string): boolean {
    const src = this.source(id)
    if (!src) return false
    rmSync(join(this.dir, `${src.file}.md`), { force: true })
    if (src.origin.original) rmSync(join(this.dir, src.origin.original), { force: true })
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(src.id)
    this.dropOrphans()
    this.onChange()
    return true
  }

  // What was deleted leaves the index's file too (after a purge took someone's sources).
  scrub(): void {
    this.db.exec('VACUUM')
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // not in WAL mode: nothing to empty
    }
  }

  // ---------- conversations: how far the curator has read each one ----------

  // The messages of a conversation some source already holds.
  readMessages(conversationId: string): Set<string> {
    const rows = this.db.prepare('SELECT origin FROM sources WHERE origin LIKE ?').all(`%"conversationId":"${conversationId.replace(/[%_"]/g, '')}"%`) as { origin: string }[]
    return new Set(rows.flatMap((r) => (JSON.parse(r.origin) as WikiSource['origin']).messageIds ?? []))
  }

  // The pages and their links, for the map; a link to a page not written yet is a node too.
  // Made again only after the index changed.
  graph(): { nodes: { title: string; kind: string; links: number; missing?: boolean }[]; edges: [string, string][] } {
    if (this.graphKept?.at === this.indexed) return this.graphKept.graph
    const graph = this.makeGraph()
    this.graphKept = { at: this.indexed, graph }
    return graph
  }
  private makeGraph(): ReturnType<Wiki['graph']> {
    const pages = this.db.prepare('SELECT file, title, kind FROM pages').all() as { file: string; title: string; kind: string }[]
    const byFile = new Map(pages.map((p) => [p.file, p.title]))
    const byName = new Map(pages.map((p) => [pageKey(p.title), p.title]))
    const ghosts = new Map<string, string>()
    const edges: [string, string][] = []
    const seen = new Set<string>()
    for (const l of this.db.prepare('SELECT src, target FROM links').all() as { src: string; target: string }[]) {
      const a = byFile.get(l.src)
      if (!a) continue
      let b = byName.get(l.target)
      if (!b) {
        // a page nobody wrote yet, named as the link that points to it writes it
        b = ghosts.get(l.target) ?? this.linkAsWritten(l.src, l.target) ?? l.target
        ghosts.set(l.target, b)
      }
      const k = [a, b].sort().join('\n')
      if (a === b || seen.has(k)) continue
      seen.add(k)
      edges.push([a, b])
    }
    const degree = new Map<string, number>()
    for (const [a, b] of edges) degree.set(a, (degree.get(a) ?? 0) + 1), degree.set(b, (degree.get(b) ?? 0) + 1)
    return {
      nodes: [...pages.map((p) => ({ title: p.title, kind: p.kind, links: degree.get(p.title) ?? 0 })), ...[...ghosts.values()].map((t) => ({ title: t, kind: '', links: degree.get(t) ?? 0, missing: true }))],
      edges
    }
  }

  private linkAsWritten(file: string, target: string): string | undefined {
    const text = existsSync(join(this.pagesDir, file)) ? readFileSync(join(this.pagesDir, file), 'utf8') : ''
    return linksIn(text).find((t) => pageKey(t) === target)
  }

  // The latest changes to any page, newest first.
  // `skip`: keys of pages left out (held for someone else); `viewer`: as in history.
  recent(limit = 12, sees: (sourceId: string) => boolean = () => true, since = 0, skip?: Set<string>, viewer?: string): Omit<WikiVersion, 'before' | 'after'>[] {
    return (this.db.prepare('SELECT id, title, key, at, by, action, reason, source_id, held_for FROM versions WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?').all(since, (limit + (skip?.size ?? 0)) * 4) as Record<string, unknown>[])
      .filter((r) => (!r['source_id'] || sees(String(r['source_id']))) && !skip?.has(String(r['key'])) && (viewer === undefined || !r['held_for'] || r['held_for'] === viewer))
      .slice(0, limit).map((r) => ({ id: Number(r['id']), title: String(r['title']), at: Number(r['at']), by: String(r['by']), action: String(r['action']) as WikiVersion['action'], ...(r['reason'] ? { reason: String(r['reason']) } : {}) }))
  }

  sourceCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n
  }

  mark(conversationId: string): number {
    return (this.db.prepare('SELECT until FROM marks WHERE conversation_id = ?').get(conversationId) as { until: number } | undefined)?.until ?? 0
  }
  setMark(conversationId: string, until: number): void {
    this.db.prepare('INSERT INTO marks (conversation_id, until) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET until = excluded.until').run(conversationId, until)
  }

  // ---------- change packages: what the curator wants to write, applied or waiting for you ----------

  // Records a package on the pages as they are now. The caller decides: apply it or leave it pending.
  getMeta(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ---------- what a review found ----------

  // Open: not dismissed, and its fix (if any) still waiting. A fix that went in or was refused closes it.
  findings(): WikiFinding[] {
    const rows = this.db.prepare("SELECT * FROM findings WHERE state = 'open' ORDER BY at, rowid").all() as Record<string, unknown>[]
    const out: WikiFinding[] = []
    for (const r of rows) {
      const change = r['change_id'] ? this.change(String(r['change_id'])) : undefined
      if (r['change_id'] && (!change || (change.state !== 'pending' && change.state !== 'conflict'))) continue
      out.push({ id: String(r['id']), at: Number(r['at']), kind: String(r['kind']) as WikiFinding['kind'], pages: JSON.parse(String(r['pages'])) as string[], text: String(r['text']), ...(r['name'] ? { name: String(r['name']) } : {}), ...(r['note'] ? { note: String(r['note']) } : {}), ...(change ? { change } : {}) })
    }
    return out
  }

  // A new review's findings take the place of the old ones; what was dismissed, or still waits, isn't said again.
  setFindings(list: (Omit<WikiFinding, 'id' | 'at' | 'change'> & { key: string; ops?: WikiOp[]; reason?: string })[]): void {
    // a fix refused counts as "leave it"
    const keep = new Set((this.db.prepare("SELECT key FROM findings WHERE state = 'dismissed' OR change_id IN (SELECT id FROM changes WHERE state = 'refused')").all() as { key: string }[]).map((r) => r.key))
    // What the resolver said about it, which is about the same finding however many times it's reviewed.
    const notes = new Map((this.db.prepare('SELECT key, note FROM findings WHERE note IS NOT NULL').all() as { key: string; note: string }[]).map((r) => [r.key, r.note]))
    for (const f of this.findings()) if (f.change) keep.add((this.db.prepare('SELECT key FROM findings WHERE id = ?').get(f.id) as { key: string }).key)
    this.db.prepare("DELETE FROM findings WHERE state = 'open' AND kind != 'git' AND (change_id IS NULL OR change_id NOT IN (SELECT id FROM changes WHERE state IN ('pending', 'conflict')))").run()
    const at = Date.now()
    for (const f of list) {
      if (keep.has(f.key)) continue
      keep.add(f.key)
      const change = f.ops?.length ? this.addChange({ ops: f.ops, by: 'review', ...(f.reason ? { reason: f.reason } : {}) }) : undefined
      this.db.prepare("INSERT INTO findings (id, key, at, kind, pages, text, name, change_id, state, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)").run(sha(f.key + at + Math.random()), f.key, at, f.kind, JSON.stringify(f.pages), f.text, f.name ?? null, change?.id ?? null, change ? null : (notes.get(f.key) ?? null))
    }
    this.onChange()
  }

  // What the git sync ran into (a conflict, a file too big, read-only), in Cuidados next to the
  // review's findings; a review doesn't replace it. Once per key while it's open.
  addNotice(n: { key: string; pages: string[]; text: string }): void {
    if (this.db.prepare("SELECT 1 FROM findings WHERE key = ? AND state = 'open'").get(n.key)) return
    this.db.prepare("INSERT INTO findings (id, key, at, kind, pages, text, name, change_id, state) VALUES (?, ?, ?, 'git', ?, ?, NULL, NULL, 'open')").run(sha(n.key + Date.now() + Math.random()), n.key, Date.now(), JSON.stringify(n.pages), n.text)
    this.onChange()
  }

  dismissFinding(id: string): void {
    const r = this.db.prepare('SELECT change_id FROM findings WHERE id = ?').get(id) as { change_id: string | null } | undefined
    if (!r) return
    this.db.prepare("UPDATE findings SET state = 'dismissed' WHERE id = ?").run(id)
    if (r.change_id) this.refuseChange(r.change_id)
    this.onChange()
  }

  // What the resolver made of a finding (src/core/wiki-resolver.ts): a change package that takes its
  // place, or what it found and couldn't settle, kept next to the finding so it's read where the
  // problem is. Nothing is written here: a package from a review or a resolver always waits for the
  // person, on automatic or not (see Wiki.applyWaiting).
  resolveFinding(id: string, answer: { ops?: WikiOp[]; note?: string; reason?: string }): WikiChange | undefined {
    const r = this.db.prepare('SELECT key, state FROM findings WHERE id = ?').get(id) as { key: string; state: string } | undefined
    if (!r || r.state !== 'open') return undefined
    const ops = answer.ops ?? []
    if (ops.length) {
      const change = this.addChange({ ops, by: 'review', ...(answer.reason ? { reason: answer.reason } : {}) })
      this.db.prepare('UPDATE findings SET change_id = ?, note = NULL WHERE id = ?').run(change.id, id)
      this.onChange()
      return change
    }
    const note = (answer.note ?? '').trim()
    if (!note) return undefined
    this.db.prepare('UPDATE findings SET note = ? WHERE id = ?').run(note, id)
    this.onChange()
    return undefined
  }

    addChange(p: { ops: WikiOp[]; sourceId?: string; by: string; reason?: string }): WikiChange {
    const base: Record<string, string | null> = {}
    for (const op of p.ops) base[op.page] = this.page(op.page)?.hash ?? null
    const id = sha(JSON.stringify(p.ops) + Date.now() + Math.random())
    this.db.prepare('INSERT INTO changes (id, source_id, at, by, state, ops, base, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, p.sourceId ?? null, Date.now(), p.by, 'pending', JSON.stringify(p.ops), JSON.stringify(base), p.reason ?? null)
    this.onChange()
    return this.change(id)!
  }

  private toChange(r: Record<string, unknown>): WikiChange {
    const sourceId = r['source_id'] ? String(r['source_id']) : undefined
    const src = sourceId ? this.source(sourceId) : undefined
    return {
      id: String(r['id']),
      at: Number(r['at']),
      by: String(r['by']),
      state: String(r['state']) as WikiChange['state'],
      ops: JSON.parse(String(r['ops'])) as WikiOp[],
      ...(r['reason'] ? { reason: String(r['reason']) } : {}),
      ...(src ? { source: { id: src.id, title: src.title, file: src.file } } : {}),
      ...(r['decided_at'] ? { decidedAt: Number(r['decided_at']) } : {})
    }
  }
  change(id: string): WikiChange | undefined {
    const r = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r && this.toChange(r)
  }
  changes(state?: WikiChange['state']): WikiChange[] {
    const rows = (state ? this.db.prepare('SELECT * FROM changes WHERE state = ? ORDER BY at DESC LIMIT 200').all(state) : this.db.prepare('SELECT * FROM changes ORDER BY at DESC LIMIT 200').all()) as Record<string, unknown>[]
    return rows.map((r) => this.toChange(r))
  }

  // Writes a package. A page that moved on since it was proposed stops it (nothing is written): it's a conflict.
  applyChange(id: string, byName: string): WikiChange {
    const r = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) throw new Error(L('Essa mudança não existe mais.', 'That change no longer exists.'))
    if (r['state'] !== 'pending' && r['state'] !== 'conflict') return this.toChange(r)
    this.writable()
    // One whose source went (taken back, purged) is gone with it: nothing of it gets written.
    if (r['source_id'] && !this.source(String(r['source_id']))) {
      this.dropOrphans()
      throw new Error(L('Essa mudança não existe mais.', 'That change no longer exists.'))
    }
    const ops = JSON.parse(String(r['ops'])) as WikiOp[]
    const base = JSON.parse(String(r['base'])) as Record<string, string | null>
    const by = String(r['by'])
    for (const [title, hash] of Object.entries(base)) {
      const now = this.page(title)?.hash ?? null
      if (now !== hash && !(hash === null && ops.every((o) => o.page !== title || o.op === 'create'))) {
        this.db.prepare("UPDATE changes SET state = 'conflict' WHERE id = ?").run(id)
        this.onChange()
        return this.change(id)!
      }
    }
    // Every page as it will be, worked out before anything is written.
    const next = new Map<string, { body: string; kind?: string; existed: boolean; hash?: string }>()
    for (const op of ops) {
      const cur = next.get(op.page) ?? (() => {
        const p = this.page(op.page)
        return p ? { body: p.body, kind: p.kind, existed: true, hash: p.hash } : { body: '', existed: false }
      })()
      next.set(op.page, { ...cur, body: applyOp(cur.body, op), ...(op.op === 'create' && op.kind && !cur.existed ? { kind: op.kind } : {}) })
    }
    const before: Record<string, string | null> = {}
    for (const [title, n] of next) {
      const p = this.page(title)
      before[title] = p ? p.body : null
      this.save({ title, body: n.body, ...(n.kind ? { kind: n.kind } : {}), by, byName, ...(p ? { expectedHash: p.hash } : {}), ...(r['reason'] ? { reason: String(r['reason']) } : {}), ...(r['source_id'] ? { sourceId: String(r['source_id']) } : {}) })
    }
    this.db.prepare("UPDATE changes SET state = 'applied', before = ?, decided_at = ? WHERE id = ?").run(JSON.stringify(before), Date.now(), id)
    this.onChange()
    return this.change(id)!
  }

  // A package that ran into a newer page, made again on the page as it is now. Null when a
  // passage it swaps is gone: then it has to be written again (the curator does it).
  rebaseChange(id: string): WikiChange | null {
    const c = this.change(id)
    if (!c || c.state !== 'conflict') return null
    const ops = c.ops.map((o): WikiOp => (o.op === 'create' && this.page(o.page) ? { op: 'append', page: o.page, ...(o.text ? { text: o.text } : {}) } : o))
    const bodies = new Map<string, string>()
    try {
      for (const o of ops) bodies.set(o.page, applyOp(bodies.get(o.page) ?? this.page(o.page)?.body ?? '', o))
    } catch {
      return null
    }
    this.db.prepare("UPDATE changes SET state = 'refused', decided_at = ? WHERE id = ?").run(Date.now(), id)
    return this.addChange({ ops, by: c.by, ...(c.source ? { sourceId: c.source.id } : {}), ...(c.reason ? { reason: c.reason } : {}) })
  }

  // Everything waiting goes in at once, oldest first (the review's fixes stay in Cuidados). One that
  // ran into a newer page, often the one before it in the list, is made again on it and goes in too;
  // one whose passage is gone stays, to redo by hand. Says how many went in and how many stayed.
  applyWaiting(byName: string, sees: (c: WikiChange) => boolean = () => true): { applied: number; left: number } {
    this.writable()
    const waiting = [...this.changes('pending'), ...this.changes('conflict')].filter((c) => c.by !== 'review' && sees(c)).sort((a, b) => a.at - b.at)
    let applied = 0
    let left = 0
    for (const c of waiting) {
      try {
        let r = c.state === 'pending' ? this.applyChange(c.id, byName) : c
        if (r.state === 'conflict') {
          const again = this.rebaseChange(r.id)
          r = again ? this.applyChange(again.id, byName) : r
        }
        if (r.state === 'applied') applied++
        else left++
      } catch {
        left++ // its source went: nothing of it is written
      }
    }
    return { applied, left }
  }

  refuseChange(id: string): void {
    this.db.prepare("UPDATE changes SET state = 'refused', decided_at = ? WHERE id = ? AND state IN ('pending', 'conflict')").run(Date.now(), id)
    this.onChange()
  }

  // Puts the pages back as they were before a package, unless they changed again since.
  undoChange(id: string, byName: string, by = 'me'): void {
    const r = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r || r['state'] !== 'applied' || !r['before']) return
    const before = JSON.parse(String(r['before'])) as Record<string, string | null>
    const sourceId = r['source_id'] ? String(r['source_id']) : undefined
    for (const [title, body] of Object.entries(before)) {
      if (body === null) this.remove(title, by, byName, sourceId)
      else {
        const p = this.page(title)
        this.save({ title, body, by, byName, ...(p ? { expectedHash: p.hash } : {}), reason: L('desfez uma mudança da wiki', 'undid a wiki change'), ...(sourceId ? { sourceId } : {}) })
      }
    }
    this.db.prepare("UPDATE changes SET state = 'undone', decided_at = ? WHERE id = ?").run(Date.now(), id)
    this.onChange()
  }
}

// One change on a page's body: write it whole, add under a section (made if missing), or swap an exact passage.
export function applyOp(body: string, op: WikiOp): string {
  const text = (op.text ?? '').trim()
  if (op.op === 'create') return body.trim() ? `${body.trimEnd()}\n\n${text}\n` : `${text}\n`
  if (op.op === 'replace') {
    if (!op.old || !body.includes(op.old)) throw new Error(L(`O trecho a trocar não está mais em "${op.page}".`, `The passage to swap is no longer in "${op.page}".`))
    return body.replace(op.old, op.new ?? '')
  }
  if (!op.section) return `${body.trimEnd()}\n\n${text}\n`
  const lines = body.replace(/\s+$/, '').split('\n')
  const head = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim().toLowerCase() === op.section!.trim().toLowerCase())
  if (head < 0) return `${body.trimEnd()}\n\n## ${op.section.trim()}\n${text}\n`
  let end = lines.length
  const level = /^#+/.exec(lines[head]!)![0].length
  for (let k = head + 1; k < lines.length; k++) if (/^#{1,6}\s/.test(lines[k]!) && /^#+/.exec(lines[k]!)![0].length <= level) (end = k), (k = lines.length)
  let at = end
  while (at > head + 1 && !lines[at - 1]!.trim()) at--
  lines.splice(at, 0, text)
  return `${lines.join('\n')}\n`
}

// ---------- the agents' tools: read the index, search, open a page ----------

export const WIKI_INDICE: ToolDef = {
  name: 'wiki_indice',
  get description() {
    return L(
      'Mostra o índice da wiki: todas as páginas, por tipo, com a primeira linha de cada uma. Comece por aqui pra saber o que já está escrito.',
      "Shows the wiki's index: every page, by kind, with its first line. Start here to see what's already written."
    )
  },
  inputSchema: { type: 'object', properties: {} }
}
export const WIKI_BUSCAR: ToolDef = {
  name: 'wiki_buscar',
  get description() {
    return L(
      'Busca nas páginas da wiki por palavras (acento não importa) e traz os trechos que batem, com o título de cada página. Depois abra a página com wiki_ler.',
      "Searches the wiki's pages by words (accents don't matter) and brings the matching parts, with each page's title. Then open the page with wiki_ler."
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: { busca: { type: 'string', description: L('Palavras que estariam na página, ex.: "orçamento reforma marcos".', 'Words that would be on the page, e.g. "quote renovation marcos".') } },
      required: ['busca']
    }
  }
}
export const WIKI_LER: ToolDef = {
  name: 'wiki_ler',
  get description() {
    return L('Abre uma página da wiki inteira, com as páginas que ela liga e as que citam ela.', 'Opens a whole wiki page, with the pages it links to and the ones that cite it.')
  },
  get inputSchema() {
    return { type: 'object' as const, properties: { pagina: { type: 'string', description: L('O título da página, como no índice.', 'The page title, as in the index.') } }, required: ['pagina'] }
  }
}
export const WIKI_TOOLS = [WIKI_INDICE, WIKI_BUSCAR, WIKI_LER]
export const WIKI_TOOL_NAMES = new Set(WIKI_TOOLS.map((t) => t.name))
const MAX_READ = 24_000

// One call: the text for the agent, and the step the reply shows.
export function wikiCall(wiki: Pick<Wiki, 'indexText' | 'search' | 'page' | 'count'>, name: string, args: Record<string, unknown>): { text: string; error?: boolean; step: { label: string; detail: string } } {
  if (name === WIKI_INDICE.name) {
    const text = wiki.indexText()
    return { text: text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…` : text, step: { label: L('Leu o índice da wiki', "Read the wiki's index"), detail: L(`${wiki.count()} páginas`, `${wiki.count()} pages`) } }
  }
  if (name === WIKI_BUSCAR.name) {
    const busca = typeof args['busca'] === 'string' ? args['busca'].trim() : ''
    if (!busca) return { text: L('Faltou o que buscar.', 'Missing what to search for.'), error: true, step: { label: L('Buscou na wiki', 'Searched the wiki'), detail: '' } }
    const hits = wiki.search(busca, 8)
    const step = { label: L('Buscou na wiki', 'Searched the wiki'), detail: `${busca} · ${hits.length === 1 ? L('1 página', '1 page') : L(`${hits.length} páginas`, `${hits.length} pages`)}` }
    if (!hits.length) return { text: L(`Nenhuma página com "${busca}". Tente outras palavras ou veja o índice; se não estiver lá, a wiki não diz: não invente.`, `No page with "${busca}". Try other words or look at the index; if it isn't there, the wiki doesn't say: don't make it up.`), step }
    return { text: hits.map((h) => `- [[${h.title}]] (${h.kind}): ${h.snippet.replace(/\s+/g, ' ')}`).join('\n'), step }
  }
  const pagina = typeof args['pagina'] === 'string' ? args['pagina'].replace(/^\[\[|\]\]$/g, '').trim() : ''
  const p = pagina ? wiki.page(pagina) : undefined
  if (!p) return { text: L(`Não há página "${pagina}". Veja os títulos com wiki_indice.`, `There's no page "${pagina}". See the titles with wiki_indice.`), error: true, step: { label: L('Abriu na wiki', 'Opened in the wiki'), detail: pagina } }
  const body = p.body.length > MAX_READ ? `${p.body.slice(0, MAX_READ)}\n…` : p.body
  const extra = [p.backlinks.length && L(`Citada por: ${p.backlinks.map((t) => `[[${t}]]`).join(', ')}`, `Cited by: ${p.backlinks.map((t) => `[[${t}]]`).join(', ')}`)].filter(Boolean)
  return { text: `# ${p.title}\n(${p.kind}, ${new Date(p.updatedAt).toLocaleDateString(locale())})\n\n${body}${extra.length ? `\n\n${extra.join('\n')}` : ''}`, step: { label: L('Leu na wiki', 'Read in the wiki'), detail: p.title } }
}
