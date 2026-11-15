// What the WhatsApp feature keeps: its own SQLite file (whatsapp.db), apart from the app's
// database, so a big message history never slows the rest. Every secret (the link's keys, the
// official API's token and app secret, the webhook's verify token) is sealed with the system's
// cipher before it is written and only opened when needed.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { ALL_CHATS, clampSettings, type WhatsAppAccess, type WhatsAppChat, type WhatsAppKind, type WhatsAppLevel, type WhatsAppMessage, type WhatsAppSendMode, type WhatsAppSettings } from '../../shared/whatsapp'
import type { Cipher } from '../secrets'

const KEEP_MS = 90 * 24 * 3_600_000 // messages older than this are dropped when the app starts

export interface NumberRow {
  id: string
  name: string
  description: string
  kind: WhatsAppKind
  phone?: string
  settings: WhatsAppSettings
  createdAt: number
}

// What is known about a conversation: a field left out keeps what was there.
export interface ChatPatch {
  id: string
  name?: string
  softName?: string // used only while the conversation has no name (a profile name never replaces a saved contact's)
  kind?: 'contact' | 'group'
  size?: number
  phone?: string
  lastAt?: number
  inboundAt?: number
}

type Row = Record<string, string | number | null>
type Param = string | number | null

const text = (v: string | number | null | undefined): string => (v === null || v === undefined ? '' : String(v))
const num = (v: string | number | null | undefined): number | undefined => (typeof v === 'number' ? v : undefined)

export class WhatsAppStore {
  private db: DatabaseSync

