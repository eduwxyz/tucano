// The Cofre: keys saved once, used by the agents by name, one command at a time (src/shared/vault.ts).
//
// Two drawers. The team's keys (owner '') are an admin's to make and to give to agents. A person's own
// keys are theirs alone: the others never see they exist, and an agent uses one only in work that person
// asked for. On a desktop with one person there are only the team's keys, called just "Cofre".
//
// The value is in secrets, encrypted with the system's keychain, under 'vault:<id>'; or it's an op://
// reference read from 1Password each time it's used. It leaves here only into the environment of the
// command that asked for it, and every value an agent may use is masked in what its computer prints.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { keyHint, keyNameError, masked, type VaultKey, type VaultKeyInput, type VaultUse } from '../shared/vault'
import type { Db } from './db'
import { isOpRef, resolveOp } from './onepassword'
import type { Secrets } from './secrets'

const secretKey = (id: string): string => `vault:${id}`

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

  private mayChange(who: Asker, k: Pick<VaultKey, 'owner'>): boolean {
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
}
