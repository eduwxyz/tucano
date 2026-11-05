// The team as one Markdown file that a company team passes around (spec §21): the agents with
// their instructions, the skills, channels, routines, the connectors (by name and address, never
// a credential) and the workspace's context, readable by a person, with a JSON block the app
// reads. Importing a newer file of the same team doesn't copy it again: each change comes as an
// update to review, merged field by field over what was changed here, never overwritten in silence.
//
// Never in it: tokens, keys, env values, conversations, memories, an agent's picture, the
// account it runs on, its monthly limit, lent folders, Mac apps, tools approved for good.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { L, locale } from '../shared/lang'
import {
  MAX_AGENT_ROUTINES,
  describeSchedule,
  modelInfo,
  nextRun,
  type Agent,
  type AgentColor,
  type ConnectorAuth,
  type Effort,
  type GrantLevel,
  type Routine,
  type Schedule,
  type TeamChange,
  type TeamChoice,
  type TeamItemKind,
  type TeamPackageInfo,
  type TeamUpdate,
  type Trigger,
  type WikiAccess
} from '../shared/types'
import { cleanLook } from './agent-look'
import type { Db } from './db'
import { parseTeamFile } from './team'

const FENCE = 'tucano-team'
export const TEAM_FORMAT = 2
const LEGACY_ID = 'v1' // a file from before teams had an id: all of them are the same team

type Fields = Record<string, unknown>
export interface Item {
  kind: TeamItemKind
  id: string // stable across exports, so renaming an agent keeps it the same one
  fields: Fields
}
export interface Team {
  id: string
  name: string
  revision: number
  exportedAt?: string
  items: Item[]
}

// A team this app imported or exported: the version it last took in (the base of the
// three-way merge) and which local item each of its items is. A link to '' is an item I said no to.
interface Follow {
  id: string
  name: string
  revision: number
  base: Item[]
  links: Record<string, string>
  at: number // created, imported or exported: the latest one is the team an export carries
}

// The file's JSON: one list per kind, each entry its id and its fields.
const LIST: Record<Exclude<TeamItemKind, 'context'>, string> = { connector: 'connectors', agent: 'agents', channel: 'channels', skill: 'skills', routine: 'routines' }
// Each person's own, though it travels for others to see: never merged.
const PERSONAL: Partial<Record<TeamItemKind, string[]>> = { agent: ['computer'] }
const ORDER: TeamItemKind[] = ['connector', 'agent', 'channel', 'skill', 'routine', 'context']

const keyOf = (it: Pick<Item, 'kind' | 'id'>): string => `${it.kind}:${it.id}`
const kindOf = (key: string): TeamItemKind => key.slice(0, key.indexOf(':')) as TeamItemKind
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

// What makes two items the same thing on two computers before they're linked.
function natural(it: Item): string {
  const f = it.fields
  if (it.kind === 'agent') return str(f['handle'])
  if (it.kind === 'routine') return `${str(f['agent'])}/${str(f['name'])}`
  if (it.kind === 'context') return 'context'
  return str(f['name'])
}

export function titleOf(it: Item): string {
  const f = it.fields
  if (it.kind === 'agent') return `${str(f['name'])} (@${str(f['handle'])})`
  if (it.kind === 'channel') return `#${str(f['name'])}`
  if (it.kind === 'routine') return `${str(f['name'])} (@${str(f['agent'])})`
  if (it.kind === 'context') return L('Contexto do workspace', "The workspace's context")
  return str(f['name'])
}

// ---------- comparing ----------

// Empty and missing are the same; text compares without trailing spaces or CRLF; keys in any order.
function norm(v: unknown): unknown {
  if (v === null || v === undefined || v === '') return undefined
  if (typeof v === 'string') return v.replace(/\r\n/g, '\n').replace(/\s+$/, '') || undefined
  if (Array.isArray(v)) return v.length ? v.map(norm) : undefined
  if (typeof v === 'object') {
    const entries = Object.entries(v as Fields)
      .map(([k, x]) => [k, norm(x)] as const)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  return v
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b))

// Names this computer can resolve: grants by connector, members by handle. What points
// elsewhere can't land here, so it doesn't count as a difference either.
interface Refs {
  connectors: Set<string>
  handles: Set<string>
}
function scoped(kind: TeamItemKind, fields: Fields, refs: Refs): Fields {
  const out = { ...fields }
  if (kind === 'agent' && out['grants'] && typeof out['grants'] === 'object')
    out['grants'] = Object.fromEntries(Object.entries(out['grants'] as Fields).filter(([name]) => refs.connectors.has(name)))
  if (kind === 'channel' && Array.isArray(out['members'])) out['members'] = (out['members'] as string[]).filter((h) => refs.handles.has(h))
  if (kind === 'skill' && Array.isArray(out['agents'])) out['agents'] = (out['agents'] as string[]).filter((h) => refs.handles.has(h))
  if (kind === 'agent' && Array.isArray(out['team'])) out['team'] = (out['team'] as string[]).filter((h) => refs.handles.has(h))
  return out
}

