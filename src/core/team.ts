// A team as a Markdown file (spec §21): the agents, skills, channels and
// routines, readable by a person and importable on another Mac. No credentials,
// no memories, no conversations; grants and triggers point at connectors by
// name, and imported routines come in turned off.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { L, locale } from '../shared/lang'
import { describeSchedule, modelInfo, type Agent, type AgentColor, type Effort, type GrantLevel, type Routine, type Schedule, type Trigger } from '../shared/types'
import type { Db } from './db'

const FENCE = 'tucano-team'
const OLD_FENCE = 'agent-desk-team' // teams exported before the rename
const KEEP_BACKUPS = 7
const DAY = 86_400_000

interface TeamFile {
  version: 1
  agents: {
    handle: string
    name: string
    role: string
    color: AgentColor
    instructions: string
    model: string
    effort: Effort
    limit: number
    web: boolean
    computer: boolean
    grants: Record<string, GrantLevel> // by connector name
  }[]
  skills: { name: string; description: string; body: string; agents: string[] }[] // agents by handle
  channels: { name: string; topic?: string; members: string[] }[]
  routines: { name: string; agent: string; where: string; prompt: string; schedule: Schedule; trigger?: { kind: 'poll'; connector: string; tool: string; args: Record<string, unknown>; everyMinutes: number } | { kind: 'webhook' } }[]
}

export function exportTeam(db: Db): string {
  const agents = db.agents().filter((a) => !a.archived && a.kind !== 'tuca') // each install has its own Tuca
  const handle = (id: string): string | undefined => agents.find((a) => a.id === id)?.handle
  const connectors = db.connectors()
  const connectorName = (id: string): string | undefined => connectors.find((c) => c.id === id)?.name
  const channels = db.conversations().filter((c) => c.kind === 'channel')
  const where = (convId: string): string => {
    const c = db.conversation(convId)
    return c?.kind === 'channel' ? `#${c.name}` : 'dm'
  }

  const data: TeamFile = {
    version: 1,
    agents: agents.map((a) => ({
      handle: a.handle,
      name: a.name,
      role: a.role,
      color: a.color,
      instructions: a.instructions,
      model: a.modelId,
      effort: a.effort,
      limit: a.limit,
      web: a.web !== false,
      computer: a.computer,
      grants: Object.fromEntries(Object.entries(a.grants).flatMap(([id, g]) => (g !== 'none' && connectorName(id) ? [[connectorName(id)!, g]] : [])))
    })),
    skills: db.skills().filter((k) => k.state === 'active').map((k) => ({ name: k.name, description: k.description, body: k.body, agents: k.agents.flatMap((id) => handle(id) ?? []) })),
    channels: channels.map((c) => ({ name: c.name, topic: c.topic, members: c.members.flatMap((id) => handle(id) ?? []) })),
    routines: db.routines().flatMap((r) => {
      const agent = handle(r.agentId)
      if (!agent) return []
      const t = r.trigger
      const trigger = t?.kind === 'poll' ? (connectorName(t.connectorId) ? { kind: 'poll' as const, connector: connectorName(t.connectorId)!, tool: t.tool, args: t.args, everyMinutes: t.everyMinutes } : undefined) : t ? { kind: 'webhook' as const } : undefined
      return [{ name: r.name, agent, where: where(r.conversationId), prompt: r.prompt, schedule: r.schedule, ...(trigger ? { trigger } : {}) }]
    })
  }

  const md = [
    L('# Time do Tucano', '# Tucano team'),
    '',
    L(
      `Exportado em ${new Date().toLocaleString(locale())}. Sem credenciais, memórias nem conversas. Pra usar em outro computador: Configurações → Time → Importar.`,
      `Exported on ${new Date().toLocaleString(locale())}. No credentials, memories or conversations. To use it on another computer: Settings → Team → Import.`
    ),
    '',
    L('## Agentes', '## Agents'),
    ...data.agents.map(
      (a) =>
        `- **${a.name}** (@${a.handle})${a.role ? ` · ${a.role}` : ''} · ${modelInfo(a.model)?.label ?? a.model}${a.computer ? L(' · com computador', ' · with a computer') : ''}${Object.keys(a.grants).length ? ` · ${L('acessa', 'uses')} ${Object.keys(a.grants).join(', ')}` : ''}`
    ),
    '',
    ...(data.skills.length ? ['## Skills', ...data.skills.map((k) => `- **${k.name}**: ${k.description}`), ''] : []),
    ...(data.channels.length ? [L('## Canais', '## Channels'), ...data.channels.map((c) => `- #${c.name}: ${c.members.map((h) => `@${h}`).join(', ') || L('sem agentes', 'no agents')}`), ''] : []),
    ...(data.routines.length
      ? [
          L('## Rotinas', '## Routines'),
          ...data.routines.map(
            (r) =>
              `- **${r.name}** (@${r.agent}, ${r.where === 'dm' ? L('na DM', 'in the DM') : r.where}): ${r.trigger ? (r.trigger.kind === 'poll' ? L(`quando aparece algo novo em ${r.trigger.connector} · ${r.trigger.tool}`, `when something new shows up in ${r.trigger.connector} · ${r.trigger.tool}`) : L('quando chamada neste computador', 'when called on this computer')) : describeSchedule(r.schedule)}`
          ),
          ''
        ]
      : []),
    L('<!-- O bloco abaixo é o que o app importa. -->', '<!-- The block below is what the app imports. -->'),
    `\`\`\`json ${FENCE}`,
    JSON.stringify(data, null, 2),
    '```',
    ''
  ]
  return md.join('\n')
}

