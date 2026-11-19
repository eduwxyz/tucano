// Who may do what in Documentos. One rule, the same in the core, which enforces it, and on the page,
// which shows it. A folder's access is the nearest one set going up its parents; a personal folder
// (privateTo) is its person's alone, and so is everything under it: not even an owner or an admin
// sees someone else's. Pure functions, no I/O.
import { L } from './lang'
import { sectorOf } from './org'
import type { Agent, Person } from './types'
import { noAccess, type AgentLevel, type DocFolder, type DocLevel, type FolderAccess } from './docs'

export type Who = Pick<Person, 'id' | 'role'>
// Who an agent works for: nobody (a routine), one person, or a group of people (a channel: everyone who reads the reply).
export type Requester = Who | Who[] | null | undefined
type AgentNode = Pick<Agent, 'id' | 'reportsTo'> & Partial<Pick<Agent, 'archived' | 'kind' | 'entry'>>
type Folders = Pick<DocFolder, 'id' | 'parentId' | 'access' | 'privateTo'>[]

const RANK = { view: 1, read: 1, edit: 2, write: 2 } as const

// The access that holds in a folder: the first one set going up, and whether a personal folder is above it
// (or it is one). A folder with nothing set up to its root: no one but the owner and admins.
export function effectiveAccess(folders: Folders, folderId: string): { access: FolderAccess; privateTo: string | null } {
  let access: FolderAccess | null = null
  let privateTo: string | null = null
  const seen = new Set<string>()
  for (let id: string | null = folderId; id && !seen.has(id); ) {
    seen.add(id)
    const f: Folders[number] | undefined = folders.find((x) => x.id === id)
    if (!f) break
    if (!access && f.access) access = f.access
    if (f.privateTo) {
      privateTo = f.privateTo
      break
    }
    id = f.parentId
  }
  return { access: access ?? noAccess(), privateTo }
}

const best = <T extends 'view' | 'edit' | 'read' | 'write'>(...levels: (T | undefined)[]): T | undefined => levels.reduce<T | undefined>((a, b) => (b && (!a || RANK[b] > RANK[a]) ? b : a), undefined)

// Whether this person may see (`view`) or change (`edit`) what is in the folder. Owners and admins may
// always, except in someone else's personal folder. 'edit' implies 'view'.
export function personMay(person: Who, folders: Folders, folderId: string, need: DocLevel): boolean {
  if (!folders.some((f) => f.id === folderId)) return false
  const { access, privateTo } = effectiveAccess(folders, folderId)
  if (privateTo) return privateTo === person.id
  if (person.role === 'owner' || person.role === 'admin') return true
  const level = best<DocLevel>(access.everyone, access.people[person.id])
  return !!level && RANK[level] >= RANK[need]
}

// Whether this agent may read (`read`) or change (`write`) what is in the folder by the folder's own
// rule: the agent itself, or its sector's head (as the org chart is now). Never in a personal folder
// (that one opens only through agentMayFor, for the person who owns it).
export function agentMay(agent: Pick<Agent, 'id'>, agents: AgentNode[], folders: Folders, folderId: string, need: AgentLevel): boolean {
  if (!folders.some((f) => f.id === folderId)) return false
  const { access, privateTo } = effectiveAccess(folders, folderId)
  if (privateTo) return false
  const head = sectorOf(agents, agent.id)
  const level = best<AgentLevel>(access.allAgents, access.agents[agent.id], head ? access.sectors[head.id] : undefined)
  return !!level && RANK[level] >= RANK[need]
}

// Whether what an agent saves in this folder waits for approval: the folder or any one above it asks for it
// (a subfolder cannot switch it off). A personal folder never does.
export function approvalNeeded(folders: Pick<DocFolder, 'id' | 'parentId' | 'privateTo' | 'needsApproval'>[], folderId: string): boolean {
  const seen = new Set<string>()
  for (let id: string | null = folderId; id && !seen.has(id); ) {
    seen.add(id)
    const f = folders.find((x) => x.id === id)
    if (!f) return false
    if (f.privateTo) return false
    if (f.needsApproval) return true
    id = f.parentId
  }
  return false
}

// Who decides what waits for approval in this folder: owners and admins, or whoever may edit it. Never in someone
// else's personal folder (which never asks for approval anyway).
export function mayApprove(person: Who, folders: Pick<DocFolder, 'id' | 'parentId' | 'access' | 'privateTo'>[], folderId: string): boolean {
  if (!folders.some((f) => f.id === folderId)) return false
  const { privateTo } = effectiveAccess(folders, folderId)
  if (privateTo) return false
  return person.role === 'owner' || person.role === 'admin' || personMay(person, folders, folderId, 'edit')
}

// THE rule the agents' tools go by. An agent working for a person (the requester) gets what the agent
// may AND the person may: without the intersection, someone with no access to a folder could ask an
// agent to read it for them. The one exception is the person's own personal folder, which their agent
// opens for them (they asked). An agent working for no one (a routine) gets what the agent may by itself.
// A channel (two or more people) is different: the reply is read by everyone there, so the agent uses only
// what every one of them may see, and never a personal folder.
export function agentMayFor(agent: Pick<Agent, 'id'>, agents: AgentNode[], requester: Requester, folders: Folders, folderId: string, need: AgentLevel): boolean {
  const people = requester == null ? [] : Array.isArray(requester) ? requester : [requester]
  if (!people.length) return agentMay(agent, agents, folders, folderId, need)
  const { privateTo } = effectiveAccess(folders, folderId)
  const level = need === 'write' ? 'edit' : 'view'
  if (people.length === 1) {
    const person = people[0]!
    if (privateTo) return privateTo === person.id && folders.some((f) => f.id === folderId)
    return agentMay(agent, agents, folders, folderId, need) && personMay(person, folders, folderId, level)
  }
  if (privateTo) return false
  return agentMay(agent, agents, folders, folderId, need) && people.every((p) => personMay(p, folders, folderId, level))
}

