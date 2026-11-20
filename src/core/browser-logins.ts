// Logins the person saved for an agent's browser (spec §24): a site's address, a username and a
// password, encrypted with the system's keychain like a connector's token (secrets.ts), or a
// 1Password reference read when it's typed. The agent only ever learns which sites have one:
// navegador_login has the app type them into the page itself, and only on that exact origin, so
// the password never reaches the model, the chat, the steps or a log.
import { L } from '../shared/lang'
import type { SavedLogin } from '../shared/types'
import type { Db } from './db'
import { isOpRef, resolveOp } from './onepassword'
import type { Secrets } from './secrets'

const PREFIX = 'browser-login:'
const keyOf = (agentId: string, origin: string): string => `${PREFIX}${agentId}:${origin}`

// "conta.example.com/login" → "https://conta.example.com": what a saved login is bound to. Only
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

// The origin a page is on, as a saved login is matched against: exactly, never a near one.
export const pageOrigin = (url: string): string | undefined => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined
  } catch {
    return undefined
  }
}

type Stored = { username: string; password: string }

export class BrowserLogins {
  constructor(
    private db: Db,
    private secrets: Secrets,
    private readOp?: (ref: string) => Promise<string> // a 1Password reference's value (tests fake it)
  ) {}

  // The sites with a saved login, from the keys alone: nothing is decrypted for the prompt.
  sites(agentId: string): string[] {
    const prefix = `${PREFIX}${agentId}:`
    return this.db.secretKeys(prefix).map((k) => k.slice(prefix.length))
  }

  // For the person's page: the sites and usernames, never the passwords.
  async list(agentId: string): Promise<SavedLogin[]> {
    const out: SavedLogin[] = []
    for (const origin of this.sites(agentId)) {
      const v = await this.secrets.getJson<Stored>(keyOf(agentId, origin)).catch(() => undefined)
      out.push({ origin, username: v?.username ?? '', ...(v && isOpRef(v.password) ? { onePassword: true } : {}) })
    }
    return out
  }

  async save(agentId: string, site: string, username: string, password: string): Promise<string> {
    const origin = loginOrigin(site)
    if (!origin) throw new Error(L('Endereço inválido. Use o do site, como conta.exemplo.com.br (só https).', 'Invalid address. Use the site’s, like account.example.com (https only).'))
    if (!username.trim() || !password) throw new Error(L('Falta o usuário ou a senha.', 'The username or the password is missing.'))
    await this.secrets.setJson(keyOf(agentId, origin), { username: username.trim(), password } satisfies Stored)
    return origin
  }

  async remove(agentId: string, origin: string): Promise<void> {
    await this.secrets.set(keyOf(agentId, origin), undefined)
  }

  // For navegador_login only, on the page's exact origin; a 1Password reference is read now.
  async get(agentId: string, origin: string): Promise<Stored | undefined> {
    if (!this.sites(agentId).includes(origin)) return undefined
    const v = await this.secrets.getJson<Stored>(keyOf(agentId, origin))
    if (!v) return undefined
    return { username: await resolveOp(v.username, this.readOp), password: await resolveOp(v.password, this.readOp) }
  }
}