interface FieldDiff {
  name: string
  mine: unknown
  theirs: unknown
  conflict: boolean
}
// Field by field: only the file changed it → theirs; only I did → mine (no change offered);
// both, differently → a conflict.
function merge3(kind: TeamItemKind, base: Fields, mine: Fields, theirs: Fields): FieldDiff[] {
  const names = [...new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])].filter((n) => !PERSONAL[kind]?.includes(n))
  const out: FieldDiff[] = []
  for (const name of names) {
    const b = base[name]
    const m = mine[name]
    const t = theirs[name]
    if (same(t, b) || same(m, t)) continue
    out.push({ name, mine: m, theirs: t, conflict: !same(m, b) })
  }
  return out
}

// ---------- the file ----------

// The readable part (what a person reviews) and the block the app reads.
export function teamMarkdown(team: Team): string {
  const of = (kind: TeamItemKind): Item[] => team.items.filter((it) => it.kind === kind)
  const f = (it: Item, k: string): string => str(it.fields[k])
  const quote = (text: string): string[] => (text.trim() ? text.trim().split('\n').map((l) => `> ${l}`.trimEnd()) : [])
  const where = (w: string): string => (w === 'dm' ? L('na DM', 'in the DM') : w)
  const json: Record<string, unknown> = { version: TEAM_FORMAT, id: team.id, name: team.name, revision: team.revision, exportedAt: team.exportedAt }
  for (const [kind, list] of Object.entries(LIST)) {
    const items = of(kind as TeamItemKind)
    if (items.length) json[list] = items.map((it) => ({ id: it.id, ...Object.fromEntries(Object.entries(it.fields).filter(([, v]) => norm(v) !== undefined)) }))
  }
  const context = of('context')[0] ? f(of('context')[0]!, 'text').trim() : ''
  if (context) json['context'] = context
  return [
    `# ${team.name}`,
    '',
    L(
      `Time do Tucano, revisão ${team.revision}${team.exportedAt ? `, exportado em ${new Date(team.exportedAt).toLocaleString(locale())}` : ''}. Sem credenciais, memórias nem conversas: cada pessoa entra nos conectores com a própria conta. Pra usar: Configurações → Geral → Importar time. Importar uma versão mais nova deste time mostra o que mudou, pra você escolher.`,
      `A Tucano team, revision ${team.revision}${team.exportedAt ? `, exported on ${new Date(team.exportedAt).toLocaleString(locale())}` : ''}. No credentials, memories or conversations: each person signs in to the connectors with their own account. To use it: Settings → General → Import team. Importing a newer version of this team shows what changed, for you to choose.`
    ),
    '',
    ...(of('agent').length ? [L('## Agentes', '## Agents'), ''] : []),
    ...of('agent').flatMap((it) => {
      const grants = Object.keys((it.fields['grants'] ?? {}) as Fields)
      return [
        `### ${f(it, 'name')} (@${f(it, 'handle')})`,
        '',
        [f(it, 'role'), modelInfo(f(it, 'model'))?.label ?? f(it, 'model'), it.fields['computer'] ? L('com computador', 'with a computer') : '', grants.length ? `${L('acessa', 'uses')} ${grants.join(', ')}` : '', ((it.fields['team'] as string[] | undefined) ?? []).length ? `${L('coordena', 'coordinates')} ${(it.fields['team'] as string[]).map((h) => `@${h}`).join(', ')}` : ''].filter(Boolean).join(' · '),
        '',
        ...quote(f(it, 'instructions')),
        ''
      ]
    }),
    ...(of('skill').length ? ['## Skills', '', ...of('skill').flatMap((it) => [`### ${f(it, 'name')}`, '', f(it, 'description'), '', ...quote(f(it, 'body')), '']) ] : []),
    ...(of('channel').length ? [L('## Canais', '## Channels'), '', ...of('channel').map((it) => `- #${f(it, 'name')}: ${((it.fields['members'] as string[] | undefined) ?? []).map((h) => `@${h}`).join(', ') || L('sem agentes', 'no agents')}`), ''] : []),
    ...(of('routine').length
      ? [
          L('## Rotinas', '## Routines'),
          '',
          ...of('routine').map((it) => {
            const t = it.fields['trigger'] as { kind?: string; connector?: string; tool?: string } | undefined
            const when = t?.kind === 'poll' ? L(`quando aparece algo novo em ${str(t.connector)} · ${str(t.tool)}`, `when something new shows up in ${str(t.connector)} · ${str(t.tool)}`) : t?.kind === 'webhook' ? L('quando chamada neste computador', 'when called on this computer') : describeSchedule((it.fields['schedule'] as Schedule | undefined) ?? { days: [], time: '' })
            return `- **${f(it, 'name')}** (@${f(it, 'agent')}, ${where(f(it, 'where'))}): ${when}`
          }),
          ''
        ]
      : []),
    ...(of('connector').length ? [L('## Conectores', '## Connectors'), '', ...of('connector').map((it) => `- **${f(it, 'name')}** · ${f(it, 'url') || f(it, 'command')}`), ''] : []),
    ...(context ? [L('## Contexto', '## Context'), '', ...quote(context), ''] : []),
    L('<!-- O bloco abaixo é o que o app importa. -->', '<!-- The block below is what the app imports. -->'),
    '```json ' + FENCE,
    JSON.stringify(json, null, 2),
    '```',
    ''
  ].join('\n')
}

