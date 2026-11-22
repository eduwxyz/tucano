// The desktop's one click (Configurações › Harnesses): the Tucano's MCP address and a new key written
// into a harness's own config, the same files harness-mcp.ts reads. An entry by the same name is
// replaced only when the person says so; a file that can't be rewritten whole (OpenCode's, with
// comments) is left alone and the person pastes the snippet instead.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { L } from '../shared/lang'
import type { Connectable, HarnessConnect } from '../shared/harness-keys'
import { stripJsonComments } from './engines/opencode'

export interface ConnectOpts {
  url: string
  key: string
  name: string // the entry's name: tucano, or tucano-<workspace>
  replace?: boolean
  home?: string
  env?: NodeJS.ProcessEnv
  claudeBin?: string // the claude CLI when it's there: it writes ~/.claude.json itself, safely while Claude Code runs
}

type Obj = Record<string, unknown>
// A path as the screen shows it: from the home folder, with / on every system.
const shown = (path: string, home: string): string => path.replace(home, '~').split(sep).join('/')
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

// A file written whole, never half: a temp file next to it, then renamed over it.
function writeWhole(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tucano-${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}

function readJsonFile(path: string): { data: Obj; comments: boolean } | undefined {
  if (!existsSync(path)) return { data: {}, comments: false }
  const raw = readFileSync(path, 'utf8')
  const plain = stripJsonComments(raw)
  try {
    const v: unknown = JSON.parse(plain.trim() ? plain : '{}')
    return isObj(v) ? { data: v, comments: plain !== raw } : undefined
  } catch {
    return undefined
  }
}

// A JSON config with the servers under `field`: { [field]: { [name]: entry } }.
function jsonEntry(path: string, field: string, o: ConnectOpts, entry: Obj): HarnessConnect {
  const where = shown(path, o.home ?? homedir())
  const file = readJsonFile(path)
  if (!file) return { done: false, where, name: o.name, error: L(`Não consegui ler ${where} (o JSON está quebrado). Cole a configuração à mão.`, `Couldn't read ${where} because the configuration is invalid. Paste the configuration manually.`) }
  const servers = isObj(file.data[field]) ? (file.data[field] as Obj) : {}
  if (servers[o.name] !== undefined && !o.replace) return { done: false, exists: true, where, name: o.name }
  if (file.comments) return { done: false, where, name: o.name, error: L(`${where} tem comentários, que se perderiam ao reescrever. Cole a configuração à mão.`, `${where} has comments, which rewriting would lose. Paste the configuration by hand.`) }
  writeWhole(path, JSON.stringify({ ...file.data, [field]: { ...servers, [o.name]: entry } }, null, 2) + '\n')
  return { done: true, where, name: o.name }
}

const run = (bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => execFile(bin, args, { env, timeout: 20_000 }, (e, _out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve())))

async function claude(o: ConnectOpts): Promise<HarnessConnect> {
  const home = o.home ?? homedir()
  const path = join(home, '.claude.json')
  const where = '~/.claude.json'
  const servers = readJsonFile(path)?.data['mcpServers']
  const exists = isObj(servers) && servers[o.name] !== undefined
  if (exists && !o.replace) return { done: false, exists: true, where, name: o.name }
  const auth = `Authorization: Bearer ${o.key}`
  if (o.claudeBin) {
    if (exists) await run(o.claudeBin, ['mcp', 'remove', '--scope', 'user', o.name], o.env).catch(() => {})
    await run(o.claudeBin, ['mcp', 'add', '--scope', 'user', '--transport', 'http', o.name, o.url, '--header', auth], o.env)
    return { done: true, where, name: o.name }
  }
  return jsonEntry(path, 'mcpServers', o, { type: 'http', url: o.url, headers: { Authorization: `Bearer ${o.key}` } })
}

// Codex: a [mcp_servers.<name>] table in config.toml, put in (or swapped) as text so the rest of the
// file, comments included, stays as the person wrote it.
function codex(o: ConnectOpts): HarnessConnect {
  const dir = o.env?.['CODEX_HOME'] || join(o.home ?? homedir(), '.codex')
  const path = join(dir, 'config.toml')
  const where = shown(path, o.home ?? homedir())
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const header = new RegExp(`^\\[mcp_servers\\.(?:${o.name}|"${o.name}")\\]\\s*$`, 'm')
  const block = `[mcp_servers.${o.name}]\nurl = ${JSON.stringify(o.url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${o.key}`)} }\n`
  const found = header.exec(raw)
  if (found && !o.replace) return { done: false, exists: true, where, name: o.name }
  let next: string
  if (found) {
    // The table runs to the next table header that isn't one of its own subtables.
    const start = found.index
    const rest = raw.slice(start + found[0].length)
    const end = rest.search(new RegExp(`^\\[(?!mcp_servers\\.${o.name}\\.)`, 'm'))
    next = raw.slice(0, start) + block + (end === -1 ? '' : `\n${rest.slice(end)}`)
  } else next = `${raw}${raw && !raw.endsWith('\n') ? '\n' : ''}${raw ? '\n' : ''}${block}`
  writeWhole(path, next)
  return { done: true, where, name: o.name }
}

export async function connectHarness(harness: Connectable, o: ConnectOpts): Promise<HarnessConnect> {
  const home = o.home ?? homedir()
  if (harness === 'claude') return claude(o)
  if (harness === 'codex') return codex(o)
  const auth = { Authorization: `Bearer ${o.key}` }
  if (harness === 'cursor') return jsonEntry(join(home, '.cursor', 'mcp.json'), 'mcpServers', o, { url: o.url, headers: auth })
  const dir = join(o.env?.['XDG_CONFIG_HOME'] || join(home, '.config'), 'opencode')
  const path = existsSync(join(dir, 'opencode.jsonc')) ? join(dir, 'opencode.jsonc') : join(dir, 'opencode.json')
  return jsonEntry(path, 'mcp', o, { type: 'remote', url: o.url, headers: auth, enabled: true })
}
