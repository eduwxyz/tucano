// The team's file from before teams had ids (spec §21), still read by team-files.ts, and the
// daily copies of the database.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { L } from '../shared/lang'
import type { Agent, AgentColor, Effort, GrantLevel, Schedule } from '../shared/types'
import type { Db } from './db'

const FENCE = 'tucano-team'
const OLD_FENCE = 'agent-desk-team' // teams exported before the rename
const KEEP_BACKUPS = 7
const DAY = 86_400_000

export interface TeamFile {
  version: 1
  agents: {
    handle: string
    name: string
    role: string
    color: AgentColor
    customColor?: string
    avatar?: Agent['avatar'] // the drawn one; a picture stays on its computer
    instructions: string
    model: string
    effort: Effort
    limit: number
    web: boolean
    computer: boolean
    grants: Record<string, GrantLevel> // by connector name
    team?: string[] // the agents it coordinates, by handle
  }[]
  skills: { name: string; description: string; body: string; agents: string[] }[] // agents by handle
  channels: { name: string; topic?: string; members: string[] }[]
  routines: { name: string; agent: string; where: string; prompt: string; schedule: Schedule; trigger?: { kind: 'poll'; connector: string; tool: string; args: Record<string, unknown>; everyMinutes: number } | { kind: 'webhook' } }[]
}

// The JSON block of a team file (this name, or the one from before the rename); throws when there's none.
export function parseTeamFile(text: string): TeamFile {
  const m = new RegExp('```json (?:' + FENCE + '|' + OLD_FENCE + ')\\n([\\s\\S]*?)\\n```').exec(text)
  if (!m) throw new Error(L('Esse arquivo não é um time exportado pelo Tucano.', "That file isn't a team exported by Tucano."))
  let data: TeamFile
  try {
    data = JSON.parse(m[1]!) as TeamFile
  } catch {
    throw new Error(L('O bloco do time está corrompido.', "The team's block is corrupted."))
  }
  if (data.version !== 1) throw new Error(L('Versão de time desconhecida.', 'Unknown team version.'))
  return data
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

