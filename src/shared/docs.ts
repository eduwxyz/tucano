// Documentos: the team's files, kept in folders that say who sees them. The types and the few pure
// helpers the core and the page share. What a person or an agent may do with a folder is in
// doc-access.ts; how the files are kept (disk + index) is in core/docs.ts.
import type { ArtifactKind } from './types'

// What a document is, for the viewer: the artifact kinds that fit, plus Word and Excel.
export type DocKind = Extract<ArtifactKind, 'image' | 'markdown' | 'html' | 'pdf' | 'csv' | 'text'> | 'docx' | 'xlsx'

// The wiki's readable files (core/wiki-extract.ts ACCEPTS: keep in step), web pages and pictures.
// No video, audio, zip or anything else.
export const DOC_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md', '.markdown', '.json', '.log', '.yml', '.yaml', '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp'] as const
export const MAX_DOC_BYTES = 20 * 1024 * 1024

const KINDS: Record<string, DocKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html',
  pdf: 'pdf', csv: 'csv', docx: 'docx', xlsx: 'xlsx',
  txt: 'text', json: 'text', log: 'text', yml: 'text', yaml: 'text'
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

// The kind of a file by its extension; null for one Documentos doesn't take.
export const docKind = (name: string): DocKind | null => KINDS[extOf(name)] ?? null
export const acceptsDoc = (name: string): boolean => docKind(name) !== null

export type DocLevel = 'view' | 'edit' // what a person may do in a folder
export type AgentLevel = 'read' | 'write' // what an agent may do in a folder

// Who may do what in a folder. A sector is its head's agent id: every agent of that sector, as the org chart has it now.
export interface FolderAccess {
  everyone?: DocLevel // the whole team (every person)
  people: Record<string, DocLevel> // person id
  sectors: Record<string /* head agent id */, AgentLevel>
  agents: Record<string /* agent id */, AgentLevel>
}

export const noAccess = (): FolderAccess => ({ people: {}, sectors: {}, agents: {} })

export interface DocFolder {
  id: string
  parentId: string | null
  name: string // also its directory name on disk
  rule: string // what belongs here, for people and for agents ("contratos assinados dos clientes")
  access: FolderAccess | null // null: inherits from the parent
  privateTo: string | null // person id: a personal folder, no one else's (owners and admins included)
  createdBy: string // an actor
  createdAt: number
}

// Where a document came from.
export interface DocOrigin {
  conversationId?: string
  messageId?: string
  artifactId?: string
  agentId?: string
  askedBy?: string // person id: whom the agent worked for
  routineId?: string
  sources?: string[] // what it was made from (document ids, page titles, links)
}

export interface Doc {
  id: string
  folderId: string
  name: string // file name with extension; also its name on disk
  kind: DocKind
  summary: string
  size: number
  hash: string // sha256 of the current bytes
  version: number // 1, 2, 3…
  origin: DocOrigin
  createdBy: string // an actor
  createdAt: number
  updatedBy: string
  updatedAt: number
  trashedAt: number | null
}

export interface DocVersion {
  id: number
  docId: string
  n: number
  at: number
  by: string
  note: string
  size: number
  hash: string
}

export type DocAction = 'created' | 'version' | 'moved' | 'renamed' | 'trashed' | 'restored' | 'reverted' | 'saved-from-chat'
export interface DocEvent {
  docId: string
  at: number
  by: string
  action: DocAction
  detail: string
}

// What one person may see: the folders (one whose parent they can't see comes with parentId null),
// every document in them (the trashed ones too: trashedAt set), and what they may do in each folder.
export interface DocsTree {
  folders: DocFolder[]
  docs: Doc[]
  can: Record<string /* folder id */, DocLevel>
}

export interface DocHit {
  doc: Doc
  snippet: string
}

// Who did something: a person, an agent, or `outside` (a file that showed up in the folder on disk).
export const OUTSIDE = 'outside'
export const actorOfPerson = (id: string): string => `person:${id}`
export const actorOfAgent = (id: string): string => `agent:${id}`
export function parseActor(actor: string): { kind: 'person' | 'agent' | 'outside'; id: string } {
  const i = actor.indexOf(':')
  const kind = i > 0 ? actor.slice(0, i) : ''
  return kind === 'person' || kind === 'agent' ? { kind, id: actor.slice(i + 1) } : { kind: 'outside', id: '' }
}

// A document's address: in a browser (Tucano as a server) the server serves it under /doc, else the
// desktop's tucano:// scheme. `version`: an older one (the current one when left out).
export const docUrl = (d: Pick<Doc, 'id' | 'name'>, version?: number): string =>
  `${(globalThis as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__ ? './doc/' : 'tucano://doc/'}${d.id}/${encodeURIComponent(d.name)}${version ? `?v=${version}` : ''}`

// Folder names from the root down, for "Guardado em A › B" and breadcrumbs.
export function folderPath(folders: Pick<DocFolder, 'id' | 'parentId' | 'name'>[], folderId: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let id = folderId; id && !seen.has(id); ) {
    seen.add(id)
    const f = folders.find((x) => x.id === id)
    if (!f) break
    out.unshift(f.name)
    id = f.parentId
  }
  return out
}

// The same, but only through the folders in `allowed`: the walk up stops at the first ancestor outside it, so the
// nearest reachable one is the root of the path (an agent must not see the names of folders it can't read).
export function folderPathWithin(folders: Pick<DocFolder, 'id' | 'parentId' | 'name'>[], folderId: string | null, allowed: Set<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let id = folderId; id && allowed.has(id) && !seen.has(id); ) {
    seen.add(id)
    const f = folders.find((x) => x.id === id)
    if (!f) break
    out.unshift(f.name)
    id = f.parentId
  }
  return out
}
