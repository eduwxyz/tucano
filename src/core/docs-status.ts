// Approval in Documentos: what an agent saved waits as "em revisão" until someone who looks after the folder
// approves it or asks for changes. Who may decide is shared/doc-access.ts mayApprove; the rules of what a save or
// a move leaves behind are in docs-core.ts (statusOnSave, statusOnMove).
import { approvalNeeded, mayApprove, personMay, visibleFolderIds } from '../shared/doc-access'
import { actorOfPerson, folderPathWithin, type Doc, type InboxDoc } from '../shared/docs'
import { UserError } from '../shared/errors'
import { L } from '../shared/lang'
import type { Person } from '../shared/types'
import { DocsCore, NO_STATUS, trashedError } from './docs-core'
import { plain } from './docs-fs'

export interface DecideTell {
  conversationId: string
  threadId?: string
  agentId: string
  text: string
}

export class DocsStatus extends DocsCore {
  // Approves what waits (it becomes the official version), or sends it back with what to change (it goes back to draft).
  // `seenVersion`: the version the person was looking at; a newer one that came since is not approved unseen.
  decide(person: Person, docId: string, ok: boolean, note?: string, seenVersion?: number): { doc: Doc; tell?: DecideTell } {
    this.need()
    const d = this.docFor(person, docId)
    if (d.trashedAt) throw trashedError()
    const folders = this.index.folders()
    if (!mayApprove(person, folders, d.folderId)) throw new UserError(L('Só quem cuida dessa pasta pode aprovar.', 'Only whoever looks after this folder can approve.'))
    if (d.status !== 'review') throw new UserError(L('Esse documento não está esperando aprovação.', "This document isn't waiting for approval."))
    if (typeof seenVersion === 'number' && seenVersion !== d.version) throw new Error(L('Chegou uma versão nova deste arquivo. Abra de novo antes de decidir.', 'A new version of this file arrived. Open it again before deciding.'))
    const by = actorOfPerson(person.id)
    const at = Date.now()
    if (ok) {
      const next: Doc = { ...d, status: 'official', officialVersion: d.version, statusBy: by, statusAt: at, statusNote: '' }
      this.index.putDoc(next)
      this.index.addEvent({ docId: d.id, at, by, action: 'approved', detail: String(d.version) })
      this.deps.emit()
      return { doc: next }
    }
    const why = (note ?? '').trim().slice(0, 2000)
    if (!why) throw new UserError(L('Diga o que precisa mudar.', 'Say what needs to change.'))
    const next: Doc = { ...d, status: 'draft', statusBy: by, statusAt: at, statusNote: why }
    this.index.putDoc(next)
    this.index.addEvent({ docId: d.id, at, by, action: 'changes-asked', detail: why })
    this.deps.emit()
    const { conversationId, agentId, threadId } = d.origin
    const agent = agentId ? this.deps.agents().find((a) => a.id === agentId) : undefined
    if (!conversationId || !agent) return { doc: next }
    // The name and the path are a file's words: cleaned, and only the folders this person may view are named.
    const where = plain(folderPathWithin(folders, d.folderId, visibleFolderIds(person, folders)).join(' › '), 160)
    const name = plain(d.name, 80)
    return { doc: next, tell: { conversationId, ...(threadId ? { threadId } : {}), agentId: agent.id, text: L(`@${agent.handle} sobre "${name}" em ${where}: ${why}`, `@${agent.handle} about "${name}" in ${where}: ${why}`) } }
  }

  // A draft, or one waiting, that someone decides is fine as it is: official where approval is asked, simply a normal document elsewhere.
  makeOfficial(person: Person, docId: string): Doc {
    this.need()
    const d = this.docFor(person, docId)
    if (d.trashedAt) throw trashedError()
    if (d.status !== 'draft' && d.status !== 'review') throw new UserError(L('Esse documento já vale como está.', 'This document already counts as it is.'))
    const folders = this.index.folders()
    const asked = approvalNeeded(folders, d.folderId)
    if (asked ? !mayApprove(person, folders, d.folderId) : !personMay(person, folders, d.folderId, 'edit')) throw new UserError(L('Você não pode dar isso como oficial.', "You can't make this official."))
    const by = actorOfPerson(person.id)
    const at = Date.now()
    const next: Doc = { ...d, ...(asked ? { status: 'official' as const, officialVersion: d.version, statusBy: by, statusAt: at, statusNote: '' } : NO_STATUS) }
    this.index.putDoc(next)
    this.index.addEvent({ docId: d.id, at, by, action: 'made-official', detail: '' })
    this.deps.emit()
    return next
  }

  // After a folder stopped asking for approval: what waited or was approved under it is a normal document again
  // (a draft stays a draft; a folder below that asks on its own keeps its documents as they are).
  clearApprovalUnder(folderId: string): void {
    const folders = this.index.folders()
    const under = this.subtree(folders, folderId)
    for (const d of this.index.docs()) if (under.has(d.folderId) && (d.status === 'review' || d.status === 'official') && !approvalNeeded(folders, d.folderId)) this.index.putDoc({ ...d, ...NO_STATUS })
  }

  // What waits for this person to approve, newest first.
  waitingFor(person: Person): InboxDoc[] {
    if (!this.ready) return []
    const folders = this.index.folders()
    const may = new Map<string, boolean>()
    const can = (id: string): boolean => (may.has(id) ? may.get(id)! : (may.set(id, mayApprove(person, folders, id)), may.get(id)!))
    const seen = visibleFolderIds(person, folders)
    return this.index
      .docs()
      .filter((d) => d.status === 'review' && !d.trashedAt && can(d.folderId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
      .map((doc) => ({ doc, folderPath: folderPathWithin(folders, doc.folderId, seen) }))
  }
}
