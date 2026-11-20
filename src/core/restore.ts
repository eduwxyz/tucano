// Everything of a Tucano in one .zip, to take it to another one (a computer's Tucano to a server):
// the database, the wiki's folder and its index, and the files agents showed. On the server it goes
// in three steps, since the database can't be swapped under a running core:
//   stageRestore   checks the file (a backup made here, or a daily backup's .db) and unpacks it apart;
//   applyRestore   at the server's next start, before the core opens anything, swaps the files,
//                  keeping what was there in restore/before-…;
//   Db.adoptRestore  once the core opens it: the server's own logins (devices, secrets) stay, and
//                  what only worked on the other computer goes (finishRestore).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { L } from '../shared/lang'
import type { BackupSummary } from '../shared/types'
import type { Db } from './db'
import { extractZip, zipFromFile } from './zip'
import { ZipWriter } from './zip-write'

export const MANIFEST = 'tucano-backup.json'
// What one upload to a server takes (src/server's /upload), with room for the zip's own bytes.
const BUDGET = 950 * 1024 * 1024
const MAX_ENTRIES = 60_000


const restoreDir = (dataDir: string): string => join(dataDir, 'restore')
const incomingDir = (dataDir: string): string => join(restoreDir(dataDir), 'incoming')

// Every file under a folder, with its path inside it ('/' between parts); a repository's .git and
// Obsidian's trash stay out.
function walk(dir: string): { rel: string; path: string; size: number }[] {
  const out: { rel: string; path: string; size: number }[] = []
  if (!existsSync(dir)) return out
  const go = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.trash' || e.name === '.DS_Store') continue
      const p = join(d, e.name)
      if (e.isDirectory()) go(p)
      else if (e.isFile()) out.push({ rel: relative(dir, p).split(sep).join('/'), path: p, size: statSync(p).size })
    }
  }
  go(dir)
  return out
}

// What a database holds, for the summary shown before restoring.
function counts(file: string): Pick<BackupSummary, 'schema' | 'agents' | 'channels' | 'messages' | 'memories' | 'workspace'> {
  const d = new DatabaseSync(file, { readOnly: true })
  try {
    const n = (sql: string): number => {
      try {
        return Number((d.prepare(sql).get() as { n: number } | undefined)?.n ?? 0)
      } catch {
        return 0
      }
    }
    let workspace = ''
    try {
      const r = d.prepare("SELECT value FROM settings WHERE key = 'workspaceName'").get() as { value: string } | undefined
      workspace = r ? String(JSON.parse(r.value) ?? '') : ''
    } catch {}
    return {
      schema: n('SELECT user_version AS n FROM pragma_user_version'),
      agents: n("SELECT count(*) AS n FROM agents WHERE archived = 0 AND (kind IS NULL OR kind <> 'tuca')"),
      channels: n("SELECT count(*) AS n FROM conversations WHERE kind = 'channel'"),
      messages: n('SELECT count(*) AS n FROM messages'),
      memories: n('SELECT count(*) AS n FROM memories'),
      workspace
    }
  } finally {
    d.close()
  }
}