// Adds what isn't there yet (agents by handle, skills and channels by name).
// Routines come in off; a grant or trigger whose connector doesn't exist here is left out.
export function importTeam(db: Db, text: string, defaultLimit: number): string {
  const m = new RegExp('```json (?:' + FENCE + '|' + OLD_FENCE + ')\\n([\\s\\S]*?)\\n```').exec(text)
  if (!m) throw new Error(L('Esse arquivo não é um time exportado pelo Tucano.', "That file isn't a team exported by Tucano."))
  let data: TeamFile
  try {
    data = JSON.parse(m[1]!) as TeamFile
  } catch {
    throw new Error(L('O bloco do time está corrompido.', "The team's block is corrupted."))
  }
  if (data.version !== 1) throw new Error(L('Versão de time desconhecida.', 'Unknown team version.'))
  const connectors = db.connectors()
  const connectorId = (name: string): string | undefined => connectors.find((c) => c.name === name)?.id
  const added = { agents: 0, skills: 0, channels: 0, routines: 0, skipped: [] as string[] }

  for (const a of data.agents ?? []) {
    if (db.agents().some((x) => x.handle === a.handle)) continue
    const agent: Agent = {
      id: randomUUID(),
      name: a.name,
      handle: a.handle,
      role: a.role ?? '',
      color: a.color ?? 'sky',
      instructions: a.instructions ?? '',
      modelId: modelInfo(a.model)?.id ? a.model : 'sonnet',
      effort: a.effort ?? 'medium',
      limit: a.limit || defaultLimit,
      used: 0,
      grants: Object.fromEntries(Object.entries(a.grants ?? {}).flatMap(([name, g]) => (connectorId(name) ? [[connectorId(name)!, g]] : (added.skipped.push(L(`acesso de @${a.handle} ao ${name}`, `@${a.handle}'s access to ${name}`)), [])))),
      memory: 'auto',
      computer: false, // turned on by hand: it downloads a system
      web: a.web,
      archived: false
    }
    db.saveAgent(agent)
    added.agents++
  }
  const byHandle = (h: string): string | undefined => db.agents().find((x) => x.handle === h)?.id

  for (const k of data.skills ?? []) {
    if (db.skills().some((x) => x.state === 'active' && x.name === k.name)) continue
    const at = Date.now()
    db.saveSkill({ id: randomUUID(), name: k.name, description: k.description, body: k.body, agents: k.agents.flatMap((h) => byHandle(h) ?? []), state: 'active', createdAt: at, updatedAt: at })
    added.skills++
  }

  for (const c of data.channels ?? []) {
    const existing = db.conversations().find((x) => x.kind === 'channel' && x.name === c.name)
    const members = c.members.flatMap((h) => byHandle(h) ?? [])
    if (existing) {
      for (const id of members) if (!existing.members.includes(id)) db.setAgentChannels(id, [...db.conversations().filter((x) => x.kind === 'channel' && x.members.includes(id)).map((x) => x.id), existing.id])
      continue
    }
    db.createConversation({ id: randomUUID(), kind: 'channel', name: c.name, topic: c.topic, members })
    added.channels++
  }

  for (const r of data.routines ?? []) {
    const agentId = byHandle(r.agent)
    if (!agentId || db.routines().some((x) => x.name === r.name && x.agentId === agentId)) continue
    let conversationId: string | undefined
    if (r.where === 'dm') {
      conversationId = db.conversations().find((c) => c.kind === 'dm' && c.name === agentId)?.id
      if (!conversationId) {
        conversationId = randomUUID()
        db.createConversation({ id: conversationId, kind: 'dm', name: agentId, members: [agentId] })
      }
    } else conversationId = db.conversations().find((c) => c.kind === 'channel' && `#${c.name}` === r.where)?.id
    let trigger: Trigger | undefined
    if (r.trigger?.kind === 'poll') {
      const id = connectorId(r.trigger.connector)
      if (!id) {
        added.skipped.push(L(`a rotina "${r.name}" (precisa do conector ${r.trigger.connector})`, `the routine "${r.name}" (needs the ${r.trigger.connector} connector)`))
        continue
      }
      trigger = { kind: 'poll', connectorId: id, tool: r.trigger.tool, args: r.trigger.args, everyMinutes: r.trigger.everyMinutes }
    } else if (r.trigger?.kind === 'webhook') trigger = { kind: 'webhook', token: randomUUID().replace(/-/g, '') }
    if (!conversationId) continue
    const routine: Routine = { id: randomUUID(), name: r.name, agentId, conversationId, prompt: r.prompt, schedule: r.schedule, trigger, enabled: false, createdAt: Date.now() }
    db.saveRoutine(routine)
    added.routines++
  }

  const parts = [
    added.agents && L(`${added.agents} agente${added.agents > 1 ? 's' : ''}`, `${added.agents} agent${added.agents > 1 ? 's' : ''}`),
    added.skills && `${added.skills} skill${added.skills > 1 ? 's' : ''}`,
    added.channels && L(`${added.channels} canal${added.channels > 1 ? 'is' : ''}`, `${added.channels} channel${added.channels > 1 ? 's' : ''}`),
    added.routines && L(`${added.routines} rotina${added.routines > 1 ? 's' : ''} (desligadas)`, `${added.routines} routine${added.routines > 1 ? 's' : ''} (off)`)
  ].filter(Boolean)
  const done = parts.length ? L(`Importei ${parts.join(', ')}.`, `Imported ${parts.join(', ')}.`) : L('Nada novo: tudo já existia aqui.', 'Nothing new: everything already existed here.')
  return `${done}${added.skipped.length ? L(` Ficou de fora: ${added.skipped.join('; ')}.`, ` Left out: ${added.skipped.join('; ')}.`) : ''}`
}

// ---------- backups ----------

// A copy of the database (secrets stay encrypted for this Mac's keychain).
export function backup(db: Db, dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `tucano-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.db`)
  if (existsSync(file)) rmSync(file)
  db.backupTo(file)
  const old = readdirSync(dir)
    .filter((f) => /^(tucano|agent-desk)-.*\.db$/.test(f)) // and the ones from before the rename
    .sort()
    .slice(0, -KEEP_BACKUPS)
  for (const f of old) rmSync(join(dir, f), { force: true })
  return file
}

// Once a day, at startup or while the app stays open.
export function backupIfDue(db: Db, dir: string): void {
  const last = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => statSync(join(dir, f)).mtimeMs)
        .sort()
        .at(-1)
    : undefined
  if (!last || Date.now() - last > DAY) backup(db, dir)
}

