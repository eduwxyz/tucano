// The Cofre: keys saved once, used by the agents by name, one command at a time (src/shared/vault.ts).
//
// Two drawers. The team's keys (owner '') are an admin's to make and to give to agents. A person's own
// keys are theirs alone: the others never see they exist, and an agent uses one only in work that person
// asked for. On a desktop with one person there are only the team's keys, called just "Cofre".
//
// The value is in secrets, encrypted with the system's keychain, under 'vault:<id>'; or it's an op://
// reference read from 1Password each time it's used. It leaves here only into the environment of the
// command that asked for it, and every value an agent may use is masked in what its computer prints.
//
// Site logins live here too, in the same two drawers: a site, a username and a password (secrets,
// 'vault-login:<id>'), given to agents one by one. The app types one into the agent's browser
// (navegador_login) on that exact site; the agent never gets the password.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { keyHint, keyNameError, loginOrigin, masked, type KeyRequestAnswer, type VaultKey, type VaultKeyInput, type VaultLogin, type VaultLoginInput, type VaultUse } from '../shared/vault'
import type { Db } from './db'
import { isOpRef, resolveOp } from './onepassword'
import type { Secrets } from './secrets'

const secretKey = (id: string): string => `vault:${id}`
const loginSecret = (id: string): string => `vault-login:${id}`
// Where an agent's browser kept its logins before the Cofre: browser-login:<agent>:<origin>.
const OLD_LOGIN = 'browser-login:'
type Stored = { username: string; password: string }
const shownUser = (u: string): string => (isOpRef(u) ? '1Password' : u)

// Values too short to mask without masking ordinary text along with them.
const MIN_MASKED = 6

// Every key's value, in the forms a program prints it (as is, inside JSON, in a URL, in base64), turned
// into [cofre:NAME]. Longer forms first, so a value that contains another is masked whole.
export function maskKeys(text: string, keys: readonly { name: string; value: string }[]): string {
  const forms: [string, string][] = []
  for (const k of keys) {
    const v = k.value
    if (v.length < MIN_MASKED) continue
    const to = masked(k.name)
    const b64 = Buffer.from(v).toString('base64').replace(/=+$/, '')
    for (const f of new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), b64])) if (f.length >= MIN_MASKED) forms.push([f, to])
  }
  if (!forms.length) return text
  forms.sort((a, b) => b[0].length - a[0].length)
  let t = text
  for (const [f, to] of forms) if (t.includes(f)) t = t.split(f).join(to)
  return t
}

export type Opened = { key: VaultKey; value: string }

export interface VaultDeps {
  db: Db
  secrets: Pick<Secrets, 'get' | 'set'>
  readOp?: (ref: string) => Promise<string>
  now?: () => number
}

// Who is asking, as the Cofre needs it: their id, whether they're an admin, and whether there's a team at all.
export type Asker = { id: string; admin: boolean; team: boolean }

