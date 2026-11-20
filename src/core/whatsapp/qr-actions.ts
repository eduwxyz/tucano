// What a number linked by QR code can do besides sending text and reading: react, mark as read, edit,
// delete, ask the phone for earlier messages, and manage groups. Each one is a function on top of
// `driver.use`, which runs after the sends already waiting and gives a sentence (UserError) for
// whatever goes wrong. Nothing here keeps state. Only the QR link has these: the official API has no
// groups, polls, edits or history.
import type * as Baileys from 'baileys'
import type { Transform } from 'node:stream'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { MAX_TEXT, MEDIA_IN_MAX, MEDIA_OUT_MAX, POLL_OPTIONS_MAX } from '../../shared/whatsapp'
import type { QrDriver } from './qr'
import type { ChatAnchor } from './store'
import { isGroup, jidPhone, keep, logger, norm, statusOf, withTimeout } from './wire'

const DOWNLOAD_TIMEOUT_MS = 60_000

// ---------- what goes out ----------

// One thing to send: text, or a file (its text is the caption), or a poll. `quoted` answers a message;
// `mentions` are ids (phone@s.whatsapp.net) of people named with @phone in the text (text, captions and polls only).
export interface Outgoing {
  text?: string
  quoted?: { id: string; fromMe: boolean; participant?: string; text: string }
  mentions?: string[]
  file?: { data: Buffer; mime: string; name: string; kind: 'image' | 'audio' | 'document' | 'video' }
  poll?: { name: string; values: string[]; selectableCount: number }
}

// The library's message for it, and the message to quote. Refuses what WhatsApp would: nothing to send, a file that is too big.
export function messageOf(out: Outgoing, chat: string): { content: Baileys.AnyMessageContent; quoted?: Baileys.WAMessage } {
  const mentions = out.mentions?.length ? { mentions: out.mentions.slice(0, 50) } : {}
  const text = out.text ?? ''
  let content: Baileys.AnyMessageContent
  if (out.poll) {
    const values = out.poll.values.map((v) => v.trim()).filter(Boolean)
    if (!out.poll.name.trim() || values.length < 2 || values.length > POLL_OPTIONS_MAX) throw new UserError(L(`Uma enquete precisa de uma pergunta e de 2 a ${POLL_OPTIONS_MAX} opções.`, `A poll needs a question and 2 to ${POLL_OPTIONS_MAX} options.`))
    content = { poll: { name: out.poll.name.trim(), values, selectableCount: Math.min(values.length, Math.max(1, Math.round(out.poll.selectableCount) || 1)) }, ...mentions }
  } else if (out.file) {
    const { data, mime, name, kind } = out.file
    if (data.length === 0) throw new UserError(L('Esse arquivo está vazio.', 'That file is empty.'))
    if (data.length > MEDIA_OUT_MAX) throw new UserError(L(`O arquivo passa de ${Math.round(MEDIA_OUT_MAX / 1048576)} MB, o máximo para enviar.`, `The file is over ${Math.round(MEDIA_OUT_MAX / 1048576)} MB, the most that can be sent.`))
    const caption = text.trim() ? { caption: text } : {}
    if (kind === 'image') content = { image: data, mimetype: mime, ...caption, ...mentions }
    else if (kind === 'video') content = { video: data, mimetype: mime, ...caption, ...mentions }
    // An ogg/opus audio is what a voice note is made of: it goes as one, with the little play bar.
    else if (kind === 'audio') content = /ogg|opus/i.test(mime) ? { audio: data, ptt: true, mimetype: 'audio/ogg; codecs=opus' } : { audio: data, mimetype: mime }
    else content = { document: data, mimetype: mime, fileName: name, ...caption }
  } else {
    if (!text.trim()) throw new UserError(L('Não há nada para enviar.', 'There is nothing to send.'))
    if (text.length > MAX_TEXT) throw new UserError(L('A mensagem é grande demais para o WhatsApp.', 'The message is too long for WhatsApp.'))
    content = { text, ...mentions }
  }
  // The library quotes from a whole message; only the key and a line of text are needed (and the text can't be empty).
  const quoted: Baileys.WAMessage | undefined = out.quoted
    ? { key: { remoteJid: chat, id: out.quoted.id, fromMe: out.quoted.fromMe, ...(out.quoted.participant && !out.quoted.fromMe ? { participant: out.quoted.participant } : {}) }, message: { conversation: out.quoted.text || '…' } }
    : undefined
  return { content, ...(quoted ? { quoted } : {}) }
}

