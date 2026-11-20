// Reads WhatsApp ids and messages without loading the library: only types come from Baileys here
// (the library itself is handed in where a function needs it). Nothing in this file opens a socket,
// so the rules of reading are kept apart from the connection.
import type * as Baileys from 'baileys'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import type { WhatsAppMediaKind } from '../../shared/whatsapp'
import { placeholder } from './cloud'
import type { ChatPatch, WhatsAppStore } from './store'

export const keep = (jid: string): boolean => /@(s\.whatsapp\.net|lid|g\.us)$/.test(jid)
export const isGroup = (jid: string): boolean => jid.endsWith('@g.us')
export const isLid = (jid: string): boolean => jid.endsWith('@lid')
export const isPn = (jid: string): boolean => jid.endsWith('@s.whatsapp.net')

// "5511900000000:12@s.whatsapp.net" → "5511900000000@s.whatsapp.net" (the device is not part of who).
export function norm(jid: string | null | undefined): string {
  if (!jid) return ''
  const at = jid.lastIndexOf('@')
  if (at < 1) return ''
  const user = (jid.slice(0, at).split(':')[0] ?? '').split('_')[0] ?? ''
  const server = jid.slice(at + 1)
  return user ? `${user}@${server === 'c.us' ? 's.whatsapp.net' : server}` : ''
}

// A contact's phone (digits), when the id is one; a hidden (LID) id has none.
export const jidPhone = (jid: string): string | undefined => (isPn(jid) ? norm(jid).split('@')[0] : undefined)

export const toMs = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : v && typeof (v as { toNumber?: unknown }).toNumber === 'function' ? (v as { toNumber(): number }).toNumber() : Number(v)
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined
}

export type Content = Baileys.proto.IMessage
const WRAPS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'] as const

// A message may come wrapped (disappearing chats, view once): the real content is inside.
export function unwrap(content: Content | null | undefined): Content | undefined {
  let m: Content | undefined = content ?? undefined
  for (let i = 0; i < 5 && m; i++) {
    const now: Content = m
    const inner = WRAPS.map((k) => (now as unknown as Record<string, { message?: Content | null } | null | undefined>)[k]?.message).find(Boolean)
    if (!inner) break
    m = inner
  }
  return m
}

// A poll as one line: "[poll] question — option / option". Newer versions of the poll message wrap it once more.
function pollText(content: Content | undefined): string | undefined {
  if (!content) return undefined
  const p = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3 ?? content.pollCreationMessageV5
  if (!p) return pollText(content.pollCreationMessageV4?.message ?? undefined)
  const options = (p.options ?? []).map((o) => o.optionName?.trim()).filter(Boolean)
  return `${placeholder('poll')} ${p.name?.trim() ?? ''}${options.length ? ` — ${options.join(' / ')}` : ''}`.trim()
}

// The words of a message, a short label for what has none, and nothing for what isn't a message (reactions, protocol).
export function describe(content: Content | undefined): string | undefined {
  if (!content) return undefined
  const withCaption = (label: string, caption: string | null | undefined): string => (caption?.trim() ? `${label} ${caption.trim()}` : label)
  if (content.conversation) return content.conversation
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text
  if (content.imageMessage) return withCaption(placeholder('image'), content.imageMessage.caption)
  if (content.videoMessage) return withCaption(placeholder('video'), content.videoMessage.caption)
  if (content.ptvMessage) return placeholder('video')
  if (content.audioMessage) return placeholder('audio')
  if (content.stickerMessage) return placeholder('sticker')
  if (content.documentMessage) return withCaption(placeholder('document'), content.documentMessage.caption ?? content.documentMessage.fileName)
  if (content.locationMessage || content.liveLocationMessage) return placeholder('location')
  if (content.contactMessage || content.contactsArrayMessage) return placeholder('contact')
  return pollText(content)
}

// ---------- files, quotes and the messages that are not messages ----------

export interface MediaInfo {
  kind: WhatsAppMediaKind
  mime: string
  fileName?: string
  size?: number // what the sender declared, in bytes: checked against the limit before anything is downloaded
  caption?: string
}

type Media = { mimetype?: string | null; fileLength?: number | { toNumber(): number } | null; caption?: string | null; fileName?: string | null }

// A name from the other side is only ever a label: never a path, never long.
export const cleanName = (name: string | null | undefined): string | undefined => {
  const base = (name ?? '').split(/[\\/]/).pop()?.replace(/\p{Cc}/gu, '').trim().slice(0, 120)
  return base || undefined
}

