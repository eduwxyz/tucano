// Only the main process opens this store. A missing/locked keychain never falls back to plaintext.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseServerUrl, parseSshTarget, type Reach } from '../shared/pairlink'

export type SavedRemote = {
  id: string; name: string; reach: Reach; remotePort: number; server: string
  device: { id: string; label: string; created: number; seen: number }; days: number
}
export type SecretStorage = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}
type Entry = { profile: SavedRemote; encrypted: string }
export function validReach(reach: Reach): boolean {
  if (!reach || typeof reach !== 'object') return false
  if (reach.via === 'url') return typeof reach.url === 'string' && parseServerUrl(reach.url) === reach.url
  if (reach.via !== 'ssh') return false
  const { user, host, port } = reach
  if (typeof user !== 'string' || typeof host !== 'string' || !Number.isInteger(port)) return false
  const parsed = parseSshTarget(`${user}@${host.includes(':') ? `[${host}]` : host}:${port}`)
  return !!parsed && parsed.user === user && parsed.host === host && parsed.port === port
}
export function validProfile(p: SavedRemote): boolean {
  return !!p && typeof p.id === 'string' && typeof p.name === 'string' && validReach(p.reach) &&
    Number.isInteger(p.remotePort) && p.remotePort >= 1 && p.remotePort <= 65535 && typeof p.server === 'string' &&
    !!p.device && typeof p.device.id === 'string' && typeof p.device.label === 'string' &&
    Number.isFinite(p.device.created) && Number.isFinite(p.device.seen) && Number.isFinite(p.days) && p.days > 0
}
// Older releases accepted plaintext Tailscale-looking URLs. Retain their metadata so
// users can rename/forget them without making unrelated safe profiles unreadable.
// This exception is ONLY for reading metadata, never connecting or unlocking tokens.
function validStoredProfile(p: SavedRemote): boolean {
  if (validProfile(p)) return true
  if (!p || p.reach?.via !== 'url' || typeof p.reach.url !== 'string') return false
  let url: URL
  try { url = new URL(p.reach.url) } catch { return false }
  if (url.protocol !== 'http:' || url.origin !== p.reach.url || url.username || url.password || url.search || url.hash || url.pathname !== '/') return false
  const host = url.hostname.toLowerCase()
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  const formerlyAllowed = host.endsWith('.ts.net') || host.startsWith('[fd7a:115c:a1e0:') ||
    (!!v4 && Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127)
  return formerlyAllowed && validProfile({ ...p, reach: { via: 'url', url: 'https://legacy.invalid' } })
}

function clean(p: SavedRemote): SavedRemote {
  const reach: Reach = p.reach.via === 'url' ? { via: 'url', url: p.reach.url } : { via: 'ssh', user: p.reach.user, host: p.reach.host, port: p.reach.port }
  return { id: p.id, name: p.name, reach, remotePort: p.remotePort, server: p.server, days: p.days,
    device: { id: p.device.id, label: p.device.label, created: p.device.created, seen: p.device.seen } }
}
export class RemoteStore {
  constructor(private readonly file: string, private readonly secrets: SecretStorage) {}
  private available(): void {
    if (!this.secrets.isEncryptionAvailable() || (process.platform === 'linux' && ['basic_text', 'unknown'].includes(this.secrets.getSelectedStorageBackend?.() ?? '')))
      throw new Error('Secure storage is unavailable. Unlock the system keychain and try again.')
  }
  private read(): Entry[] {
    let data: string
    try { data = readFileSync(this.file, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('Cannot read saved servers.')
    }
    try {
      const value = JSON.parse(data)
      if (value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every((e: Entry) => validStoredProfile(e.profile) && typeof e.encrypted === 'string')) throw new Error()
      return value.entries.map((e: Entry) => ({ profile: clean(e.profile), encrypted: e.encrypted }))
    } catch { throw new Error('Saved servers are unreadable. Restore the file from a backup or pair again.') }
  }
  list(): SavedRemote[] { return this.read().map(e => e.profile) }
  get(id: string): { profile: SavedRemote; token: string } | undefined {
    const entry = this.read().find(e => e.profile.id === id)
    if (!entry) return undefined
    if (!validProfile(entry.profile)) throw new Error('This saved server uses plaintext HTTP outside localhost. Configure HTTPS (including Tailscale Serve) and pair again, or forget this connection. No token was unlocked or sent.')
    this.available()
    try { return { profile: entry.profile, token: this.secrets.decryptString(Buffer.from(entry.encrypted, 'base64')) } }
    catch { throw new Error('Cannot unlock this server token. Unlock the system keychain or pair again.') }
  }
  put(profile: SavedRemote, token: string): void {
    if (!validProfile(profile) || !token || /\s/.test(token)) throw new Error('Invalid server credentials.')
    this.available()
    let encrypted: string
    try { encrypted = this.secrets.encryptString(token).toString('base64') }
    catch { throw new Error('Cannot save this token securely. Unlock the system keychain and try again.') }
    const entries = this.read().filter(e => e.profile.id !== profile.id)
    entries.push({ profile: clean(profile), encrypted })
    this.write(entries)
  }
  rename(id: string, name: string): void {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || /\p{Cc}/u.test(name)) throw new Error('Server name must contain 1 to 60 characters without control characters.')
    const entries = this.read()
    const entry = entries.find(e => e.profile.id === id)
    if (!entry) throw new Error('Saved server not found.')
    entry.profile.name = name.trim()
    this.write(entries)
  }
  remove(id: string): void { this.write(this.read().filter(e => e.profile.id !== id)) }
  private write(entries: Entry[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, entries }), { mode: 0o600, flag: 'wx' })
      // POSIX permission hardening; Windows chmod does not set an ACL. There the file
      // inherits the app data directory ACL and safeStorage protects tokens with DPAPI.
      chmodSync(temp, 0o600)
      renameSync(temp, this.file)
    } catch { throw new Error('Cannot save the server connection.') }
    finally { try { unlinkSync(temp) } catch { /* rename already removed it */ } }
  }
}
