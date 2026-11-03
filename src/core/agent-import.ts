// Agents from another app (spec §21). Each source becomes one `ForeignTeam`, and `applyForeignTeam`
// adds it the same way for all: the agents come in with no connector granted, their routines off and their
// memories waiting for the person to confirm. Nothing that can run comes in by itself: an MCP server of
// the other app is named in the summary, never added as a connector.
//
// OpenBot: the .zip of Server settings → Transfer → Export from this server (`openbot-transfer.json`,
// format "openbot-instance-transfer", version 1). Only its documented format is read here; none of
// OpenBot's code is used.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { codexValue, customModel, MAX_AGENT_ROUTINES, type Agent, type Effort, type EngineId, type Memory, type Routine, type Schedule } from '../shared/types'
import { cleanLook } from './agent-look'
import type { Db } from './db'
import { frontmatter } from './local-skills'
import { skillName } from './skills'
import type { Zip } from './zip'

export interface ForeignSkill {
  name: string
  description: string
  body: string
  extraFiles: number // files beside SKILL.md, which stay out
}

export interface ForeignAgent {
  name: string
  role: string
  instructions: string
  modelId?: string // undefined: this app's default
  effort: Effort
  customColor?: string
  picture?: string
  skills: ForeignSkill[]
  routines: { name: string; prompt: string; schedule: Schedule }[]
  memories: string[]
  notes: string[] // what of this agent stayed out, and why
}

export interface ForeignTeam {
  source: string // "OpenBot"
  agents: ForeignAgent[]
  servers: string[] // MCP servers there, by name, to add by hand
  notes: string[]
}

const MAX_MANIFEST = 20_000_000
const MAX_TEXT = 1_000_000
const MAX_INSTRUCTIONS = 32_000
const MAX_PICTURE_BYTES = 145_000 // as a data URL it stays under cleanLook's cap
const MAX_MEMORY = 500
const MAX_SKILL_BODY = 20_000

const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const time = (v: unknown): string | undefined => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined)
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

// A path the manifest names must be inside the agent's own folder, without "..".
const inside = (path: unknown, prefix: string): string | undefined =>
  typeof path === 'string' && path.startsWith(prefix) && !path.split('/').some((p) => p === '..' || p === '') ? path : undefined

// ---------- OpenBot ----------

export const isOpenBotTransfer = (zip: Zip): boolean => zip.entries.has('openbot-transfer.json')

export function readOpenBot(zip: Zip): ForeignTeam {
  const raw = zip.read('openbot-transfer.json', MAX_MANIFEST)
  if (!raw) throw new Error(L('Esse .zip não é uma exportação do OpenBot.', "That .zip isn't an OpenBot export."))
  let m: Record<string, unknown>
  try {
    m = obj(JSON.parse(raw.toString('utf8')))
  } catch {
    throw new Error(L('O arquivo de exportação do OpenBot está corrompido.', "The OpenBot export file is corrupted."))
  }
  if (m['format'] !== 'openbot-instance-transfer') throw new Error(L('Esse .zip não é uma exportação do OpenBot.', "That .zip isn't an OpenBot export."))
  if (m['version'] !== 1) throw new Error(L('Essa exportação vem de uma versão do OpenBot que o Tucano ainda não lê.', "That export comes from an OpenBot version Tucano doesn't read yet."))

  const notes: string[] = []
  const agents = arr(m['agents']).flatMap((item, i) => {
    try {
      const a = openBotAgent(zip, obj(item))
      return a ? [a] : []
    } catch {
      notes.push(L(`o agente nº ${i + 1}, que não deu pra ler`, `agent #${i + 1}, which couldn't be read`))
      return []
    }
  })
  const settings = obj(m['settings'])
  const servers = arr(settings['mcpServers']).flatMap((s) => str(obj(s)['name'], 128) || [])
  if (arr(settings['customProviders']).length) notes.push(L('os provedores de modelo próprios', 'the custom model providers'))
  if (arr(settings['routineFlows']).length) notes.push(L('os fluxos entre rotinas', 'the routine flows'))
  if (m['shared']) notes.push(L('a pasta Shared', 'the Shared folder'))
  return { source: 'OpenBot', agents, servers, notes }
}

