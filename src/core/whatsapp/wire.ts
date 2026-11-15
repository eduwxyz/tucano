// Reads WhatsApp ids and messages without loading the library: only types come from Baileys here.
// Nothing in this file opens a socket or touches the store, so the rules of reading are kept apart from the connection.
import type * as Baileys from 'baileys'
import { placeholder } from './cloud'

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
  return undefined
}

export const contextOf = (content: Content): Baileys.proto.IContextInfo | undefined => Object.values(content).map((v) => (v as { contextInfo?: Baileys.proto.IContextInfo | null } | null)?.contextInfo).find(Boolean) ?? undefined

export const statusOf = (e: unknown): number | undefined => (e as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
