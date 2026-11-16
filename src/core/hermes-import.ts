// Hermes Agent (Nous Research), spec §26: the person's Hermes folder is read where it is
// ($HERMES_HOME, ~/.hermes, or one they pick), on this same computer, and becomes a `ForeignTeam`
// that `applyForeignTeam` adds like OpenBot's: no connector, web off, no computer, routines off,
// memories waiting for a yes, MCP servers only named.
//
// Only a list of files is ever opened, by name (ALLOWED): never .env, auth.json or any of the
// other credential files Hermes keeps beside them, never the sessions, state.db or logs. A file
// that is a link to somewhere outside the Hermes folder is not followed. The layout, as Hermes
// writes it (github.com/NousResearch/hermes-agent):
//
//   SOUL.md                     the agent's identity (slot #1 of its prompt)
//   memories/MEMORY.md          the agent's notes, entries split by "\n§\n"
//   memories/USER.md            what it knows about the person, the same way
//   skills/<name>/SKILL.md      and skills/<category>/<name>/SKILL.md; dot folders (.hub,
//                               .archive…) are Hermes's own, and the ones in .bundled_manifest
//                               came with Hermes, not from the person
//   cron/jobs.json              { jobs: [{ name, prompt, schedule: { kind: once|interval|cron,
//                               run_at | minutes | expr }, timezone?, no_agent?, script? }] }
//   config.yaml                 model, agent.reasoning_effort, mcp_servers, platforms (gateways)
//   profiles/<name>/            each one the same layout again: one more agent
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { L } from '../shared/lang'
import { customModel, type Effort, type Schedule } from '../shared/types'
import type { HermesPreview, HermesProfile } from '../shared/hermes-import'
import { IMPORT_CAPS, type ForeignAgent, type ForeignSkill, type ForeignTeam } from './agent-import'
import { frontmatter } from './local-skills'
import { skillName } from './skills'

const MAX_TEXT = 1_000_000 // SOUL.md, a SKILL.md, a memories file, config.yaml
const MAX_JOBS = 5_000_000 // cron/jobs.json keeps run bookkeeping too
const MAX_MEMORY = 300
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/ // Hermes's own rule for a profile's name
const ENTRY = '\n§\n' // Hermes's memory entries
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

// The only files read, relative to a profile's folder. Skills are read as <dir>/SKILL.md under skills/.
const ALLOWED = new Set(['SOUL.md', 'config.yaml', 'memories/MEMORY.md', 'memories/USER.md', 'cron/jobs.json', 'skills/.bundled_manifest'])

// Where Hermes lives when the person doesn't say: $HERMES_HOME (a profile's folder points back to
// its root, profiles/<name> → the folder above) or ~/.hermes.
export function hermesRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const set = env['HERMES_HOME']?.trim()
  if (!set) return join(home, '.hermes')
  const p = resolve(set)
  return basename(dirname(p)) === 'profiles' ? dirname(dirname(p)) : p
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export interface HermesReadOpts {
  // Every file opened, for the tests that prove .env and auth.json never are.
  onRead?: (path: string) => void
  now?: number
}

