// Documentos' data: one read of what this person sees (folders, files, what they may do), kept
// for as long as nothing changed, and the small questions the screens ask of it.
import { useEffect, useMemo, useState } from 'react'
import { L } from '../../../../shared/lang'
import type { Doc, DocFolder, DocKind, DocsTree } from '../../../../shared/docs'
import { parseActor } from '../../../../shared/docs'
import { accessInWords, effectiveAccess, mayApprove } from '../../../../shared/doc-access'
import { headsOf } from '../../../../shared/org'
import type { Routine } from '../../../../shared/types'
import { call } from '../../rpc'
import { personName, useStore, type Agent, type State } from '../../store'
import { message } from '../Invite'

// ---------- loading ----------

// Every screen that asks in the same moment shares one answer; a change (docsRev) makes the next ask a new one.
const trees = new Map<number, Promise<DocsTree>>()
const links = new Map<number, Promise<Record<string, { docId: string; folderId: string }>>>()
const once = <T>(cache: Map<number, Promise<T>>, rev: number, load: () => Promise<T>): Promise<T> => {
  let p = cache.get(rev)
  if (!p) {
    cache.clear()
    cache.set(rev, (p = load()))
    p.catch(() => cache.delete(rev)) // a failure is asked again, not remembered
  }
  return p
}

export interface DocsState {
  tree: DocsTree | null // null until the first answer; kept while a newer one comes
  loading: boolean
  error: string | null
  retry: () => void
}

export function useDocs(): DocsState {
  const rev = useStore((s) => s.docsRev)
  const [tree, setTree] = useState<DocsTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [again, setAgain] = useState(0)
  useEffect(() => {
    let alive = true
    if (again) trees.clear()
    once(trees, rev, () => call('docs')).then(
      (t) => alive && (setTree(t), setError(null)),
      (e: unknown) => alive && setError(message(e))
    )
    return () => {
      alive = false
    }
  }, [rev, again])
  return { tree, loading: !tree && !error, error, retry: () => setAgain((n) => n + 1) }
}

// The artifacts kept as documents (artifact id → its document), for "Guardado em…" in the chat.
export function useSavedArtifacts(): Record<string, { docId: string; folderId: string }> {
  const rev = useStore((s) => s.docsRev)
  const [saved, setSaved] = useState<Record<string, { docId: string; folderId: string }>>({})
  useEffect(() => {
    let alive = true
    void once(links, rev, () => call('docByArtifact')).then((m) => alive && setSaved(m), () => {})
    return () => {
      alive = false
    }
  }, [rev])
  return saved
}

// ---------- the tree ----------

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

// The folders directly under one (null: the top). The personal one goes last at the top.
export function childFolders(tree: DocsTree, parentId: string | null): DocFolder[] {
  const out = tree.folders.filter((f) => f.parentId === parentId)
  return out.sort((a, b) => Number(!!a.privateTo) - Number(!!b.privateTo) || byName(a, b))
}

export const liveDocs = (tree: DocsTree): Doc[] => tree.docs.filter((d) => !d.trashedAt)

// The files in a folder, the latest first. `trashed`: the ones sent to the trash instead.
export function docsIn(tree: DocsTree, folderId: string, trashed = false): Doc[] {
  return tree.docs.filter((d) => d.folderId === folderId && !!d.trashedAt === trashed).sort((a, b) => (trashed ? b.trashedAt! - a.trashedAt! : b.updatedAt - a.updatedAt))
}

// The files in a folder and in every folder under it (not the trashed ones).
export function countIn(tree: DocsTree, folderId: string): number {
  const ids = new Set([folderId])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of tree.folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true))
  }
  return tree.docs.filter((d) => !d.trashedAt && ids.has(d.folderId)).length
}

export const folderOf = (tree: DocsTree, id: string | undefined): DocFolder | undefined => (id ? tree.folders.find((f) => f.id === id) : undefined)

// "Financeiro › Relatórios", from the top down.
export function pathText(tree: DocsTree, folderId: string): string {
  const names: string[] = []
  const seen = new Set<string>()
  for (let f = folderOf(tree, folderId); f && !seen.has(f.id); f = folderOf(tree, f.parentId ?? undefined)) (seen.add(f.id), names.unshift(f.name))
  return names.join(' › ')
}

// The folders from the top down to this one, for the breadcrumb.
export function trail(tree: DocsTree, folderId: string): DocFolder[] {
  const out: DocFolder[] = []
  const seen = new Set<string>()
  for (let f = folderOf(tree, folderId); f && !seen.has(f.id); f = folderOf(tree, f.parentId ?? undefined)) (seen.add(f.id), out.unshift(f))
  return out
}