// Reads a team file: this format, or the one before teams had ids (known then by handle and name).
export function parseTeam(text: string): Team {
  const m = new RegExp('```json (?:' + FENCE + '|agent-desk-team)\\r?\\n([\\s\\S]*?)\\r?\\n```').exec(text)
  if (!m) throw new Error(L('Esse arquivo não é um time exportado pelo Tucano.', "That file isn't a team exported by Tucano."))
  let data: Record<string, unknown>
  try {
    data = JSON.parse(m[1]!) as Record<string, unknown>
  } catch {
    throw new Error(L('O bloco do time está corrompido.', "The team's block is corrupted."))
  }
  if (data['version'] === 1) return fromTeamFile(text)
  if (typeof data['version'] !== 'number' || data['version'] > TEAM_FORMAT) throw new Error(L('Esse time é de uma versão mais nova do Tucano. Atualize o app pra importá-lo.', 'This team is from a newer Tucano. Update the app to import it.'))
  const items: Item[] = []
  for (const [kind, list] of Object.entries(LIST))
    for (const { id, ...fields } of (data[list] ?? []) as ({ id?: string } & Fields)[]) items.push({ kind: kind as TeamItemKind, id: str(id) || str(fields['handle'] ?? fields['name']), fields })
  if (str(data['context']).trim()) items.push({ kind: 'context', id: 'context', fields: { text: str(data['context']) } })
  return { id: str(data['id']) || LEGACY_ID, name: str(data['name']) || L('Time importado', 'Imported team'), revision: Number(data['revision']) || 1, exportedAt: str(data['exportedAt']) || undefined, items }
}

function fromTeamFile(text: string): Team {
  const t = parseTeamFile(text)
  const items: Item[] = [
    ...(t.agents ?? []).map(({ handle, instructions, limit: _, ...a }) => ({ kind: 'agent' as const, id: handle, fields: { handle, ...a, instructions } })),
    ...(t.skills ?? []).map((k) => ({ kind: 'skill' as const, id: k.name, fields: { ...k } })),
    ...(t.channels ?? []).map((c) => ({ kind: 'channel' as const, id: c.name, fields: { ...c } })),
    ...(t.routines ?? []).map((r) => ({ kind: 'routine' as const, id: `${r.agent}/${r.name}`, fields: { ...r } }))
  ]
  return { id: LEGACY_ID, name: L('Time importado', 'Imported team'), revision: 1, items }
}

// ---------- the app's team, as items ----------

interface Local {
  kind: TeamItemKind
  localId: string
  fields: Fields
}

function localItems(db: Db, context: string): Local[] {
  const agents = db.agents().filter((a) => !a.archived && a.kind !== 'tuca') // each install has its own Tuca
  const handle = (id: string): string | undefined => agents.find((a) => a.id === id)?.handle
  const connectors = db.connectors()
  const connectorName = (id: string): string | undefined => connectors.find((c) => c.id === id)?.name
  const sorted = (xs: string[]): string[] => [...xs].sort()
  const out: Local[] = []
  for (const c of connectors)
    out.push({ kind: 'connector', localId: c.id, fields: { name: c.name, kind: c.kind, url: c.url, command: c.command, args: c.args?.length ? c.args : undefined, envKeys: c.envKeys?.length ? c.envKeys : undefined, auth: c.auth } })
  for (const a of agents)
    out.push({
      kind: 'agent',
      localId: a.id,
      fields: {
        handle: a.handle,
        name: a.name,
        role: a.role,
        color: a.color,
        customColor: a.customColor,
        avatar: a.avatar, // the drawn one; a picture stays on its computer
        model: a.modelId,
        effort: a.effort,
        web: a.web !== false,
        browser: a.browser ? true : undefined,
        wiki: a.wiki,
        computer: a.computer,
        grants: Object.fromEntries(Object.entries(a.grants).flatMap(([id, g]) => (g !== 'none' && connectorName(id) ? [[connectorName(id)!, g]] : [])).sort(([x], [y]) => x!.localeCompare(y!))),
        team: a.team?.length ? sorted(a.team.flatMap((id) => handle(id) ?? [])) : undefined, // who it coordinates
        instructions: a.instructions
      }
    })
  for (const c of db.conversations().filter((x) => x.kind === 'channel')) out.push({ kind: 'channel', localId: c.id, fields: { name: c.name, topic: c.topic, members: sorted(c.members.flatMap((id) => handle(id) ?? [])) } })
  for (const k of db.skills().filter((x) => x.state === 'active')) out.push({ kind: 'skill', localId: k.id, fields: { name: k.name, description: k.description, agents: sorted(k.agents.flatMap((id) => handle(id) ?? [])), body: k.body } })
  for (const r of db.routines()) {
    const agent = handle(r.agentId)
    if (!agent) continue
    const conv = db.conversation(r.conversationId)
    const t = r.trigger
    const trigger = t?.kind === 'poll' ? { kind: 'poll', connector: connectorName(t.connectorId), tool: t.tool, args: t.args, everyMinutes: t.everyMinutes } : t ? { kind: 'webhook' } : undefined
    out.push({ kind: 'routine', localId: r.id, fields: { name: r.name, agent, where: conv?.kind === 'channel' ? `#${conv.name}` : 'dm', schedule: r.schedule, trigger, prompt: r.prompt } })
  }
  out.push({ kind: 'context', localId: 'context', fields: { text: context } })
  return out
}

