// The vault: secrets the agents use by reference ({{vault:name}}) and never see (src/core/vault/refs.ts).
// It opens on its own when Tucano starts: the vault key is wrapped by this computer's key, which the
// OS keychain keeps (the server's key, on a server). Nothing is typed. A copy of the database alone
// opens nothing; the recovery code, shown once, opens it where the keychain is gone.
// The screen gets names, kinds and who uses each item; a value goes in once and never comes back out.
import { randomUUID } from 'node:crypto'
import { UserError } from '../../shared/errors'
import { L } from '../../shared/lang'
import { VAULT_FIELDS, VAULT_KINDS, type Agent, type VaultAccess, type VaultItem, type VaultItemInput, type VaultStatus, type VaultUse } from '../../shared/types'
import type { Db, VaultStored } from '../db'
import { unreadable, type Secrets } from '../secrets'
import { derive, deviceKek, newKdf, newKey, newRecoveryCode, open, readRecoveryCode, seal, wipe, type Kdf } from './crypto'

export const DEVICE_SECRET = 'vault.device'
const META_AAD = 'tucano-vault-v1'
const FORMAT = 1
export const MAX_VALUE = 64 * 1024
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const HOST_RE = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+(:\d{1,5})?$/

const itemAad = (i: Pick<VaultStored, 'id' | 'version'>): string => `item|${i.id}|${i.version}`

// Written for people (L('…', '…')): the screen shows it as it is (src/shared/errors.ts), never "something went wrong".
export class VaultError extends UserError {}

// A host as it's kept: no scheme, path or trailing dot; lowercase. undefined when it isn't one.
export function cleanHost(h: string): string | undefined {
  let s = h.trim().toLowerCase()
  if (!s) return undefined
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^[^@]*@/, '').replace(/\.$/, '')
  return HOST_RE.test(s) ? s : undefined
}

// Whether a URL's host is one of the item's: exactly, or under a *. wildcard (not the bare domain).
export function hostAllowed(url: URL, hosts: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const port = url.port
  return hosts.some((h) => {
    const [name, p] = h.split(':') as [string, string | undefined]
    if (p !== undefined && p !== port) return false
    return name.startsWith('*.') ? host.endsWith(name.slice(1)) && host.length > name.length - 1 : host === name
  })
}

// Who uses an item: the Tuca (the app's own helper) only when named, never by "all agents".
export function canUse(item: Pick<VaultItem, 'access'>, agent: Pick<Agent, 'id' | 'kind' | 'archived'>): boolean {
  if (agent.archived) return false
  return item.access.all ? agent.kind !== 'tuca' : item.access.agentIds.includes(agent.id)
}

export class Vault {
  private key: Buffer | null = null
  private state: VaultStatus['state'] = 'empty'
  private problem: string | undefined

