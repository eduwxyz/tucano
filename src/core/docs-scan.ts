// Keeps Documentos' index in step with its folder: the first folders (one per sector, plus the
// company's), and the scan that picks up what changed outside Tucano (a file dropped into a folder,
// moved, renamed, edited or deleted in the file manager, Obsidian, git, a sync client).
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { docKind, MAX_DOC_BYTES, OUTSIDE, type Doc, type DocFolder } from '../shared/docs'
import { L } from '../shared/lang'
import { headsOf, sectorName } from '../shared/org'
import { sha, summaryOf, type DocsCore } from './docs-core'
import { sameName } from './docs-fs'

const SYSTEM = 'system'

// A root folder for each sector head that has none yet (once per head: one deleted stays deleted),
// and, the first time, the company's, which everyone sees. Returns whether it made any.
export function ensureRoots(core: DocsCore): boolean {
  const { index, deps } = core
  let made = false
  const heads = headsOf(deps.agents())
  let company = index.folders().find((f) => f.id === index.meta('companyRoot'))
  if (!index.meta('seeded')) {
    company = core.createFolder({
      parentId: null,
      name: L('Empresa', 'Company'),
      rule: L('O que vale pra empresa toda: regras, modelos, avisos.', 'What holds for the whole company: rules, templates, notices.'),
      // Every agent there is today reads it (a team with no sectors yet would otherwise reach no folder at all); an admin changes it under "Quem vê".
      access: { everyone: 'view', people: {}, agents: Object.fromEntries(deps.agents().map((x) => [x.id, 'read' as const])), sectors: {} },
      by: SYSTEM
    })
    index.setMeta('companyRoot', company.id)
    index.setMeta('seeded', '1')
    made = true
  }
  let done: string[] = []
  try {
    done = JSON.parse(index.meta('sectorRoots') ?? '[]') as string[]
  } catch {}
  for (const head of heads) {
    if (done.includes(head.id)) continue
    core.createFolder({
      parentId: null,
      name: sectorName(head, L('Setor de', 'Sector of')),
      rule: L('Arquivos do setor. Só o setor e quem você liberar vê.', "The sector's files. Only the sector and whoever you allow sees them."),
      access: { people: {}, agents: {}, sectors: { [head.id]: 'write' } },
      by: SYSTEM
    })
    done.push(head.id)
    if (company?.access) {
      company = { ...company, access: { ...company.access, sectors: { ...company.access.sectors, [head.id]: 'read' } } }
      index.putFolder(company)
    }
    company = index.folders().find((f) => f.id === company?.id)
    made = true
  }
  if (made) index.setMeta('sectorRoots', JSON.stringify(done))
  return made
}

