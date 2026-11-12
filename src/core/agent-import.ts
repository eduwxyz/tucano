// Agents from another app (spec §26). Each source becomes one `ForeignTeam`, and `applyForeignTeam`
// adds it the same way for all: the agents come in with no connector granted, web search off, their
// routines off and their memories waiting for the person to confirm. Nothing that can run comes in by
// itself: an MCP server of the other app is named in the summary, never added as a connector. A file
// never puts an agent in a channel that's already here: its group chats become channels of their own.
//
// OpenBot: the .zip of Server settings → Transfer → Export from this server (`openbot-transfer.json`,
// format "openbot-instance-transfer", version 1). Only its documented format is read here; none of
// OpenBot's code is used.
//
// Apps with no export of their own (Grok Bot): the person gives one of their agents there our skill
// (assets/tucano-export-skill.md), and it writes a .zip in Tucano's own format (`tucano-import.json`,
// format "tucano-agent-import", version 1), read by `readTucanoImport`.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { channelName, codexValue, customModel, dateAt, MAX_AGENT_ROUTINES, validDate, type Agent, type Effort, type EngineId, type Memory, type Routine, type Schedule } from '../shared/types'
import { cleanLook } from './agent-look'
import type { Db } from './db'
import { frontmatter } from './local-skills'
import { overlongSkillNote } from '../shared/skills'
import { instructionLengthNote } from '../shared/instructions'
import { skillName } from './skills'
import type { Zip } from './zip'

export interface ForeignSkill {
  name: string
  description: string
  body: string
  extraFiles: number // files beside SKILL.md, which stay out
}

export interface ForeignAgent {
  key: string // the agent's id inside the file, which channels name
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
  source: string // "OpenBot", "Grok Bot"
  agents: ForeignAgent[]
  channels: { name: string; topic?: string; members: string[] }[] // members by agent key
  servers: string[] // MCP servers there, by name, to add by hand
  notes: string[]
}

const MAX_MANIFEST = 20_000_000
const MAX_TEXT = 1_000_000
const MAX_PICTURE_BYTES = 145_000 // as a data URL it stays under cleanLook's cap
const MAX_MEMORY = 300
// What one file brings at most; the rest is counted in the summary.
export const IMPORT_CAPS = { agents: 40, channels: 30, skills: 20, routines: 20, memories: 40 }
const SUMMARY_LINES = 40

const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const time = (v: unknown): string | undefined => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined)
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

// The first `cap` items of a list; the summary says how many stayed out.
function capped(v: unknown, cap: number, what: (n: number) => string, notes: string[]): unknown[] {
  const list = arr(v)
  if (list.length > cap) notes.push(what(list.length - cap))
  return list.slice(0, cap)
}
// A part that can't be read (too big, broken) stays out alone, not with the whole agent.
function attempt<T>(read: () => T, fallback: T, note: string, notes: string[]): T {
  try {
    return read()
  } catch {
    notes.push(note)
    return fallback
  }
}

// A path the manifest names must be inside the agent's own folder, without "..".
const inside = (path: unknown, prefix: string): string | undefined =>
  typeof path === 'string' && path.startsWith(prefix) && !path.split('/').some((p) => p === '..' || p === '') ? path : undefined
const KEY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/ // OpenBot's agent keys
const OUR_KEY = /^[a-z][a-z0-9-]{0,39}$/ // tucano-import.json's

