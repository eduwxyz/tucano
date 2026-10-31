// The MCP servers the person already set up in their harnesses: Claude Code
// (~/.claude.json, user scope), Codex (config.toml), OpenCode
// (opencode.json) and Hermes (config.yaml). The app never runs them through the
// harness: adding one makes it a connector of the app, reached through the
// gateway like any other. Secrets (tokens, env values) stay in the core; the
// screen gets names only.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import type { ConnectorInput, EngineId, HarnessMcp } from '../shared/types'
import { stripJsonComments } from './engines/opencode'

export interface FoundMcp extends HarnessMcp {
  input: ConnectorInput // what adding it creates, secrets included
}

export interface McpDirs {
  claude?: string // ~/.claude.json
  codex?: string // the dir with config.toml
  opencode?: string // the dir with opencode.json(c)
  hermes?: string // the dir with config.yaml
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const strMap = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {})

// One server as the app would add it. Headers: a Bearer Authorization becomes
// the connector's token; any other header the app can't send, so it's named.
function server(name: string, s: { url?: string; headers?: Record<string, string>; token?: string; command?: string; args?: string[]; env?: Record<string, string> }): Omit<FoundMcp, 'harnesses'> | undefined {
  if (s.url) {
    const headers = { ...s.headers }
    const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization')
    const bearer = authKey ? /^Bearer\s+(.+)$/i.exec(headers[authKey]!)?.[1] : undefined
    if (bearer) delete headers[authKey!]
    const token = s.token ?? bearer
    return {
      key: `url:${s.url.replace(/\/+$/, '')}`,
      name,
      kind: 'remote',
      address: s.url,
      ...(Object.keys(headers).length ? { missing: Object.keys(headers) } : {}),
      input: { name, kind: 'remote', url: s.url, ...(token ? { auth: 'token', token } : { auth: 'oauth' }) }
    }
  }
  if (s.command) {
    const args = s.args ?? []
    return {
      key: `cmd:${[s.command, ...args].join(' ')}`,
      name,
      kind: 'stdio',
      address: [s.command, ...args].join(' '),
      envKeys: Object.keys(s.env ?? {}),
      input: { name, kind: 'stdio', command: s.command, args, env: s.env ?? {} }
    }
  }
  return undefined
}

function readJson(path: string): Obj | undefined {
  try {
    const v: unknown = JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

// Claude Code: { type: 'http'|'sse', url, headers } or { command, args, env }. Only the user scope: project ones belong to a folder.
export function claudeMcps(file = join(homedir(), '.claude.json')): Omit<FoundMcp, 'harnesses'>[] {
  const servers = readJson(file)?.['mcpServers']
  if (!isObj(servers)) return []
  return Object.entries(servers).flatMap(([name, s]) => {
    if (!isObj(s)) return []
    const f = server(name, { url: typeof s['url'] === 'string' ? s['url'] : undefined, headers: strMap(s['headers']), command: typeof s['command'] === 'string' ? s['command'] : undefined, args: strs(s['args']), env: strMap(s['env']) })
    return f ? [f] : []
  })
}

// Codex: [mcp_servers.x] with command/args/env, or url with http_headers and
// bearer_token_env_var (read from the person's shell). Off ones stay out.
export function codexMcps(dir = process.env['CODEX_HOME'] || join(homedir(), '.codex'), env: NodeJS.ProcessEnv = process.env): Omit<FoundMcp, 'harnesses'>[] {
  let c: Obj
  try {
    c = parse(readFileSync(join(dir, 'config.toml'), 'utf8'))
  } catch {
    return []
  }
  const servers = c['mcp_servers']
  if (!isObj(servers)) return []
  return Object.entries(servers).flatMap(([name, s]) => {
    if (!isObj(s) || s['enabled'] === false) return []
    const tokenVar = typeof s['bearer_token_env_var'] === 'string' ? s['bearer_token_env_var'] : undefined
    const headers = strMap(s['http_headers'])
    for (const [h, v] of Object.entries(strMap(s['env_http_headers']))) if (env[v]) headers[h] = env[v]!
    const f = server(name, {
      url: typeof s['url'] === 'string' ? s['url'] : undefined,
      headers,
      token: tokenVar ? env[tokenVar] : undefined,
      command: typeof s['command'] === 'string' ? s['command'] : undefined,
      args: strs(s['args']),
      env: strMap(s['env'])
    })
    return f ? [f] : []
  })
}

// OpenCode: mcp.x = { type: 'local', command: [bin, ...args], environment } or { type: 'remote', url, headers }.
export function opencodeMcps(dir = join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'opencode')): Omit<FoundMcp, 'harnesses'>[] {
  const c = readJson(join(dir, 'opencode.jsonc')) ?? readJson(join(dir, 'opencode.json'))
  const servers = c?.['mcp']
  if (!isObj(servers)) return []
  return Object.entries(servers).flatMap(([name, s]) => {
    if (!isObj(s) || s['enabled'] === false) return []
    const [command, ...args] = strs(s['command'])
    const f = server(name, { url: typeof s['url'] === 'string' ? s['url'] : undefined, headers: strMap(s['headers']), command, args, env: strMap(s['environment']) })
    return f ? [f] : []
  })
}

// Hermes: mcp_servers in ~/.hermes/config.yaml — { command, args, env } or
// { url, headers? }. Off ones stay out.
export function hermesMcps(dir = process.env['HERMES_HOME'] || join(homedir(), '.hermes')): Omit<FoundMcp, 'harnesses'>[] {
  let c: Obj
  try {
    c = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf8')) as Obj
  } catch {
    return []
  }
  const servers = c?.['mcp_servers']
  if (!isObj(servers)) return []
  return Object.entries(servers).flatMap(([name, s]) => {
    if (!isObj(s) || s['enabled'] === false) return []
    const f = server(name, { url: typeof s['url'] === 'string' ? s['url'] : undefined, headers: strMap(s['headers']), command: typeof s['command'] === 'string' ? s['command'] : undefined, args: strs(s['args']), env: strMap(s['env']) })
    return f ? [f] : []
  })
}

// Every harness's servers, one entry per server (same address = same server), with the harnesses that have it.
export function harnessMcps(dirs: McpDirs = {}, env: NodeJS.ProcessEnv = process.env): FoundMcp[] {
  const out = new Map<string, FoundMcp>()
  const sources: [EngineId, Omit<FoundMcp, 'harnesses'>[]][] = [
    ['claude', claudeMcps(dirs.claude)],
    ['codex', codexMcps(dirs.codex, env)],
    ['opencode', opencodeMcps(dirs.opencode)],
    ['hermes', hermesMcps(dirs.hermes)]
  ]
  for (const [engine, list] of sources)
    for (const f of list) {
      if (f.kind === 'stdio' && /\.app\/Contents\//.test(f.address)) continue // a harness app's own tool (Codex's node_repl): useless outside it
      const seen = out.get(f.key)
      if (!seen) out.set(f.key, { ...f, harnesses: [engine] })
      // The same server: keep the setup that has a token, if one does.
      else if (seen.input.auth !== 'token' && f.input.auth === 'token') out.set(f.key, { ...f, harnesses: [...seen.harnesses, engine] })
      else seen.harnesses.push(engine)
    }
  return [...out.values()]
}

// What the screen gets: no token, no env values.
export const publicMcp = ({ input: _input, ...m }: FoundMcp): HarnessMcp => m
