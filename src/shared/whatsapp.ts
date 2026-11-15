// WhatsApp for agents: numbers the team owns, and which agent may read or answer which
// conversation. What is shared by the core, the window and the tests lives here: the shapes
// and the rules that decide a send (who may, how many a day, whether it asks first).

import { clampCallSettings, type CallSettings } from './calls'

// 'qr': a WhatsApp already on a phone, linked as one more device (contacts and groups).
// 'cloud': Meta's official Cloud API (contacts only; needs a server Meta can reach).
export type WhatsAppKind = 'qr' | 'cloud'

// 'pairing': waiting for the phone to scan the code (or type the pairing code).
export type WhatsAppStatus = 'disconnected' | 'connecting' | 'pairing' | 'connected'

export type WhatsAppLevel = 'read' | 'reply'
export type WhatsAppSendMode = 'ask' | 'auto'

// Every conversation of a number, for an agent that answers whoever writes.
export const ALL_CHATS = '*'

export interface WhatsAppAccess {
  agentId: string
  chat: string // a conversation's id, or ALL_CHATS
  level: WhatsAppLevel
  send: WhatsAppSendMode // only read when level is 'reply'
}

export interface WhatsAppSettings {
  inbound: 'store' | 'wake' // a new message is kept, or also wakes the agents that answer there
  groupsOnlyMention: boolean // in a group, wake only when the number is mentioned or answered
  pauseOnHumanMin: number // someone answered from the phone: agents stay quiet this long (0: never)
  dailyLimit: number // messages agents send from this number in a day
  newChatsLimit: number // of those, conversations with someone who never wrote to this number
  markRead: boolean // what an agent reads is marked as read on WhatsApp (the other side sees it)
  groupManagers: string[] // agents that may create groups and add or remove people (qr only; each time asks first)
  calls?: CallSettings // how the number takes calls (src/shared/calls.ts): the official API only
}

export interface WhatsAppChat {
  id: string
  name: string
  kind: 'contact' | 'group'
  size?: number // a group's people
  phone?: string // a contact's number, when known: digits only
  lastAt?: number // the last message seen there
  inboundAt?: number // the last message they wrote: none means they never did
  pausedUntil?: number // agents are quiet here until then (someone answered from the phone)
}

export interface WhatsAppMessage {
  id: string
  chat: string
  fromMe: boolean
  sender?: string // in a group, who wrote
  text: string
  at: number
  agentId?: string // sent by this agent
  media?: WhatsAppMediaKind // it carries a file: `text` is its label and caption (or, for audio, what was said)
  fileName?: string
  quoted?: { id: string; text: string; sender?: string } // the message this one answers
  edited?: boolean
  deleted?: boolean
}

export type WhatsAppMediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker'

export interface WhatsAppNumber {
  id: string
  name: string
  description: string // what the number is for: agents read it to pick one
  kind: WhatsAppKind
  phone?: string // digits only, once known
  status: WhatsAppStatus
  error?: string // why it isn't connected, in words
  qr?: string // 'pairing': the text of the code to draw
  pairingCode?: string // 'pairing' by phone number: the 8 characters to type on the phone
  settings: WhatsAppSettings
  access: WhatsAppAccess[]
  chats: WhatsAppChat[] // only the ones in `access`, for their names
  sentToday: number
  newToday: number
  createdAt: number
}

export interface WhatsAppState {
  numbers: WhatsAppNumber[]
  // Meta's API needs an address Meta can call: a server on https. `why` says what's missing.
  cloud: { available: boolean; why?: string; webhookUrl?: string; verifyToken?: string }
}

export interface WhatsAppCloudInput {
  phoneId: string // "Phone number ID" of the number in Meta's panel
  wabaId: string // "WhatsApp Business Account ID": where its templates live
  token: string
  appSecret: string // signs what Meta sends to the webhook
}

export interface WhatsAppNumberInput {
  name: string
  description: string
  kind: WhatsAppKind
  cloud?: WhatsAppCloudInput
}

export interface WhatsAppTemplate {
  name: string
  language: string
  body: string // its text, with {{1}} where a variable goes
  variables: number
}

// ---------- limits ----------

// An unofficial link isn't made for bulk sending: WhatsApp blocks numbers that behave like a
// sender. The ceilings below can't be raised from the screen. The official API is the one for
// volume, inside what Meta allows (templates, opt-in, its own tiers).
export const LIMITS: Record<WhatsAppKind, { daily: number; dailyMax: number; newChats: number; newChatsMax: number }> = {
  qr: { daily: 60, dailyMax: 300, newChats: 10, newChatsMax: 30 },
  cloud: { daily: 250, dailyMax: 100_000, newChats: 250, newChatsMax: 100_000 }
}

export const MAX_TEXT = 4096 // WhatsApp's own limit for one message
export const NAME_MAX = 60
export const DESCRIPTION_MAX = 300
export const SERVICE_WINDOW_MS = 24 * 3_600_000 // the official API: free text only this long after they wrote
export const PAUSE_MAX_MIN = 24 * 60
export const MEDIA_IN_MAX = 25 * 1024 * 1024 // a file that arrives: bigger ones are noted, not kept
export const MEDIA_OUT_MAX = 16 * 1024 * 1024 // a file an agent sends
export const GROUP_ACTIONS_PER_DAY = 5 // groups created or changed in a day, per number: never raised from the screen
export const GROUP_PEOPLE_PER_ACTION = 20
export const REACTIONS_PER_DAY = 200 // a reaction isn't a message, but a number that reacts all day looks like a bot
export const POLL_OPTIONS_MAX = 12
export const EDIT_WINDOW_MS = 15 * 60_000 // WhatsApp lets a message be edited this long after it was sent
export const ACCESS_MAX = 2_000 // rows of who-may-use-what one number keeps
export const CHAT_ID_MAX = 200

