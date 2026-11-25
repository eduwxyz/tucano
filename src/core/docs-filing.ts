// Documentos' memory around the documents: dates found in them, files a person dropped for the cataloguer
// to put away, and the excerpts that answer a question. The cataloguer itself (the AI) lives in docs-brain.ts;
// this is only what it keeps and reads. Calls that take a `person` check access; the others are internal.
import { randomUUID } from 'node:crypto'
import { effectiveAccess, personMay, visibleFolderIds } from '../shared/doc-access'
import { actorOfPerson, folderPath, folderPathWithin, type Doc, type DocDate, type DocFolder, type InboxDocDate } from '../shared/docs'
import { UserError } from '../shared/errors'
import { L } from '../shared/lang'
import type { Person } from '../shared/types'
import { gone, readOnly } from './docs-core'
import { DocsStatus } from './docs-status'
import { ftsQuery } from './wiki'

const DAY = 86_400_000
const toDay = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, m! - 1, d).getTime()
}
const dayString = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const validDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && dayString(toDay(s)) === s
const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)

export class DocsFiling extends DocsStatus {
  // ---------- dates found in documents ----------
  dates(docId: string): DocDate[] {
    return this.index.dates(docId)
  }

  // Replaces the document's OPEN dates with `found`: the reminded and the dismissed stay, and a date and what that was
  // already reminded or dismissed is not added again. At most 6 open ones per document.
  setDates(docId: string, found: { date: string; what: string }[]): void {
    if (!this.index.doc(docId)) return
    const key = (date: string, what: string): string => `${date}\n${what.toLowerCase()}`
    const closed = new Set(this.index.dates(docId).filter((d) => d.state !== 'open').map((d) => key(d.date, d.what)))
    const next: DocDate[] = []
    for (const f of found) {
      const what = oneLine(String(f?.what ?? ''), 120)
      const date = String(f?.date ?? '')
      if (!what || !validDate(date) || closed.has(key(date, what)) || next.some((n) => key(n.date, n.what) === key(date, what))) continue
      next.push({ id: randomUUID(), docId, date, what, state: 'open', routineId: null })
      if (next.length === 6) break
    }
    const before = this.index.dates(docId).filter((d) => d.state === 'open')
    if (!before.length && !next.length) return
    this.index.dropOpenDates(docId)
    for (const d of next) this.index.putDate(d)
    this.deps.emit()
  }

  dismissDate(person: Person, dateId: string): void {
    this.need()
    const { date } = this.dateFor(person, dateId)
    this.index.putDate({ ...date, state: 'dismissed' })
    this.deps.emit()
  }
  markReminded(dateId: string, routineId: string): void {
    const date = this.index.date(dateId)
    if (!date) return
    this.index.putDate({ ...date, state: 'reminded', routineId })
    this.deps.emit()
  }
  // A date, its document and folder, when this person may edit that folder (anything else looks like it isn't there).
  dateFor(person: Person, dateId: string): { date: DocDate; doc: Doc; folder: DocFolder } {
    this.need()
    const date = this.index.date(dateId)
    const doc = date ? this.index.doc(date.docId) : undefined
    const folders = this.index.folders()
    const folder = doc ? folders.find((f) => f.id === doc.folderId) : undefined
    if (!date || !doc || !folder || !personMay(person, folders, folder.id, 'edit')) throw gone()
    return { date, doc, folder }
  }

  // The open dates coming in the next year, in documents this person may edit, soonest first.
  datesFor(person: Person): InboxDocDate[] {
    if (!this.ready) return []
    const folders = this.index.folders()
    const today = toDay(dayString(Date.now()))
    const last = dayString(today + 365 * DAY)
    const from = dayString(today)
    const out: InboxDocDate[] = []
    const seen = visibleFolderIds(person, folders)
    for (const date of this.index.openDates()) {
      if (date.date < from || date.date > last) continue
      const doc = this.index.doc(date.docId)
      if (!doc || doc.trashedAt || !personMay(person, folders, doc.folderId, 'edit')) continue
      out.push({ date, doc: { id: doc.id, name: doc.name, kind: doc.kind, folderId: doc.folderId }, folderPath: folderPathWithin(folders, doc.folderId, seen), daysLeft: Math.round((toDay(date.date) - today) / DAY) })
      if (out.length === 20) break
    }
    return out
  }

  // ---------- files dropped for the cataloguer ----------
  // Saved in the person's personal folder, waiting to be put away.
  async addInbox(person: Person, p: { name: string; data: Buffer }): Promise<Doc> {
    this.need()
    if (this.index.docs().filter((d) => d.filing?.state === 'pending' && d.filing.by === person.id).length >= 20) throw new UserError(L('Espere o Tuca guardar os arquivos anteriores antes de mandar mais.', 'Wait for Tuca to file the earlier ones before sending more.'))
    let root = this.personalRoot(this.index.folders(), person.id)
    root ??= this.createFolder({ parentId: null, name: L('Só meus', 'Only mine'), rule: L('Seus arquivos pessoais. Só você vê.', 'Your personal files. Only you can see them.'), access: null, privateTo: person.id, by: actorOfPerson(person.id) })
    const doc = await this.create({ folderId: root.id, name: p.name, data: p.data, by: actorOfPerson(person.id), filing: { state: 'pending', by: person.id, at: Date.now() } })
    this.deps.emit()
    return doc
  }

  // Where this person's files may be put away: shared folders they may edit.
  foldersToFileInto(person: Person): { folder: DocFolder; path: string }[] {
    if (!this.ready) return []
    const folders = this.index.folders()
    return folders.filter((f) => !f.privateTo && !effectiveAccess(folders, f.id).privateTo && personMay(person, folders, f.id, 'edit')).map((folder) => ({ folder, path: folderPath(folders, folder.id).join('/') }))
  }