// ---------- what comes in ----------

// The bytes of a file that arrived. The limit is checked before the download when the size is known, and while
// reading when it is not, so a file that lies about its size can't fill the memory. Never hangs (60 s).
export async function downloadFile(B: typeof Baileys, sock: Baileys.WASocket, msg: Baileys.WAMessage, size: number | undefined): Promise<Buffer> {
  const tooBig = new UserError(L(`O arquivo passa de ${Math.round(MEDIA_IN_MAX / 1048576)} MB e não foi guardado.`, `The file is over ${Math.round(MEDIA_IN_MAX / 1048576)} MB and was not kept.`))
  if (size !== undefined && size > MEDIA_IN_MAX) throw tooBig
  let stream: Transform | undefined
  let finished = false // the read is over, or the time limit gave up: a stream that comes later is destroyed
  let failed = false
  const timer = setTimeout(() => stream?.destroy(), DOWNLOAD_TIMEOUT_MS)
  timer.unref()
  try {
    const got = B.downloadMediaMessage(msg, 'stream', {}, { logger, reuploadRequest: sock.updateMediaMessage })
    // Every stream gets an 'error' listener as soon as it is here, so a late network error cannot become an unhandled
    // 'error' event; a stream that fails is one that failed, whatever the read got before it.
    got.then(
      (s) => {
        s.on('error', () => {
          failed = true
        })
        if (finished) s.destroy()
      },
      () => {}
    )
    stream = await withTimeout(got, DOWNLOAD_TIMEOUT_MS)
    const parts: Buffer[] = []
    let total = 0
    for await (const chunk of stream) {
      const part = chunk as Buffer
      total += part.length
      if (total > MEDIA_IN_MAX) throw tooBig
      parts.push(part)
    }
    if (failed) throw new Error('download stream failed')
    return Buffer.concat(parts)
  } catch (e) {
    if (e instanceof UserError) throw e
    // The library's own message can carry the signed address of the file: only a fixed sentence and the status are logged.
    const code = statusOf(e)
    console.error(`[whatsapp] a file could not be downloaded${code !== undefined ? ` (status ${code})` : ''}`)
    throw new UserError(L('Não consegui baixar esse arquivo do WhatsApp. Ele pode ter expirado no celular de quem enviou.', "I couldn't download that file from WhatsApp. It may have expired on the sender's phone."))
  } finally {
    finished = true
    clearTimeout(timer)
    stream?.destroy()
  }
}

// ---------- helpers ----------

export interface MsgKey {
  id: string
  fromMe: boolean
  participant?: string // in a group, who wrote it (needed when it isn't ours)
}

const waKey = (chat: string, k: MsgKey): Baileys.WAMessageKey => ({ remoteJid: chat, id: k.id, fromMe: k.fromMe, ...(k.participant && !k.fromMe ? { participant: k.participant } : {}) })

const notAdmin = (): UserError => new UserError(L('Este número não é administrador desse grupo, então o WhatsApp não deixa fazer isso.', "This number isn't an admin of that group, so WhatsApp doesn't allow that."))
const noGroup = (): UserError => new UserError(L('Não achei esse grupo. Ele pode ter sido apagado, ou este número saiu dele.', "I couldn't find that group. It may have been deleted, or this number left it."))

// The library reports a refusal as an HTTP-like status: the two that have a clear meaning get a sentence.
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const code = statusOf(e)
    if (code === 403) throw notAdmin()
    if (code === 404 || code === 410) throw noGroup()
    throw e
  }
}

