import { L } from './lang'

// A harness (Claude Code, Codex, Cursor…) connected to this Tucano over MCP (src/core/mcp.ts): a key of
// one person's, made in Configurações › Harnesses. It acts as that person, up to its level.

// What a key may do; each level includes the one before it.
//   read: understand Tucano and see the team, the conversations and what ran
//   talk: also send messages to the agents and wait for the answer
//   configure: also create and change agents, channels, routines, skills, connectors and memories
export const HARNESS_LEVELS = ['read', 'talk', 'configure'] as const
export type HarnessLevel = (typeof HARNESS_LEVELS)[number]
export const DEFAULT_HARNESS_LEVEL: HarnessLevel = 'configure'

export const isHarnessLevel = (v: unknown): v is HarnessLevel => typeof v === 'string' && (HARNESS_LEVELS as readonly string[]).includes(v)
export const levelAllows = (has: HarnessLevel, needs: HarnessLevel): boolean => HARNESS_LEVELS.indexOf(has) >= HARNESS_LEVELS.indexOf(needs)

// A key as its person sees it: never the key itself, shown once when it's made.
export interface HarnessKey {
  id: string // the key's hash: it opens nothing
  name: string // what the person called it: "Claude Code no notebook"
  level: HarnessLevel
  createdAt: number
  seenAt?: number // its last call, to the minute
}

export const HARNESS_KEY = /^tk_[\w-]{43}$/
export const MAX_HARNESS_NAME = 60
export const MAX_HARNESS_KEYS = 20 // per person

// Where this Tucano answers MCP, and whether apps on the internet (claude.ai, ChatGPT) can reach it.
export interface McpInfo {
  url?: string // unset: not listening (the port was taken, say)
  local: boolean // the desktop: only programs on this computer reach it
  error?: string // why it isn't listening
}

// What connecting a harness on the desktop did (connectHarness).
export interface HarnessConnect {
  done: boolean
  exists?: boolean // there's already an entry by that name: say so, and replace only if asked
  where: string // the file (or command) it went into
  name: string // the entry's name in that config
  error?: string // why it couldn't write it: the person pastes the snippet instead
}

// The harnesses the desktop writes the connection into, in one click (core/harness-connect.ts).
export const CONNECTABLE = ['claude', 'codex', 'cursor', 'opencode'] as const
export type Connectable = (typeof CONNECTABLE)[number]
export const CONNECTABLE_LABEL: Record<Connectable, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' }

// The name of the entry in the harness's config: one per workspace when there are several.
export const mcpEntryName = (workspace?: string): string => {
  const slug = (workspace ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  return slug ? `tucano-${slug}` : 'tucano'
}

// What to paste in each harness, with the address and the key in it.
export interface HarnessSnippet {
  id: Connectable | 'other'
  label: string
  where: string // where it goes: a terminal, a file
  text: string
}

const quoteToml = (s: string): string => JSON.stringify(s)

export function harnessSnippets(url: string, key: string, name = 'tucano'): HarnessSnippet[] {
  const auth = `Bearer ${key}`
  return [
    { id: 'claude', label: 'Claude Code', where: 'terminal', text: `claude mcp add --scope user --transport http ${name} ${url} --header "Authorization: ${auth}"` },
    { id: 'codex', label: 'Codex', where: '~/.codex/config.toml', text: `[mcp_servers.${name}]\nurl = ${quoteToml(url)}\nhttp_headers = { Authorization = ${quoteToml(auth)} }` },
    { id: 'cursor', label: 'Cursor', where: '~/.cursor/mcp.json', text: JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: auth } } } }, null, 2) },
    { id: 'opencode', label: 'OpenCode', where: '~/.config/opencode/opencode.json', text: JSON.stringify({ mcp: { [name]: { type: 'remote', url, headers: { Authorization: auth }, enabled: true } } }, null, 2) },
    { id: 'other', label: L('Outro', 'Other'), where: 'MCP (HTTP)', text: `URL: ${url}\nHeader: Authorization: ${auth}` }
  ]
}