export class Vault {
  // Values already opened (an op:// reference as last read), so masking doesn't ask the keychain each time.
  private values = new Map<string, string>()
  constructor(private deps: VaultDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // What a person sees: the team's keys and their own.
  list(who: Pick<Asker, 'id'>): VaultKey[] {
    return this.deps.db.vaultKeys().filter((k) => !k.owner || k.owner === who.id)
  }

  private mayChange(who: Asker, k: { owner?: string }): boolean {
    return k.owner ? k.owner === who.id : who.admin
  }

  async save(who: Asker, input: VaultKeyInput): Promise<VaultKey> {
    const { db } = this.deps
    const name = input.name.trim()
    const bad = keyNameError(name)
    if (bad) throw new Error(bad)
    const before = input.id ? db.vaultKey(input.id) : undefined
    if (input.id && (!before || (before.owner && before.owner !== who.id))) throw new Error(L('Essa chave não existe mais.', 'That key no longer exists.'))
    // A member's keys are their own; an admin's are the team's unless they say "mine". Alone, there is no "mine".
    const owner = before ? before.owner : who.team && (input.mine || !who.admin) ? who.id : undefined
    if (!this.mayChange(who, { owner })) throw new Error(L('Só um admin muda as chaves do time.', 'Only an admin changes the team’s keys.'))
    const clash = db.vaultKeys().find((k) => k.name === name && (k.owner ?? '') === (owner ?? '') && k.id !== before?.id)
    if (clash) throw new Error(L(`Já existe a chave ${name}${owner ? ' entre as suas' : ''}.`, `There's already a ${name} key${owner ? ' among yours' : ''}.`))
    const value = input.value?.trim()
    if (!before && !value) throw new Error(L('Cole o valor da chave.', 'Paste the key’s value.'))
    const live = new Set(db.agents().filter((a) => !a.archived && a.kind !== 'tuca').map((a) => a.id))
    const id = before?.id ?? randomUUID()
    const at = this.now()
    const key: VaultKey = {
      id,
      name,
      ...(owner ? { owner } : {}),
      agents: [...new Set(input.agents)].filter((a) => live.has(a) || before?.agents.includes(a)),
      approve: input.approve,
      hint: value ? keyHint(value) : (before?.hint ?? ''),
      ...(input.note?.trim() ? { note: input.note.trim().slice(0, 300) } : {}),
      createdBy: before?.createdBy ?? who.id,
      createdAt: before?.createdAt ?? at,
      updatedAt: at,
      ...(before?.usedAt ? { usedAt: before.usedAt } : {})
    }
    if (value) {
      await this.deps.secrets.set(secretKey(id), value)
      this.values.delete(id)
    }
    db.saveVaultKey(key)
    return key
  }

  async remove(who: Asker, id: string): Promise<VaultKey | undefined> {
    const k = this.deps.db.vaultKey(id)
    if (!k || (k.owner && k.owner !== who.id)) return undefined
    if (!this.mayChange(who, k)) throw new Error(L('Só um admin apaga as chaves do time.', 'Only an admin deletes the team’s keys.'))
    this.deps.db.removeVaultKey(id)
    await this.deps.secrets.set(secretKey(id), undefined)
    this.values.delete(id)
    return k
  }

  // Gives a key to an agent, or takes it back: the key's owner, or an admin for the team's.
  setAgent(who: Asker, id: string, agentId: string, on: boolean): VaultKey {
    const k = this.deps.db.vaultKey(id)
    if (!k || (k.owner && k.owner !== who.id)) throw new Error(L('Essa chave não existe mais.', 'That key no longer exists.'))
    if (!this.mayChange(who, k)) throw new Error(L('Só um admin libera as chaves do time.', 'Only an admin gives out the team’s keys.'))
    const agents = on ? [...new Set([...k.agents, agentId])] : k.agents.filter((a) => a !== agentId)
    const next = { ...k, agents, updatedAt: this.now() }
    this.deps.db.saveVaultKey(next)
    return next
  }

  // The keys an agent may use in work for this person (unset: for no one in particular, e.g. a routine
  // of the team's): the team's given to it, and that person's own given to it. A person's own key of a
  // name stands in for the team's of the same name.
  usable(agentId: string, personId?: string): VaultKey[] {
    const mine = this.deps.db.vaultKeys().filter((k) => k.agents.includes(agentId) && (!k.owner || k.owner === personId))
    return mine.filter((k) => k.owner || !mine.some((o) => o.owner && o.name === k.name))
  }

  // The named keys, for one command of this agent in work for this person, or why not.
  pick(agentId: string, names: readonly string[], personId?: string): { keys: VaultKey[] } | { error: string } {
    const usable = this.usable(agentId, personId)
    const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    const missing = wanted.filter((n) => !usable.some((k) => k.name === n))
    if (missing.length) {
      const have = usable.map((k) => k.name)
      return {
        error: L(
          `Não rodei: ${missing.join(', ')} não ${missing.length > 1 ? 'estão' : 'está'} no Cofre pra você. ${have.length ? `As chaves que você pode usar: ${have.join(', ')}.` : 'Nenhuma chave do Cofre foi liberada pra você.'} Peça a quem você atende que salve a chave no Cofre e libere pra você; nunca peça que cole a chave na conversa.`,
          `Not run: ${missing.join(', ')} ${missing.length > 1 ? "aren't" : "isn't"} in the Cofre for you. ${have.length ? `The keys you may use: ${have.join(', ')}.` : 'No key in the Cofre was given to you.'} Ask the person you're working for to save the key in the Cofre and give it to you; never ask them to paste the key in the conversation.`
        )
      }
    }
    return { keys: wanted.map((n) => usable.find((k) => k.name === n)!) }
  }

  // A key's value: from the keychain, or read from 1Password when it's a reference.
  private async value(k: VaultKey): Promise<string> {
    const stored = await this.deps.secrets.get(secretKey(k.id))
    if (stored === undefined) throw new Error(L(`A chave ${k.name} está sem valor no Cofre: salve de novo.`, `The ${k.name} key has no value in the Cofre: save it again.`))
    const value = isOpRef(stored) ? await resolveOp(stored, this.deps.readOp) : stored
    this.values.set(k.id, value)
    return value
  }

  // The values, for the command's environment. Each opened key goes in the log.
  async open(keys: readonly VaultKey[], use: Omit<VaultUse, 'id' | 'keyId' | 'name' | 'at'>): Promise<Record<string, string>> {
    const env: Record<string, string> = {}
    for (const k of keys) env[k.name] = await this.value(k)
    const at = this.now()
    for (const k of keys) this.deps.db.recordVaultUse({ ...use, id: randomUUID(), keyId: k.id, name: k.name, at })
    return env
  }

  // A team key's value by name, for a connector's variable that says cofre:NAME.
  async teamValue(name: string): Promise<string | undefined> {
    const k = this.deps.db.vaultKeys().find((x) => !x.owner && x.name === name)
    return k && this.value(k)
  }

  // What this agent's computer printed, with every value it may have had masked: the keys given to it
  // (whoever's) whose values were opened in this run of the app, so a `cat .env` or a service's log
  // shows [cofre:NAME] too.
  mask(agentId: string, text: string): string {
    const keys = this.deps.db
      .vaultKeys()
      .filter((k) => k.agents.includes(agentId) && this.values.has(k.id))
      .map((k) => ({ name: k.name, value: this.values.get(k.id)! }))
    return maskKeys(text, keys)
  }

  // Opens (once) every key given to this agent, so mask() knows their values before its first command.
  // Not a 1Password reference: reading one asks to unlock 1Password, which only a use should do.
  async warm(agentId: string): Promise<void> {
    for (const k of this.deps.db.vaultKeys()) {
      if (!k.agents.includes(agentId) || this.values.has(k.id)) continue
      const stored = await this.deps.secrets.get(secretKey(k.id)).catch(() => undefined)
      if (stored !== undefined && !isOpRef(stored)) this.values.set(k.id, stored)
    }
  }

  // ---------- site logins ----------

  // What a person sees: the team's logins and their own.
  logins(who: Pick<Asker, 'id'>): VaultLogin[] {
    return this.deps.db.vaultLogins().filter((l) => !l.owner || l.owner === who.id)
  }

  // An agent gets one login per site in a drawer: giving it this one takes it off the others.
  private takeOff(l: VaultLogin, agents: readonly string[]): void {
    for (const o of this.deps.db.vaultLogins()) {
      if (o.id === l.id || o.origin !== l.origin || (o.owner ?? '') !== (l.owner ?? '') || !o.agents.some((a) => agents.includes(a))) continue
      this.deps.db.saveVaultLogin({ ...o, agents: o.agents.filter((a) => !agents.includes(a)), updatedAt: this.now() })
    }
  }

  async saveLogin(who: Asker, input: VaultLoginInput): Promise<VaultLogin> {
    const { db } = this.deps
    const origin = loginOrigin(input.site)
    if (!origin) throw new Error(L('Endereço inválido. Use o do site, como conta.exemplo.com.br (só https).', 'Invalid address. Use the site’s, like account.example.com (https only).'))
    const before = input.id ? db.vaultLogin(input.id) : undefined
    if (input.id && (!before || (before.owner && before.owner !== who.id))) throw new Error(L('Esse login não existe mais.', 'That login no longer exists.'))
    const owner = before ? before.owner : who.team && (input.mine || !who.admin) ? who.id : undefined
    if (!this.mayChange(who, { owner })) throw new Error(L('Só um admin muda os logins do time.', 'Only an admin changes the team’s logins.'))
    const typed = { username: input.username?.trim() ?? '', password: input.password ?? '' }
    let stored: Stored | undefined
    if (typed.username || typed.password) {
      const old = before && (!typed.username || !typed.password) ? await this.stored(before) : undefined
      stored = { username: typed.username || old?.username || '', password: typed.password || old?.password || '' }
      if (!stored.username || !stored.password) throw new Error(L('Falta o usuário ou a senha.', 'The username or the password is missing.'))
    } else if (!before) throw new Error(L('Falta o usuário ou a senha.', 'The username or the password is missing.'))
    const live = new Set(db.agents().filter((a) => !a.archived && a.kind !== 'tuca').map((a) => a.id))
    const at = this.now()
    const login: VaultLogin = {
      id: before?.id ?? randomUUID(),
      origin,
      username: stored ? shownUser(stored.username) : (before?.username ?? ''),
      ...(owner ? { owner } : {}),
      agents: [...new Set(input.agents)].filter((a) => live.has(a) || before?.agents.includes(a)),
      ...(input.note?.trim() ? { note: input.note.trim().slice(0, 300) } : {}),
      createdBy: before?.createdBy ?? who.id,
      createdAt: before?.createdAt ?? at,
      updatedAt: at,
      ...(before?.usedAt ? { usedAt: before.usedAt } : {})
    }
    if (stored) await this.deps.secrets.set(loginSecret(login.id), JSON.stringify(stored))
    db.saveVaultLogin(login)
    this.takeOff(login, login.agents)
    return login
  }

  async removeLogin(who: Asker, id: string): Promise<VaultLogin | undefined> {
    const l = this.deps.db.vaultLogin(id)
    if (!l || (l.owner && l.owner !== who.id)) return undefined
    if (!this.mayChange(who, l)) throw new Error(L('Só um admin apaga os logins do time.', 'Only an admin deletes the team’s logins.'))
    this.deps.db.removeVaultLogin(id)
    await this.deps.secrets.set(loginSecret(id), undefined)
    return l
  }

  setLoginAgent(who: Asker, id: string, agentId: string, on: boolean): VaultLogin {
    const l = this.deps.db.vaultLogin(id)
    if (!l || (l.owner && l.owner !== who.id)) throw new Error(L('Esse login não existe mais.', 'That login no longer exists.'))
    if (!this.mayChange(who, l)) throw new Error(L('Só um admin libera os logins do time.', 'Only an admin gives out the team’s logins.'))
    const next = { ...l, agents: on ? [...new Set([...l.agents, agentId])] : l.agents.filter((a) => a !== agentId), updatedAt: this.now() }
    this.deps.db.saveVaultLogin(next)
    if (on) this.takeOff(next, [agentId])
    return next
  }

  // The logins an agent may use in work for this person: as with keys, a person's own for a site
  // stands in for the team's.
  usableLogins(agentId: string, personId?: string): VaultLogin[] {
    const mine = this.deps.db.vaultLogins().filter((l) => l.agents.includes(agentId) && (!l.owner || l.owner === personId))
    return mine.filter((l) => l.owner || !mine.some((o) => o.owner && o.origin === l.origin))
  }

  // The sites, for the agent's prompt: never the logins themselves.
  loginSites(agentId: string, personId?: string): string[] {
    return [...new Set(this.usableLogins(agentId, personId).map((l) => l.origin))]
  }

  private async stored(l: VaultLogin): Promise<Stored | undefined> {
    const raw = await this.deps.secrets.get(loginSecret(l.id))
    return raw === undefined ? undefined : (JSON.parse(raw) as Stored)
  }

  // For navegador_login only, on the page's exact origin: the login, a 1Password reference read now,
  // and the use in the log.
  async loginFor(agentId: string, origin: string, use: Omit<VaultUse, 'id' | 'keyId' | 'name' | 'at' | 'agentId' | 'via'>): Promise<Stored | undefined> {
    const l = this.usableLogins(agentId, use.personId).find((x) => x.origin === origin)
    const v = l && (await this.stored(l))
    if (!l || !v) return undefined
    const login = { username: await resolveOp(v.username, this.deps.readOp), password: await resolveOp(v.password, this.deps.readOp) }
    this.deps.db.recordVaultUse({ ...use, id: randomUUID(), keyId: l.id, name: l.origin, agentId, via: 'login', at: this.now() })
    return login
  }

  // The logins saved on an agent's browser page before the Cofre, moved in as the team's: one per
  // site and account, given to the agents that had it. One that won't open stays where it was.
  async moveOldLogins(): Promise<number> {
    const { db, secrets } = this.deps
    let moved = 0
    for (const key of db.secretKeys(OLD_LOGIN)) {
      const rest = key.slice(OLD_LOGIN.length)
      const cut = rest.indexOf(':')
      const agentId = rest.slice(0, cut)
      const origin = rest.slice(cut + 1)
      const raw = await secrets.get(key).catch(() => undefined)
      if (cut < 1 || raw === undefined) continue
      const v = JSON.parse(raw) as Stored
      const agent = db.agent(agentId)
      const same = await this.findSame(origin, v)
      const at = this.now()
      if (same) {
        if (agent && !agent.deleted && !same.agents.includes(agentId)) db.saveVaultLogin({ ...same, agents: [...same.agents, agentId], updatedAt: at })
      } else {
        const id = randomUUID()
        await secrets.set(loginSecret(id), JSON.stringify(v))
        db.saveVaultLogin({ id, origin, username: shownUser(v.username), agents: agent && !agent.deleted ? [agentId] : [], createdAt: at, updatedAt: at })
      }
      await secrets.set(key, undefined)
      moved++
    }
    return moved
  }

  private async findSame(origin: string, v: Stored): Promise<VaultLogin | undefined> {
    for (const l of this.deps.db.vaultLogins()) {
      if (l.owner || l.origin !== origin) continue
      const s = await this.stored(l).catch(() => undefined)
      if (s && s.username === v.username && s.password === v.password) return l
    }
    return undefined
  }

  // ---------- pedir_chave's card ----------

  // What the card saves for the agent that asked (args: its { nome } or { site }): the key or login
  // pasted, in the person's own drawer or the team's when an admin says so (alone, just the Cofre); or
  // one already saved, given to it. A key already there by that name gets the new value and the agent.
  async answer(who: Asker, agentId: string, args: Record<string, unknown>, a: Omit<KeyRequestAnswer, 'id'>): Promise<{ kind: 'key'; item: VaultKey; created: boolean } | { kind: 'login'; item: VaultLogin; created: boolean }> {
    const mine = !(a.team && who.admin)
    const drawer = who.team && mine ? who.id : undefined
    const nome = typeof args['nome'] === 'string' ? args['nome'] : undefined
    const site = typeof args['site'] === 'string' ? args['site'] : undefined
    if (nome) {
      if (a.existing) {
        const k = this.list(who).find((x) => x.id === a.existing && x.name === nome)
        if (!k) throw new Error(L('Essa chave não existe mais.', 'That key no longer exists.'))
        return { kind: 'key', item: this.setAgent(who, k.id, agentId, true), created: false }
      }
      if (!a.value?.trim()) throw new Error(L('Cole o valor da chave.', 'Paste the key’s value.'))
      const same = this.list(who).find((k) => k.name === nome && k.owner === drawer)
      const item = await this.save(who, same ? { id: same.id, name: nome, value: a.value, agents: [...same.agents, agentId], approve: same.approve, ...(same.note ? { note: same.note } : {}) } : { name: nome, value: a.value, mine, agents: [agentId], approve: false })
      return { kind: 'key', item, created: !same }
    }
    if (!site) throw new Error(L('Esse pedido não diz o que falta.', "That request doesn't say what's missing."))
    if (a.existing) {
      const l = this.logins(who).find((x) => x.id === a.existing && x.origin === site)
      if (!l) throw new Error(L('Esse login não existe mais.', 'That login no longer exists.'))
      return { kind: 'login', item: this.setLoginAgent(who, l.id, agentId, true), created: false }
    }
    const item = await this.saveLogin(who, { site, username: a.username ?? '', password: a.password ?? '', mine, agents: [agentId] })
    return { kind: 'login', item, created: true }
  }
}