// The file a message carries (content already unwrapped): what it is, not its bytes.
export function mediaOf(content: Content | undefined): MediaInfo | undefined {
  if (!content) return undefined
  const make = (kind: WhatsAppMediaKind, m: Media | null | undefined, mime: string): MediaInfo | undefined => {
    if (!m) return undefined
    const raw = m.fileLength
    const size = typeof raw === 'number' ? raw : raw ? raw.toNumber() : undefined
    const name = cleanName(m.fileName)
    const caption = m.caption?.trim()
    return { kind, mime: m.mimetype || mime, ...(name ? { fileName: name } : {}), ...(size !== undefined && Number.isFinite(size) && size >= 0 ? { size } : {}), ...(caption ? { caption } : {}) }
  }
  return (
    make('image', content.imageMessage, 'image/jpeg') ??
    make('video', content.videoMessage ?? content.ptvMessage, 'video/mp4') ??
    make('audio', content.audioMessage, 'audio/ogg') ??
    make('sticker', content.stickerMessage, 'image/webp') ??
    make('document', content.documentMessage, 'application/octet-stream')
  )
}

// The message this one answers: its id, what it said (in a few words) and who wrote it, when that is a phone.
export function quotedOf(content: Content | undefined): { id: string; text: string; sender?: string } | undefined {
  if (!content) return undefined
  const ctx = contextOf(content)
  if (!ctx?.stanzaId) return undefined
  const text = (describe(unwrap(ctx.quotedMessage)) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const sender = ctx.participant ? jidPhone(norm(ctx.participant)) : undefined
  return { id: ctx.stanzaId, text, ...(sender ? { sender } : {}) }
}

export type Special = { kind: 'reaction'; target: string; emoji: string } | { kind: 'edit'; target: string; text: string } | { kind: 'delete'; target: string } | { kind: 'poll'; text: string }

// WAProto's ProtocolMessage.Type: REVOKE = 0, MESSAGE_EDIT = 14 (numbers here so this file never loads the library).
const REVOKE = 0
const MESSAGE_EDIT = 14

// What a content is when it is not a plain message: a reaction, an edit, a delete or a poll being created.
export function special(content: Content | undefined): Special | undefined {
  if (!content) return undefined
  const r = content.reactionMessage
  if (r?.key?.id) return { kind: 'reaction', target: r.key.id, emoji: r.text ?? '' }
  const p = content.protocolMessage
  if (p?.key?.id && p.type !== null && p.type !== undefined) {
    if (Number(p.type) === REVOKE) return { kind: 'delete', target: p.key.id }
    if (Number(p.type) === MESSAGE_EDIT) {
      const text = describe(unwrap(p.editedMessage))
      if (text) return { kind: 'edit', target: p.key.id, text }
    }
  }
  const poll = pollText(content)
  return poll ? { kind: 'poll', text: poll } : undefined
}

export const contextOf = (content: Content): Baileys.proto.IContextInfo | undefined => Object.values(content).map((v) => (v as { contextInfo?: Baileys.proto.IContextInfo | null } | null)?.contextInfo).find(Boolean) ?? undefined

// The link's keys, read from and written to the sealed store (`write` goes through the driver, which orders the writes).
export function sealedKeys(B: typeof Baileys, store: WhatsAppStore, numberId: string, write: (entries: [string, string | undefined][]) => Promise<void>): Baileys.SignalKeyStore {
  return {
    get: async <T extends keyof Baileys.SignalDataTypeMap>(type: T, ids: string[]) => {
      const out: { [id: string]: Baileys.SignalDataTypeMap[T] } = {}
      await Promise.all(
        ids.map(async (id) => {
          const raw = await store.authGet(numberId, `${type}:${id}`)
          if (raw === undefined) return
          const value = JSON.parse(raw, B.BufferJSON.reviver) as object
          out[id] = (type === 'app-state-sync-key' ? B.proto.Message.AppStateSyncKeyData.fromObject(value) : value) as unknown as Baileys.SignalDataTypeMap[T]
        })
      )
      return out
    },
    set: async (data) => {
      const entries: [string, string | undefined][] = []
      for (const [type, byId] of Object.entries(data)) for (const [id, v] of Object.entries(byId ?? {})) entries.push([`${type}:${id}`, v ? JSON.stringify(v, B.BufferJSON.replacer) : undefined])
      await write(entries)
    }
  }
}

// ---------- the directory: conversations, contacts and groups as the store wants them ----------

interface Ids {
  canon(jid: string, alt?: string | null): string // the id a conversation is kept under
  learn(lid: string | null | undefined, pn: string | null | undefined): void // a hidden id and the phone id it stands for
}

export function chatPatchOf(c: Baileys.ChatUpdate, ids: Ids): ChatPatch | undefined {
  const raw = c.id
  if (!raw || !keep(raw)) return undefined
  ids.learn(c.lidJid ?? (isLid(raw) ? raw : undefined), c.pnJid ?? undefined)
  const id = ids.canon(raw, c.pnJid)
  const group = isGroup(id)
  const name = c.name ?? c.displayName ?? undefined
  const lastAt = toMs(c.conversationTimestamp)
  return { id, kind: group ? 'group' : 'contact', ...(name ? { name } : {}), ...(!group && jidPhone(id) ? { phone: jidPhone(id) } : {}), ...(lastAt ? { lastAt } : {}) }
}

export function contactPatchOf(c: Partial<Baileys.Contact>, ids: Ids): ChatPatch | undefined {
  if (!c.id || !keep(c.id) || isGroup(c.id)) return undefined
  const pn = c.phoneNumber ?? (isPn(c.id) ? c.id : undefined)
  ids.learn(c.lid ?? (isLid(c.id) ? c.id : undefined), pn)
  const id = ids.canon(c.id, pn)
  // The name saved on the phone wins; the one the person chose for themselves only fills a gap.
  const name = c.name ?? c.verifiedName
  return { id, kind: 'contact', ...(name ? { name } : {}), ...(c.notify ? { softName: c.notify } : {}), ...(jidPhone(id) ? { phone: jidPhone(id) } : {}) }
}

export function groupPatchOf(g: Partial<Baileys.GroupMetadata>): ChatPatch | undefined {
  if (!g.id || !isGroup(g.id)) return undefined
  const size = g.size ?? g.participants?.length
  return { id: norm(g.id), kind: 'group', ...(g.subject ? { name: g.subject } : {}), ...(size ? { size } : {}) }
}

// WhatsApp itself ended the link (401 signed out, 411 invalid) or refused it (440 opened elsewhere, 403): said in words,
// and whether the saved keys are no use any more. Other codes are often a server hiccup: the link stays.
export function endOfLink(code: number | undefined): { error: string; wipe: boolean } | undefined {
  if (code === 401) return { wipe: true, error: L('O WhatsApp saiu deste número (foi desconectado pelo celular). Conecte de novo para ler o código.', 'WhatsApp signed out of this number (it was unlinked from the phone). Connect again to read the code.') }
  if (code === 411) return { wipe: true, error: L('A ligação com o WhatsApp ficou inválida. Conecte de novo para refazer.', 'The link with WhatsApp became invalid. Connect again to redo it.') }
  if (code === 440) return { wipe: false, error: L('Este número foi aberto em outro lugar e o WhatsApp encerrou esta conexão. Conecte de novo quando quiser.', 'This number was opened somewhere else and WhatsApp ended this connection. Connect again when you want.') }
  if (code === 403) return { wipe: false, error: L('O WhatsApp recusou a conexão deste número. Veja no celular se ele está com algum aviso.', "WhatsApp refused this number's connection. Check the phone for a warning.") }
  return undefined
}

// ---------- what the driver and its actions share ----------

export const noop = (): void => {}
type Logger = NonNullable<Parameters<typeof Baileys.makeCacheableSignalKeyStore>[1]>
export const logger: Logger = {
  level: 'silent',
  child: () => logger,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  // Only the library's sentence: the object it came with can hold keys.
  error: (_obj, msg) => {
    if (typeof msg === 'string') console.error('[whatsapp]', msg)
  }
}

export const log = (e: unknown): void => console.error('[whatsapp]', e instanceof Error ? e.message : e)

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout?.() ?? new UserError(L('O WhatsApp demorou demais para responder. Tente de novo.', 'WhatsApp took too long to answer. Try again.'))), ms)
    t.unref()
    p.then(resolve, reject).finally(() => clearTimeout(t))
  })
}

// The message was handed to WhatsApp but no confirmation came back in time: it may have been delivered.
export class Unconfirmed extends UserError {
  constructor(readonly id: string) {
    super(L('O WhatsApp não confirmou o envio a tempo. A mensagem pode ter sido entregue: não envie de novo sem conferir a conversa.', 'WhatsApp did not confirm the send in time. The message may have been delivered: do not send it again without checking the conversation.'))
  }
}

export const statusOf = (e: unknown): number | undefined => (e as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