// The picture, as a data URL, when it's a kind and a size this app shows.
function readPicture(zip: Zip, path: unknown, prefix: string, notes: string[]): string | undefined {
  const avatar = inside(path, prefix)
  if (!avatar) return undefined
  const type = ({ png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' } as Record<string, string>)[avatar.split('.').pop()!.toLowerCase()]
  if (!type) {
    notes.push(L('a foto (formato que o Tucano não mostra)', "the picture (a format Tucano doesn't show)"))
    return undefined
  }
  const entry = zip.entries.get(avatar)
  if (!entry) return undefined
  if (entry.size > MAX_PICTURE_BYTES) {
    notes.push(L('a foto (grande demais)', 'the picture (too big)'))
    return undefined
  }
  const bytes = attempt(() => zip.read(avatar, MAX_PICTURE_BYTES), undefined, L('a foto (não deu pra ler)', "the picture (it couldn't be read)"), notes)
  return bytes && `data:image/${type};base64,${bytes.toString('base64')}`
}

// Each skill is a folder with a SKILL.md; only the recipe comes, the files beside it are counted.
function readSkills(zip: Zip, paths: unknown, prefix: string, notes: string[]): ForeignSkill[] {
  const list = capped(paths, IMPORT_CAPS.skills, (n) => L(`${n} skill${n > 1 ? 's' : ''} além de ${IMPORT_CAPS.skills}`, `${n} skill${n > 1 ? 's' : ''} beyond ${IMPORT_CAPS.skills}`), notes)
  return list.flatMap((path) => {
    const folder = inside(path, `${prefix}skills/`)
    const where = folder?.split('/').pop() ?? ''
    const text = folder && attempt(() => zip.read(`${folder}/SKILL.md`, MAX_TEXT)?.toString('utf8'), undefined, L(`a skill ${where} (não deu pra ler)`, `the ${where} skill (it couldn't be read)`), notes)
    if (!folder || !text) return []
    const fm = frontmatter(text)
    const nm = skillName(fm.name || folder.split('/').pop()!)
    const body = fm.body.trim()
    if (!nm || !body) return []
    const extraFiles = [...zip.entries.keys()].filter((f) => f.startsWith(`${folder}/`) && f !== `${folder}/SKILL.md`).length
    return [{ name: nm, description: str(fm.description, 1_000) || nm, body, extraFiles }]
  })
}

const memoriesOf = (v: unknown, notes: string[]): string[] =>
  capped(v, IMPORT_CAPS.memories, (n) => L(`${n} memória${n > 1 ? 's' : ''} além de ${IMPORT_CAPS.memories}`, `${n} memor${n > 1 ? 'ies' : 'y'} beyond ${IMPORT_CAPS.memories}`), notes).flatMap(
    (item) => str(typeof item === 'string' ? item : obj(item)['text'], MAX_MEMORY) || []
  )
const routinesOver = (n: number): string => L(`${n} rotina${n > 1 ? 's' : ''} além de ${IMPORT_CAPS.routines}`, `${n} routine${n > 1 ? 's' : ''} beyond ${IMPORT_CAPS.routines}`)
const agentsOver = (n: number): string => L(`${n} agente${n > 1 ? 's' : ''} além de ${IMPORT_CAPS.agents} (importe de novo com menos)`, `${n} agent${n > 1 ? 's' : ''} beyond ${IMPORT_CAPS.agents} (import again with fewer)`)
const channelsOver = (n: number): string => L(`${n} ${n > 1 ? 'canais' : 'canal'} além de ${IMPORT_CAPS.channels}`, `${n} channel${n > 1 ? 's' : ''} beyond ${IMPORT_CAPS.channels}`)

// A routine's own time zone isn't this computer's: the time stays the same, and the summary says so.
function zoneNote(tz: string, name: string, notes: string[]): void {
  if (tz && tz !== Intl.DateTimeFormat().resolvedOptions().timeZone)
    notes.push(L(`o fuso da rotina "${name}" (${tz}): o horário ficou como estava, no fuso deste computador`, `the time zone of the routine "${name}" (${tz}): the time stayed as it was, in this computer's zone`))
}

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
  const agents = capped(m['agents'], IMPORT_CAPS.agents, agentsOver, notes).flatMap((item, i) => {
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
  return { source: 'OpenBot', agents, servers, notes, channels: [] }
}

function openBotAgent(zip: Zip, a: Record<string, unknown>): ForeignAgent | undefined {
  const key = str(a['key'], 128)
  const name = str(a['name'], 80)
  if (!key || !KEY.test(key) || !name) return undefined
  const prefix = `agents/${key}/`
  const notes: string[] = []

  // The standing rules live in the workspace's AGENTS.md (or CLAUDE.md), only there when the export took the files.
  const files = inside(a['files'], prefix)
  const fromFile = files
    ? attempt(() => ['AGENTS.md', 'CLAUDE.md'].map((f) => zip.read(`${files}/${f}`, MAX_TEXT)).find(Boolean)?.toString('utf8') ?? '', '', L('o AGENTS.md (não deu pra ler)', "AGENTS.md (it couldn't be read)"), notes)
    : ''
  const description = typeof a['description'] === 'string' ? a['description'] : ''
  const instructions = fromFile || description
  const longPrompt = instructionLengthNote(instructions.length)
  if (longPrompt) notes.push(longPrompt)
  if (!fromFile) notes.push(description ? L('as instruções (só veio a descrição: exporte com os arquivos)', 'the instructions (only the description came: export with the files)') : L('as instruções (exporte com os arquivos)', 'the instructions (export with the files)'))
  if (files) notes.push(L('os outros arquivos do workspace', 'the other workspace files'))

  const { modelId, note } = openBotModel(str(a['provider'], 32), str(a['model'], 256))
  if (note) notes.push(note)

  const picture = readPicture(zip, a['avatar'], prefix, notes)
  const skills = readSkills(zip, a['skills'], prefix, notes)

  const routines = capped([...arr(a['routines']), ...arr(a['oneTimeRoutines'])], IMPORT_CAPS.routines, routinesOver, notes).flatMap((item) => {
    const r = obj(item)
    const rname = str(r['name'], 120)
    const prompt = str(r['instruction'], 20_000)
    if (!rname || !prompt) return []
    const schedule = openBotSchedule(obj(r['schedule']))
    if (!schedule) {
      notes.push(L(`a rotina "${rname}" (horário sem equivalente aqui)`, `the routine "${rname}" (a schedule with no match here)`))
      return []
    }
    zoneNote(str(r['timezone'], 64), rname, notes)
    return [{ name: rname, prompt, schedule }]
  })

  const memories = memoriesOf(a['memories'], notes)

  const hue = a['avatarHue']
  return {
    key,
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
  const engines: Record<string, EngineId> = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', antigravity: 'antigravity', cursor: 'cursor' }
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

// Tucano runs a routine at a time on some weekdays, on a date or on a day of the month; the rest (hourly, intervals, cron) has no match.
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
    case 'monthly': {
      const d = s['day']
      return t && typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 31 ? { days: [0, 1, 2, 3, 4, 5, 6], time: t, monthDay: d } : undefined
    }
    case 'once': {
      // On that date, once; one already past isn't brought.
      const date = typeof s['date'] === 'string' && validDate(s['date']) ? s['date'] : undefined
      return t && date && dateAt(date, t) > Date.now() ? { days: [new Date(dateAt(date, t)).getDay()], time: t, once: true, date } : undefined
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

// ---------- Tucano's own format (Grok Bot, and any app with no export) ----------

export const TUCANO_IMPORT = 'tucano-import.json'
const SOURCES: Record<string, string> = { 'grok-bot': 'Grok Bot' }
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export function readTucanoImport(zip: Zip): ForeignTeam {
  const raw = zip.read(TUCANO_IMPORT, MAX_MANIFEST)
  if (!raw) throw new Error(L('Esse .zip não é uma exportação pro Tucano.', "That .zip isn't an export for Tucano."))
  let m: Record<string, unknown>
  try {
    m = obj(JSON.parse(raw.toString('utf8')))
  } catch {
    throw new Error(L('O arquivo tucano-import.json está corrompido.', 'The tucano-import.json file is corrupted.'))
  }
  if (m['format'] !== 'tucano-agent-import') throw new Error(L('Esse .zip não é uma exportação pro Tucano.', "That .zip isn't an export for Tucano."))
  if (m['version'] !== 1) throw new Error(L('Essa exportação é de uma versão mais nova do formato. Atualize o Tucano.', 'That export is from a newer version of the format. Update Tucano.'))
  const app = str(m['source'], 40)
  const source = SOURCES[app] ?? (app || L('outro app', 'another app'))

  const notes: string[] = []
  const keys = new Set<string>()
  const agents = capped(m['agents'], IMPORT_CAPS.agents, agentsOver, notes).flatMap((item, i) => {
    try {
      const a = tucanoAgent(zip, obj(item), source)
      if (!a || keys.has(a.key)) {
        notes.push(L(`o agente nº ${i + 1} (sem nome, ou com a chave inválida ou repetida)`, `agent #${i + 1} (no name, or a key that's invalid or repeated)`))
        return []
      }
      keys.add(a.key)
      return [a]
    } catch {
      notes.push(L(`o agente nº ${i + 1}, que não deu pra ler`, `agent #${i + 1}, which couldn't be read`))
      return []
    }
  })
  const channels = capped(m['channels'], IMPORT_CAPS.channels, channelsOver, notes).flatMap((item) => {
    const c = obj(item)
    const name = channelName(str(c['name'], 80))
    if (!name) return []
    const members = arr(c['members']).filter((k): k is string => typeof k === 'string' && keys.has(k))
    if (arr(c['routines']).length) notes.push(L(`as rotinas do canal #${name} (crie de novo no canal)`, `the routines of #${name} (make them again in the channel)`))
    return [{ name, topic: str(c['topic'], 200) || undefined, members: [...new Set(members)] }]
  })
  return { source, agents, servers: [], notes, channels }
}

function tucanoAgent(zip: Zip, a: Record<string, unknown>, source: string): ForeignAgent | undefined {
  const key = str(a['key'], 40)
  const name = str(a['name'], 80)
  if (!OUR_KEY.test(key) || !name) return undefined
  const prefix = `agents/${key}/`
  const notes: string[] = []
  const instructions = typeof a['instructions'] === 'string' ? a['instructions'] : ''
  const longPrompt = instructionLengthNote(instructions.length)
  if (longPrompt) notes.push(longPrompt)
  if (!instructions) notes.push(L('as instruções (não vieram no arquivo)', "the instructions (they weren't in the file)"))
  notes.push(L(`o modelo do ${source} (ficou o modelo padrão)`, `the ${source} model (it got the default model)`))

  const routines = capped(a['routines'], IMPORT_CAPS.routines, routinesOver, notes).flatMap((item) => {
    const r = obj(item)
    const rname = str(r['name'], 120)
    const prompt = str(r['prompt'], 20_000)
    if (!rname || !prompt) return []
    const schedule = tucanoSchedule(r)
    if (!schedule) {
      notes.push(L(`a rotina "${rname}" (horário sem equivalente aqui)`, `the routine "${rname}" (a schedule with no match here)`))
      return []
    }
    zoneNote(str(r['timezone'], 64), rname, notes)
    return [{ name: rname, prompt, schedule }]
  })

  return {
    key,
    name,
    role: str(a['role'], 80),
    instructions,
    effort: 'medium',
    picture: readPicture(zip, a['picture'], prefix, notes),
    skills: readSkills(zip, a['skills'], prefix, notes),
    routines,
    memories: memoriesOf(a['memories'], notes),
    notes
  }
}

// { days: ["mon", "wed"], time: "08:30", once?: true, date?: "2026-11-17", monthDay?: 5 }: what a routine here already is, with day names.
export function tucanoSchedule(r: Record<string, unknown>): Schedule | undefined {
  const t = time(r['time'])
  if (t && typeof r['date'] === 'string' && validDate(r['date'])) return { days: [new Date(dateAt(r['date'], t)).getDay()], time: t, once: true, date: r['date'] }
  const md = r['monthDay']
  if (t && typeof md === 'number' && Number.isInteger(md) && md >= 1 && md <= 31) return { days: [0, 1, 2, 3, 4, 5, 6], time: t, monthDay: md }
  const days = arr(r['days']).map((d) => (typeof d === 'string' ? DAYS.indexOf(d.toLowerCase().slice(0, 3)) : -1))
  if (!t || !days.length || days.some((d) => d < 0)) return undefined
  return { days: [...new Set(days)].sort(), time: t, ...(r['once'] === true ? { once: true } : {}) }
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

// `works`: whether a model runs here now (its harness chosen and signed in); `defaultModel` is one that does.
export function applyForeignTeam(db: Db, team: ForeignTeam, opts: { defaultLimit: number; defaultModel: string; works?: (modelId: string) => boolean }): ImportResult {
  const added = { agents: [] as string[], skills: 0, routines: 0, memories: [] as Memory[], same: [] as string[] }
  const left: string[] = [...team.notes]
  const skillsBefore = new Set(db.skills().filter((k) => k.state === 'active').map((k) => k.name))
  const createdSkills = new Map<string, string>() // name → id, made by this import
  const byKey = new Map<string, string>() // the file's agent key → the agent here

  for (const f of team.agents) {
    const existing = db.agents().filter((x) => !x.archived)
    // The same agent imported before: same name, role and instructions.
    const before = existing.find((x) => x.name === f.name && x.role === f.role && x.instructions === f.instructions)
    if (before) {
      added.same.push(f.name)
      byKey.set(f.key, before.id)
      continue
    }
    const handle = handleFor(f.name, new Set(db.agents().map((x) => x.handle)))
    // The other app's model when it runs here; else one that does.
    const ready = f.modelId && (!opts.works || opts.works(f.modelId))
    if (f.modelId && !ready) left.push(L(`@${handle}: o modelo ${f.modelId} (o CLI dele não está pronto aqui: ficou ${opts.defaultModel})`, `@${handle}: the ${f.modelId} model (its CLI isn't ready here: it got ${opts.defaultModel})`))
    const agent: Agent = cleanLook({
      id: randomUUID(),
      name: f.name,
      handle,
      role: f.role,
      color: 'sky',
      customColor: f.customColor,
      picture: f.picture,
      instructions: f.instructions,
      modelId: ready ? f.modelId! : opts.defaultModel,
      effort: f.effort,
      maxRoutines: MAX_AGENT_ROUTINES,
      limit: opts.defaultLimit,
      used: 0,
      grants: {}, // the other app's access doesn't come: each connector is given here, by hand
      memory: 'auto',
      // Instructions written somewhere else: no way out to the internet until the person turns it on.
      web: false,
      computer: false,
      archived: false
    })
    db.saveAgent(agent)
    added.agents.push(agent.id)
    byKey.set(f.key, agent.id)
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
      const note = overlongSkillNote(k.name, k.body.length)
      if (note) left.push(`@${handle}: ${note}`)
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

  // Group chats become channels of their own: an imported agent never joins one that's already here,
  // where it would read the conversation. And only the agents made by this import go in: one that was
  // already here (it may only look the same, like a copy of Tuca) is never put in a room with a stranger
  // by a file. Imported again, the channel has no one new and is skipped.
  const made = new Set(added.agents)
  let channels = 0
  for (const c of team.channels) {
    const mapped = [...new Set(c.members.flatMap((k) => byKey.get(k) ?? []))]
    const members = mapped.filter((id) => made.has(id))
    if (!members.length) continue
    const kept = mapped.filter((id) => !made.has(id)).map((id) => db.agent(id)?.name).filter(Boolean)
    const all = db.conversations().filter((x) => x.kind === 'channel')
    const base = c.name.slice(0, 54) // room for "-<number>" within a channel name's 60
    const same = (x: { name: string; members: string[] }): boolean =>
      (x.name === c.name || (x.name.startsWith(`${base}-`) && /^\d+$/.test(x.name.slice(base.length + 1)))) && x.members.length === members.length && members.every((id) => x.members.includes(id))
    if (all.some(same)) continue
    let name = c.name
    for (let i = 2; all.some((x) => x.name === name); i++) name = `${base}-${i}`
    if (name !== c.name) left.push(L(`o canal #${c.name} já existia: os agentes entraram no #${name}, novo`, `#${c.name} already existed: the agents went into a new #${name}`))
    if (kept.length) left.push(L(`#${name}: ${kept.join(', ')} já ${kept.length > 1 ? 'estavam' : 'estava'} aqui e não ${kept.length > 1 ? 'entraram' : 'entrou'} (só os agentes importados agora entram)`, `#${name}: ${kept.join(', ')} ${kept.length > 1 ? 'were' : 'was'} already here and stayed out (only the agents imported now go in)`))
    db.createConversation({ id: randomUUID(), kind: 'channel', name, topic: c.topic, members })
    channels++
  }

  const n = added.agents.length
  const parts = [
    n && L(`${n} agente${n > 1 ? 's' : ''} sem nenhum conector e com a busca na web desligada`, `${n} agent${n > 1 ? 's' : ''} with no connector and web search off`),
    added.skills && `${added.skills} skill${added.skills > 1 ? 's' : ''}`,
    channels && L(`${channels} ${channels > 1 ? 'canais' : 'canal'}`, `${channels} channel${channels > 1 ? 's' : ''}`),
    added.routines && L(`${added.routines} rotina${added.routines > 1 ? 's' : ''} (desligadas)`, `${added.routines} routine${added.routines > 1 ? 's' : ''} (off)`),
    added.memories.length && L(`${added.memories.length} memória${added.memories.length > 1 ? 's' : ''} pra você confirmar`, `${added.memories.length} memor${added.memories.length > 1 ? 'ies' : 'y'} for you to confirm`)
  ].filter(Boolean)
  const done = parts.length ? L(`Do ${team.source}, importei ${parts.join(', ')}.`, `From ${team.source}, I imported ${parts.join(', ')}.`) : L(`Nada novo do ${team.source}.`, `Nothing new from ${team.source}.`)
  const same = added.same.length ? L(` Já existiam aqui: ${added.same.join(', ')}.`, ` Already here: ${added.same.join(', ')}.`) : ''
  const servers = team.servers.length ? L(` Conectores pra adicionar à mão, se quiser: ${team.servers.join(', ')}.`, ` Connectors to add by hand, if you want: ${team.servers.join(', ')}.`) : ''
  const shown = left.slice(0, SUMMARY_LINES).map((x) => `• ${x}`)
  if (left.length > SUMMARY_LINES) shown.push(L(`• e mais ${left.length - SUMMARY_LINES}`, `• and ${left.length - SUMMARY_LINES} more`))
  const out = left.length ? `\n\n${L('Fica pra você ver:', 'For you to check:')}\n${shown.join('\n')}` : ''
  return { summary: `${done}${same}${servers}${out}`, agents: added.agents, memories: added.memories }
}

// Reads whichever app the .zip came from.
export function readForeignZip(zip: Zip): ForeignTeam {
  if (isOpenBotTransfer(zip)) return readOpenBot(zip)
  if (zip.entries.has(TUCANO_IMPORT)) return readTucanoImport(zip)
  if (zip.entries.has('openbot-import.json')) throw new Error(L('Esse .zip foi feito pro OpenBot. Pra trazer do Grok Bot, use a skill de exportação do Tucano (botão "Skill pro Grok Bot").', 'That .zip was made for OpenBot. To bring agents from Grok Bot, use Tucano\'s export skill (the "Skill for Grok Bot" button).'))
  throw new Error(L('Não reconheci esse .zip. O Tucano importa a exportação do OpenBot (Configurações do servidor → Transfer → Export) e a do Grok Bot feita com a skill do Tucano.', "I didn't recognize that .zip. Tucano imports OpenBot's export (Server settings → Transfer → Export) and Grok Bot's, made with Tucano's skill."))
}
