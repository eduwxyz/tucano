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
//                               came with Hermes, not from the person, unless they edited one:
//                               its v2 line keeps the folder's MD5 from when Hermes put it there
//                               (tools/skills_sync.py dir_hash), and only then are that skill's
//                               own files opened, to hash them (never a credential's name)
//   cron/jobs.json              { jobs: [{ name, prompt, schedule: { kind: once|interval|cron,
//                               run_at | minutes | expr }, timezone?, no_agent?, script? }] }
//   config.yaml                 model, agent.reasoning_effort, mcp_servers, platforms (gateways)
//   gateway_state.json          what the gateway wrote when it last ran; only its platforms' names
//                               are taken (a gateway set up in .env alone shows only here)
//   profiles/<name>/            each one the same layout again: one more agent
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
const ALLOWED = new Set(['SOUL.md', 'config.yaml', 'memories/MEMORY.md', 'memories/USER.md', 'cron/jobs.json', 'skills/.bundled_manifest', 'gateway_state.json'])

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
const uniq = (xs: string[]): string[] => [...new Set(xs)]
// Hermes's is_truthy_value / _bool_token (utils.py, gateway/config.py): a bool, a number, or 1/true/yes/on.
const truthy = (v: unknown): boolean => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()) : !!v)
const falsy = (v: unknown): boolean => (typeof v === 'string' ? ['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase()) : v === false || v === 0)

export interface HermesReadOpts {
  // Every file opened, for the tests that prove .env and auth.json never are.
  onRead?: (path: string) => void
  now?: number
}

// A reader confined to one folder: only regular files and folders, never through a link. Hermes
// makes none in its folder, so a link (out of it, or to .env, auth.json, sessions/ inside it) isn't
// followed. Only the folder itself may be a link (~/.hermes -> elsewhere).
function reader(root: string, opts: HermesReadOpts) {
  const real = realpathSync(root)
  const base = resolve(root)
  // What p is, without following a link at any step below the folder; undefined when not plain.
  const plain = (p: string): Stats | undefined => {
    const rel = relative(base, resolve(p))
    if (rel === '') return statSync(real)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return undefined
    let here = real
    let st: Stats | undefined
    for (const part of rel.split(sep)) {
      here = join(here, part)
      st = lstatSync(here)
      if (!st.isFile() && !st.isDirectory()) return undefined
    }
    return st
  }
  const isDir = (p: string): boolean => {
    try {
      return !!plain(p)?.isDirectory()
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
      const st = plain(p)
      if (!st?.isFile() || st.size > max) return null
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
  // Every name in a folder, dot ones too (for a skill's hash).
  const all = (p: string): string[] => {
    if (!isDir(p)) return []
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  }
  // The bytes of a regular file inside the folder, or undefined.
  const bytes = (p: string, max: number): Buffer | undefined => {
    try {
      const st = plain(p)
      if (!st?.isFile() || st.size > max) return undefined
      opts.onRead?.(p)
      return readFileSync(p)
    } catch {
      return undefined
    }
  }
  const isFile = (p: string): boolean => {
    try {
      return !!plain(p)?.isFile()
    } catch {
      return false
    }
  }
  return { real, text, list, isDir, exists, all, bytes, isFile }
}
type Reader = ReturnType<typeof reader>

// A file of the allow list, in a profile's folder.
const allowed = (r: Reader, dir: string, file: string, max?: number): string | undefined | null => {
  if (!ALLOWED.has(file)) throw new Error(`not on the list: ${file}`)
  return r.text(join(dir, ...file.split('/')), max)
}

// ---------- the parts of one profile ----------

// The SOUL.md texts Hermes writes by itself, with no word from the person (hermes_cli/default_soul.py):
// DEFAULT_SOUL_MD, seeded on the first run and by `hermes profile create`, its "--" variant
// (install.ps1), and _LEGACY_TEMPLATE_SOULS (the comment scaffolds and the previous default).
const H_DEFAULT =
  'You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask \u2014 a one-line question gets a one-line answer, and finished work gets a short report of what changed, what\'s verified, and what\'s left, never a replay of the process. No filler ("Great question," "I\'d be happy to"), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it\'s right, not because the user said it. Depth is earned \u2014 give it when the user asks for detail, teaches, or the stakes demand it, not by default.'
const H_HEAD = "# Hermes Agent Persona\n\n<!--\nThis file defines the agent's personality and tone.\nThe agent will embody whatever you write here.\nEdit this to customize how Hermes communicates with you.\n\n"
const H_TAIL = 'This file is loaded fresh each message -- no restart needed.\nDelete the contents (or this file) to use the default personality.\n-->'
// Hermes's _normalize_soul: line endings unified, no BOM, trimmed.
const normalSoul = (t: string): string => t.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trim()
const SEEDED_SOULS = new Set(
  [
    H_DEFAULT,
    H_DEFAULT.split('\u2014').join('--'),
    H_HEAD + 'Examples:\n  - "You are a warm, playful assistant who uses kaomoji occasionally."\n  - "You are a concise technical expert. No fluff, just facts."\n  - "You speak like a friendly coworker who happens to know everything."\n\n' + H_TAIL,
    H_HEAD + H_TAIL,
    'You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful, knowledgeable, and direct. You assist users with a wide range of tasks including answering questions, writing and editing code, analyzing information, creative work, and executing actions via your tools. You communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose unless otherwise directed below. Be targeted and efficient in your exploration and investigations.'
  ].map(normalSoul)
)

// SOUL.md, unless Hermes wrote it by itself (it carries nothing of the person): one of the texts it
// seeds, or only a comment scaffold.
function soulOf(text: string): string {
  const t = normalSoul(text)
  if (SEEDED_SOULS.has(t)) return ''
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

// The skills that came with Hermes, by name, with the hash of the folder Hermes put there (v2
// "name:hash" lines; v1, a name alone, has none: '').
function bundled(r: Reader, dir: string): Map<string, string> {
  const t = allowed(r, dir, 'skills/.bundled_manifest')
  const out = new Map<string, string>()
  for (const line of (t || '').split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    const i = l.indexOf(':')
    const name = (i < 0 ? l : l.slice(0, i)).trim()
    if (name) out.set(name, i < 0 ? '' : l.slice(i + 1).trim())
  }
  return out
}

// Hermes's dir_hash (tools/skills_sync.py): MD5 over every file under the skill's folder, sorted
// by path parts, each as its relative path then its bytes, leaving out runtime caches
// (__pycache__ and the like, a .pyc beside its .py). The legacy form keeps the caches.
const CACHE_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'])
const SECRET_NAME = /^(\.env(\..*)?|auth\.json|.*\.(pem|key))$/i
const HASH_FILES = 300
const HASH_BYTES = 5_000_000
const pathPart = (part: string): string => (process.platform === 'win32' ? part.toLowerCase() : part)
const cmpParts = (a: string[], b: string[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = pathPart(a[i]!)
    const right = pathPart(b[i]!)
    if (left !== right) return left < right ? -1 : 1
  }
  return a.length - b.length
}

// Whether a skill that came with Hermes is still as Hermes put it. undefined: can't tell (too big, a
// link out, a credential's name in it): the caller keeps it out, as before.
function unchanged(r: Reader, folder: string, origin: string): boolean | undefined {
  const files: string[][] = []
  const walk = (parts: string[]): boolean => {
    if (parts.length > 6) return false
    for (const n of r.all(join(folder, ...parts))) {
      const here = [...parts, n]
      const p = join(folder, ...here)
      if (r.isDir(p)) {
        if (!walk(here)) return false
      } else if (r.isFile(p)) {
        files.push(here)
        if (files.length > HASH_FILES) return false
      } else if (r.exists(p)) return false // a link out, or something else: can't prove it
    }
    return true
  }
  if (!walk([])) return undefined
  files.sort(cmpParts)
  // A credential's name never ships with a skill: it was put there, so it's not as it came.
  if (files.some((f) => SECRET_NAME.test(f[f.length - 1]!))) return false
  const isCache = (f: string[]): boolean => {
    if (f.slice(0, -1).some((x) => CACHE_DIRS.has(x))) return true
    const last = f[f.length - 1]!
    return /\.py[co]$/.test(last) && files.some((g) => g.length === f.length && g.slice(0, -1).join(sep) === f.slice(0, -1).join(sep) && g[g.length - 1] === last.slice(0, -1))
  }
  const clean = createHash('md5')
  const legacy = createHash('md5')
  let total = 0
  for (const f of files) {
    const b = r.bytes(join(folder, ...f), HASH_BYTES - total)
    if (!b) return undefined
    total += b.length
    const rel = Buffer.from(f.join(sep), 'utf8')
    legacy.update(rel).update(b)
    if (!isCache(f)) clean.update(rel).update(b)
  }
  return clean.digest('hex') === origin || legacy.digest('hex') === origin
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

// Only what's needed is opened: once 20 skills are in, the rest are counted by their folder,
// unopened (one that came with Hermes is told by its folder's name then, and counted as such).
function skillsOf(r: Reader, dir: string, notes: string[]): { skills: ForeignSkill[]; stock: number } {
  const root = join(dir, 'skills')
  const stock = bundled(r, dir)
  const mine: { folder: string; text: string | null }[] = []
  let came = 0
  let beyond = 0
  // A skill that came with Hermes stays out, unless its folder isn't as Hermes put it.
  const stays = (folder: string, name: string): boolean => {
    const origin = stock.get(name)
    if (!origin) return true // v1 line: no hash to tell
    return unchanged(r, folder, origin) !== false
  }
  for (const folder of skillDirs(r, root)) {
    const full = mine.length >= IMPORT_CAPS.skills
    const byFolder = stock.has(basename(folder))
    if (full) {
      if (byFolder) came++
      else beyond++
      continue
    }
    if (byFolder && stays(folder, basename(folder))) {
      came++
      continue
    }
    const text = r.text(join(folder, 'SKILL.md')) ?? null
    const fm = text ? frontmatter(text) : undefined
    if (!byFolder && fm?.name && stock.has(fm.name) && stays(folder, fm.name)) {
      came++
      continue
    }
    mine.push({ folder, text })
  }
  if (beyond) notes.push(L(`${beyond} skill${beyond > 1 ? 's' : ''} além de ${IMPORT_CAPS.skills}`, `${beyond} skill${beyond > 1 ? 's' : ''} beyond ${IMPORT_CAPS.skills}`))
  const skills = mine.flatMap(({ folder, text }) => {
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
  off: string[] // platforms config.yaml turns off by name: an older gateway_state.json doesn't bring them back
  model?: { provider: string; model: string }
  effort?: Effort
}

function configOf(r: Reader, dir: string, notes: string[]): Config {
  const raw = allowed(r, dir, 'config.yaml')
  if (raw === undefined) return { servers: [], gateways: [], off: [] }
  let c: Record<string, unknown>
  try {
    if (raw === null) throw new Error()
    c = obj(parseYaml(raw, { maxAliasCount: 100 }))
  } catch {
    notes.push(L('as configurações (config.yaml grande demais ou ilegível)', 'the settings (config.yaml too big or unreadable)'))
    return { servers: [], gateways: [], off: [] }
  }
  // Names only: nothing of a server's command, URL or env is kept. One turned off in Hermes (hermes
  // mcp add saves it so when its connection test fails) is said, not dropped without a word.
  const all = Object.entries(obj(c['mcp_servers'])).map(([k, v]) => [k.slice(0, 128), falsy(obj(v)['enabled']) || truthy(obj(v)['disabled'])] as const)
  const servers = all.filter(([, off]) => !off).map(([k]) => k)
  const off = all.filter(([, off]) => off).map(([k]) => k)
  if (off.length) notes.push(L(`os servidores MCP desligados no Hermes: ${off.slice(0, 10).join(', ')}${off.length > 10 ? ` e mais ${off.length - 10}` : ''}`, `the MCP servers turned off in Hermes: ${off.slice(0, 10).join(', ')}${off.length > 10 ? ` and ${off.length - 10} more` : ''}`))
  // Where Hermes reads a platform block (gateway/config_loader.py merge_platform_sections), later
  // winning: gateway.platforms, platforms, then gateway.<platform>. A block at the top, by its name,
  // wins over them all when it has `enabled` (bridge_platform_shared_keys); without it, it is only
  // settings (discord.require_mention…). With no `enabled` anywhere, Hermes keeps it off.
  const gw = obj(c['gateway'])
  const on = new Map<string, boolean>()
  for (const source of [obj(gw['platforms']), obj(c['platforms']), Object.fromEntries(Object.entries(gw).filter(([k]) => k !== 'platforms' && PLATFORMS[k]))])
    for (const [k, v] of Object.entries(source)) if (PLATFORMS[k] && v && typeof v === 'object' && 'enabled' in obj(v)) on.set(k, truthy(obj(v)['enabled']))
  for (const k of Object.keys(PLATFORMS)) {
    const top = c[k]
    if (top && typeof top === 'object' && !Array.isArray(top) && 'enabled' in obj(top)) on.set(k, truthy(obj(top)['enabled']))
  }
  const gateways = [...new Set([...on].filter(([, yes]) => yes).map(([k]) => PLATFORMS[k]!))]
  const offNames = [...new Set([...on].filter(([, yes]) => !yes).map(([k]) => PLATFORMS[k]!))].filter((n) => !gateways.includes(n))
  const m = c['model']
  const mo = obj(m)
  const model = typeof m === 'string' ? str(m, 256) : str(mo['default'], 256) || str(mo['model'], 256)
  const provider = typeof m === 'string' ? '' : str(mo['provider'], 64)
  const re = obj(c['agent'])['reasoning_effort']
  const e = typeof re === 'string' ? re : str(obj(re)['effort'], 32)
  const effort: Effort | undefined = e === 'xhigh' ? 'xhigh' : e === 'high' ? 'high' : e === 'medium' ? 'medium' : e === 'low' || e === 'minimal' || e === 'none' ? 'low' : undefined
  return { servers, gateways, off: offNames, ...(model ? { model: { provider, model } } : {}), ...(effort ? { effort } : {}) }
}

// The platforms in the gateway_state.json the gateway writes as it runs: { platforms: { telegram: {…},
// "<profile>:discord": {…} } } (gateway/status.py write_runtime_status; the second form when one
// gateway serves many profiles, gateway/run_adapters_recovery.py). Only the names are taken, less
// the ones it stood down (state "disabled"); it's a hint, so one that can't be read is nothing.
function gatewayState(r: Reader, dir: string): string[] {
  const raw = allowed(r, dir, 'gateway_state.json')
  if (!raw) return []
  try {
    return Object.entries(obj(obj(JSON.parse(raw))['platforms'])).filter(([, v]) => obj(v)['state'] !== 'disabled').map(([k]) => k).slice(0, 200)
  } catch {
    return []
  }
}

// The ones of a profile: bare in its own folder's file, "<profile>:<platform>" in the root's.
const statePlatforms = (keys: string[], profile?: string): string[] =>
  keys.flatMap((k) => {
    const i = k.indexOf(':')
    const name = i < 0 ? (profile ? undefined : k) : profile && k.slice(0, i) === profile ? k.slice(i + 1) : undefined
    return name && PLATFORMS[name] ? [PLATFORMS[name]!] : []
  })

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

function readProfile(r: Reader, dir: string, key: string, now: number, running: string[] = []): HermesProfileRead {
  const notes: string[] = []
  const soulText = allowed(r, dir, 'SOUL.md')
  if (soulText === null) notes.push(L('o SOUL.md (grande demais ou ilegível)', 'SOUL.md (too big or unreadable)'))
  const instructions = soulText ? soulOf(soulText) : ''
  if (!instructions && soulText !== null) notes.push(L('as instruções (não havia um SOUL.md escrito: ficou sem)', 'the instructions (there was no written SOUL.md: it has none)'))
  const memories = memoriesOf(allowed(r, dir, 'memories/MEMORY.md'), 'agent', notes)
  const userMemories = memoriesOf(allowed(r, dir, 'memories/USER.md'), 'user', notes)
  const { skills, stock } = skillsOf(r, dir, notes)
  if (stock) notes.push(L(`${stock} skill${stock > 1 ? 's' : ''} que já ${stock > 1 ? 'vêm' : 'vem'} com o Hermes, sem mudança (não ${stock > 1 ? 'são suas' : 'é sua'})`, `${stock} skill${stock > 1 ? 's' : ''} that come${stock > 1 ? '' : 's'} with Hermes, unchanged (not yours)`))
  const { routines, asNames } = routinesOf(r, dir, now, notes)
  const config = configOf(r, dir, notes)
  config.gateways = uniq([...config.gateways, ...running.filter((n) => !config.off.includes(n))])
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

// A folder is Hermes's only by a sign Hermes leaves and others don't: the SOUL.md it writes on its
// first run, its memory files, its skills manifest, its state.db (only there, never opened), or a
// config.yaml with its `_config_version`. A config.yaml or a skills/ alone (~/.claude, any
// project) is not enough.
const isHermes = (r: Reader, dir: string): boolean => {
  if (['SOUL.md', 'memories/MEMORY.md', 'memories/USER.md', 'skills/.bundled_manifest'].some((f) => allowed(r, dir, f) !== undefined)) return true
  if (r.exists(join(dir, 'state.db'))) return true
  const c = allowed(r, dir, 'config.yaml')
  if (!c) return false
  try {
    return '_config_version' in obj(parseYaml(c, { maxAliasCount: 100 }))
  } catch {
    return false
  }
}

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
  const rootState = gatewayState(r, root)
  if (isHermes(r, root)) profiles.push(readProfile(r, root, 'default', now, statePlatforms(rootState)))
  const names = r.list(join(root, 'profiles')).filter((n) => PROFILE.test(n) && r.isDir(join(root, 'profiles', n)) && isHermes(r, join(root, 'profiles', n)))
  const room = IMPORT_CAPS.agents - profiles.length
  for (const n of names.slice(0, room)) {
    const dir = join(root, 'profiles', n)
    profiles.push(readProfile(r, dir, n, now, [...statePlatforms(rootState, n), ...statePlatforms(gatewayState(r, dir))]))
  }
  const over = names.length - room
  if (over > 0) notes.push(L(`${over} perfi${over > 1 ? 's' : 'l'} além de ${IMPORT_CAPS.agents}`, `${over} profile${over > 1 ? 's' : ''} beyond ${IMPORT_CAPS.agents}`))
  if (!profiles.length) throw new Error(L(`${root} não parece uma pasta do Hermes: não tem SOUL.md, memórias, a lista de skills do Hermes nem um config.yaml do Hermes.`, `${root} doesn't look like a Hermes folder: it has no SOUL.md, memories, Hermes's skills list or a Hermes config.yaml.`))
  // What never comes, said once.
  if (r.isDir(join(root, 'sessions')) || r.exists(join(root, 'state.db'))) notes.push(L('as conversas e o histórico (sessions, state.db)', 'the conversations and history (sessions, state.db)'))
  return { path: r.real, profiles, notes }
}

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

// Where Hermes chatted: only the ones it had, and Telegram's place here only when Telegram was one.
export function gatewaysNote(gateways: string[]): string {
  const list = gateways.join(', ')
  return gateways.includes('Telegram')
    ? L(`onde o Hermes conversava (${list}): não vem; aqui, o Telegram se liga em Configurações`, `where Hermes chatted (${list}): it doesn't come; here, Telegram is turned on in Settings`)
    : L(`onde o Hermes conversava (${list}): não vem`, `where Hermes chatted (${list}): it doesn't come`)
}

// The chosen profiles (by key; none chosen: all) as a team for applyForeignTeam.
export function hermesTeam(read: HermesRead, keys: string[]): ForeignTeam {
  const chosen = keys.length ? read.profiles.filter((p) => keys.includes(p.meta.key)) : read.profiles
  if (!chosen.length) throw new Error(L('Escolha pelo menos um perfil do Hermes.', 'Choose at least one Hermes profile.'))
  const gateways = uniq(chosen.flatMap((p) => p.config.gateways))
  const notes = [...read.notes]
  if (gateways.length) notes.push(gatewaysNote(gateways))
  return {
    source: 'Hermes',
    agents: chosen.map((p) => ({ ...p.agent, userMemories: p.userMemories })),
    channels: [],
    servers: uniq(chosen.flatMap((p) => p.config.servers)),
    notes
  }
}