  constructor(
    private deps: {
      db: Db
      secrets: Secrets
      now?: () => number
      changed?: () => void // the status or the items changed: the screens hear it
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // At start: opens the vault there is, with this computer's key. Never creates one.
  async start(): Promise<void> {
    const meta = this.deps.db.vaultMeta()
    if (!meta) {
      this.state = 'empty'
      return
    }
    let device: string | undefined
    try {
      device = await this.deps.secrets.get(DEVICE_SECRET)
    } catch (e) {
      if (unreadable(e)) {
        this.set('needs_recovery')
        return
      }
      this.set('unavailable', e instanceof Error ? e.message : String(e))
      return
    }
    if (!device) return this.set('needs_recovery')
    const kek = deviceKek(Buffer.from(device, 'base64'))
    try {
      this.key = open(kek, meta.wrappedKey, META_AAD)
      this.set('open')
    } catch {
      this.set('needs_recovery')
    } finally {
      wipe(kek)
    }
  }

  private set(state: VaultStatus['state'], problem?: string): void {
    if (state !== 'open') {
      wipe(this.key)
      this.key = null
    }
    this.state = state
    this.problem = problem
    this.deps.changed?.()
  }

  status(): VaultStatus {
    const meta = this.deps.db.vaultMeta()
    return {
      state: this.state,
      ...(this.problem ? { problem: this.problem } : {}),
      recoverySaved: !!meta?.recoverySaved,
      count: meta ? this.deps.db.vaultItems().length : 0
    }
  }

  isOpen(): boolean {
    return this.state === 'open' && !!this.key
  }

  // Makes the vault (the first time): a vault key, this computer's key in the keychain, and the
  // recovery code, returned once for the person to keep. Nothing of the code is saved but what it wraps.
  async create(): Promise<{ recoveryCode: string }> {
    if (this.deps.db.vaultMeta()) throw new VaultError(L('O cofre já existe.', 'The vault already exists.'))
    const vk = newKey()
    const device = newKey()
    try {
      await this.deps.secrets.set(DEVICE_SECRET, device.toString('base64')) // throws without a keychain: nothing made
      const { code, recoveryKdf, recoveryKey } = this.wrapRecovery(vk)
      const kek = deviceKek(device)
      this.deps.db.setVaultMeta({ version: FORMAT, wrappedKey: seal(kek, vk, META_AAD), recoveryKdf, recoveryKey, recoverySaved: false, createdAt: this.now() })
      wipe(kek)
      this.key = Buffer.from(vk)
      this.set('open')
      return { recoveryCode: code }
    } finally {
      wipe(vk, device)
    }
  }

  private wrapRecovery(vk: Buffer): { code: string; recoveryKdf: string; recoveryKey: string } {
    const { code, secret } = newRecoveryCode()
    const kdf = newKdf()
    const rk = derive(secret, kdf)
    const recoveryKey = seal(rk, vk, META_AAD)
    wipe(rk, secret)
    return { code, recoveryKdf: JSON.stringify(kdf), recoveryKey }
  }

  // A new recovery code: the old one stops opening the vault.
  newRecoveryCode(): { recoveryCode: string } {
    const meta = this.deps.db.vaultMeta()
    if (!meta || !this.key) throw this.closedError()
    const { code, recoveryKdf, recoveryKey } = this.wrapRecovery(this.key)
    this.deps.db.setVaultMeta({ ...meta, recoveryKdf, recoveryKey, recoverySaved: false })
    this.deps.changed?.()
    return { recoveryCode: code }
  }

  recoverySaved(): void {
    const meta = this.deps.db.vaultMeta()
    if (!meta) return
    this.deps.db.setVaultMeta({ ...meta, recoverySaved: true })
    this.deps.changed?.()
  }

  // Opens with the recovery code, and gives this computer a key of its own again: from then on it
  // opens on its own here. The same message for a wrong code and a wrong vault.
  async recover(code: string): Promise<void> {
    const meta = this.deps.db.vaultMeta()
    if (!meta) throw new VaultError(L('Não há cofre pra abrir.', 'There is no vault to open.'))
    const wrong = (): VaultError => new VaultError(L('Esse código não abre este cofre. Confira e digite de novo.', "That code doesn't open this vault. Check it and type it again."))
    const secret = readRecoveryCode(code)
    if (!secret) throw wrong()
    let vk: Buffer
    const rk = derive(secret, JSON.parse(meta.recoveryKdf) as Kdf)
    try {
      vk = open(rk, meta.recoveryKey, META_AAD)
    } catch {
      throw wrong()
    } finally {
      wipe(rk, secret)
    }
    const device = newKey()
    try {
      await this.deps.secrets.set(DEVICE_SECRET, device.toString('base64'))
      const kek = deviceKek(device)
      this.deps.db.setVaultMeta({ ...meta, wrappedKey: seal(kek, vk, META_AAD) })
      wipe(kek)
      wipe(this.key)
      this.key = vk
      this.set('open')
    } catch (e) {
      wipe(vk)
      throw e
    } finally {
      wipe(device)
    }
  }

  // No key and no code: a new vault, with a new key and a new recovery code. The values saved before
  // can't be opened by anyone any more; keepItems keeps each item (name, what it's for, hosts, who
  // uses it) with no value, to be typed again. Otherwise everything goes.
  async reset(keepItems = false): Promise<{ recoveryCode: string }> {
    this.deps.db.clearVault(keepItems)
    await this.deps.secrets.set(DEVICE_SECRET, undefined).catch(() => {})
    this.set('empty')
    return this.create()
  }

  private closedError(): VaultError {
    return new VaultError(
      this.state === 'needs_recovery'
        ? L('O cofre precisa do código de recuperação neste computador (Configurações › Cofre).', 'The vault needs its recovery code on this computer (Settings › Vault).')
        : this.state === 'unavailable'
          ? (this.problem ?? L('O cofre não está disponível.', 'The vault is unavailable.'))
          : L('Ainda não há cofre. Crie em Configurações › Cofre.', 'There is no vault yet. Create it in Settings › Vault.')
    )
  }

  // ---------- items, for the screen (never a value) ----------

  list(): VaultItem[] {
    return this.deps.db.vaultItems().map(publicItem)
  }

  uses(itemId: string): VaultUse[] {
    return this.deps.db.vaultUses(itemId)
  }

  save(input: VaultItemInput): VaultItem {
    if (!this.key) throw this.closedError()
    const { db } = this.deps
    const name = input.name.trim().toLowerCase()
    if (!NAME_RE.test(name)) throw new VaultError(L('Nome inválido: use letras minúsculas, números, - ou _ (até 64), começando por letra ou número.', 'Invalid name: use lowercase letters, numbers, - or _ (up to 64), starting with a letter or number.'))
    if (!VAULT_KINDS.includes(input.kind)) throw new VaultError(L('Tipo desconhecido.', 'Unknown kind.'))
    const prev = input.id ? db.vaultItem(input.id) : undefined
    if (input.id && !prev) throw new VaultError(L('Esse item não existe mais.', 'That item no longer exists.'))
    const taken = db.vaultItemNamed(name)
    if (taken && taken.id !== prev?.id) throw new VaultError(L(`Já existe um item chamado ${name}.`, `There's already an item called ${name}.`))
    const hosts: string[] = []
    for (const h of input.hosts) {
      if (!h.trim()) continue
      const clean = cleanHost(h)
      if (!clean) throw new VaultError(L(`Host inválido: ${h}. Use só o nome, como api.github.com ou *.exemplo.com.`, `Invalid host: ${h}. Use the name only, like api.github.com or *.example.com.`))
      if (!hosts.includes(clean)) hosts.push(clean)
    }
    const scope = input.scope === 'any' ? 'any' : 'http'
    if (scope === 'http' && !hosts.length) throw new VaultError(L('Diga pelo menos um host pra onde o segredo pode ir, ou libere o uso em comandos e no navegador.', 'Name at least one host the secret may go to, or allow using it in commands and the browser.'))
    const fields = VAULT_FIELDS[input.kind]
    const given = Object.fromEntries(Object.entries(input.values ?? {}).filter(([k, v]) => fields.includes(k) && typeof v === 'string' && v !== ''))
    for (const v of Object.values(given)) if (Buffer.byteLength(v) > MAX_VALUE) throw new VaultError(L('Valor grande demais (até 64 KB).', 'Value too big (up to 64 KB).'))
    // What stays: the values saved before, when the kind is the same and a field wasn't typed again.
    let values: Record<string, string> = {}
    if (prev && prev.kind === input.kind && !prev.missing) {
      const old = open(this.key, prev.sealed, itemAad(prev))
      values = JSON.parse(old.toString('utf8')) as Record<string, string>
      wipe(old)
    }
    values = { ...values, ...given }
    if (!values[fields[0]!]) throw new VaultError(prev?.missing ? L('Esse item está sem valor: digite o valor de novo.', 'This item has no value: type the value again.') : prev && prev.kind !== input.kind ? L('Mudou o tipo: digite o valor de novo.', 'The kind changed: type the value again.') : L('Faltou o valor.', 'The value is missing.'))
    const access: VaultAccess = input.access.all ? { all: true } : { all: false, agentIds: [...new Set(input.access.agentIds.filter((x) => typeof x === 'string' && x))] }
    const at = this.now()
    const id = prev?.id ?? randomUUID()
    const version = (prev?.version ?? 0) + 1
    const plain = Buffer.from(JSON.stringify(values), 'utf8')
    const sealed = seal(this.key, plain, itemAad({ id, version }))
    wipe(plain)
    const item: VaultStored = {
      id,
      name,
      kind: input.kind,
      description: input.description.trim().slice(0, 500),
      fields,
      access,
      hosts,
      scope,
      askEachUse: !!input.askEachUse,
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
      sealed,
      version
    }
    db.saveVaultItem(item)
    this.deps.changed?.()
    return publicItem(db.vaultItem(id)!)
  }

  setAccess(id: string, access: VaultAccess): VaultItem {
    const prev = this.deps.db.vaultItem(id)
    if (!prev) throw new VaultError(L('Esse item não existe mais.', 'That item no longer exists.'))
    const clean: VaultAccess = access.all ? { all: true } : { all: false, agentIds: [...new Set(access.agentIds)] }
    this.deps.db.saveVaultItem({ ...prev, access: clean, updatedAt: this.now() })
    this.deps.changed?.()
    return publicItem(this.deps.db.vaultItem(id)!)
  }

  remove(id: string): void {
    this.deps.db.removeVaultItem(id)
    this.deps.changed?.()
  }

  // ---------- for the agents (src/core/vault/refs.ts) ----------

  // The items this agent may use, by name: what its prompt lists.
  usable(agent: Pick<Agent, 'id' | 'kind' | 'archived'>): VaultItem[] {
    return this.deps.db
      .vaultItems()
      .filter((i) => canUse(i, agent))
      .map(publicItem)
  }

  // The item by name, if this agent may use it. Unknown and not allowed look the same from outside.
  find(agent: Pick<Agent, 'id' | 'kind' | 'archived'>, name: string): VaultItem | undefined {
    const item = this.deps.db.vaultItemNamed(name.toLowerCase())
    return item && canUse(item, agent) ? publicItem(item) : undefined
  }

  // An item's values, opened now. Throws while the vault isn't open.
  reveal(itemId: string): Record<string, string> {
    if (!this.key) throw this.closedError()
    const item = this.deps.db.vaultItem(itemId)
    if (!item) throw new VaultError(L('Esse item não existe mais.', 'That item no longer exists.'))
    if (item.missing) throw new VaultError(L(`"${item.name}" está sem valor: precisa ser salvo de novo no cofre.`, `"${item.name}" has no value: it needs to be saved again in the vault.`))
    const plain = open(this.key, item.sealed, itemAad(item))
    try {
      return JSON.parse(plain.toString('utf8')) as Record<string, string>
    } finally {
      wipe(plain)
    }
  }

  closedMessage(): string {
    return this.closedError().message
  }

  record(use: Omit<VaultUse, 'id' | 'at'>): void {
    this.deps.db.addVaultUse({ ...use, id: randomUUID(), at: this.now() })
  }

  // The app is closing: the key goes out of memory.
  close(): void {
    wipe(this.key)
    this.key = null
  }
}

const publicItem = ({ sealed: _s, version: _v, ...item }: VaultStored): VaultItem => item