function groupJid(group: string): string {
  if (!isGroup(group)) throw new UserError(L('Isso não é um grupo do WhatsApp.', "That isn't a WhatsApp group."))
  return group
}

function peopleJids(jids: readonly string[]): string[] {
  const clean = [...new Set(jids.map((j) => norm(j)).filter((j) => keep(j) && !isGroup(j)))]
  if (clean.length === 0) throw new UserError(L('Faltou dizer quem. Informe os telefones das pessoas.', "Say who: give the people's phone numbers."))
  return clean
}

// Its own id: sent through the driver's list of ours, so the copy WhatsApp echoes back is not taken for someone typing on the phone.
const ownId = (driver: QrDriver, sock: Baileys.WASocket, B: typeof Baileys): string => {
  const id = B.generateMessageIDV2(sock.user?.id)
  driver.markSent(id)
  return id
}

// ---------- messages ----------

// An empty emoji takes the reaction back.
export async function react(driver: QrDriver, chat: string, key: MsgKey, emoji: string): Promise<void> {
  await driver.use(async (sock, B) => {
    await sock.sendMessage(chat, { react: { text: emoji, key: waKey(chat, key) } }, { messageId: ownId(driver, sock, B) })
  })
}

// The blue ticks. Only what other people wrote can be marked.
export async function markRead(driver: QrDriver, keys: readonly (MsgKey & { chat: string })[]): Promise<void> {
  const theirs = keys.filter((k) => !k.fromMe && k.id && k.chat).slice(0, 200)
  if (theirs.length === 0) return
  await driver.use(async (sock) => {
    await sock.readMessages(theirs.map((k) => waKey(k.chat, k)))
  })
}

// Only a message this number sent can be edited or taken back.
const ours = (key: MsgKey): void => {
  if (!key.fromMe) throw new UserError(L('Só dá para corrigir ou apagar uma mensagem que este número enviou.', 'Only a message this number sent can be corrected or deleted.'))
}

export async function edit(driver: QrDriver, chat: string, key: MsgKey, text: string): Promise<void> {
  ours(key)
  if (!text.trim()) throw new UserError(L('O texto novo está vazio.', 'The new text is empty.'))
  if (text.length > MAX_TEXT) throw new UserError(L('A mensagem é grande demais para o WhatsApp.', 'The message is too long for WhatsApp.'))
  await driver.use(async (sock, B) => {
    await sock.sendMessage(chat, { text, edit: waKey(chat, key) }, { messageId: ownId(driver, sock, B) })
  })
}

// Deletes for everyone.
export async function remove(driver: QrDriver, chat: string, key: MsgKey): Promise<void> {
  ours(key)
  await driver.use(async (sock, B) => {
    await sock.sendMessage(chat, { delete: waKey(chat, key) }, { messageId: ownId(driver, sock, B) })
  })
}

// Asks the phone for messages older than the anchor; they come back later through the driver's `message` hook (not live).
// The phone decides how many it sends (at most 50).
export async function history(driver: QrDriver, anchor: ChatAnchor & { chat: string }, count = 50): Promise<void> {
  if (!keep(anchor.chat)) throw new UserError(L('Essa conversa não pode ser pedida ao celular.', "That conversation can't be asked for from the phone."))
  const n = Math.min(50, Math.max(1, Math.round(count) || 50))
  await driver.use(async (sock) => {
    await sock.fetchMessageHistory(n, waKey(anchor.chat, anchor), anchor.at)
  })
}

// ---------- groups ----------

export async function groupCreate(driver: QrDriver, name: string, jids: readonly string[]): Promise<{ id: string; name: string }> {
  const subject = name.trim().slice(0, 100)
  if (!subject) throw new UserError(L('O grupo precisa de um nome.', 'The group needs a name.'))
  const people = peopleJids(jids)
  return driver.use(async (sock) => {
    const g = await guard(() => sock.groupCreate(subject, people))
    return { id: norm(g.id), name: g.subject || subject }
  })
}