  constructor(
    dir: string,
    private cipher: Cipher
  ) {
    try {
      mkdirSync(dir, { recursive: true })
      this.db = new DatabaseSync(join(dir, 'whatsapp.db'))
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS numbers (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL, phone TEXT, settings TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS chats (number_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER, phone TEXT, last_at INTEGER, inbound_at INTEGER, PRIMARY KEY (number_id, id));
        CREATE TABLE IF NOT EXISTS access (number_id TEXT NOT NULL, agent_id TEXT NOT NULL, chat TEXT NOT NULL, level TEXT NOT NULL, send TEXT NOT NULL, PRIMARY KEY (number_id, agent_id, chat));
        CREATE TABLE IF NOT EXISTS messages (number_id TEXT NOT NULL, chat TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT, text TEXT NOT NULL, at INTEGER NOT NULL, agent_id TEXT, "first" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (number_id, chat, id));
        CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (number_id, chat, at);
        CREATE TABLE IF NOT EXISTS auth (number_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (number_id, k));
      `)
      // A database made by an earlier build has no "first" column yet: it is added once, here.
      if (!this.all('PRAGMA table_info(messages)').some((r) => r['name'] === 'first')) this.db.exec('ALTER TABLE messages ADD COLUMN "first" INTEGER NOT NULL DEFAULT 0')
      this.db.prepare('DELETE FROM messages WHERE at < ?').run(Date.now() - KEEP_MS)
    } catch (e) {
      console.error('[whatsapp]', e)
      throw new UserError(L('Não consegui abrir os dados do WhatsApp neste computador. Feche o app e abra de novo.', "I couldn't open the WhatsApp data on this computer. Close the app and open it again."))
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  private all(sql: string, ...p: Param[]): Row[] {
    return this.db.prepare(sql).all(...p) as unknown as Row[]
  }

  private one(sql: string, ...p: Param[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as unknown as Row | undefined
  }

  private run(sql: string, ...p: Param[]): number {
    return Number(this.db.prepare(sql).run(...p).changes)
  }

  // ---------- numbers ----------

  private numberOf(r: Row): NumberRow {
    const kind: WhatsAppKind = r['kind'] === 'cloud' ? 'cloud' : 'qr'
    let settings: Partial<WhatsAppSettings> | undefined
    try {
      settings = JSON.parse(text(r['settings'])) as Partial<WhatsAppSettings>
    } catch {
      settings = undefined // an unreadable row falls back to the defaults
    }
    return {
      id: text(r['id']),
      name: text(r['name']),
      description: text(r['description']),
      kind,
      ...(r['phone'] ? { phone: text(r['phone']) } : {}),
      settings: clampSettings(kind, settings),
      createdAt: num(r['created_at']) ?? 0
    }
  }

  numbers(): NumberRow[] {
    return this.all('SELECT * FROM numbers ORDER BY created_at, id').map((r) => this.numberOf(r))
  }

  number(id: string): NumberRow | undefined {
    const r = this.one('SELECT * FROM numbers WHERE id = ?', id)
    return r ? this.numberOf(r) : undefined
  }

  addNumber(n: NumberRow): void {
    this.run('INSERT INTO numbers (id, name, description, kind, phone, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', n.id, n.name, n.description, n.kind, n.phone ?? null, JSON.stringify(n.settings), n.createdAt)
  }

  updateNumber(id: string, patch: { name?: string; description?: string; phone?: string; settings?: WhatsAppSettings }): void {
    const cur = this.number(id)
    if (!cur) return
    this.run('UPDATE numbers SET name = ?, description = ?, phone = ?, settings = ? WHERE id = ?', patch.name ?? cur.name, patch.description ?? cur.description, patch.phone ?? cur.phone ?? null, JSON.stringify(patch.settings ?? cur.settings), id)
  }

  // A number leaves with everything that belonged to it: conversations, rules, messages and keys.
  removeNumber(id: string): void {
    this.db.exec('BEGIN')
    try {
      for (const table of ['chats', 'access', 'messages', 'auth']) this.run(`DELETE FROM ${table} WHERE number_id = ?`, id)
      this.run('DELETE FROM numbers WHERE id = ?', id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---------- conversations ----------

  private chatOf(r: Row): WhatsAppChat {
    const size = num(r['size'])
    const lastAt = num(r['last_at'])
    const inboundAt = num(r['inbound_at'])
    return {
      id: text(r['id']),
      name: text(r['name']) || text(r['phone']) || text(r['id']).split('@')[0] || text(r['id']),
      kind: r['kind'] === 'group' ? 'group' : 'contact',
      ...(size !== undefined ? { size } : {}),
      ...(r['phone'] ? { phone: text(r['phone']) } : {}),
      ...(lastAt !== undefined ? { lastAt } : {}),
      ...(inboundAt !== undefined ? { inboundAt } : {})
    }
  }

  chats(numberId: string): WhatsAppChat[] {
    return this.all('SELECT * FROM chats WHERE number_id = ? ORDER BY COALESCE(last_at, 0) DESC, name', numberId).map((r) => this.chatOf(r))
  }

  chat(numberId: string, id: string): WhatsAppChat | undefined {
    const r = this.one('SELECT * FROM chats WHERE number_id = ? AND id = ?', numberId, id)
    return r ? this.chatOf(r) : undefined
  }

  // Merges into what is already known: a missing name never erases one, times only move forward.
  upsertChat(numberId: string, p: ChatPatch): void {
    if (!p.id) return
    const old = this.one('SELECT * FROM chats WHERE number_id = ? AND id = ?', numberId, p.id)
    const later = (a: number | undefined, b: number | undefined): number | null => (a === undefined ? (b ?? null) : b === undefined ? a : Math.max(a, b))
    this.run(
      'INSERT OR REPLACE INTO chats (number_id, id, name, kind, size, phone, last_at, inbound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      numberId,
      p.id,
      p.name?.trim() || text(old?.['name']) || p.softName?.trim() || '',
      p.kind ?? (old?.['kind'] === 'group' ? 'group' : 'contact'),
      p.size ?? num(old?.['size']) ?? null,
      p.phone ?? (old?.['phone'] ? text(old['phone']) : null),
      later(num(old?.['last_at']), p.lastAt),
      later(num(old?.['inbound_at']), p.inboundAt)
    )
  }

  // ---------- who may do what ----------

  access(numberId: string): WhatsAppAccess[] {
    return this.all('SELECT * FROM access WHERE number_id = ? ORDER BY agent_id, chat', numberId).map((r) => ({
      agentId: text(r['agent_id']),
      chat: text(r['chat']),
      level: (r['level'] === 'reply' ? 'reply' : 'read') as WhatsAppLevel,
      send: (r['send'] === 'auto' ? 'auto' : 'ask') as WhatsAppSendMode
    }))
  }

  setAccess(numberId: string, rows: readonly WhatsAppAccess[]): void {
    this.db.exec('BEGIN')
    try {
      this.run('DELETE FROM access WHERE number_id = ?', numberId)
      for (const a of rows) this.run('INSERT OR REPLACE INTO access (number_id, agent_id, chat, level, send) VALUES (?, ?, ?, ?, ?)', numberId, a.agentId, a.chat, a.level, a.send)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  setSend(numberId: string, agentId: string, chat: string, level: WhatsAppLevel, send: WhatsAppSendMode): void {
    this.run('INSERT OR REPLACE INTO access (number_id, agent_id, chat, level, send) VALUES (?, ?, ?, ?, ?)', numberId, agentId, chat, level, send)
  }

  hasAgent(agentId: string): boolean {
    return this.one('SELECT 1 AS x FROM access WHERE agent_id = ? LIMIT 1', agentId) !== undefined
  }

  dropAgent(agentId: string): void {
    this.run('DELETE FROM access WHERE agent_id = ?', agentId)
  }

  // Whether some agent may read this conversation, or every conversation of the number.
  readable(numberId: string, chat: string): boolean {
    return this.one('SELECT 1 AS x FROM access WHERE number_id = ? AND (chat = ? OR chat = ?) LIMIT 1', numberId, chat, ALL_CHATS) !== undefined
  }

  // ---------- messages ----------

  // False when the message was already there (WhatsApp and Meta both deliver the same one twice now and then).
  // "first" marks an agent's message that opened a conversation with someone who had not written: it counts toward the day's new conversations for good.
  addMessage(numberId: string, m: WhatsAppMessage & { first?: boolean }): boolean {
    return this.run('INSERT OR IGNORE INTO messages (number_id, chat, id, from_me, sender, text, at, agent_id, "first") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', numberId, m.chat, m.id, m.fromMe ? 1 : 0, m.sender ?? null, m.text, m.at, m.agentId ?? null, m.first ? 1 : 0) > 0
  }

  // The latest messages of a conversation, oldest first.
  messages(numberId: string, chat: string, limit: number): WhatsAppMessage[] {
    return this.all('SELECT * FROM messages WHERE number_id = ? AND chat = ? ORDER BY at DESC, rowid DESC LIMIT ?', numberId, chat, limit)
      .reverse()
      .map((r) => ({
        id: text(r['id']),
        chat: text(r['chat']),
        fromMe: r['from_me'] === 1,
        ...(r['sender'] ? { sender: text(r['sender']) } : {}),
        text: text(r['text']),
        at: num(r['at']) ?? 0,
        ...(r['agent_id'] ? { agentId: text(r['agent_id']) } : {})
      }))
  }

  // ---------- counting (what the daily limits look at) ----------

  sentToday(numberId: string, since: number): number {
    return num(this.one('SELECT COUNT(*) AS n FROM messages WHERE number_id = ? AND agent_id IS NOT NULL AND at >= ?', numberId, since)?.['n']) ?? 0
  }

  // Conversations an agent started today with someone who had never written to this number. Marked when sent,
  // so the count stays the same after that person answers.
  newToday(numberId: string, since: number): number {
    return num(this.one('SELECT COUNT(DISTINCT chat) AS n FROM messages WHERE number_id = ? AND agent_id IS NOT NULL AND "first" = 1 AND at >= ?', numberId, since)?.['n']) ?? 0
  }

  contactedToday(numberId: string, chat: string, since: number): boolean {
    return this.one('SELECT 1 AS x FROM messages WHERE number_id = ? AND chat = ? AND agent_id IS NOT NULL AND at >= ? LIMIT 1', numberId, chat, since) !== undefined
  }

  // ---------- sealed values ----------

  async authGet(numberId: string, k: string): Promise<string | undefined> {
    const r = this.one('SELECT v FROM auth WHERE number_id = ? AND k = ?', numberId, k)
    return r ? this.cipher.decrypt(text(r['v'])) : undefined
  }

  hasAuth(numberId: string, k: string): boolean {
    return this.one('SELECT 1 AS x FROM auth WHERE number_id = ? AND k = ?', numberId, k) !== undefined
  }

  // Many values at once: all are sealed first, then written together; undefined deletes.
  async authSet(numberId: string, entries: readonly [string, string | undefined][]): Promise<void> {
    const sealed = await Promise.all(entries.map(async ([k, v]) => [k, v === undefined ? undefined : await this.cipher.encrypt(v)] as const))
    this.db.exec('BEGIN')
    try {
      for (const [k, v] of sealed) {
        if (v === undefined) this.run('DELETE FROM auth WHERE number_id = ? AND k = ?', numberId, k)
        else this.run('INSERT OR REPLACE INTO auth (number_id, k, v) VALUES (?, ?, ?)', numberId, k, v)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  authClear(numberId: string): void {
    this.run('DELETE FROM auth WHERE number_id = ?', numberId)
  }
}
