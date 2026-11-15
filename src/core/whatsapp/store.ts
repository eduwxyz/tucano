// What the WhatsApp feature keeps: its own SQLite file (whatsapp.db), apart from the app's
// database, so a big message history never slows the rest. Every secret (the link's keys, the
// official API's token and app secret, the webhook's verify token) is sealed with the system's
// cipher before it is written and only opened when needed.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { ALL_CHATS, clampSettings, type WhatsAppAccess, type WhatsAppChat, type WhatsAppKind, type WhatsAppLevel, type WhatsAppMediaKind, type WhatsAppMessage, type WhatsAppSendMode, type WhatsAppSettings } from '../../shared/whatsapp'
import type { CallState, CallTurn, VoiceChoice } from '../../shared/calls'
import type { Cipher } from '../secrets'
import { REACTION_PREFIX } from './tools'

// A call as it is kept (the window's card is made from it).
export interface CallRow {
  id: string
  numberId: string
  chat: string // the person's conversation
  agentId: string
  conversationId?: string // the voice service's id for the call
  direction: 'in' | 'out'
  state: CallState
  startedAt: number
  seconds: number
  summary?: string
  agreed: string[]
  turns: CallTurn[]
  messageId?: string // the message in the agent's conversation that shows the call
  note?: string
}

const KEEP_MS = 90 * 24 * 3_600_000 // messages older than this are dropped when the app starts
const EVENTS_KEEP_MS = 7 * 24 * 3_600_000 // the daily counters only look at today

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

// A message as it is kept: what the window shows, plus what is needed to answer it, react to it or read its file.
// `file` is a path inside the media folder (see media.ts), never one the other side chose.
export type StoredMessage = WhatsAppMessage & { first?: boolean; file?: string; mime?: string; size?: number; participant?: string }

// The oldest message seen in a conversation (stored or not): where "earlier messages" is asked backwards from.
export interface ChatAnchor {
  id: string
  fromMe: boolean
  participant?: string
  at: number
}

type Row = Record<string, string | number | null>
type Param = string | number | null

const text = (v: string | number | null | undefined): string => (v === null || v === undefined ? '' : String(v))
const num = (v: string | number | null | undefined): number | undefined => (typeof v === 'number' ? v : undefined)

const MEDIA_KINDS: readonly WhatsAppMediaKind[] = ['image', 'audio', 'video', 'document', 'sticker']

// The id an agent sees and quotes: the last six characters, upper-case.
export const shortId = (id: string): string => id.slice(-6).toUpperCase()

// Columns a database made by an earlier build does not have yet: each is added once, at start.
const NEW_MESSAGE_COLUMNS: [string, string][] = [
  ['media', 'TEXT'],
  ['file', 'TEXT'],
  ['file_name', 'TEXT'],
  ['mime', 'TEXT'],
  ['size', 'INTEGER'],
  ['participant', 'TEXT'],
  ['quoted_id', 'TEXT'],
  ['quoted_text', 'TEXT'],
  ['quoted_sender', 'TEXT'],
  ['edited', 'INTEGER NOT NULL DEFAULT 0'],
  ['deleted', 'INTEGER NOT NULL DEFAULT 0']
]

const likeEscape = (v: string): string => v.replace(/[\\%_]/g, (c) => `\\${c}`)