export interface GroupOutcome {
  jid: string
  ok: boolean
  reason?: string // in words, when it didn't work
}

// Whether this number is an admin of the group: false only when the group says so (when it can't tell, the server decides).
async function adminCheck(sock: Baileys.WASocket, group: string): Promise<void> {
  const meta = await guard(() => sock.groupMetadata(group))
  const me = [sock.user?.id, sock.user?.lid].map((j) => norm(j)).filter(Boolean)
  const mine = meta.participants.find((p) => [p.id, p.lid, p.phoneNumber].some((j) => me.includes(norm(j))))
  if (mine && !(mine.admin || mine.isAdmin || mine.isSuperAdmin)) throw notAdmin()
}

const reasonOf = (action: 'add' | 'remove', status: string): string => {
  if (status === '403') return L('A pessoa só entra por convite (configuração de privacidade dela). Mande o link do grupo.', 'That person only joins by invitation (their privacy setting). Send them the group link.')
  if (status === '408') return L('A pessoa saiu do grupo faz pouco tempo e ainda não dá para adicionar de novo.', 'That person left the group a short while ago and cannot be added again yet.')
  if (status === '409') return L('A pessoa já está no grupo.', 'That person is already in the group.')
  if (status === '404') return action === 'remove' ? L('A pessoa não está no grupo.', "That person isn't in the group.") : L('Esse número não está no WhatsApp.', "That number isn't on WhatsApp.")
  return L('O WhatsApp não aceitou.', "WhatsApp didn't accept it.")
}

async function change(driver: QrDriver, group: string, jids: readonly string[], action: 'add' | 'remove'): Promise<GroupOutcome[]> {
  const gid = groupJid(group)
  const people = peopleJids(jids)
  return driver.use(async (sock) => {
    await adminCheck(sock, gid)
    const res = await guard(() => sock.groupParticipantsUpdate(gid, people, action))
    if (res.length === 0) return people.map((jid) => ({ jid, ok: false, reason: L('O WhatsApp não respondeu sobre essa pessoa. Confira o grupo.', "WhatsApp didn't say what happened to that person. Check the group.") }))
    return res.map((r, i) => {
      const ok = r.status === '200'
      return { jid: r.jid ?? people[i] ?? '', ok, ...(ok ? {} : { reason: reasonOf(action, r.status) }) }
    })
  })
}

export const groupAdd = (driver: QrDriver, group: string, jids: readonly string[]): Promise<GroupOutcome[]> => change(driver, group, jids, 'add')
export const groupRemove = (driver: QrDriver, group: string, jids: readonly string[]): Promise<GroupOutcome[]> => change(driver, group, jids, 'remove')

// The link anyone can join by.
export async function groupInvite(driver: QrDriver, group: string): Promise<string> {
  const gid = groupJid(group)
  return driver.use(async (sock) => {
    const code = await guard(() => sock.groupInviteCode(gid))
    if (!code) throw new UserError(L('O WhatsApp não deu o link desse grupo. Só administradores conseguem.', "WhatsApp didn't give that group's link. Only admins can."))
    return `https://chat.whatsapp.com/${code}`
  })
}

// Who is in a group. `id` is what WhatsApp calls them (it may be a hidden id); `phone` is there when it is known.
export async function groupPeople(driver: QrDriver, group: string): Promise<{ id: string; name?: string; phone?: string; admin: boolean }[]> {
  const gid = groupJid(group)
  return driver.use(async (sock) => {
    const meta = await guard(() => sock.groupMetadata(gid))
    return meta.participants.map((p) => {
      const phone = jidPhone(norm(p.phoneNumber)) ?? jidPhone(norm(p.id))
      const name = p.name ?? p.notify
      return { id: norm(p.id) || p.id, ...(name ? { name } : {}), ...(phone ? { phone } : {}), admin: !!(p.admin || p.isAdmin || p.isSuperAdmin) }
    })
  })
}