  // Puts a pending file away (`by`: the actor doing it: an agent, so a folder asking for approval takes it for review).
  fileInto(docId: string, folderId: string, name: string | undefined, by: string): Doc {
    this.need()
    const d = this.index.doc(docId)
    if (!d || d.trashedAt || d.filing?.state !== 'pending') throw new UserError(L('Esse arquivo não está esperando para ser guardado.', "This file isn't waiting to be put away."))
    const folders = this.index.folders()
    const { privateTo } = effectiveAccess(folders, folderId)
    if (privateTo && privateTo !== d.filing.by) throw new UserError(L('Essa pasta é de outra pessoa.', "That folder is someone else's."))
    const moved = this.moveDoc(d, folderId, name, by)
    const next: Doc = { ...moved, filing: { ...d.filing, state: 'filed' } }
    this.index.putDoc(next)
    this.index.addEvent({ docId, at: Date.now(), by, action: 'filed', detail: folderPath(this.index.folders(), folderId).join(' › ') })
    this.deps.emit()
    return next
  }

  // Leaves a pending file where it is (the person's personal folder), with why.
  keepUnfiled(docId: string, note: string): void {
    const d = this.index.doc(docId)
    if (!d?.filing) return
    this.index.putDoc({ ...d, filing: { ...d.filing, state: 'kept', note: oneLine(note, 300) } })
    this.deps.emit()
  }

  // The person takes back what was put away for them: it returns to their personal folder, with every
  // version. Theirs to take only while they may still change it where it is: once it was moved out of
  // their reach, or their access went, it would bring along what others wrote in it since.
  unfile(person: Person, docId: string): Doc {
    this.need()
    const d = this.docFor(person, docId, 'edit')
    if (d.trashedAt || d.filing?.by !== person.id || d.filing.state !== 'filed') throw new UserError(L('Esse arquivo não foi guardado para você.', "This file wasn't put away for you."))
    const root = this.personalRoot(this.index.folders(), person.id)
    if (!root) throw readOnly()
    const by = actorOfPerson(person.id)
    const moved = this.moveDoc(d, root.id, undefined, by)
    const next: Doc = { ...moved, filing: { ...d.filing, state: 'kept' } }
    this.index.putDoc(next)
    this.index.addEvent({ docId, at: Date.now(), by, action: 'unfiled', detail: '' })
    this.deps.emit()
    return next
  }

  // ---------- for the cataloguer ----------
  uncataloged(limit: number): Doc[] {
    return this.ready ? this.index.uncataloged(limit) : []
  }
  markCataloged(docId: string): void {
    const d = this.index.doc(docId)
    if (d && d.catalogedAt === null) this.index.putDoc({ ...d, catalogedAt: Date.now() })
  }
  // The cataloguer's summary, only where there is none or it was the first characters (a person's own stays).
  fillSummary(docId: string, summary: string): void {
    const d = this.index.doc(docId)
    const text = oneLine(summary, 160)
    if (!d || !text || (d.summary && !this.index.summaryAuto(docId))) return
    const body = this.index.body(docId)
    const was = body.startsWith(`${d.summary}\n`) ? body.slice(d.summary.length + 1) : body
    const next: Doc = { ...d, summary: text }
    this.index.putDoc(next)
    this.index.setSummaryAuto(docId, false)
    this.reindex(next, was)
    this.deps.emit()
  }
  // What a document says, for the cataloguer (no access check: internal use).
  async textFor(docId: string, max: number): Promise<string> {
    const d = this.index.doc(docId)
    if (!d) return ''
    try {
      return (await this.textOf(d.name, d.kind, this.bytes(d))).slice(0, max)
    } catch {
      return ''
    }
  }

  // ---------- answering ----------
  // Passages that may answer `q`, from what this person sees (inside `scope`): the best matches by the words of the question,
  // each a window of about 1500 characters around the first word found. With a document and no match: its first 6000 characters.
  excerpts(person: Person, q: string, scope: { folderId?: string; docId?: string }, limit = 6): { doc: Doc; text: string }[] {
    this.need()
    const folders = this.index.folders()
    const seen = visibleFolderIds(person, folders)
    const words = q.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)
    const window = (body: string): string | null => {
      const low = body.toLowerCase()
      const at = words.map((w) => low.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0]
      return at === undefined ? null : body.slice(Math.max(0, at - 500), Math.max(0, at - 500) + 1500).trim()
    }
    if (scope.docId) {
      const doc = this.index.doc(scope.docId)
      if (!doc || doc.trashedAt || !seen.has(doc.folderId)) return []
      const body = this.index.body(doc.id)
      const text = window(body) ?? body.slice(0, 6000).trim()
      return text ? [{ doc, text }] : []
    }
    if (scope.folderId && !seen.has(scope.folderId)) return []
    const ids = scope.folderId ? [...this.subtree(folders, scope.folderId)].filter((x) => seen.has(x)) : [...seen]
    let rows: { id: string; snippet: string }[] = []
    try {
      rows = this.index.search(ftsQuery(q, true), ids, limit)
    } catch {}
    const out: { doc: Doc; text: string }[] = []
    for (const r of rows) {
      const doc = this.index.doc(r.id)
      if (!doc) continue
      const body = this.index.body(doc.id)
      const text = window(body) ?? body.slice(0, 1500).trim()
      if (text) out.push({ doc, text })
    }
    return out
  }
}