export class WhatsAppStore {
  private db: DatabaseSync
  private expired: string[] = [] // files of the messages the start-up prune dropped, until the service deletes them

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
        CREATE TABLE IF NOT EXISTS chats (number_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER, phone TEXT, last_at INTEGER, inbound_at INTEGER, anchor TEXT, PRIMARY KEY (number_id, id));
        CREATE TABLE IF NOT EXISTS access (number_id TEXT NOT NULL, agent_id TEXT NOT NULL, chat TEXT NOT NULL, level TEXT NOT NULL, send TEXT NOT NULL, PRIMARY KEY (number_id, agent_id, chat));
        CREATE TABLE IF NOT EXISTS messages (number_id TEXT NOT NULL, chat TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT, text TEXT NOT NULL, at INTEGER NOT NULL, agent_id TEXT, "first" INTEGER NOT NULL DEFAULT 0, ${NEW_MESSAGE_COLUMNS.map(([n, t]) => `${n} ${t}`).join(', ')}, PRIMARY KEY (number_id, chat, id));
        CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (number_id, chat, at);
        CREATE TABLE IF NOT EXISTS auth (number_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (number_id, k));
        CREATE TABLE IF NOT EXISTS events (number_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS events_by_number ON events (number_id, kind, at);
        CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, number_id TEXT NOT NULL, chat TEXT NOT NULL, agent_id TEXT NOT NULL, conversation_id TEXT, direction TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, summary TEXT, agreed TEXT, turns TEXT, message_id TEXT, note TEXT);
        CREATE INDEX IF NOT EXISTS calls_by_number ON calls (number_id, started_at);
        CREATE INDEX IF NOT EXISTS calls_by_conversation ON calls (conversation_id);
        CREATE TABLE IF NOT EXISTS voices (agent_id TEXT PRIMARY KEY, provider TEXT NOT NULL, voice_id TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS call_permissions (number_id TEXT NOT NULL, chat TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (number_id, chat));
      `)
      // A database made by an earlier build lacks the columns added since: each is added once, here.
      const have = (table: string): Set<string> => new Set(this.all(`PRAGMA table_info(${table})`).map((r) => text(r['name'])))
      const message = have('messages')
      if (!message.has('first')) this.db.exec('ALTER TABLE messages ADD COLUMN "first" INTEGER NOT NULL DEFAULT 0')
      for (const [name, type] of NEW_MESSAGE_COLUMNS) if (!message.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`)
      if (!have('chats').has('anchor')) this.db.exec('ALTER TABLE chats ADD COLUMN anchor TEXT')
      this.expired = this.prune()
      this.db.prepare('DELETE FROM events WHERE at < ?').run(Date.now() - EVENTS_KEEP_MS)
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
  // Returns the files its messages had, for the service to delete.
  removeNumber(id: string): string[] {
    this.db.exec('BEGIN')
    try {
      const files = this.all('SELECT file FROM messages WHERE number_id = ? AND file IS NOT NULL', id).map((r) => text(r['file']))
      for (const table of ['chats', 'access', 'messages', 'auth', 'events', 'calls', 'call_permissions']) this.run(`DELETE FROM ${table} WHERE number_id = ?`, id)
      this.run('DELETE FROM numbers WHERE id = ?', id)
      this.db.exec('COMMIT')
      return files
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // Drops the messages older than 90 days; returns the files they had, for the service to delete.
  prune(now = Date.now()): string[] {
    const cutoff = now - KEEP_MS
    const files = this.all('SELECT file FROM messages WHERE at < ? AND file IS NOT NULL', cutoff).map((r) => text(r['file']))
    this.run('DELETE FROM messages WHERE at < ?', cutoff)
    this.run("DELETE FROM calls WHERE started_at < ? AND state != 'live'", cutoff) // a call's turns are big
    return files
  }

  // What the prune at start-up dropped: handed over once.
  takeExpired(): string[] {
    const files = this.expired
    this.expired = []
    return files
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
      'INSERT OR REPLACE INTO chats (number_id, id, name, kind, size, phone, last_at, inbound_at, anchor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      numberId,
      p.id,
      p.name?.trim() || text(old?.['name']) || p.softName?.trim() || '',
      p.kind ?? (old?.['kind'] === 'group' ? 'group' : 'contact'),
      p.size ?? num(old?.['size']) ?? null,
      p.phone ?? (old?.['phone'] ? text(old['phone']) : null),
      later(num(old?.['last_at']), p.lastAt),
      later(num(old?.['inbound_at']), p.inboundAt),
      old?.['anchor'] ? text(old['anchor']) : null // the row is replaced, so what it already holds is carried over
    )
  }

  // The oldest message seen in a conversation. A message not older than the one already kept changes nothing,
  // so the anchor only ever moves back in time (history arrives in any order).
  setAnchor(numberId: string, chat: string, a: ChatAnchor): void {
    if (!chat || !a.id) return
    const cur = this.anchor(numberId, chat)
    if (cur && cur.at <= a.at) return
    if (!this.chat(numberId, chat)) this.upsertChat(numberId, { id: chat, kind: chat.endsWith('@g.us') ? 'group' : 'contact' })
    this.run('UPDATE chats SET anchor = ? WHERE number_id = ? AND id = ?', JSON.stringify({ id: a.id, fromMe: a.fromMe, ...(a.participant ? { participant: a.participant } : {}), at: a.at }), numberId, chat)
  }

  anchor(numberId: string, chat: string): ChatAnchor | undefined {
    const raw = this.one('SELECT anchor FROM chats WHERE number_id = ? AND id = ?', numberId, chat)?.['anchor']
    if (!raw) return undefined
    try {
      const a = JSON.parse(text(raw)) as Partial<ChatAnchor> | null
      if (!a || typeof a.id !== 'string' || !a.id || typeof a.at !== 'number') return undefined
      return { id: a.id, fromMe: a.fromMe === true, ...(typeof a.participant === 'string' && a.participant ? { participant: a.participant } : {}), at: a.at }
    } catch {
      return undefined // an unreadable anchor is as good as none
    }
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
    this.run('DELETE FROM voices WHERE agent_id = ?', agentId)
  }

  // Whether some agent may read this conversation, or every conversation of the number.
  readable(numberId: string, chat: string): boolean {
    return this.one('SELECT 1 AS x FROM access WHERE number_id = ? AND (chat = ? OR chat = ?) LIMIT 1', numberId, chat, ALL_CHATS) !== undefined
  }

  // ---------- messages ----------

  // False when the message was already there (WhatsApp and Meta both deliver the same one twice now and then).
  // "first" marks an agent's message that opened a conversation with someone who had not written: it counts toward the day's new conversations for good.
  addMessage(numberId: string, m: StoredMessage): boolean {
    return (
      this.run(
        'INSERT OR IGNORE INTO messages (number_id, chat, id, from_me, sender, text, at, agent_id, "first", media, file, file_name, mime, size, participant, quoted_id, quoted_text, quoted_sender, edited, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        numberId,
        m.chat,
        m.id,
        m.fromMe ? 1 : 0,
        m.sender ?? null,
        m.text,
        m.at,
        m.agentId ?? null,
        m.first ? 1 : 0,
        m.media ?? null,
        m.file ?? null,
        m.fileName ?? null,
        m.mime ?? null,
        m.size ?? null,
        m.participant ?? null,
        m.quoted?.id ?? null,
        m.quoted?.text ?? null,
        m.quoted?.sender ?? null,
        m.edited ? 1 : 0,
        m.deleted ? 1 : 0
      ) > 0
    )
  }

  private messageOf(r: Row): WhatsAppMessage {
    const media = MEDIA_KINDS.find((k) => k === r['media'])
    return {
      id: text(r['id']),
      chat: text(r['chat']),
      fromMe: r['from_me'] === 1,
      ...(r['sender'] ? { sender: text(r['sender']) } : {}),
      text: text(r['text']),
      at: num(r['at']) ?? 0,
      ...(r['agent_id'] ? { agentId: text(r['agent_id']) } : {}),
      ...(media ? { media } : {}),
      ...(r['file_name'] ? { fileName: text(r['file_name']) } : {}),
      ...(r['quoted_id'] ? { quoted: { id: text(r['quoted_id']), text: text(r['quoted_text']), ...(r['quoted_sender'] ? { sender: text(r['quoted_sender']) } : {}) } } : {}),
      ...(r['edited'] === 1 ? { edited: true } : {}),
      ...(r['deleted'] === 1 ? { deleted: true } : {})
    }
  }

  // The latest messages of a conversation, oldest first.
  messages(numberId: string, chat: string, limit: number): WhatsAppMessage[] {
    return this.all('SELECT * FROM messages WHERE number_id = ? AND chat = ? ORDER BY at DESC, rowid DESC LIMIT ?', numberId, chat, limit)
      .reverse()
      .map((r) => this.messageOf(r))
  }

  // One message, by its full id or by the short one agents see (the last six characters, any case): the match must be unique.
  message(numberId: string, chat: string, idOrShort: string): StoredMessage | undefined {
    // Agents copy the short id as the list shows it, "(#ABC123)", or without the brackets or the hash: those are not part of it.
    const key = idOrShort.trim().replace(/^\(?#?/, '').replace(/\)$/, '')
    if (!key || key.length > 200) return undefined
    let r = this.one('SELECT * FROM messages WHERE number_id = ? AND chat = ? AND id = ?', numberId, chat, key)
    if (!r && key.length >= 6) {
      const like = likeEscape(key.toUpperCase())
      const found = this.all("SELECT * FROM messages WHERE number_id = ? AND chat = ? AND (UPPER(id) LIKE ? ESCAPE '\\' OR UPPER(id) LIKE ? ESCAPE '\\') LIMIT 2", numberId, chat, `${like}%`, `%${like}`)
      if (found.length === 1) r = found[0]
    }
    if (!r) return undefined
    const size = num(r['size'])
    return {
      ...this.messageOf(r),
      ...(r['first'] === 1 ? { first: true } : {}),
      ...(r['file'] ? { file: text(r['file']) } : {}),
      ...(r['mime'] ? { mime: text(r['mime']) } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(r['participant'] ? { participant: text(r['participant']) } : {})
    }
  }

  // An edit that arrived or was made: the words change and the message is marked as edited.
  setText(numberId: string, chat: string, id: string, newText: string, edited: boolean): boolean {
    return this.run('UPDATE messages SET text = ?, edited = ? WHERE number_id = ? AND chat = ? AND id = ?', newText, edited ? 1 : 0, numberId, chat, id) > 0
  }

  // The file of a message arrived after the message was stored. False when the message is gone or was taken
  // back meanwhile: the caller then deletes the file it just saved.
  setFile(numberId: string, chat: string, id: string, file: string, size: number): boolean {
    return this.run('UPDATE messages SET file = ?, size = ? WHERE number_id = ? AND chat = ? AND id = ? AND deleted = 0', file, size, numberId, chat, id) > 0
  }

  // A message taken back for everyone: it stays as a marker, but its words and file are gone (the sender
  // meant to retract them). Returns the file it had, for the service to delete.
  setDeleted(numberId: string, chat: string, id: string): { found: boolean; file?: string } {
    const r = this.one('SELECT file FROM messages WHERE number_id = ? AND chat = ? AND id = ?', numberId, chat, id)
    if (!r) return { found: false }
    this.run("UPDATE messages SET deleted = 1, text = '', file = NULL, file_name = NULL, quoted_text = NULL WHERE number_id = ? AND chat = ? AND id = ?", numberId, chat, id)
    // What was taken back does not survive elsewhere: a reply keeps its own words but not the words it quoted...
    this.run('UPDATE messages SET quoted_text = NULL WHERE number_id = ? AND chat = ? AND quoted_id = ?', numberId, chat, id)
    // ...and the reactions to it go with it (their ids are the reaction prefix, the id, then who and when).
    this.run('DELETE FROM messages WHERE number_id = ? AND chat = ? AND instr(id, ?) = 1', numberId, chat, `${REACTION_PREFIX}${id}:`)
    return { found: true, ...(r['file'] ? { file: text(r['file']) } : {}) }
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

  // Things an agent did that are not messages but still count against a number (a reaction, a group change).
  addEvent(numberId: string, kind: 'reaction' | 'group', at = Date.now()): void {
    this.run('INSERT INTO events (number_id, kind, at) VALUES (?, ?, ?)', numberId, kind, at)
  }

  private eventsToday(numberId: string, kind: string, since: number): number {
    return num(this.one('SELECT COUNT(*) AS n FROM events WHERE number_id = ? AND kind = ? AND at >= ?', numberId, kind, since)?.['n']) ?? 0
  }

  reactionsToday(numberId: string, since: number): number {
    return this.eventsToday(numberId, 'reaction', since)
  }

  groupActionsToday(numberId: string, since: number): number {
    return this.eventsToday(numberId, 'group', since)
  }

  // ---------- calls ----------

  private callOf(r: Row): CallRow {
    const list = <T>(v: unknown): T[] => {
      try {
        const x: unknown = JSON.parse(text(v as string | null))
        return Array.isArray(x) ? (x as T[]) : []
      } catch {
        return [] // an unreadable list is as good as none
      }
    }
    return {
      id: text(r['id']),
      numberId: text(r['number_id']),
      chat: text(r['chat']),
      agentId: text(r['agent_id']),
      ...(r['conversation_id'] ? { conversationId: text(r['conversation_id']) } : {}),
      direction: r['direction'] === 'out' ? 'out' : 'in',
      state: (['live', 'done', 'missed', 'failed'] as const).find((s) => s === r['state']) ?? 'failed',
      startedAt: num(r['started_at']) ?? 0,
      seconds: num(r['seconds']) ?? 0,
      ...(r['summary'] ? { summary: text(r['summary']) } : {}),
      agreed: list<string>(r['agreed']),
      turns: list<CallTurn>(r['turns']),
      ...(r['message_id'] ? { messageId: text(r['message_id']) } : {}),
      ...(r['note'] ? { note: text(r['note']) } : {})
    }
  }

  // Adds the call, or replaces the one with this id.
  putCall(c: CallRow): void {
    this.run(
      'INSERT OR REPLACE INTO calls (id, number_id, chat, agent_id, conversation_id, direction, state, started_at, seconds, summary, agreed, turns, message_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, c.numberId, c.chat, c.agentId, c.conversationId ?? null, c.direction, c.state, c.startedAt, Math.max(0, Math.round(c.seconds)), c.summary ?? null, JSON.stringify(c.agreed), JSON.stringify(c.turns), c.messageId ?? null, c.note ?? null
    )
  }

  updateCall(id: string, patch: Partial<Omit<CallRow, 'id' | 'numberId'>>): CallRow | undefined {
    const cur = this.call(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch }
    this.putCall(next)
    return next
  }

  call(id: string): CallRow | undefined {
    const r = this.one('SELECT * FROM calls WHERE id = ?', id)
    return r ? this.callOf(r) : undefined
  }

  callByConversation(conversationId: string): CallRow | undefined {
    const r = this.one('SELECT * FROM calls WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1', conversationId)
    return r ? this.callOf(r) : undefined
  }

  // Calls still on (all numbers, or one); `since` leaves out the ones so old they never got closed.
  liveCalls(numberId?: string, since = 0): CallRow[] {
    return this.all(`SELECT * FROM calls WHERE state = 'live' AND started_at >= ?${numberId ? ' AND number_id = ?' : ''}`, since, ...(numberId ? [numberId] : [])).map((r) => this.callOf(r))
  }

  // Whole minutes talked today (each second counts; a call still on has none yet).
  minutesToday(numberId: string, since: number): number {
    return Math.ceil((num(this.one('SELECT COALESCE(SUM(seconds), 0) AS s FROM calls WHERE number_id = ? AND started_at >= ?', numberId, since)?.['s']) ?? 0) / 60)
  }

  outboundToday(numberId: string, since: number): number {
    return num(this.one("SELECT COUNT(*) AS n FROM calls WHERE number_id = ? AND direction = 'out' AND started_at >= ?", numberId, since)?.['n']) ?? 0
  }

  voice(agentId: string): VoiceChoice | undefined {
    const r = this.one('SELECT * FROM voices WHERE agent_id = ?', agentId)
    return r && r['provider'] === 'elevenlabs' ? { provider: 'elevenlabs', voiceId: text(r['voice_id']), name: text(r['name']) } : undefined
  }

  setVoice(agentId: string, v: VoiceChoice | null): void {
    if (v) this.run('INSERT OR REPLACE INTO voices (agent_id, provider, voice_id, name) VALUES (?, ?, ?, ?)', agentId, v.provider, v.voiceId, v.name)
    else this.run('DELETE FROM voices WHERE agent_id = ?', agentId)
  }

  // Until when this person has allowed calls from this number (ms); undefined when never or already over.
  callPermission(numberId: string, chat: string, now = Date.now()): number | undefined {
    const until = num(this.one('SELECT until FROM call_permissions WHERE number_id = ? AND chat = ?', numberId, chat)?.['until'])
    return until !== undefined && until > now ? until : undefined
  }

  setCallPermission(numberId: string, chat: string, until: number | null): void {
    if (until === null) this.run('DELETE FROM call_permissions WHERE number_id = ? AND chat = ?', numberId, chat)
    else this.run('INSERT OR REPLACE INTO call_permissions (number_id, chat, until) VALUES (?, ?, ?)', numberId, chat, until)
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