// A reader confined to one folder: only regular files, only inside it (a link out isn't followed).
function reader(root: string, opts: HermesReadOpts) {
  const real = realpathSync(root)
  const within = (p: string): boolean => {
    try {
      const r = realpathSync(p)
      return r === real || r.startsWith(real + sep)
    } catch {
      return false
    }
  }
  const isDir = (p: string): boolean => {
    try {
      return within(p) && statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  // undefined: not there; null: there, but too big, a link out, or unreadable.
  const text = (p: string, max = MAX_TEXT): string | undefined | null => {
    try {
      lstatSync(p)
    } catch {
      return undefined
    }
    try {
      if (!within(p)) return null
      const st = statSync(p)
      if (!st.isFile() || st.size > max) return null
      opts.onRead?.(p)
      return readFileSync(p, 'utf8').replace(/^﻿/, '')
    } catch {
      return null
    }
  }
  // There, without opening it.
  const exists = (p: string): boolean => {
    try {
      lstatSync(p)
      return true
    } catch {
      return false
    }
  }
  const list = (p: string): string[] => {
    if (!isDir(p)) return []
    try {
      return readdirSync(p).filter((n) => !n.startsWith('.')).sort()
    } catch {
      return []
    }
  }
  return { real, text, list, isDir, exists }
}
type Reader = ReturnType<typeof reader>

// A file of the allow list, in a profile's folder.
const allowed = (r: Reader, dir: string, file: string, max?: number): string | undefined | null => {
  if (!ALLOWED.has(file)) throw new Error(`not on the list: ${file}`)
  return r.text(join(dir, ...file.split('/')), max)
}

// ---------- the parts of one profile ----------

// SOUL.md, unless it's only the comment scaffold old installers wrote (it carries nothing).
function soulOf(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').trim()
  const bare = t.replace(/<!--[\s\S]*?-->/g, '').replace(/^#\s*Hermes Agent Persona\s*$/m, '').trim()
  return bare ? t : ''
}

function entries(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(ENTRY)
    .map((e) => e.trim())
    .filter(Boolean)
}

// The entries that fit (40, of up to 300 characters each); the summary counts the rest.
function memoriesOf(text: string | undefined | null, which: 'agent' | 'user', notes: string[]): string[] {
  if (text === null) {
    notes.push(which === 'agent' ? L('as memórias (MEMORY.md grande demais ou ilegível)', "the memories (MEMORY.md too big or unreadable)") : L('o que ele sabia sobre você (USER.md grande demais ou ilegível)', "what it knew about you (USER.md too big or unreadable)"))
    return []
  }
  if (!text) return []
  const all = entries(text)
  const long = all.filter((e) => e.length > MAX_MEMORY).length
  const fit = all.filter((e) => e.length <= MAX_MEMORY)
  const over = Math.max(0, fit.length - IMPORT_CAPS.memories)
  if (long)
    notes.push(
      which === 'agent'
        ? L(`${long} memória${long > 1 ? 's' : ''} com mais de ${MAX_MEMORY} caracteres (copie à mão, se quiser)`, `${long} memor${long > 1 ? 'ies' : 'y'} longer than ${MAX_MEMORY} characters (copy by hand, if you want)`)
        : L(`${long} memória${long > 1 ? 's' : ''} sobre você com mais de ${MAX_MEMORY} caracteres (copie à mão, se quiser)`, `${long} memor${long > 1 ? 'ies' : 'y'} about you longer than ${MAX_MEMORY} characters (copy by hand, if you want)`)
    )
  const about = which === 'user' ? L(' sobre você', ' about you') : ''
  if (over) notes.push(L(`${over} memória${over > 1 ? 's' : ''}${about} além de ${IMPORT_CAPS.memories}`, `${over} memor${over > 1 ? 'ies' : 'y'}${about} beyond ${IMPORT_CAPS.memories}`))
  return fit.slice(0, IMPORT_CAPS.memories)
}

// The names of the skills that came with Hermes (v2 "name:hash" lines, v1 a name alone).
function bundled(r: Reader, dir: string): Set<string> {
  const t = allowed(r, dir, 'skills/.bundled_manifest')
  return new Set(
    (t || '')
      .split(/\r?\n/)
      .map((l) => l.split(':')[0]!.trim())
      .filter(Boolean)
  )
}

const countFiles = (r: Reader, dir: string, depth = 0): number =>
  depth > 4 ? 0 : r.list(dir).reduce((n, f) => n + (r.isDir(join(dir, f)) ? countFiles(r, join(dir, f), depth + 1) : 1), 0)

// <name>/SKILL.md, or one level deeper <category>/<name>/SKILL.md (the same rule as the skill folders'
// discovery, src/core/local-skills.ts); dot folders are Hermes's own.
function skillDirs(r: Reader, root: string): string[] {
  return r.list(root).flatMap((d) => {
    const here = join(root, d)
    if (!r.isDir(here)) return []
    if (r.exists(join(here, 'SKILL.md'))) return [here]
    return r
      .list(here)
      .map((x) => join(here, x))
      .filter((x) => r.isDir(x) && r.exists(join(x, 'SKILL.md')))
  })
}

function skillsOf(r: Reader, dir: string, notes: string[]): { skills: ForeignSkill[]; stock: number } {
  const root = join(dir, 'skills')
  const stock = bundled(r, dir)
  const mine: { folder: string; text: string | null }[] = []
  let came = 0
  for (const folder of skillDirs(r, root)) {
    const text = r.text(join(folder, 'SKILL.md')) ?? null
    const fm = text ? frontmatter(text) : undefined
    if (stock.has(basename(folder)) || (fm?.name && stock.has(fm.name))) {
      came++
      continue
    }
    mine.push({ folder, text })
  }
  if (mine.length > IMPORT_CAPS.skills) {
    const n = mine.length - IMPORT_CAPS.skills
    notes.push(L(`${n} skill${n > 1 ? 's' : ''} além de ${IMPORT_CAPS.skills}`, `${n} skill${n > 1 ? 's' : ''} beyond ${IMPORT_CAPS.skills}`))
  }
  const skills = mine.slice(0, IMPORT_CAPS.skills).flatMap(({ folder, text }) => {
    const where = basename(folder)
    if (!text) {
      notes.push(L(`a skill ${where} (grande demais ou ilegível)`, `the ${where} skill (too big or unreadable)`))
      return []
    }
    const fm = frontmatter(text)
    const name = skillName(fm.name || where)
    const body = fm.body.trim()
    if (!name || !body) return []
    return [{ name, description: str(fm.description, 1_000) || name, body, extraFiles: Math.max(0, countFiles(r, folder) - 1) }]
  })
  return { skills, stock: came }
}

// ---------- the schedule of a cron job ----------

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const hhmm = (h: number, m: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
const int = (s: string, lo: number, hi: number): number | undefined => (/^\d{1,2}$/.test(s) && +s >= lo && +s <= hi ? +s : undefined)

// Days of the week from a cron field: "*", "1-5", "mon,wed", "0,7".
function weekdays(f: string): number[] | undefined {
  if (f === '*' || f === '?') return ALL_DAYS
  // 0 and 7 are both Sunday; a range may end on 7 ("1-7").
  const one = (x: string): number | undefined => DOW[x] ?? int(x, 0, 7)
  const out = new Set<number>()
  for (const part of f.toLowerCase().split(',')) {
    const [a, b, ...rest] = part.split('-')
    const from = a === undefined ? undefined : one(a)
    const to = b === undefined ? from : one(b)
    if (rest.length || from === undefined || to === undefined || to < from) return undefined
    for (let d = from; d <= to; d++) out.add(d % 7)
  }
  return out.size ? [...out].sort() : undefined
}

// What fits a routine here: a time on some weekdays, a time on a day of the month, or one date.
// Every hour, every 30 minutes, a list of hours, some months only: no match (only named).
export function hermesSchedule(s: Record<string, unknown>, now = Date.now()): Schedule | undefined {
  if (s['kind'] === 'once') {
    const at = Date.parse(str(s['run_at'], 64))
    if (!Number.isFinite(at) || at <= now) return undefined
    const d = new Date(at)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { days: [d.getDay()], time: hhmm(d.getHours(), d.getMinutes()), once: true, date }
  }
  if (s['kind'] !== 'cron') return undefined
  const parts = str(s['expr'], 200).split(/\s+/)
  if (parts.length !== 5) return undefined
  const [mi, ho, dom, mon, dow] = parts as [string, string, string, string, string]
  const m = int(mi, 0, 59)
  const h = int(ho, 0, 23)
  if (m === undefined || h === undefined || mon !== '*') return undefined
  const time = hhmm(h, m)
  if (dom === '*' || dom === '?') {
    const days = weekdays(dow)
    return days ? { days, time } : undefined
  }
  const md = int(dom, 1, 31)
  return md !== undefined && (dow === '*' || dow === '?') ? { days: ALL_DAYS, time, monthDay: md } : undefined
}

function routinesOf(r: Reader, dir: string, now: number, notes: string[]): { routines: ForeignAgent['routines']; asNames: string[] } {
  const raw = allowed(r, dir, 'cron/jobs.json', MAX_JOBS)
  if (raw === undefined) return { routines: [], asNames: [] }
  let jobs: unknown[]
  try {
    if (raw === null) throw new Error()
    const data = JSON.parse(raw) as unknown
    const j = Array.isArray(data) ? data : obj(data)['jobs']
    jobs = Array.isArray(j) ? j : Object.entries(obj(j)).map(([id, v]) => ({ id, ...obj(v) }))
  } catch {
    notes.push(L('as tarefas agendadas (cron/jobs.json grande demais ou ilegível)', 'the scheduled jobs (cron/jobs.json too big or unreadable)'))
    return { routines: [], asNames: [] }
  }
  const routines: ForeignAgent['routines'] = []
  const asNames: string[] = []
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  for (const item of jobs) {
    const j = obj(item)
    const name = str(j['name'], 120) || str(j['id'], 60)
    const prompt = str(j['prompt'], 20_000)
    if (!name) continue
    // A job that only runs a script, or that has no prompt for the agent, has nothing to bring.
    const schedule = !j['no_agent'] && prompt ? hermesSchedule(obj(j['schedule']), now) : undefined
    if (!schedule || routines.length >= IMPORT_CAPS.routines) {
      asNames.push(name)
      continue
    }
    const tz = str(j['timezone'], 64)
    if (tz && tz !== here) notes.push(L(`o fuso da rotina "${name}" (${tz}): o horário ficou como estava, no fuso deste computador`, `the time zone of the routine "${name}" (${tz}): the time stayed as it was, in this computer's zone`))
    const skills = arr(j['skills']).filter((x): x is string => typeof x === 'string')
    routines.push({ name, prompt: skills.length ? `${prompt}\n\n${L('Use a skill', 'Use the skill')}: ${skills.join(', ')}` : prompt, schedule })
  }
  return { routines, asNames }
}

// The jobs that stay only as names, for the summary after importing (the preview lists them itself).
function asNamesNote(asNames: string[]): string[] {
  if (!asNames.length) return []
  const shown = asNames.slice(0, 10).map((n) => `"${n}"`).join(', ') + (asNames.length > 10 ? L(` e mais ${asNames.length - 10}`, ` and ${asNames.length - 10} more`) : '')
  return [L(`as tarefas agendadas ${shown} (horário sem equivalente aqui, só roda um script, ou além de ${IMPORT_CAPS.routines}: crie de novo, se quiser)`, `the scheduled jobs ${shown} (a schedule with no match here, a script only, or beyond ${IMPORT_CAPS.routines}: make them again, if you want)`)]
}

// ---------- config.yaml: only names ----------

const PLATFORMS: Record<string, string> = {
  telegram: 'Telegram', discord: 'Discord', whatsapp: 'WhatsApp', whatsapp_cloud: 'WhatsApp', slack: 'Slack', signal: 'Signal', mattermost: 'Mattermost', matrix: 'Matrix',
  email: 'E-mail', sms: 'SMS', dingtalk: 'DingTalk', api_server: 'API server', webhook: 'Webhook', msgraph_webhook: 'Microsoft Graph', feishu: 'Feishu', wecom: 'WeCom', wecom_callback: 'WeCom',
  weixin: 'Weixin', bluebubbles: 'BlueBubbles', qqbot: 'QQ', relay: 'Relay'
}

interface Config {
  servers: string[]
  gateways: string[]
  model?: { provider: string; model: string }
  effort?: Effort
}

function configOf(r: Reader, dir: string, notes: string[]): Config {
  const raw = allowed(r, dir, 'config.yaml')
  if (raw === undefined) return { servers: [], gateways: [] }
  let c: Record<string, unknown>
  try {
    if (raw === null) throw new Error()
    c = obj(parseYaml(raw, { maxAliasCount: 100 }))
  } catch {
    notes.push(L('as configurações (config.yaml grande demais ou ilegível)', 'the settings (config.yaml too big or unreadable)'))
    return { servers: [], gateways: [] }
  }
  // Names only: nothing of a server's command, URL or env is kept.
  const servers = Object.entries(obj(c['mcp_servers']))
    .filter(([, v]) => obj(v)['enabled'] !== false && obj(v)['disabled'] !== true)
    .map(([k]) => k.slice(0, 128))
  // A platform block may sit in platforms:, gateway.platforms: or at the top, by its name.
  const blocks = { ...obj(obj(c['gateway'])['platforms']), ...obj(c['platforms']), ...Object.fromEntries(Object.keys(PLATFORMS).filter((k) => k in c).map((k) => [k, c[k]])) }
  const gateways = [...new Set(Object.entries(blocks).filter(([k, v]) => PLATFORMS[k] && obj(v)['enabled'] !== false).map(([k]) => PLATFORMS[k]!))]
  const m = c['model']
  const mo = obj(m)
  const model = typeof m === 'string' ? str(m, 256) : str(mo['default'], 256) || str(mo['model'], 256)
  const provider = typeof m === 'string' ? '' : str(mo['provider'], 64)
  const re = obj(c['agent'])['reasoning_effort']
  const e = typeof re === 'string' ? re : str(obj(re)['effort'], 32)
  const effort: Effort | undefined = e === 'xhigh' ? 'xhigh' : e === 'high' ? 'high' : e === 'medium' ? 'medium' : e === 'low' || e === 'minimal' || e === 'none' ? 'low' : undefined
  return { servers, gateways, ...(model ? { model: { provider, model } } : {}), ...(effort ? { effort } : {}) }
}

// ---------- one profile, the whole folder ----------

interface HermesProfileRead {
  meta: HermesProfile
  previewNotes: string[] // the agent's notes, less the jobs the preview already lists by name
  agent: ForeignAgent
  userMemories: string[]
  config: Config
}

const titled = (key: string): string => {
  const words = key.replace(/[-_]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : key
}

function readProfile(r: Reader, dir: string, key: string, now: number): HermesProfileRead {
  const notes: string[] = []
  const soulText = allowed(r, dir, 'SOUL.md')
  if (soulText === null) notes.push(L('o SOUL.md (grande demais ou ilegível)', 'SOUL.md (too big or unreadable)'))
  const instructions = soulText ? soulOf(soulText) : ''
  if (!instructions && soulText !== null) notes.push(L('as instruções (não havia um SOUL.md escrito: ficou sem)', 'the instructions (there was no written SOUL.md: it has none)'))
  const memories = memoriesOf(allowed(r, dir, 'memories/MEMORY.md'), 'agent', notes)
  const userMemories = memoriesOf(allowed(r, dir, 'memories/USER.md'), 'user', notes)
  const { skills, stock } = skillsOf(r, dir, notes)
  if (stock) notes.push(L(`${stock} skill${stock > 1 ? 's' : ''} que já ${stock > 1 ? 'vêm' : 'vem'} com o Hermes (não são suas)`, `${stock} skill${stock > 1 ? 's' : ''} that come${stock > 1 ? '' : 's'} with Hermes (not yours)`))
  const { routines, asNames } = routinesOf(r, dir, now, notes)
  const config = configOf(r, dir, notes)
  // The same model on the Hermes engine here, when its provider is named; else this app's default.
  const m = config.model
  const modelId = m && m.provider && m.provider !== 'auto' ? customModel('hermes', `${m.provider}/${m.model}`) : undefined
  if (m && !modelId) notes.push(L(`o modelo ${m.model} (o provedor era automático: ficou o modelo padrão)`, `the ${m.model} model (the provider was automatic: it got the default model)`))
  const name = key === 'default' ? 'Hermes' : titled(key)
  return {
    meta: { key, name, instructions: !!instructions, memories: memories.length, userMemories: userMemories.length, skills: skills.length, routines: routines.length, routinesAsNames: asNames },
    previewNotes: notes,
    agent: { key, name, role: '', instructions, modelId, effort: config.effort ?? 'medium', skills, routines, memories, notes: [...notes, ...asNamesNote(asNames)] },
    userMemories,
    config
  }
}

const hasAny = (r: Reader, dir: string): boolean =>
  ['SOUL.md', 'config.yaml', 'memories/MEMORY.md', 'memories/USER.md', 'cron/jobs.json'].some((f) => allowed(r, dir, f) !== undefined) || r.isDir(join(dir, 'skills'))

export interface HermesRead {
  path: string
  profiles: HermesProfileRead[]
  notes: string[]
}

// The whole folder, adding nothing. Throws, in the person's words, when it isn't Hermes's.
export function readHermes(path: string, opts: HermesReadOpts = {}): HermesRead {
  const root = resolve(path)
  let r: Reader
  try {
    r = reader(root, opts)
  } catch {
    throw new Error(L(`Não achei a pasta ${root}.`, `I couldn't find the folder ${root}.`))
  }
  if (!r.isDir(root)) throw new Error(L(`${root} não é uma pasta.`, `${root} isn't a folder.`))
  const now = opts.now ?? Date.now()
  const profiles: HermesProfileRead[] = []
  const notes: string[] = []
  if (hasAny(r, root)) profiles.push(readProfile(r, root, 'default', now))
  const names = r.list(join(root, 'profiles')).filter((n) => PROFILE.test(n) && r.isDir(join(root, 'profiles', n)) && hasAny(r, join(root, 'profiles', n)))
  const room = IMPORT_CAPS.agents - profiles.length
  for (const n of names.slice(0, room)) profiles.push(readProfile(r, join(root, 'profiles', n), n, now))
  const over = names.length - room
  if (over > 0) notes.push(L(`${over} perfi${over > 1 ? 's' : 'l'} além de ${IMPORT_CAPS.agents}`, `${over} profile${over > 1 ? 's' : ''} beyond ${IMPORT_CAPS.agents}`))
  if (!profiles.length) throw new Error(L(`${root} não parece uma pasta do Hermes: não tem SOUL.md, memórias, skills, tarefas agendadas nem config.yaml.`, `${root} doesn't look like a Hermes folder: it has no SOUL.md, memories, skills, scheduled jobs or config.yaml.`))
  // What never comes, said once.
  if (r.isDir(join(root, 'sessions')) || r.exists(join(root, 'state.db'))) notes.push(L('as conversas e o histórico (sessions, state.db)', 'the conversations and history (sessions, state.db)'))
  return { path: r.real, profiles, notes }
}

const uniq = (xs: string[]): string[] => [...new Set(xs)]

export function hermesPreview(read: HermesRead): HermesPreview {
  const all = read.profiles
  return {
    path: read.path,
    profiles: all.map((p) => p.meta),
    servers: uniq(all.flatMap((p) => p.config.servers)),
    gateways: uniq(all.flatMap((p) => p.config.gateways)),
    models: uniq(all.flatMap((p) => (p.config.model ? [p.config.model.provider && p.config.model.provider !== 'auto' ? `${p.config.model.provider}/${p.config.model.model}` : p.config.model.model] : []))),
    notes: [...read.notes, ...all.flatMap((p) => p.previewNotes.map((n) => (all.length > 1 ? `${p.meta.name}: ${n}` : n)))]
  }
}

// The chosen profiles (by key; none chosen: all) as a team for applyForeignTeam.
export function hermesTeam(read: HermesRead, keys: string[]): ForeignTeam {
  const chosen = keys.length ? read.profiles.filter((p) => keys.includes(p.meta.key)) : read.profiles
  if (!chosen.length) throw new Error(L('Escolha pelo menos um perfil do Hermes.', 'Choose at least one Hermes profile.'))
  const gateways = uniq(chosen.flatMap((p) => p.config.gateways))
  const notes = [...read.notes]
  if (gateways.length) notes.push(L(`onde o Hermes conversava (${gateways.join(', ')}): não vem; aqui, o Telegram se liga em Configurações`, `where Hermes chatted (${gateways.join(', ')}): it doesn't come; here, Telegram is turned on in Settings`))
  return {
    source: 'Hermes',
    agents: chosen.map((p) => ({ ...p.agent, userMemories: p.userMemories })),
    channels: [],
    servers: uniq(chosen.flatMap((p) => p.config.servers)),
    notes
  }
}