const PALETTE = ['indigo', 'rose', 'teal', 'amber', 'violet', 'sky', 'green', 'graphite']
// A folder keeps one color, from its top folder, so a family of folders looks alike.
export function folderColor(tree: DocsTree, folderId: string): string {
  const top = trail(tree, folderId)[0]
  if (top?.privateTo) return 'var(--c-graphite)'
  let h = 0
  for (const ch of top?.id ?? folderId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `var(--c-${PALETTE[h % PALETTE.length]})`
}

export const mayEdit = (tree: DocsTree, folderId: string): boolean => tree.can[folderId] === 'edit'

// The routine that keeps a living document up to date (undefined: none, or it was deleted).
export function useRoutineOf(id: string | null | undefined): Routine | undefined {
  return useStore((s) => (id ? s.routines.find((r) => r.id === id) : undefined))
}

// Whether I am the one who says yes to what waits in this folder. Alone (no people list), I am the owner.
export function useMayApprove(tree: DocsTree | null, folderId: string): boolean {
  const you = useStore((s) => s.you)
  const role = useStore((s) => s.people.find((p) => p.id === you)?.role ?? 'owner')
  return !!tree && mayApprove({ id: you, role }, tree.folders, folderId)
}

// ---------- words ----------

// A file's kind, for the line under its name.
export const kindWords = (kind: DocKind): string =>
  ({ pdf: 'PDF', docx: L('Documento Word', 'Word document'), xlsx: L('Planilha', 'Spreadsheet'), csv: L('Planilha', 'Spreadsheet'), markdown: L('Texto', 'Text'), text: L('Texto', 'Text'), html: L('Página', 'Page'), image: L('Imagem', 'Image') })[kind]

// What the page needs to say who sees a folder.
function useAccessContext(): { people: State['people']; agents: Agent[]; me: string } {
  const people = useStore((s) => s.people)
  const agents = useStore((s) => s.agents)
  const me = useStore((s) => s.you)
  return { people, agents, me }
}

export interface AccessWords {
  short: (folderId: string) => string // for a chip: "Só o setor Financeiro", "Todo o time", "Particular"
  long: (folderId: string) => string // the sentence
}

export function useAccessWords(tree: DocsTree | null): AccessWords {
  const ctx = useAccessContext()
  return useMemo(() => {
    const folders = tree?.folders ?? []
    const sectorLabel = (id: string): string => {
      const h = ctx.agents.find((a) => a.id === id)
      return h ? h.sectorName?.trim() || h.name : '?'
    }
    return {
      short: (folderId) => {
        const { access, privateTo } = effectiveAccess(folders, folderId)
        if (privateTo) return L('Particular', 'Private')
        if (access.everyone === 'edit') return L('Todo o time edita', 'Whole team edits')
        if (access.everyone === 'view') return L('Todo o time', 'Whole team')
        const sectors = Object.keys(access.sectors)
        const people = Object.keys(access.people)
        if (sectors.length === 1 && !people.length) return L(`Só o setor ${sectorLabel(sectors[0]!)}`, `Only the ${sectorLabel(sectors[0]!)} sector`)
        if (!sectors.length && people.length === 1) return people[0] === ctx.me ? L('Só você', 'Only you') : L(`Só ${ctx.people.find((p) => p.id === people[0])?.name.split(/\s+/)[0] ?? L('uma pessoa', 'one person')}`, `Only ${ctx.people.find((p) => p.id === people[0])?.name.split(/\s+/)[0] ?? 'one person'}`)
        if (!sectors.length && !people.length) return L('Só os admins', 'Only admins')
        return L('Só algumas pessoas', 'Only some people')
      },
      long: (folderId) => {
        const { access, privateTo } = effectiveAccess(folders, folderId)
        const heads = new Set(headsOf(ctx.agents).map((h) => h.id))
        const named = ctx.agents.map((a) => ({ id: a.id, name: a.name, sectorName: heads.has(a.id) ? a.sectorName : undefined }))
        return accessInWords(access, { people: ctx.people, agents: named, me: ctx.me, privateTo })
      }
    }
  }, [tree, ctx.people, ctx.agents, ctx.me])
}

// ---------- who did it ----------

export interface Who {
  name: string
  agent?: Agent
  person?: string // a person's id
  outside: boolean
}

// An actor of a document ("person:…", "agent:…", or a file that showed up on disk) as the page names it.
export function useActors(): (actor: string) => Who {
  const state = useStore((s) => ({ you: s.you, people: s.people, me: s.me, former: s.former, agents: s.agents }))
  return (actor) => {
    const a = parseActor(actor)
    if (a.kind === 'outside') return { name: L('Veio de fora do Tucano', 'Came from outside Tucano'), outside: true }
    if (a.kind === 'agent') {
      const agent = state.agents.find((x) => x.id === a.id)
      return { name: agent?.name ?? L('Um agente', 'An agent'), ...(agent ? { agent } : {}), outside: false }
    }
    return { name: personName(state, a.id), person: a.id, outside: false }
  }
}