// ---------- following ----------

export interface TeamFilesDeps {
  db: Db
  dir: string // where what each team last brought lives, in the app's data
  defaultLimit: () => number
  context: () => string // the workspace's, from the settings
  name: () => string // a new team's name: the workspace's
}

export interface Applied {
  note: string
  connectors: string[] // added or changed: to connect, so each one asks its own sign-in
}

export class TeamFiles {
  constructor(private deps: TeamFilesDeps) {
    mkdirSync(deps.dir, { recursive: true })
  }

  private locals(): Local[] {
    return localItems(this.deps.db, this.deps.context())
  }
  private all(): Follow[] {
    return readdirSync(this.deps.dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(this.deps.dir, f), 'utf8')) as Follow]
        } catch {
          return []
        }
      })
  }
  private find(id: string): Follow | undefined {
    return this.all().find((x) => x.id === id)
  }
  private save(f: Follow): void {
    writeFileSync(join(this.deps.dir, `${f.id.replace(/[^\w-]/g, '_')}.json`), JSON.stringify(f, null, 2))
  }

  list(): TeamPackageInfo[] {
    const locals = this.locals()
    return this.all()
      .sort((a, b) => b.at - a.at)
      .map((f) => {
        const refs = this.refs(locals, f.base)
        const changedHere = f.base.flatMap((b) => {
          const lid = f.links[keyOf(b)]
          const mine = lid ? locals.find((l) => l.kind === b.kind && l.localId === lid) : undefined
          return mine && this.differs(b, mine, refs) ? [{ kind: b.kind, title: titleOf({ ...b, fields: mine.fields }) }] : []
        })
        return { id: f.id, name: f.name, revision: f.revision, at: f.at, changedHere }
      })
  }

  // How many fields of mine differ from what the team's file last brought.
  private differs(b: Item, mine: Local, refs: Refs): number {
    const base = scoped(b.kind, b.fields, refs)
    return [...new Set([...Object.keys(base), ...Object.keys(mine.fields)])].filter((n) => !PERSONAL[b.kind]?.includes(n) && !same(base[n], mine.fields[n])).length
  }

  private refs(locals: Local[], incoming: Item[]): Refs {
    const names = (kind: TeamItemKind, field: string): string[] => [...locals.filter((l) => l.kind === kind).map((l) => str(l.fields[field])), ...incoming.filter((it) => it.kind === kind).map((it) => str(it.fields[field]))]
    return { connectors: new Set(names('connector', 'name')), handles: new Set(names('agent', 'handle')) }
  }

  forget(id: string): void {
    for (const f of readdirSync(this.deps.dir)) if (f === `${id.replace(/[^\w-]/g, '_')}.json`) rmSync(join(this.deps.dir, f), { force: true })
  }

  // What importing this file would change here, item by item. Nothing changes yet.
  preview(text: string): TeamUpdate {
    const team = parseTeam(text) // throws when it isn't one
    const f = this.find(team.id) ?? { id: team.id, name: team.name, revision: 0, base: [], links: {}, at: Date.now() }
    return { packageId: team.id, name: team.name, revision: team.revision, seen: f.revision, changes: this.diff(f, team) }
  }

  // Links what already exists here by handle or name (what's here becomes its base, so the
  // file's version comes as an update to review), then compares item by item.
  private diff(f: Follow, team: Team): TeamChange[] {
    const locals = this.locals()
    const refs = this.refs(locals, team.items)
    const taken = new Set(this.all().flatMap((x) => (x.id === f.id ? [] : Object.entries(x.links).map(([k, lid]) => `${kindOf(k)}:${lid}`))))
    for (const [k, lid] of Object.entries(f.links)) taken.add(`${kindOf(k)}:${lid}`)
    const base = new Map(f.base.map((b) => [keyOf(b), b]))
    for (const it of team.items) {
      const k = keyOf(it)
      if (k in f.links) continue
      const match = locals.find((l) => l.kind === it.kind && !taken.has(`${l.kind}:${l.localId}`) && natural({ ...it, fields: l.fields }) === natural(it))
      if (!match) continue
      f.links[k] = match.localId
      taken.add(`${match.kind}:${match.localId}`)
      base.set(k, { kind: it.kind, id: it.id, fields: match.fields })
    }
    f.base = [...base.values()]

    const local = (k: string): Local | undefined => {
      const lid = f.links[k]
      return lid ? locals.find((l) => l.kind === kindOf(k) && l.localId === lid) : undefined
    }
    const changes: TeamChange[] = []
    const incoming = new Set<string>()
    for (const it of team.items) {
      const k = keyOf(it)
      incoming.add(k)
      const theirs = scoped(it.kind, it.fields, refs)
      if (!(k in f.links)) {
        changes.push({ key: k, kind: it.kind, title: titleOf(it), status: 'new', fields: Object.entries(theirs).filter(([n, v]) => norm(v) !== undefined && !PERSONAL[it.kind]?.includes(n)).map(([name, v]) => ({ name, theirs: v, conflict: false })) })
        continue
      }
      const mine = local(k)
      if (!mine) continue // said no to it, or removed here: left alone
      const b = base.get(k)
      const fields = merge3(it.kind, b ? scoped(it.kind, b.fields, refs) : mine.fields, mine.fields, theirs)
      if (fields.length) changes.push({ key: k, kind: it.kind, title: titleOf(it), status: fields.some((x) => x.conflict) ? 'conflict' : 'update', fields })
    }
    // Only a file at least as new as what I took in can say something left the team.
    if (team.revision >= f.revision) for (const [k, b] of base) if (!incoming.has(k) && local(k)) changes.push({ key: k, kind: b.kind, title: titleOf({ ...b, fields: local(k)!.fields }), status: 'removed', fields: [] })
    return changes.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
  }

  // Applies the chosen changes: new items come in (routines off, connectors waiting for each
  // person's sign-in), updates take the file's fields where I hadn't changed them and, on a
  // conflict, the side I picked. 'later' leaves a change to be offered again next import.
  apply(text: string, choices: Record<string, TeamChoice>): Applied {
    const team = parseTeam(text)
    const f = this.find(team.id) ?? { id: team.id, name: team.name, revision: 0, base: [], links: {}, at: Date.now() }
    const changes = this.diff(f, team)
    const theirsOf = new Map(team.items.map((it) => [keyOf(it), it]))
    const base = new Map(f.base.map((b) => [keyOf(b), b]))
    const done = { added: 0, updated: 0, removed: 0, skipped: [] as string[], connectors: [] as string[], teams: [] as { agentId: string; handles: string[] }[] }
    let left = 0
    for (const ch of changes) {
      const choice = choices[ch.key] ?? 'later'
      if (choice === 'later') {
        left++
        continue
      }
      const it = theirsOf.get(ch.key)
      if (ch.status === 'removed') {
        if (choice === 'package') {
          if (this.remove(ch.kind, f.links[ch.key]!)) done.removed++
          f.links[ch.key] = '' // gone: an older file doesn't bring it back
        } else delete f.links[ch.key]
        base.delete(ch.key)
        continue
      }
      if (!it) continue
      if (ch.status === 'new') {
        if (choice === 'mine') f.links[ch.key] = '' // not wanted here: not offered again
        else {
          const lid = this.create(it, done)
          if (!lid) continue
          f.links[ch.key] = lid
          done.added++
        }
        base.set(ch.key, it)
        continue
      }
      const patch = Object.fromEntries(ch.fields.filter((x) => !x.conflict || choice === 'package').map((x) => [x.name, x.theirs]))
      if (Object.keys(patch).length) this.update(it.kind, f.links[ch.key]!, patch, done)
      done.updated++
      base.set(ch.key, it)
    }
    for (const t of done.teams) {
      const a = this.deps.db.agent(t.agentId)
      if (a) this.deps.db.saveAgent({ ...a, team: t.handles.flatMap((h) => this.ids().agent(h) ?? []) })
    }
    // Items without changes follow the file too: their base moves to its version.
    for (const it of team.items) if (f.links[keyOf(it)] && !changes.some((c) => c.key === keyOf(it))) base.set(keyOf(it), it)
    this.save({ ...f, name: team.name, base: [...base.values()], revision: Math.max(f.revision, team.revision), at: Date.now() })

    const parts = [
      done.added && L(`adicionei ${done.added}`, `added ${done.added}`),
      done.updated && L(`atualizei ${done.updated}`, `updated ${done.updated}`),
      done.removed && L(`arquivei ${done.removed}`, `archived ${done.removed}`)
    ].filter(Boolean)
    const note = [
      parts.length ? L(`Time importado: ${parts.join(', ')}.`, `Team imported: ${parts.join(', ')}.`) : L('Nada aplicado.', 'Nothing applied.'),
      left ? L(`${left} ficou pra depois: importe o arquivo de novo pra ver.`, `${left} left for later: import the file again to see it.`) : '',
      done.connectors.length ? L('Entre nos conectores novos com a sua conta, em Conectores.', 'Sign in to the new connectors with your own account, in Connectors.') : '',
      done.skipped.length ? L(`Ficou de fora: ${done.skipped.join('; ')}.`, `Left out: ${done.skipped.join('; ')}.`) : ''
    ]
      .filter(Boolean)
      .join(' ')
    return { note, connectors: done.connectors }
  }

  // The whole team as a file, under the id of the team this app last imported or exported (a
  // new one the first time), with that team's ids, so whoever imports it gets updates, not copies.
  // What I said no to goes on as the team had it. The base stays what I last took in: another
  // file made from it in the meantime still merges with mine field by field.
  export(): string {
    const f = this.all().sort((a, b) => b.at - a.at)[0] ?? { id: randomUUID(), name: this.deps.name() ? L(`Time de ${this.deps.name()}`, `${this.deps.name()}'s team`) : L('Time do Tucano', 'Tucano team'), revision: 0, base: [], links: {}, at: Date.now() }
    const first = f.revision === 0
    const ids = new Map(Object.entries(f.links).filter(([, lid]) => lid).map(([k, lid]) => [`${kindOf(k)}:${lid}`, k.slice(k.indexOf(':') + 1)]))
    const items: Item[] = this.locals()
      .filter((l) => l.kind !== 'context' || str(l.fields['text']).trim())
      .map((l) => ({ kind: l.kind, id: ids.get(`${l.kind}:${l.localId}`) ?? l.localId, fields: l.fields }))
    for (const b of f.base) if (f.links[keyOf(b)] === '') items.push(b)
    for (const it of items) if (!(keyOf(it) in f.links)) f.links[keyOf(it)] = it.id
    const team: Team = { id: f.id, name: f.name, revision: f.revision + 1, exportedAt: new Date().toISOString(), items }
    this.save({ ...f, revision: team.revision, base: first ? items : f.base, at: Date.now() })
    return teamMarkdown(team)
  }

  // ----- changing the app's items -----

  private ids(): { agent: (h: string) => string | undefined; connector: (n: string) => string | undefined } {
    const agents = this.deps.db.agents().filter((a) => !a.archived)
    const connectors = this.deps.db.connectors()
    return { agent: (h) => agents.find((a) => a.handle === h)?.id, connector: (n) => connectors.find((c) => c.name === n)?.id }
  }

  private grants(v: unknown, skipped: string[], who: string): Record<string, GrantLevel> {
    const { connector } = this.ids()
    return Object.fromEntries(
      Object.entries((v ?? {}) as Record<string, GrantLevel>).flatMap(([name, g]) => (connector(name) ? [[connector(name)!, g]] : (skipped.push(L(`acesso de @${who} ao ${name}`, `@${who}'s access to ${name}`)), [])))
    )
  }

  private conversation(where: string, agentId: string): string | undefined {
    const { db } = this.deps
    if (where === 'dm') {
      const dm = db.conversations().find((c) => c.kind === 'dm' && c.name === agentId)
      if (dm) return dm.id
      const id = randomUUID()
      db.createConversation({ id, kind: 'dm', name: agentId, members: [agentId] })
      return id
    }
    return db.conversations().find((c) => c.kind === 'channel' && `#${c.name}` === where)?.id
  }

  private trigger(v: unknown, prev: Trigger | undefined, skipped: string[], name: string): Trigger | undefined | null {
    const t = v as { kind?: string; connector?: string; tool?: string; args?: Record<string, unknown>; everyMinutes?: number } | undefined
    if (!t?.kind) return undefined
    if (t.kind === 'webhook') return { kind: 'webhook', token: prev?.kind === 'webhook' ? prev.token : randomUUID().replace(/-/g, '') }
    const connectorId = this.ids().connector(str(t.connector))
    if (!connectorId) {
      skipped.push(L(`a rotina "${name}" (precisa do conector ${str(t.connector)})`, `the routine "${name}" (needs the ${str(t.connector)} connector)`))
      return null
    }
    const keep = prev?.kind === 'poll' && prev.connectorId === connectorId && prev.tool === t.tool && same(prev.args, t.args)
    return { kind: 'poll', connectorId, tool: str(t.tool), args: t.args ?? {}, everyMinutes: t.everyMinutes || 5, ...(keep ? { seen: prev.seen, checkedAt: prev.checkedAt } : {}) }
  }

  private create(it: Item, done: { skipped: string[]; connectors: string[]; teams: { agentId: string; handles: string[] }[] }): string | undefined {
    const { db } = this.deps
    const f = it.fields
    const id = randomUUID()
    const handles = this.ids()
    switch (it.kind) {
      case 'connector':
        db.saveConnector({ id, name: str(f['name']), kind: f['kind'] === 'stdio' ? 'stdio' : 'remote', url: str(f['url']) || undefined, command: str(f['command']) || undefined, args: f['args'] as string[] | undefined, envKeys: f['envKeys'] as string[] | undefined, auth: (str(f['auth']) || 'none') as ConnectorAuth })
        done.connectors.push(id)
        return id
      case 'agent': {
        const handle = str(f['handle'])
        if (handles.agent(handle)) return void done.skipped.push(L(`@${handle} (já existe outro agente com esse @)`, `@${handle} (another agent already has that @)`))
        const agent: Agent = {
          id,
          name: str(f['name']) || handle,
          handle,
          role: str(f['role']),
          color: (str(f['color']) || 'sky') as AgentColor,
          customColor: str(f['customColor']) || undefined,
          avatar: f['avatar'] as Agent['avatar'],
          instructions: str(f['instructions']),
          modelId: modelInfo(str(f['model'])) ? str(f['model']) : 'sonnet',
          effort: (str(f['effort']) || 'medium') as Effort,
          maxRoutines: MAX_AGENT_ROUTINES,
          limit: this.deps.defaultLimit(),
          used: 0,
          grants: this.grants(f['grants'], done.skipped, handle),
          memory: 'auto',
          computer: false, // turned on by hand: it downloads a system
          web: f['web'] !== false,
          browser: f['browser'] === true ? true : undefined,
          wiki: (str(f['wiki']) || undefined) as WikiAccess | undefined,
          archived: false
        }
        db.saveAgent(cleanLook(agent))
        if (Array.isArray(f['team'])) done.teams.push({ agentId: id, handles: f['team'] as string[] })
        return id
      }
      case 'channel':
        if (db.conversations().some((c) => c.kind === 'channel' && c.name === str(f['name']))) return void done.skipped.push(`#${str(f['name'])}`)
        db.createConversation({ id, kind: 'channel', name: str(f['name']), topic: str(f['topic']) || undefined, members: ((f['members'] as string[] | undefined) ?? []).flatMap((h) => handles.agent(h) ?? []) })
        return id
      case 'skill': {
        const at = Date.now()
        db.saveSkill({ id, name: str(f['name']), description: str(f['description']), body: str(f['body']), agents: ((f['agents'] as string[] | undefined) ?? []).flatMap((h) => handles.agent(h) ?? []), state: 'active', createdAt: at, updatedAt: at })
        return id
      }
      case 'routine': {
        const name = str(f['name'])
        const agentId = handles.agent(str(f['agent']))
        if (!agentId) return void done.skipped.push(L(`a rotina "${name}" (o agente @${str(f['agent'])} não está aqui)`, `the routine "${name}" (agent @${str(f['agent'])} isn't here)`))
        const trigger = this.trigger(f['trigger'], undefined, done.skipped, name)
        if (trigger === null) return undefined
        const conversationId = this.conversation(str(f['where']) || 'dm', agentId)
        if (!conversationId) return void done.skipped.push(L(`a rotina "${name}" (o canal ${str(f['where'])} não está aqui)`, `the routine "${name}" (channel ${str(f['where'])} isn't here)`))
        const routine: Routine = { id, name, agentId, conversationId, prompt: str(f['prompt']), schedule: (f['schedule'] as Schedule | undefined) ?? { days: [], time: '' }, trigger, enabled: false, createdAt: Date.now() }
        db.saveRoutine(routine)
        return id
      }
      case 'context':
        db.setSettings({ context: str(f['text']) })
        return 'context'
    }
  }

  private update(kind: TeamItemKind, localId: string, patch: Fields, done: { skipped: string[]; connectors: string[]; teams: { agentId: string; handles: string[] }[] }): void {
    const { db } = this.deps
    const has = (k: string): boolean => k in patch
    const handles = this.ids()
    switch (kind) {
      case 'connector': {
        const c = db.connectors().find((x) => x.id === localId)
        if (!c) return
        db.saveConnector({
          id: c.id,
          name: has('name') ? str(patch['name']) : c.name,
          kind: c.kind,
          url: has('url') ? str(patch['url']) || undefined : c.url,
          command: has('command') ? str(patch['command']) || undefined : c.command,
          args: has('args') ? (patch['args'] as string[] | undefined) : c.args,
          envKeys: has('envKeys') ? (patch['envKeys'] as string[] | undefined) : c.envKeys,
          auth: has('auth') ? ((str(patch['auth']) || 'none') as ConnectorAuth) : c.auth
        })
        done.connectors.push(c.id)
        return
      }
      case 'agent': {
        const a = db.agent(localId)
        if (!a) return
        const next: Agent = { ...a }
        if (has('handle')) {
          const h = str(patch['handle'])
          if (handles.agent(h) && handles.agent(h) !== a.id) done.skipped.push(L(`o novo @${h} de @${a.handle} (já é de outro agente)`, `@${a.handle}'s new @${h} (another agent has it)`))
          else next.handle = h
        }
        if (has('name')) next.name = str(patch['name']) || a.name
        if (has('role')) next.role = str(patch['role'])
        if (has('color')) next.color = (str(patch['color']) || 'sky') as AgentColor
        if (has('customColor')) next.customColor = str(patch['customColor']) || undefined
        if (has('avatar')) next.avatar = patch['avatar'] as Agent['avatar']
        if (has('instructions')) next.instructions = str(patch['instructions'])
        if (has('model') && modelInfo(str(patch['model']))) next.modelId = str(patch['model'])
        if (has('effort')) next.effort = (str(patch['effort']) || 'medium') as Effort
        if (has('web')) next.web = patch['web'] !== false
        if (has('browser')) next.browser = patch['browser'] === true ? true : undefined
        if (has('wiki')) next.wiki = (str(patch['wiki']) || undefined) as WikiAccess | undefined
        if (has('grants')) next.grants = this.grants(patch['grants'], done.skipped, next.handle)
        if (has('team')) done.teams.push({ agentId: a.id, handles: (patch['team'] as string[] | undefined) ?? [] })
        db.saveAgent(cleanLook(next))
        return
      }
      case 'channel': {
        const c = db.conversation(localId)
        if (!c) return
        if (has('name') && str(patch['name'])) db.renameConversation(c.id, str(patch['name']))
        if (has('topic')) db.setTopic(c.id, str(patch['topic']) || undefined)
        if (has('members')) db.setMembers(c.id, ((patch['members'] as string[] | undefined) ?? []).flatMap((h) => handles.agent(h) ?? []))
        return
      }
      case 'skill': {
        const k = db.skills().find((x) => x.id === localId)
        if (!k) return
        db.saveSkill({
          ...k,
          name: has('name') ? str(patch['name']) || k.name : k.name,
          description: has('description') ? str(patch['description']) : k.description,
          body: has('body') ? str(patch['body']) : k.body,
          agents: has('agents') ? ((patch['agents'] as string[] | undefined) ?? []).flatMap((h) => handles.agent(h) ?? []) : k.agents,
          updatedAt: Date.now()
        })
        return
      }
      case 'routine': {
        const r = db.routines().find((x) => x.id === localId)
        if (!r) return
        const next: Routine = { ...r }
        if (has('name')) next.name = str(patch['name']) || r.name
        if (has('prompt')) next.prompt = str(patch['prompt'])
        if (has('schedule')) next.schedule = (patch['schedule'] as Schedule | undefined) ?? r.schedule
        if (has('agent')) {
          const id = handles.agent(str(patch['agent']))
          if (id) next.agentId = id
          else done.skipped.push(L(`o novo agente da rotina "${r.name}"`, `the routine "${r.name}"'s new agent`))
        }
        if (has('where') || has('agent')) {
          const where = has('where') ? str(patch['where']) : str(this.locals().find((l) => l.kind === 'routine' && l.localId === r.id)?.fields['where'])
          const conv = this.conversation(where || 'dm', next.agentId)
          if (conv) next.conversationId = conv
        }
        if (has('trigger')) {
          const t = this.trigger(patch['trigger'], r.trigger, done.skipped, r.name)
          if (t !== null) next.trigger = t
        }
        next.nextAt = next.enabled && !next.trigger ? nextRun(next.schedule, Date.now()) : undefined
        db.saveRoutine(next)
        return
      }
      case 'context':
        if (has('text')) db.setSettings({ context: str(patch['text']) })
    }
  }

  private remove(kind: TeamItemKind, localId: string): boolean {
    const { db } = this.deps
    if (kind === 'agent') {
      const a = db.agent(localId)
      if (!a) return false
      db.saveAgent({ ...a, archived: true })
      for (const r of db.routines().filter((x) => x.agentId === a.id && x.enabled)) db.saveRoutine({ ...r, enabled: false, nextAt: undefined })
      return true
    }
    if (kind === 'skill') {
      const k = db.skills().find((x) => x.id === localId)
      if (!k) return false
      db.saveSkill({ ...k, state: 'archived', updatedAt: Date.now() })
      return true
    }
    if (kind === 'routine') {
      if (!db.routines().some((x) => x.id === localId)) return false
      db.removeRoutine(localId)
      return true
    }
    return false // a channel keeps its conversation, a connector its sign-in, the context its text: they just stop following
  }
}