// A consistent copy of a SQLite file that may be open elsewhere (the wiki's index).
function snapshot(file: string, to: string): void {
  const d = new DatabaseSync(file, { readOnly: true })
  try {
    d.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`)
  } finally {
    d.close()
  }
}

// The backup: Settings › Geral › Exportar tudo. `out` is the .zip to write.
export function writeBackup(p: { db: Db; dataDir: string; wikiDir: string; wikiIndex: string; out: string; app: string }): BackupSummary {
  const staging = join(p.dataDir, 'backups')
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  const dbCopy = join(staging, `.export-${randomUUID()}.db`)
  const wikiCopy = join(staging, `.export-${randomUUID()}-wiki.db`)
  const zip = new ZipWriter(p.out)
  try {
    p.db.backupTo(dbCopy)
    const c = counts(dbCopy)
    zip.addFile('tucano.db', dbCopy)
    let entries = 1
    const pages = walk(p.wikiDir)
    for (const f of pages) {
      if (entries >= MAX_ENTRIES || zip.size + f.size > BUDGET) throw new Error(L('A wiki é grande demais pra um backup só (mais de 950 MB).', 'The wiki is too big for one backup (over 950 MB).'))
      zip.addFile(`wiki/${f.rel}`, f.path)
      entries++
    }
    if (existsSync(p.wikiIndex)) {
      snapshot(p.wikiIndex, wikiCopy)
      zip.addFile('wiki.db', wikiCopy)
      entries++
    }
    // The agents' files, newest first, as many as fit in one upload (a big one that doesn't fit is skipped, smaller ones still go).
    const files = walk(join(p.dataDir, 'artifacts')).sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
    let kept = 0
    let left = 0
    for (const f of files) {
      if (entries >= MAX_ENTRIES || zip.size + f.size + 1024 > BUDGET) {
        left++
        continue
      }
      zip.addFile(`artifacts/${f.rel}`, f.path)
      entries++
      kept++
    }
    const summary: BackupSummary = { version: 1, madeAt: Date.now(), app: p.app, ...c, wikiPages: pages.filter((f) => f.rel.endsWith('.md')).length, files: kept, filesLeftOut: left }
    zip.add(MANIFEST, Buffer.from(JSON.stringify(summary, null, 2)))
    zip.close()
    return summary
  } catch (e) {
    zip.abort()
    rmSync(p.out, { force: true })
    throw e
  } finally {
    rmSync(dbCopy, { force: true })
    rmSync(wikiCopy, { force: true })
  }
}

const isSqlite = (file: string): boolean => {
  const head = Buffer.alloc(16)
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    readSync(fd, head, 0, 16, 0)
    return head.toString('latin1') === 'SQLite format 3\0'
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Step 1, on the server: the uploaded file, checked and unpacked apart. A newer database than this
// server reads is refused (the server is updated first); nothing of what's running is touched.
export function stageRestore(p: { file: string; dataDir: string; schemaMax: number; app: string }): BackupSummary {
  const incoming = incomingDir(p.dataDir)
  rmSync(incoming, { recursive: true, force: true })
  mkdirSync(incoming, { recursive: true, mode: 0o700 })
  try {
    let manifest: Partial<BackupSummary> = {}
    if (isSqlite(p.file)) {
      // A daily backup (backups/tucano-….db): the database alone.
      renameSync(p.file, join(incoming, 'tucano.db'))
    } else {
      const zip = zipFromFile(p.file)
      try {
        const m = zip.read(MANIFEST, 1024 * 1024)
        if (!m || !zip.entries.has('tucano.db'))
          throw new Error(L('Esse arquivo não é um backup do Tucano. No app do computador, use Configurações › Geral › Exportar tudo.', "That file isn't a Tucano backup. In the desktop app, use Settings › General › Export everything."))
        manifest = JSON.parse(m.toString('utf8')) as Partial<BackupSummary>
        extractZip(zip, incoming, { file: 700 * 1024 * 1024, total: 1536 * 1024 * 1024 })
      } finally {
        zip.close()
      }
    }
    const db = join(incoming, 'tucano.db')
    const check = new DatabaseSync(db, { readOnly: true })
    let ok = false
    try {
      ok = (check.prepare('PRAGMA quick_check').get() as Record<string, string> | undefined)?.['quick_check'] === 'ok'
    } catch {}
    check.close()
    if (!ok) throw new Error(L('O banco desse backup está corrompido.', "That backup's database is corrupted."))
    const c = counts(db)
    if (c.schema > p.schemaMax)
      throw new Error(
        L(
          `Esse backup é de uma versão mais nova do Tucano${manifest.app ? ` (${manifest.app})` : ''} que este servidor${p.app ? ` (${p.app})` : ''}. Atualize o servidor e tente de novo.`,
          `That backup is from a newer Tucano${manifest.app ? ` (${manifest.app})` : ''} than this server${p.app ? ` (${p.app})` : ''}. Update the server and try again.`
        )
      )
    const pages = walk(join(incoming, 'wiki'))
    return {
      version: 1,
      madeAt: manifest.madeAt ?? statSync(db).mtimeMs,
      app: manifest.app ?? '',
      ...c,
      wikiPages: pages.filter((f) => f.rel.endsWith('.md')).length,
      files: walk(join(incoming, 'artifacts')).length,
      filesLeftOut: manifest.filesLeftOut ?? 0
    }
  } catch (e) {
    rmSync(incoming, { recursive: true, force: true })
    throw e
  } finally {
    rmSync(p.file, { force: true })
  }
}

export const staged = (dataDir: string): boolean => existsSync(join(incomingDir(dataDir), 'tucano.db'))

// Step 1 confirmed: the swap waits for the next start.
export function markRestoreReady(dataDir: string): void {
  if (!staged(dataDir)) throw new Error(L('Envie o backup de novo.', 'Send the backup again.'))
  writeFileSync(join(restoreDir(dataDir), 'ready.json'), JSON.stringify({ at: Date.now() }), { mode: 0o600 })
}

export function cancelRestore(dataDir: string): void {
  rmSync(incomingDir(dataDir), { recursive: true, force: true })
  rmSync(join(restoreDir(dataDir), 'ready.json'), { force: true })
}

const PARTS = ['tucano.db', 'tucano.db-wal', 'tucano.db-shm', 'wiki.db', 'wiki.db-wal', 'wiki.db-shm', 'wiki', 'artifacts']

// Step 2, at the server's start, before the core: what was here goes to restore/before-<time>
// (the newest one kept, to undo by hand), and the backup takes its place. Only file moves.
export function applyRestore(dataDir: string): boolean {
  const dir = restoreDir(dataDir)
  const ready = join(dir, 'ready.json')
  if (!existsSync(ready)) return false
  const incoming = incomingDir(dataDir)
  if (!existsSync(join(incoming, 'tucano.db'))) {
    rmSync(ready, { force: true })
    return false
  }
  const before = join(dir, `before-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(before, { recursive: true, mode: 0o700 })
  for (const name of PARTS) if (existsSync(join(dataDir, name))) renameSync(join(dataDir, name), join(before, name))
  for (const name of PARTS) if (existsSync(join(incoming, name))) renameSync(join(incoming, name), join(dataDir, name))
  writeFileSync(join(dir, 'finish.json'), JSON.stringify({ before }), { mode: 0o600 })
  rmSync(ready, { force: true })
  rmSync(incoming, { recursive: true, force: true })
  for (const old of readdirSync(dir).filter((f) => f.startsWith('before-') && join(dir, f) !== before)) rmSync(join(dir, old), { recursive: true, force: true })
  return true
}

// Step 3, once the core has opened the restored database (and brought it up to this version).
// Returns how many routines were turned off, or undefined when there was nothing to finish.
export function finishRestore(db: Db, dataDir: string): number | undefined {
  const file = join(restoreDir(dataDir), 'finish.json')
  if (!existsSync(file)) return undefined
  let before = ''
  try {
    before = String((JSON.parse(readFileSync(file, 'utf8')) as { before?: string }).before ?? '')
  } catch {}
  const previous = before ? join(before, 'tucano.db') : undefined
  const routines = db.adoptRestore(previous && existsSync(previous) ? previous : undefined)
  db.setMeta('restoredAt', String(Date.now()))
  db.setMeta('restoredRoutines', String(routines))
  rmSync(file, { force: true })
  return routines
}
