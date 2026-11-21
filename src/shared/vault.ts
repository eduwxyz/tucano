// The Cofre (vault): keys the person saves once and the agents use by name, one command at a time.
// A key's value never comes back to a screen or to the model: the app puts it in the environment of
// the one command that asked for it (bash or start_service with `keys`) and masks it in what that
// command prints before the agent reads it. This file is what the core and the pages share: a key's
// shape as the pages see it (no value), the rule for its name, an .env read and the masking.
import { L } from './lang'

// A key as the pages see it: never its value, only its last characters (`hint`).
export interface VaultKey {
  id: string
  name: string // an environment variable's name: STRIPE_KEY
  owner?: string // a person's own key (theirs alone, used only in work they asked for); unset: the team's
  agents: string[] // the agents that may use it; empty: none yet
  approve: boolean // each use waits for a person's approval
  hint: string // "••••a1b2", or "1Password" for an op:// reference
  note?: string
  createdBy?: string
  createdAt: number
  updatedAt: number
  usedAt?: number
}

// A key saved or changed from the page. `value` left out keeps the one saved.
export interface VaultKeyInput {
  id?: string
  name: string
  value?: string
  mine?: boolean // in a team: the person's own key instead of the team's
  agents: string[]
  approve: boolean
  note?: string
}

// A line of an .env, to save as a key.
export type EnvPair = { name: string; value: string }

// One use of a key, for the Cofre's log: never the value.
export interface VaultUse {
  id: string
  keyId: string
  name: string
  agentId: string
  conversationId?: string
  messageId?: string
  personId?: string // the person the work was for
  via: 'bash' | 'service' | 'connector' | 'login'
  at: number
}

// A site's login, as the pages see it: the site and the username, never the password. The app types
// it into the agent's browser (navegador_login), only on that exact origin.
export interface VaultLogin {
  id: string
  origin: string // https://conta.example.com
  username: string // as saved, or "1Password" for an op:// reference
  owner?: string // as a key's: a person's own, or unset for the team's
  agents: string[]
  note?: string
  createdBy?: string
  createdAt: number
  updatedAt: number
  usedAt?: number
}

export interface VaultLoginInput {
  id?: string
  site: string
  username?: string // left out (with password) keeps the saved login
  password?: string
  mine?: boolean
  agents: string[]
  note?: string
}

// An agent asking for a key or a site's login it doesn't have (pedir_chave): an approval of the
// Cofre's, answered by pasting it in the chat's card or by giving one already saved.
export const COFRE = 'cofre'
export const PEDIR_CHAVE = 'pedir_chave'

// The answer to that card: a key's value or a login pasted, or one already in the Cofre given.
export interface KeyRequestAnswer {
  id: string // the approval
  existing?: string // a key's or a login's id, to give to the agent
  value?: string
  username?: string
  password?: string
  team?: boolean // an admin's: in the team's drawer, not their own
}

export const VAULT_REF = 'cofre:' // a connector's variable that points to a team key: cofre:STRIPE_KEY

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
// Names the shell itself lives on: given another value, the command stops working as a command.
// The key goes only into the command on the agent's computer, never into Claude Code's or Codex's own
// process, so names like OPENAI_API_KEY are fine: they can't redirect the agent itself.
const RESERVED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'IFS', 'ENV', 'BASH_ENV', 'PS1', 'PS2', 'PS4', 'PROMPT_COMMAND', 'TMPDIR', 'LANG', 'SHLVL', 'HOSTNAME'])
const RESERVED_PREFIX = ['LD_', 'DYLD_', 'BASH_', 'LC_', 'TUCANO_']

// Why a name can't be a key's, or undefined when it can.
export function keyNameError(name: string): string | undefined {
  const n = name.trim()
  if (!n) return L('Dê um nome à chave.', 'Give the key a name.')
  if (!NAME.test(n)) return L('Use o formato de variável de ambiente: letras maiúsculas, números e _ (ex.: STRIPE_KEY).', 'Use an environment variable’s format: capital letters, digits and _ (e.g. STRIPE_KEY).')
  if (RESERVED.has(n) || RESERVED_PREFIX.some((p) => n.startsWith(p))) return L(`${n} é do próprio terminal e não pode ser uma chave.`, `${n} belongs to the shell itself and can’t be a key.`)
  return undefined
}

// "sk_live_…a1b2" → "••••a1b2"; a 1Password reference says so instead.
export function keyHint(value: string): string {
  const v = value.trim()
  if (/^op:\/\//.test(v)) return '1Password'
  return v.length >= 12 ? `••••${v.slice(-4)}` : '••••'
}

// An .env file's lines, as the pages show them before saving: each NAME=value, and why a line can't be a key.
export type EnvLine = { name: string; value: string; error?: string }
export function parseEnv(text: string): EnvLine[] {
  const out: EnvLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!.trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '') // an unquoted value's trailing comment
    if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    const name = m[1]!
    const error = keyNameError(name) ?? (value ? undefined : L('Sem valor.', 'No value.'))
    out.push({ name, value, ...(error ? { error } : {}) })
  }
  // The last of a name wins, as in a shell.
  return out.filter((l, i) => !out.slice(i + 1).some((x) => x.name === l.name))
}

// "conta.example.com/login" → "https://conta.example.com": what a site's login is bound to. Only
// https (http only on this computer, for a local test): a password never goes over plain http.
export function loginOrigin(site: string): string | undefined {
  let s = site.trim()
  if (!s) return undefined
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (!u.hostname || !(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return undefined
    return u.origin
  } catch {
    return undefined
  }
}

// The origin a page is on, as a login is matched against: exactly, never a near one.
export function pageOrigin(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined
  } catch {
    return undefined
  }
}

// What stands for a key's value in what the agent reads.
export const masked = (name: string): string => `[cofre:${name}]`