// The folders this person sees.
export const visibleFolderIds = (person: Who, folders: Folders): Set<string> => new Set(folders.filter((f) => personMay(person, folders, f.id, 'view')).map((f) => f.id))

// The folders this agent may use, working for `requester` (null: a routine; a list: a channel).
export const agentFolderIds = (agent: Pick<Agent, 'id'>, agents: AgentNode[], requester: Requester, folders: Folders, need: AgentLevel): Set<string> =>
  new Set(folders.filter((f) => agentMayFor(agent, agents, requester, folders, f.id, need)).map((f) => f.id))

// A stored access with what no longer exists dropped (a person or an agent removed since). Whatever
// came in (a page's request, a stored value) is read defensively.
export function cleanFolderAccess(access: unknown, personIds: string[], agentIds: string[]): FolderAccess {
  const a = (access && typeof access === 'object' ? access : {}) as Partial<FolderAccess>
  const rec = <T extends string>(src: unknown, ok: string[], levels: readonly T[]): Record<string, T> => {
    const out: Record<string, T> = {}
    if (src && typeof src === 'object') for (const [k, v] of Object.entries(src)) if (ok.includes(k) && levels.includes(v as T)) out[k] = v as T
    return out
  }
  const everyone = a.everyone === 'view' || a.everyone === 'edit' ? a.everyone : undefined
  const allAgents = a.allAgents === 'read' || a.allAgents === 'write' ? a.allAgents : undefined
  return { ...(everyone ? { everyone } : {}), ...(allAgents ? { allAgents } : {}), people: rec(a.people, personIds, ['view', 'edit']), sectors: rec(a.sectors, agentIds, ['read', 'write']), agents: rec(a.agents, agentIds, ['read', 'write']) }
}

const list = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${L('e', 'and')} ${xs[xs.length - 1]}`)

// Who sees a folder, in a sentence or two: "Só o setor Financeiro e você veem.", "Todo o time vê; só Ana e os admins editam."
// `me`: who reads it (named "você"). `privateTo`: the folder is a personal one.
export function accessInWords(
  access: FolderAccess,
  ctx: { people: Pick<Person, 'id' | 'name'>[]; agents: (Pick<Agent, 'id' | 'name'> & Partial<Pick<Agent, 'sectorName'>>)[]; me?: string; privateTo?: string | null }
): string {
  if (ctx.privateTo) return ctx.privateTo === ctx.me ? L('Só você vê.', 'Only you can see this.') : L('É uma pasta pessoal: só a pessoa dona vê.', 'A personal folder: only its owner sees it.')
  const who = (id: string): string => (id === ctx.me ? L('você', 'you') : (ctx.people.find((p) => p.id === id)?.name ?? L('alguém que saiu', 'someone who left')))
  const sector = (id: string): string => {
    const h = ctx.agents.find((a) => a.id === id)
    const name = h ? h.sectorName?.trim() || h.name : '?'
    return L(`o setor ${name}`, `the ${name} sector`)
  }
  // The ones named, sectors first, "you" last.
  const named = (level: DocLevel | 'any'): string[] => {
    const sectors = Object.entries(access.sectors).filter(([, l]) => level === 'any' || (level === 'edit') === (l === 'write')).map(([id]) => sector(id))
    const ids = Object.entries(access.people).filter(([, l]) => level === 'any' || l === level).map(([id]) => id)
    const people = ids.filter((id) => id !== ctx.me).map(who)
    return [...sectors, ...people, ...(ids.includes(ctx.me ?? '') ? [who(ctx.me!)] : [])]
  }
  const plural = (xs: string[]): boolean => xs.length > 1
  const agentsLine = access.allAgents ? ` ${access.allAgents === 'write' ? L('Todos os agentes leem e escrevem.', 'Every agent reads and writes.') : L('Todos os agentes leem.', 'Every agent reads.')}` : ''
  if (access.everyone === 'edit') return `${L('Todo o time vê e edita.', 'The whole team sees and edits.')}${agentsLine}`
  const editors = named('edit')
  const editLine = editors.length ? L(`só ${list(editors)} e os admins editam`, `only ${list(editors)} and the admins edit`) : L('só os admins editam', 'only the admins edit')
  if (access.everyone === 'view') return `${L(`Todo o time vê; ${editLine}.`, `The whole team sees it; ${editLine}.`)}${agentsLine}`
  const seen = named('any')
  if (!seen.length) return `${L('Só os admins veem.', 'Only the admins see this.')}${agentsLine}`
  const first = L(`Só ${list(seen)} ${plural(seen) ? 'veem' : 'vê'}.`, `Only ${list(seen)} can see this.`)
  const readers = named('view')
  return `${readers.length && editors.length ? `${first} ${L(`Editam: ${list(editors)}.`, `Editing: ${list(editors)}.`)}` : first}${agentsLine}`
}