// Between two sends of an unofficial number: a person's pace, never a burst.
export const SEND_GAP_MS: [number, number] = [4_000, 9_000]

const int = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

export function defaultSettings(kind: WhatsAppKind): WhatsAppSettings {
  return { inbound: 'wake', groupsOnlyMention: true, pauseOnHumanMin: 30, dailyLimit: LIMITS[kind].daily, newChatsLimit: LIMITS[kind].newChats, markRead: false, groupManagers: [] }
}

// What the screen (or an old row) asks for, brought inside what's allowed: never an error.
export function clampSettings(kind: WhatsAppKind, s: Partial<WhatsAppSettings> | undefined): WhatsAppSettings {
  const d = defaultSettings(kind)
  const dailyLimit = int(s?.dailyLimit, d.dailyLimit, 1, LIMITS[kind].dailyMax)
  return {
    inbound: s?.inbound === 'store' ? 'store' : 'wake',
    groupsOnlyMention: s?.groupsOnlyMention !== false,
    pauseOnHumanMin: int(s?.pauseOnHumanMin, d.pauseOnHumanMin, 0, PAUSE_MAX_MIN),
    dailyLimit,
    newChatsLimit: Math.min(dailyLimit, int(s?.newChatsLimit, d.newChatsLimit, 0, LIMITS[kind].newChatsMax)),
    markRead: s?.markRead === true,
    // Groups only exist on a number linked by QR code.
    groupManagers: kind === 'qr' && Array.isArray(s?.groupManagers) ? [...new Set(s.groupManagers.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100))].slice(0, 100) : [],
    // Calls only exist on a number of the official API.
    ...(kind === 'cloud' && s?.calls && typeof s.calls === 'object' ? { calls: clampCallSettings(s.calls) } : {})
  }
}

// ---------- access ----------

// What an agent may do in a conversation: its own row there, else the number's "every conversation" row.
export function accessFor(access: readonly WhatsAppAccess[], agentId: string, chat: string): WhatsAppAccess | undefined {
  const mine = access.filter((a) => a.agentId === agentId)
  return mine.find((a) => a.chat === chat) ?? mine.find((a) => a.chat === ALL_CHATS)
}

// Rows as the screen sends them, made safe to keep: one per agent and conversation, known values only.
export function cleanAccess(rows: readonly WhatsAppAccess[], agentIds: ReadonlySet<string>): WhatsAppAccess[] {
  const seen = new Set<string>()
  const out: WhatsAppAccess[] = []
  for (const r of rows) {
    if (out.length >= ACCESS_MAX) break
    if (!r || typeof r.agentId !== 'string' || typeof r.chat !== 'string' || !r.chat || r.chat.length > CHAT_ID_MAX || !agentIds.has(r.agentId)) continue
    const key = `${r.agentId}\n${r.chat}`
    if (seen.has(key)) continue
    seen.add(key)
    const level: WhatsAppLevel = r.level === 'reply' ? 'reply' : 'read'
    out.push({ agentId: r.agentId, chat: r.chat, level, send: level === 'reply' && r.send === 'auto' ? 'auto' : 'ask' })
  }
  return out
}

// ---------- a send, judged ----------

export type SendRefusal = 'no_access' | 'read_only' | 'daily_limit' | 'new_chats_limit' | 'needs_template' | 'too_long' | 'empty' | 'paused'

export interface SendQuestion {
  kind: WhatsAppKind
  settings: WhatsAppSettings
  access: WhatsAppAccess | undefined // accessFor(...)
  sentToday: number
  newToday: number
  text: string
  template: boolean // goes as one of Meta's approved templates
  chat: { inboundAt?: number; pausedUntil?: number; contactedToday: boolean } // contactedToday: an agent already wrote there today
  now: number
}

export type SendVerdict = { ok: false; why: SendRefusal } | { ok: true; ask: boolean; firstContact: boolean }

// Whether a message may go, and whether it waits for a person first. The order is what an
// agent should hear first: what it can't do at all, then what's full, then what needs a yes.
export function judgeSend(q: SendQuestion): SendVerdict {
  if (!q.access) return { ok: false, why: 'no_access' }
  if (q.access.level !== 'reply') return { ok: false, why: 'read_only' }
  if (!q.template && !q.text.trim()) return { ok: false, why: 'empty' }
  if (q.text.length > MAX_TEXT) return { ok: false, why: 'too_long' }
  const firstContact = q.chat.inboundAt === undefined
  // Meta's rule: outside the day after their last message, only a template goes.
  if (q.kind === 'cloud' && !q.template && (firstContact || q.now - q.chat.inboundAt! > SERVICE_WINDOW_MS)) return { ok: false, why: 'needs_template' }
  if (q.sentToday >= q.settings.dailyLimit) return { ok: false, why: 'daily_limit' }
  if (firstContact && !q.chat.contactedToday && q.newToday >= q.settings.newChatsLimit) return { ok: false, why: 'new_chats_limit' }
  if (q.chat.pausedUntil !== undefined && q.chat.pausedUntil > q.now) return { ok: true, ask: true, firstContact }
  // Someone who never wrote to this number: a person looks at it first, whatever the conversation's rule.
  return { ok: true, ask: firstContact || q.access.send !== 'auto', firstContact }
}

// ---------- small helpers ----------

// "+55 (11) 90000-0142" → "5511900000142"; nothing usable → undefined.
export function phoneDigits(v: string): string | undefined {
  const d = v.replace(/\D/g, '')
  return d.length >= 8 && d.length <= 15 ? d : undefined
}

// The start of a day in this computer's time: what "today" counts from.
export function dayStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