// Reconciles the index with the folder. Never throws: a file or folder that can't be read is passed over.
// Returns whether anything changed.
export async function scanDocs(core: DocsCore): Promise<boolean> {
  const { index } = core
  let changed = false
  const folders = index.folders()
  const docs = index.docs()
  const byKey = new Map<string, Doc>()
  for (const d of docs) if (!d.trashedAt) byKey.set(`${d.folderId}\n${sameName(d.name)}`, d)

  // What is on disk: the files of a kind Documentos takes, each with the folder it is in.
  const files: { folder: DocFolder; name: string; path: string }[] = []
  const adopt = (parentId: string | null, name: string): DocFolder => {
    const f: DocFolder = { id: randomUUID(), parentId, name, rule: '', access: null, privateTo: null, createdBy: OUTSIDE, createdAt: Date.now() }
    folders.push(f)
    index.putFolder(f)
    changed = true
    return f
  }
  const walk = (dir: string, folder: DocFolder): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path, folders.find((f) => f.parentId === folder.id && sameName(f.name) === sameName(e.name)) ?? adopt(folder.id, e.name))
      else if (e.isFile() && docKind(e.name)) files.push({ folder, name: e.name, path })
    }
  }
  // Top level: a directory the index doesn't know is a new root. It inherits nothing: owners and admins
  // only, until someone shares it. Personal folders (.private) are walked by their own path.
  let top: Dirent[] = []
  try {
    top = readdirSync(core.root, { withFileTypes: true })
  } catch {}
  for (const e of top) {
    if (e.name.startsWith('.') || !e.isDirectory()) continue
    walk(join(core.root, e.name), folders.find((f) => !f.parentId && !f.privateTo && sameName(f.name) === sameName(e.name)) ?? adopt(null, e.name))
  }
  for (const f of folders.filter((x) => x.privateTo && !x.parentId)) {
    try {
      walk(core.folderDir(folders, f.id), f)
    } catch {}
  }

  // Whether a document was left alone since the scan took its snapshot (a save meanwhile is never overwritten by the scan).
  const unchanged = (d: Doc): boolean => {
    const now = index.doc(d.id)
    return !!now && now.updatedAt === d.updatedAt
  }

  const seen = new Set<string>()
  const loose: typeof files = []
  for (const f of files) {
    const d = byKey.get(`${f.folder.id}\n${sameName(f.name)}`)
    if (!d) {
      loose.push(f)
      continue
    }
    seen.add(d.id)
    try {
      // Read again only what looks changed: another size, or touched after the last change we know of.
      const st = statSync(f.path)
      if ((st.size === d.size && Math.floor(st.mtimeMs) <= d.updatedAt) || st.size > MAX_DOC_BYTES) continue
      const data = readFileSync(f.path)
      if (sha(data) === d.hash) continue
      const text = await core.indexable(d.name, d.kind, data)
      if (!unchanged(d)) continue // someone saved it meanwhile: their version stands
      // The old bytes are already overwritten: this version has no earlier copy to go back to.
      const at = Date.now()
      const next: Doc = { ...d, size: data.length, hash: sha(data), version: d.version + 1, updatedBy: OUTSIDE, updatedAt: at, summary: d.summary || summaryOf(text) }
      index.putDoc(next)
      index.addVersion({ docId: d.id, n: next.version, at, by: OUTSIDE, note: '', size: next.size, hash: next.hash })
      index.addEvent({ docId: d.id, at, by: OUTSIDE, action: 'version', detail: '' })
      core.reindex(next, text)
      changed = true
    } catch {}
  }

  // A file that is gone, and one that appeared with the same bytes: the same document, moved or renamed.
  // (A document the scan itself trashed, with nothing in the trash folder, comes back the same way.)
  const missing = docs.filter((d) => !seen.has(d.id) && (!d.trashedAt || !core.filePath(d)))
  for (const f of loose) {
    try {
      const st = statSync(f.path)
      if (st.size > MAX_DOC_BYTES) continue
      const data = readFileSync(f.path)
      const kind = docKind(f.name)!
      const hash = sha(data)
      const at = Date.now()
      const same = missing.findIndex((d) => d.hash === hash)
      if (same >= 0) {
        const d = missing.splice(same, 1)[0]!
        if (!unchanged(d)) continue
        const moved = d.folderId !== f.folder.id
        index.putDoc({ ...d, folderId: f.folder.id, name: f.name, kind, trashedAt: null, updatedBy: OUTSIDE, updatedAt: at })
        index.addEvent({ docId: d.id, at, by: OUTSIDE, action: moved ? 'moved' : 'renamed', detail: moved ? f.folder.name : d.name })
        index.retitle(d.id, f.name)
      } else {
        core.record({ folderId: f.folder.id, name: f.name, kind, data, text: await core.indexable(f.name, kind, data), by: OUTSIDE, action: 'created', at: Math.min(at, Math.round(st.mtimeMs)) })
      }
      changed = true
    } catch {}
  }
  // A file missing for a moment (a sync client writing it, a save in progress) is not gone: it is looked for once more, after a pause.
  const absent = missing.filter((d) => !d.trashedAt)
  if (absent.length) {
    await new Promise((r) => setTimeout(r, 1500))
    const now = index.folders()
    for (const d of absent) {
      let there = false
      try {
        there = existsSync(core.docPath(now, d))
      } catch {}
      if (there) missing.splice(missing.indexOf(d), 1)
    }
  }
  for (const d of missing) {
    if (d.trashedAt || !unchanged(d)) continue
    const at = Date.now()
    index.putDoc({ ...d, trashedAt: at, updatedBy: OUTSIDE, updatedAt: at })
    index.addEvent({ docId: d.id, at, by: OUTSIDE, action: 'trashed', detail: '' })
    changed = true
  }
  return changed
}