function openBotAgent(zip: Zip, a: Record<string, unknown>): ForeignAgent | undefined {
  const key = str(a['key'], 128)
  const name = str(a['name'], 80)
  if (!key || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(key) || !name) return undefined
  const prefix = `agents/${key}/`
  const notes: string[] = []

  // The standing rules live in the workspace's AGENTS.md (or CLAUDE.md), only there when the export took the files.
  const files = inside(a['files'], prefix)
  const fromFile = files ? (['AGENTS.md', 'CLAUDE.md'].map((f) => zip.read(`${files}/${f}`, MAX_TEXT)).find(Boolean)?.toString('utf8').trim() ?? '') : ''
  const description = str(a['description'], 2_000)
  const instructions = (fromFile || description).slice(0, MAX_INSTRUCTIONS)
  if (!fromFile) notes.push(description ? L('as instruções (só veio a descrição: exporte com os arquivos)', 'the instructions (only the description came: export with the files)') : L('as instruções (exporte com os arquivos)', 'the instructions (export with the files)'))
  if (files) notes.push(L('os outros arquivos do workspace', 'the other workspace files'))

  const { modelId, note } = openBotModel(str(a['provider'], 32), str(a['model'], 256))
  if (note) notes.push(note)

  let picture: string | undefined
  const avatar = inside(a['avatar'], prefix)
  const type = avatar && ({ png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' } as Record<string, string>)[avatar.split('.').pop()!.toLowerCase()]
  if (avatar && type) {
    const bytes = zip.entries.get(avatar)
    if (bytes && bytes.size <= MAX_PICTURE_BYTES) picture = `data:image/${type};base64,${zip.read(avatar, MAX_PICTURE_BYTES)!.toString('base64')}`
    else notes.push(L('a foto (grande demais)', 'the picture (too big)'))
  } else if (avatar) notes.push(L('a foto (formato que o Tucano não mostra)', "the picture (a format Tucano doesn't show)"))

  const skills = arr(a['skills']).flatMap((path) => {
    const folder = inside(path, `${prefix}skills/`)
    const text = folder && zip.read(`${folder}/SKILL.md`, MAX_TEXT)?.toString('utf8')
    if (!folder || !text) return []
    const fm = frontmatter(text)
    const nm = skillName(fm.name || folder.split('/').pop()!)
    const body = fm.body.trim()
    if (!nm || !body) return []
    if (body.length > MAX_SKILL_BODY) {
      notes.push(L(`a skill ${nm} (receita longa demais)`, `the ${nm} skill (recipe too long)`))
      return []
    }
    const extraFiles = [...zip.entries.keys()].filter((f) => f.startsWith(`${folder}/`) && f !== `${folder}/SKILL.md`).length
    return [{ name: nm, description: str(fm.description, 1_000) || nm, body, extraFiles }]
  })

  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  const routines = [...arr(a['routines']), ...arr(a['oneTimeRoutines'])].flatMap((item) => {
    const r = obj(item)
    const rname = str(r['name'], 120)
    const prompt = str(r['instruction'], 20_000)
    if (!rname || !prompt) return []
    const schedule = openBotSchedule(obj(r['schedule']))
    if (!schedule) {
      notes.push(L(`a rotina "${rname}" (horário sem equivalente aqui)`, `the routine "${rname}" (a schedule with no match here)`))
      return []
    }
    const tz = str(r['timezone'], 64)
    if (tz && tz !== here) notes.push(L(`o fuso da rotina "${rname}" (${tz}): o horário ficou como estava, no fuso deste computador`, `the time zone of the routine "${rname}" (${tz}): the time stayed as it was, in this computer's zone`))
    return [{ name: rname, prompt, schedule }]
  })

  const memories = arr(a['memories']).flatMap((item) => str(obj(item)['text'], MAX_MEMORY) || [])

  const hue = a['avatarHue']
  return {
    name,
    role: str(a['title'], 80),
    instructions,
    modelId,
    effort: openBotEffort(a['reasoningEffort']),
    customColor: typeof hue === 'number' && hue >= 0 && hue < 360 ? hueColor(hue) : undefined,
    picture,
    skills,
    routines,
    memories,
    notes
  }
}

// The same CLI keeps the model; a provider Tucano doesn't run leaves the agent on the default.
function openBotModel(provider: string, model: string): { modelId?: string; note?: string } {
  const engines: Record<string, EngineId> = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', cursor: 'cursor' }
  const engine = engines[provider]
  if (engine === 'claude') return { modelId: /opus/i.test(model) ? 'opus' : /haiku/i.test(model) ? 'haiku' : 'sonnet' }
  if (engine === 'codex') return model ? { modelId: codexValue(model) } : {}
  if (engine) return model ? { modelId: customModel(engine, model) } : {}
  return { note: L(`o modelo ${model || provider} (${provider} não roda no Tucano: ficou o modelo padrão)`, `the ${model || provider} model (${provider} doesn't run on Tucano: it got the default model)`) }
}

function openBotEffort(v: unknown): Effort {
  if (v === 'medium') return 'medium'
  if (v === 'high') return 'high'
  if (v === 'xhigh' || v === 'max' || v === 'ultra') return 'xhigh'
  return v === 'none' || v === 'minimal' || v === 'low' ? 'low' : 'medium'
}

// Tucano runs a routine at a time on some weekdays; the rest (hourly, monthly, intervals, cron) has no match.
export function openBotSchedule(s: Record<string, unknown>): Schedule | undefined {
  const t = time(s['time'])
  switch (s['kind']) {
    case 'daily':
      return t ? { days: ALL_DAYS, time: t } : undefined
    case 'weekdays':
      return t ? { days: [1, 2, 3, 4, 5], time: t } : undefined
    case 'weekly': {
      const d = s['weekday']
      return t && typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6 ? { days: [d], time: t } : undefined
    }
    case 'once': {
      // Tucano's "once" runs at the next matching weekday: right only within the coming week.
      const date = typeof s['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s['date']) ? new Date(`${s['date']}T${t ?? '00:00'}:00`) : undefined
      const ahead = date ? date.getTime() - Date.now() : -1
      return t && date && ahead > 0 && ahead < 7 * 86_400_000 ? { days: [date.getDay()], time: t, once: true } : undefined
    }
    case 'advanced': {
      const months = arr(s['months'])
      const days = obj(s['days'])
      const at = obj(s['time'])
      const tt = at['kind'] === 'at-time' ? time(at['time']) : undefined
      if (months.length !== 12 || !tt) return undefined
      if (days['kind'] === 'every-day') return { days: ALL_DAYS, time: tt }
      const list = arr(days['days']).filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
      return days['kind'] === 'days-of-week' && list.length ? { days: [...new Set(list)].sort(), time: tt } : undefined
    }
    default:
      return undefined
  }
}

// OpenBot keeps a hue (0, 30… 320); here a color is #rrggbb.
export function hueColor(h: number): string {
  const s = 0.6
  const l = 0.52
  const k = (n: number): number => (n + h / 30) % 12
  const f = (n: number): number => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
}

// ---------- adding it here ----------

// A @handle from a name: "Lúcia M." → "luciam", with a number when it's taken.
const handleFor = (name: string, taken: Set<string>): string => {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 28) || 'agente'
  let h = base
  for (let i = 2; taken.has(h) || h === 'tuca'; i++) h = `${base}${i}`
  return h
}

export interface ImportResult {
  summary: string
  agents: string[] // ids added
  memories: Memory[]
}

export function applyForeignTeam(db: Db, team: ForeignTeam, opts: { defaultLimit: number; defaultModel: string }): ImportResult {
  const added = { agents: [] as string[], skills: 0, routines: 0, memories: [] as Memory[], same: [] as string[] }
  const left: string[] = [...team.notes]
  const skillsBefore = new Set(db.skills().filter((k) => k.state === 'active').map((k) => k.name))
  const createdSkills = new Map<string, string>() // name → id, made by this import

  for (const f of team.agents) {
    const existing = db.agents().filter((x) => !x.archived)
    // The same agent imported before: same name, role and instructions.
    if (existing.some((x) => x.name === f.name && x.role === f.role && x.instructions === f.instructions)) {
      added.same.push(f.name)
      continue
    }
    const handle = handleFor(f.name, new Set(db.agents().map((x) => x.handle)))
    const agent: Agent = cleanLook({
      id: randomUUID(),
      name: f.name,
      handle,
      role: f.role,
      color: 'sky',
      customColor: f.customColor,
      picture: f.picture,
      instructions: f.instructions,
      modelId: f.modelId ?? opts.defaultModel,
      effort: f.effort,
      maxRoutines: MAX_AGENT_ROUTINES,
      limit: opts.defaultLimit,
      used: 0,
      grants: {}, // the other app's access doesn't come: each connector is given here, by hand
      memory: 'auto',
      computer: false,
      archived: false
    })
    db.saveAgent(agent)
    added.agents.push(agent.id)
    for (const n of f.notes) left.push(`@${handle}: ${n}`)

    for (const k of f.skills) {
      if (k.extraFiles) left.push(L(`@${handle}: ${k.extraFiles} arquivo${k.extraFiles > 1 ? 's' : ''} da skill ${k.name} além do SKILL.md`, `@${handle}: ${k.extraFiles} file${k.extraFiles > 1 ? 's' : ''} of the ${k.name} skill besides SKILL.md`))
      const mine = createdSkills.get(k.name)
      const same = mine ? db.skill(mine) : undefined
      if (same && same.body === k.body) {
        db.saveSkill({ ...same, agents: [...new Set([...same.agents, agent.id])], updatedAt: Date.now() })
        continue
      }
      let nm = k.name
      if (skillsBefore.has(nm) || createdSkills.has(nm)) nm = skillName(`${k.name}-${handle}`)
      if (skillsBefore.has(nm) || createdSkills.has(nm)) {
        left.push(L(`@${handle}: a skill ${k.name} (já existe uma com esse nome)`, `@${handle}: the ${k.name} skill (one with that name already exists)`))
        continue
      }
      const at = Date.now()
      const id = randomUUID()
      db.saveSkill({ id, name: nm, description: k.description, body: k.body, agents: [agent.id], state: 'active', createdAt: at, updatedAt: at })
      createdSkills.set(nm, id)
      added.skills++
    }

    if (f.routines.length) {
      let dm = db.conversations().find((c) => c.kind === 'dm' && c.name === agent.id)?.id
      if (!dm) {
        dm = randomUUID()
        db.createConversation({ id: dm, kind: 'dm', name: agent.id, members: [agent.id] })
      }
      for (const r of f.routines) {
        const routine: Routine = { id: randomUUID(), name: r.name, agentId: agent.id, conversationId: dm, prompt: r.prompt, schedule: r.schedule, enabled: false, createdAt: Date.now() }
        db.saveRoutine(routine)
        added.routines++
      }
    }

    // Waiting for a yes, like any memory an agent proposes.
    const seen = new Set<string>()
    for (const text of f.memories) {
      const key = text.toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) continue
      seen.add(key)
      const at = Date.now()
      const m: Memory = { id: randomUUID(), scope: agent.id, text, state: 'pending', origin: 'agent', agentId: agent.id, messageIds: [], createdAt: at, confirmedAt: at }
      db.saveMemory(m)
      added.memories.push(m)
    }
  }

  const n = added.agents.length
  const parts = [
    n && L(`${n} agente${n > 1 ? 's' : ''} sem nenhum conector liberado`, `${n} agent${n > 1 ? 's' : ''} with no connector granted`),
    added.skills && `${added.skills} skill${added.skills > 1 ? 's' : ''}`,
    added.routines && L(`${added.routines} rotina${added.routines > 1 ? 's' : ''} (desligadas)`, `${added.routines} routine${added.routines > 1 ? 's' : ''} (off)`),
    added.memories.length && L(`${added.memories.length} memória${added.memories.length > 1 ? 's' : ''} pra você confirmar`, `${added.memories.length} memor${added.memories.length > 1 ? 'ies' : 'y'} for you to confirm`)
  ].filter(Boolean)
  const done = parts.length ? L(`Do ${team.source}, importei ${parts.join(', ')}.`, `From ${team.source}, I imported ${parts.join(', ')}.`) : L(`Nada novo do ${team.source}.`, `Nothing new from ${team.source}.`)
  const same = added.same.length ? L(` Já existiam aqui: ${added.same.join(', ')}.`, ` Already here: ${added.same.join(', ')}.`) : ''
  const servers = team.servers.length ? L(` Conectores pra adicionar à mão, se quiser: ${team.servers.join(', ')}.`, ` Connectors to add by hand, if you want: ${team.servers.join(', ')}.`) : ''
  const out = left.length ? `\n\n${L('Ficou de fora:', 'Left out:')}\n${left.map((x) => `• ${x}`).join('\n')}` : ''
  return { summary: `${done}${same}${servers}${out}`, agents: added.agents, memories: added.memories }
}

// Reads whichever app the .zip came from.
export function readForeignZip(zip: Zip): ForeignTeam {
  if (isOpenBotTransfer(zip)) return readOpenBot(zip)
  if (zip.entries.has('openbot-import.json')) throw new Error(L('Esse .zip é o do Grok Bot para o OpenBot, que o Tucano ainda não lê.', "That .zip is Grok Bot's export for OpenBot, which Tucano doesn't read yet."))
  throw new Error(L('Não reconheci esse .zip. O Tucano importa a exportação do OpenBot (Configurações do servidor → Transfer → Export).', "I didn't recognize that .zip. Tucano imports OpenBot's export (Server settings → Transfer → Export)."))
}
