// What agents do on WhatsApp besides reading and sending plain text: seeing the file of a message,
// reacting, fixing or deleting what they sent, asking for earlier messages, marking what they read as
// read, and getting one send ready (a reply, mentions, a file or a poll are checked here, before the
// judging and the approval). Groups are in groups.ts. Every refusal is a UserError with a sentence the
// agent can act on; the runner turns anything else into a generic one.
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { MAX_IMAGE_BYTES } from '../../shared/types'
import { MAX_WIKI_FILE } from '../../shared/rpc-shapes'
import { accessFor, dayStart, EDIT_WINDOW_MS, MAX_TEXT, MEDIA_OUT_MAX, phoneDigits, REACTIONS_PER_DAY, type WhatsAppAccess, type WhatsAppChat, type WhatsAppMessage } from '../../shared/whatsapp'
import { extractFile } from '../wiki-extract'
import type { Host, ToolOutcome } from './agent'
import * as cloud from './cloud'
import { kindOf, mimeOfFile } from './media'
import type { QrDriver } from './qr'
import { edit, groupPeople, history, markRead as qrMarkRead, react as qrReact, remove, type MsgKey, type Outgoing } from './qr-actions'
import type { NumberRow, StoredMessage } from './store'
import { fold, pick, REACTION_PREFIX, refusalText, str, type Poll, type Template } from './tools'

const DOCUMENT_CHARS = 40_000
const CAPTION_MAX = 1_024 // WhatsApp's own limit for a file's caption
// The edit window, a minute shorter: the time kept for a sent message is taken after the send, so ours would end a little after WhatsApp's.
const EDIT_LIMIT_MS = EDIT_WINDOW_MS - 60_000

// What the agent tools share: picking a number and the conversations an agent may use there.
export interface Shared {
  pickNumber(agentId: string, query: string): NumberRow
  usable(n: NumberRow, agentId: string): WhatsAppChat[]
}

export const notConnected = (): UserError => new UserError(L('Esse número não está conectado ao WhatsApp agora. Conecte-o e tente de novo.', "That number isn't connected to WhatsApp right now. Connect it and try again."))

// The link of a number made by QR code, connected; the official API has none of what needs it.
export function driverOf(h: Host, n: NumberRow): QrDriver {
  if (n.kind !== 'qr') throw new UserError(L('Isso só existe no número ligado por QR code, não na API oficial.', 'That only exists on a QR-code number, not on the official API.'))
  const r = h.rt(n.id)
  if (!r.driver || r.view.status !== 'connected') throw notConnected()
  return r.driver
}

function keysOf(h: Host, n: NumberRow): cloud.CloudCreds {
  const keys = h.keys.get(n.id)
  if (!keys || !h.cloudOk()) throw notConnected()
  return keys
}

export const keyOf = (m: StoredMessage): MsgKey => ({ id: m.id, fromMe: m.fromMe, ...(m.participant ? { participant: m.participant } : {}) })

const megabytes = (bytes: number): string => `${(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`

// What a file really is, read from its first bytes. The type the sender's phone gave can be wrong, and a model
// rejects a whole reply when its "image" is not one.
export function sniffImage(data: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  const at = (offset: number, bytes: readonly number[]): boolean => bytes.every((b, i) => data[offset + i] === b)
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return undefined
}

// What one send carries, as the agent asked for it (or as it was stored with an approval).
export interface Spec {
  text: string
  tpl?: Template
  replyId?: string
  mention: string[]
  file?: { id: string; name: string; path: string }
  poll?: Poll
}

// The same, checked and made ready: the message answered, who is tagged, the file read for size and type.
export interface Plan {
  text: string // as the agent wrote it
  sent: string // what goes out as the text (or caption): the text with the tags added
  judged: string // what the day's limits and the "is it empty" rule look at
  tpl?: Template
  reply?: StoredMessage
  mentions: { jid: string; phone: string; name?: string }[] // name: as the group has it, when known
  file?: { id: string; name: string; path: string; size: number; mime: string; kind: 'image' | 'audio' | 'document' | 'video' }
  poll?: Poll
}

export class Extras {
  constructor(
    private h: Host,
    private s: Shared
  ) {}

  private chatFor(n: NumberRow, agentId: string, query: string): WhatsAppChat {
    if (!query) throw new UserError(L('Diga qual conversa (conversa). Veja whatsapp_conversas.', 'Say which conversation (conversa). See whatsapp_conversas.'))
    return pick(this.s.usable(n, agentId), query, 'chat')
  }

  // The one way an agent's message id becomes a stored message: a reaction's row is never a message, whatever its id says.
  private stored(numberId: string, chatId: string, ref: string): StoredMessage | undefined {
    return ref && !ref.startsWith(REACTION_PREFIX) ? this.h.store().message(numberId, chatId, ref) : undefined
  }

  // A message of that conversation by the short id of whatsapp_ler (or the full one): none or several is told to read again.
  private message(n: NumberRow, chat: WhatsAppChat, ref: string): StoredMessage {
    const m = this.stored(n.id, chat.id, ref)
    if (!m) throw new UserError(L(`Não achei essa mensagem em "${chat.name}", ou o id combina com mais de uma. Leia a conversa de novo com whatsapp_ler e use o id curto que aparece em (#...).`, `I couldn't find that message in "${chat.name}", or the id matches more than one. Read the conversation again with whatsapp_ler and use the short id shown in (#...).`))
    return m
  }

  // Acting on a conversation (not only reading it) needs the "read and answer" level.
  private needReply(n: NumberRow, agentId: string, chat: WhatsAppChat): WhatsAppAccess {
    const access = accessFor(this.h.store().access(n.id), agentId, chat.id)
    if (access?.level !== 'reply') throw new UserError(refusalText(access ? 'read_only' : 'no_access', { chat: chat.name, number: n.name, daily: n.settings.dailyLimit, newChats: n.settings.newChatsLimit }))
    return access
  }

  private paused(n: NumberRow, chatId: string): boolean {
    const until = this.h.rt(n.id).paused.get(chatId)
    return !!until && until > Date.now()
  }

  // ---------- seeing a file ----------

  async media(agentId: string, args: Record<string, unknown>, label: string): Promise<ToolOutcome> {
    const n = this.s.pickNumber(agentId, str(args['numero']))
    const chat = this.chatFor(n, agentId, str(args['conversa']))
    const m = this.message(n, chat, str(args['mensagem']))
    const step = { label, detail: `${n.name} · ${chat.name}` }
    const done = (text: string, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({ text, outside: true, step, ...extra })
    if (m.deleted) return done(L('Essa mensagem foi apagada por quem a enviou.', 'That message was deleted by whoever sent it.'))
    if (!m.media) return done(L(`Essa mensagem não tem arquivo. O texto dela é: "${m.text}"`, `That message has no file. Its text is: "${m.text}"`))
    const kinds = { image: L('imagem', 'image'), audio: L('áudio', 'audio'), video: L('vídeo', 'video'), document: L('documento', 'document'), sticker: L('figurinha', 'sticker') }
    const name = m.fileName ?? (m.file ? m.file.split('/').pop() : undefined) ?? kinds[m.media]
    const about = `${kinds[m.media]} "${name}"${m.size !== undefined ? ` (${megabytes(m.size)})` : ''}`
    if (!m.file) {
      if (m.agentId) return done(L(`Essa ${kinds[m.media]} foi enviada por você mesmo: ela está entre os seus arquivos.`, `That ${kinds[m.media]} was sent by you: it is among your own files.`))
      return done(L(`O arquivo (${about}) não foi guardado: era grande demais, ou não deu para baixar do WhatsApp (ele pode ter expirado no celular de quem enviou).`, `The file (${about}) was not kept: it was too big, or it couldn't be downloaded from WhatsApp (it may have expired on the sender's phone).`))
    }
    const data = await this.h.media.read(m.file)
    if (m.media === 'image') {
      // The bytes say what the picture is: the type the sender's phone gave may be wrong.
      const type = sniffImage(data)
      if (!type || data.length > MAX_IMAGE_BYTES) return done(L(`Não consigo mostrar essa ${about} aqui: só png, jpg, gif e webp de até ${megabytes(MAX_IMAGE_BYTES)}.`, `I can't show that ${about} here: only png, jpg, gif and webp up to ${megabytes(MAX_IMAGE_BYTES)}.`))
      return done(L(`Imagem de ${m.sender ?? chat.name}: ${m.text}`, `Image from ${m.sender ?? chat.name}: ${m.text}`), { image: { data: data.toString('base64'), mimeType: type } })
    }
    if (m.media === 'document') {
      // extractFile reads up to MAX_WIKI_FILE: a bigger file is said to be too large, not that its kind can't be read.
      if (data.length > MAX_WIKI_FILE) return done(L(`O arquivo "${name}" (${megabytes(data.length)}) é grande demais para eu ler: o limite é ${megabytes(MAX_WIKI_FILE)}.`, `The file "${name}" (${megabytes(data.length)}) is too large for me to read: the limit is ${megabytes(MAX_WIKI_FILE)}.`))
      // The extension decides how it is read: the name the sender gave may have none.
      const named = m.fileName && extname(m.fileName) ? m.fileName : `${m.fileName ?? 'arquivo'}${extname(m.file)}`
      let text: string
      try {
        text = await extractFile(named, data)
      } catch {
        return done(L(`Não consegui ler esse tipo de arquivo (${about}). Dá para ler PDF, Word, planilha (.xlsx, .csv) e texto.`, `I couldn't read this kind of file (${about}). PDF, Word, spreadsheets (.xlsx, .csv) and text can be read.`))
      }
      const cut = text.length > DOCUMENT_CHARS
      return done(L(`Texto do ${about}${cut ? ` (só os primeiros ${DOCUMENT_CHARS} caracteres)` : ''}:\n\n${text.slice(0, DOCUMENT_CHARS)}`, `Text of the ${about}${cut ? ` (only the first ${DOCUMENT_CHARS} characters)` : ''}:\n\n${text.slice(0, DOCUMENT_CHARS)}`))
    }
    if (m.media === 'audio') {
      if (m.text.includes('"')) return done(m.text) // the words were written down when it arrived
      // An audio that came as history is transcribed only now, when someone wants it.
      const said = await this.h.speech(data)
      if (said) {
        try {
          const text = `${m.text} "${said}"`.slice(0, 8_000)
          this.h.store().setText(n.id, chat.id, m.id, text, false)
          return done(text)
        } catch (e) {
          this.h.fail(e)
          return done(`${m.text} "${said}"`)
        }
      }
      return done(L(`Não consegui transcrever esse ${about}. Para ler áudios, o Tucano precisa do ditado ativado (Configurações › Geral) e do ffmpeg instalado neste computador.`, `I couldn't transcribe this ${about}. To read audio, Tucano needs dictation turned on (Settings › General) and ffmpeg installed on this computer.`))
    }
    return done(L(`É ${about}, um tipo que não consigo abrir aqui.`, `It is ${about}, a kind I can't open here.`))
  }

  // ---------- reacting ----------

  async react(agentId: string, args: Record<string, unknown>, label: string): Promise<ToolOutcome> {
    const n = this.s.pickNumber(agentId, str(args['numero']))
    const chat = this.chatFor(n, agentId, str(args['conversa']))
    const step = { label, detail: `${n.name} · ${chat.name}` }
    this.needReply(n, agentId, chat)
    const emoji = typeof args['emoji'] === 'string' ? args['emoji'].trim() : ''
    if (args['emoji'] !== undefined && typeof args['emoji'] !== 'string') throw new UserError(L('O emoji precisa ser um texto, ex.: 👍. Para tirar a reação, deixe vazio.', 'The emoji must be text, e.g. 👍. To remove the reaction, leave it empty.'))
    if (emoji && (/[\p{L}\p{N}]/u.test(emoji) || [...emoji].length > 12)) throw new UserError(L('Use um único emoji, ex.: 👍. Para tirar a reação, deixe vazio.', 'Use a single emoji, e.g. 👍. To remove the reaction, leave it empty.'))
    const m = this.message(n, chat, str(args['mensagem']))
    if (m.deleted) throw new UserError(L('Essa mensagem foi apagada: não dá para reagir a ela.', 'That message was deleted: you cannot react to it.'))
    if (this.paused(n, chat.id)) throw new UserError(refusalText('paused', { chat: chat.name, number: n.name, daily: 0, newChats: 0 }))
    if (this.h.store().reactionsToday(n.id, dayStart(Date.now())) >= REACTIONS_PER_DAY) throw new UserError(L(`O número "${n.name}" já reagiu ${REACTIONS_PER_DAY} vezes hoje, que é o limite. Não tente de novo hoje.`, `The number "${n.name}" already reacted ${REACTIONS_PER_DAY} times today, which is the limit. Don't try again today.`))
    // Everything that can refuse is settled before the slot is taken, so a refusal does not use up one of the day's reactions.
    let act: () => Promise<unknown>
    if (n.kind === 'qr') {
      const driver = driverOf(this.h, n)
      act = () => qrReact(driver, chat.id, keyOf(m), emoji)
    } else {
      if (m.fromMe) throw new UserError(L('Na API oficial só dá para reagir ao que a pessoa escreveu.', 'On the official API you can only react to what the person wrote.'))
      const keys = keysOf(this.h, n)
      act = () => cloud.react(keys, chat.id, m.id, emoji)
    }
    // The slot is taken before the action starts, so reactions sent in parallel can't all pass the day's check.
    // A failure does not give it back: a reaction that timed out may have gone.
    try {
      this.h.store().addEvent(n.id, 'reaction')
    } catch (e) {
      this.h.fail(e) // the reaction still goes; only its count may be lost
    }
    await act()
    return { text: emoji ? L(`Reagi com ${emoji}.`, `Reacted with ${emoji}.`) : L('Tirei a reação.', 'Removed the reaction.'), step }
  }

  // ---------- fixing or deleting what the agent sent ----------

  private mine(m: StoredMessage, agentId: string): void {
    if (m.agentId !== agentId) throw new UserError(L('Só dá para corrigir ou apagar uma mensagem que você mesmo enviou por aqui.', 'You can only fix or delete a message you sent from here yourself.'))
    if (m.deleted) throw new UserError(L('Essa mensagem já foi apagada.', 'That message was already deleted.'))
  }

  // Only the words of a text message can be changed, shortly after it was sent.
  private editable(m: StoredMessage, text: string): void {
    if (m.media || m.text.startsWith(cloud.placeholder('poll'))) throw new UserError(L('Só dá para corrigir mensagens de texto. Para trocar um arquivo ou uma enquete, apague (sem texto) e envie de novo.', 'Only text messages can be fixed. To change a file or a poll, delete it (without texto) and send again.'))
    if (Date.now() - m.at > EDIT_LIMIT_MS) throw new UserError(L(`Já passou de ${EDIT_LIMIT_MS / 60_000} minutos desde o envio: o WhatsApp não deixa mais corrigir. Apague a mensagem (sem texto) ou envie uma nova.`, `It has been over ${EDIT_LIMIT_MS / 60_000} minutes since it was sent: WhatsApp no longer lets it be fixed. Delete the message (without texto) or send a new one.`))
    if (!text.trim()) throw new UserError(L('O texto novo está vazio. Para apagar a mensagem, deixe "texto" de fora.', 'The new text is empty. To delete the message, leave "texto" out.'))
    if (text.length > MAX_TEXT) throw new UserError(L(`O texto novo passa de ${MAX_TEXT} caracteres. Encurte.`, `The new text is over ${MAX_TEXT} characters. Shorten it.`))
    if (text.trim() === m.text.trim()) throw new UserError(L('O texto novo é igual ao que já está na mensagem.', 'The new text is the same as what the message already says.'))
  }

  async correct(agentId: string, args: Record<string, unknown>, label: string): Promise<ToolOutcome> {
    const n = this.s.pickNumber(agentId, str(args['numero']))
    driverOf(this.h, n) // the official API can't edit or delete: said before anything else
    const chat = this.chatFor(n, agentId, str(args['conversa']))
    const step = { label, detail: `${n.name} · ${chat.name}` }
    const access = this.needReply(n, agentId, chat)
    const m = this.message(n, chat, str(args['mensagem']))
    this.mine(m, agentId)
    const raw = args['texto']
    if (raw === undefined || raw === null) {
      await remove(driverOf(this.h, n), chat.id, keyOf(m))
      try {
        const gone = this.h.store().setDeleted(n.id, chat.id, m.id)
        if (gone.file) void this.h.media.remove([gone.file])
        this.h.changed()
      } catch (e) {
        this.h.fail(e) // it is gone on WhatsApp either way
      }
      return { text: L('Apaguei a mensagem para todos.', 'Deleted the message for everyone.'), step }
    }
    // An empty text must not turn into a delete by accident.
    if (typeof raw !== 'string') throw new UserError(L('O texto novo precisa ser um texto. Para apagar a mensagem, deixe "texto" de fora.', 'The new text must be text. To delete the message, leave "texto" out.'))
    this.editable(m, raw)
    // Someone who never wrote to this number looks at it first, whatever the rule; so does a conversation a person took over.
    const ask = access.send !== 'auto' || this.paused(n, chat.id) || this.h.store().chat(n.id, chat.id)?.inboundAt === undefined
    if (ask) {
      return {
        text: L('Essa correção espera a aprovação de uma pessoa. Nada mudou ainda; você será avisado da decisão.', 'This fix waits for a person to approve it. Nothing changed yet; you will be told the decision.'),
        step,
        approval: { args: { numero_id: n.id, numero: n.name, conversa_id: chat.id, conversa: chat.name, mensagem_id: m.id, texto_antigo: m.text, texto: raw }, why: L(`Corrigir uma mensagem em ${chat.name}, pelo número ${n.name}.`, `Fix a message in ${chat.name}, from the number ${n.name}.`), detail: raw }
      }
    }
    await this.applyEdit(n, chat.id, m, raw)
    return { text: L('Corrigi a mensagem.', 'Fixed the message.'), step }
  }

  private async applyEdit(n: NumberRow, chatId: string, m: StoredMessage, text: string): Promise<void> {
    await edit(driverOf(this.h, n), chatId, keyOf(m), text)
    try {
      this.h.store().setText(n.id, chatId, m.id, text, true)
      this.h.changed()
    } catch (e) {
      this.h.fail(e) // it changed on WhatsApp either way
    }
  }

  // The fix a person approved, checked again now: the access, the message and the time limit.
  async approvedEdit(agentId: string, args: Record<string, unknown>): Promise<string> {
    const n = this.h.store().number(str(args['numero_id']))
    if (!n) throw new UserError(L('Esse número de WhatsApp não existe mais. Nada mudou.', 'That WhatsApp number no longer exists. Nothing changed.'))
    const chatId = str(args['conversa_id'])
    const name = this.h.store().chat(n.id, chatId)?.name ?? (str(args['conversa']) || chatId)
    const access = accessFor(this.h.store().access(n.id), agentId, chatId)
    if (access?.level !== 'reply') throw new UserError(refusalText(access ? 'read_only' : 'no_access', { chat: name, number: n.name, daily: 0, newChats: 0 }))
    const m = chatId ? this.stored(n.id, chatId, str(args['mensagem_id'])) : undefined
    if (!m) throw new UserError(L('A mensagem não está mais guardada. Nada mudou.', 'The message is no longer kept. Nothing changed.'))
    const text = typeof args['texto'] === 'string' ? args['texto'] : ''
    this.mine(m, agentId)
    this.editable(m, text)
    await this.applyEdit(n, chatId, m, text)
    return L('Corrigi a mensagem.', 'Fixed the message.')
  }

  // ---------- earlier messages ----------

  // Asks the phone for older messages of a conversation (the screen's button): they arrive on their own.
  async history(n: NumberRow, chatId: unknown): Promise<void> {
    const chat = typeof chatId === 'string' ? chatId.trim() : ''
    if (!chat) throw new UserError(L('Diga de qual conversa trazer as mensagens.', 'Say which conversation to bring the messages from.'))
    const driver = driverOf(this.h, n)
    const store = this.h.store()
    if (!store.readable(n.id, chat)) throw new UserError(L('Nenhum agente lê essa conversa ainda, então o Tucano não guarda as mensagens dela. Libere a conversa para um agente e tente de novo.', "No agent reads that conversation yet, so Tucano doesn't keep its messages. Open the conversation to an agent and try again."))
    const anchor = store.anchor(n.id, chat)
    if (!anchor) throw new UserError(L('Ainda não chegou nenhuma mensagem nessa conversa para servir de ponto de partida. Espere uma mensagem nova e tente de novo.', 'No message has arrived in that conversation yet to start from. Wait for a new message and try again.'))
    await history(driver, { ...anchor, chat }, 50)
  }

  // ---------- marking as read ----------

  // After an agent read a conversation, what it read is marked as read on WhatsApp, if the number is set to.
  // Nothing waits for it and a failure is only logged: the agent already has its answer.
  markRead(n: NumberRow, agentId: string, chat: WhatsAppChat, messages: readonly WhatsAppMessage[]): void {
    try {
      if (!n.settings.markRead || accessFor(this.h.store().access(n.id), agentId, chat.id)?.level !== 'reply') return
      const theirs = messages.filter((m) => !m.fromMe && !m.deleted && !m.id.startsWith(REACTION_PREFIX))
      if (!theirs.length) return
      let job: Promise<void>
      if (n.kind === 'qr') {
        const r = this.h.rt(n.id)
        if (!r.driver || r.view.status !== 'connected') return
        // In a group, WhatsApp needs to know who wrote each one: that is kept with the message.
        const keys = theirs.map((m) => {
          const participant = this.stored(n.id, chat.id, m.id)?.participant
          return { chat: chat.id, id: m.id, fromMe: false, ...(participant ? { participant } : {}) }
        })
        job = qrMarkRead(r.driver, keys)
      } else {
        const keys = this.h.keys.get(n.id)
        if (!keys || !this.h.cloudOk()) return
        job = cloud.markRead(keys, theirs[theirs.length - 1]!.id) // the newest one marks the ones before it
      }
      void job.catch((e: unknown) => this.h.fail(e))
    } catch (e) {
      this.h.fail(e)
    }
  }

  // ---------- getting a send ready ----------

  // Who an agent means by a name or a phone, among the people of a group. An exact phone or name always wins; a part of a
  // name or phone is used only when nothing matches exactly, and then several matches are refused with the list (never a guess).
  private who(people: { id: string; name?: string; phone?: string }[], query: string): { jid: string; phone: string; name?: string } {
    const q = query.replace(/^@/, '').trim()
    const digits = phoneDigits(q)
    const exactPhone = digits ? people.filter((p) => p.phone === digits) : []
    const exactName = people.filter((p) => p.name && fold(p.name) === fold(q))
    const loosePhone = digits && digits.length >= 8 ? people.filter((p) => !!p.phone?.endsWith(digits)) : []
    const looseName = people.filter((p) => p.name && fold(q) && fold(p.name).includes(fold(q)))
    const hits = [exactPhone, exactName, loosePhone, looseName].find((list) => list.length) ?? []
    const label = (p: { name?: string; phone?: string; id: string }): string => (p.name && p.phone ? `${p.name} (${p.phone})` : (p.name ?? p.phone ?? p.id.split('@')[0]!))
    if (hits.length === 1) return { jid: hits[0]!.id, phone: hits[0]!.phone ?? hits[0]!.id.split('@')[0]!, ...(hits[0]!.name ? { name: hits[0]!.name } : {}) }
    const who = people.slice(0, 40).map(label).join(', ')
    if (hits.length > 1) throw new UserError(L(`Mais de uma pessoa combina com "${query}": ${hits.slice(0, 10).map(label).join(', ')}. Use o telefone.`, `More than one person matches "${query}": ${hits.slice(0, 10).map(label).join(', ')}. Use the phone.`))
    throw new UserError(L(`Não achei "${query}" nesse grupo. Quem está nele: ${who}.`, `I couldn't find "${query}" in that group. Who is in it: ${who}.`))
  }

  // Checks everything a send carries and resolves it; throws the sentence of the first thing that is wrong.
  async plan(n: NumberRow, target: { id: string; name: string; kind: 'contact' | 'group' }, spec: Spec): Promise<Plan> {
    const mixed = [spec.tpl ? 'modelo' : '', spec.file ? 'arquivo' : '', spec.poll ? 'enquete' : ''].filter(Boolean)
    if (mixed.length > 1) throw new UserError(L(`Envie uma coisa só por vez: ${mixed.join(' e ')} não vão juntos. Faça um envio para cada.`, `Send one thing at a time: ${mixed.join(' and ')} don't go together. Make one send for each.`))
    if (spec.tpl && spec.text.trim()) throw new UserError(L('Com "modelo", deixe "texto" de fora: o modelo já é a mensagem.', 'With "modelo", leave "texto" out: the template is the message.'))
    if (spec.poll && spec.text.trim()) throw new UserError(L('Com "enquete", a pergunta vai em enquete.pergunta: deixe "texto" de fora.', 'With "enquete", the question goes in enquete.pergunta: leave "texto" out.'))
    if (spec.poll && n.kind !== 'qr') throw new UserError(L('Enquete só existe no número ligado por QR code.', 'Polls only exist on a QR-code number.'))
    if (spec.mention.length && (n.kind !== 'qr' || target.kind !== 'group')) throw new UserError(L('Mencionar pessoas só dá em grupo, no número ligado por QR code.', 'Mentioning people only works in a group, on a QR-code number.'))
    if (spec.mention.length && (spec.tpl || spec.poll)) throw new UserError(L('Mencionar só vai junto de um texto ou da legenda de uma imagem ou vídeo.', 'Mentions only go with a text or the caption of an image or video.'))

    let file: Plan['file']
    if (spec.file) {
      let size: number
      try {
        size = statSync(spec.file.path).size
      } catch {
        throw new UserError(L(`Não consegui abrir o arquivo "${spec.file.name}": ele pode ter sido apagado. Nada foi enviado.`, `I couldn't open the file "${spec.file.name}": it may have been deleted. Nothing was sent.`))
      }
      if (size === 0) throw new UserError(L(`O arquivo "${spec.file.name}" está vazio.`, `The file "${spec.file.name}" is empty.`))
      if (size > MEDIA_OUT_MAX) throw new UserError(L(`O arquivo "${spec.file.name}" tem ${megabytes(size)}, e o máximo para enviar é ${megabytes(MEDIA_OUT_MAX)}.`, `The file "${spec.file.name}" is ${megabytes(size)}, and the most that can be sent is ${megabytes(MEDIA_OUT_MAX)}.`))
      const mime = mimeOfFile(spec.file.name)
      file = { ...spec.file, size, mime, kind: kindOf(mime) }
      if (file.kind === 'audio' && spec.text.trim()) throw new UserError(L('Um áudio não leva legenda. Envie o texto numa mensagem separada.', 'An audio has no caption. Send the text as a separate message.'))
      if (spec.mention.length && file.kind !== 'image' && file.kind !== 'video') throw new UserError(L('Mencionar só vai na legenda de uma imagem ou vídeo, ou num texto.', 'Mentions only go in the caption of an image or video, or in a text.'))
      if (spec.text.length > CAPTION_MAX) throw new UserError(L(`A legenda de um arquivo tem no máximo ${CAPTION_MAX} caracteres.`, `A file's caption is at most ${CAPTION_MAX} characters.`))
    }

    let reply: StoredMessage | undefined
    if (spec.replyId) {
      reply = this.stored(n.id, target.id, spec.replyId)
      if (!reply || reply.deleted) throw new UserError(L(`Não achei a mensagem a que responder em "${target.name}", ou o id combina com mais de uma. Leia a conversa de novo com whatsapp_ler e use o id curto (#...). Nada foi enviado.`, `I couldn't find the message to answer in "${target.name}", or the id matches more than one. Read the conversation again with whatsapp_ler and use the short id (#...). Nothing was sent.`))
    }

    let mentions: Plan['mentions'] = []
    if (spec.mention.length) {
      const people = await groupPeople(driverOf(this.h, n), target.id)
      mentions = spec.mention.map((q) => this.who(people, q)).filter((x, i, all) => all.findIndex((y) => y.jid === x.jid) === i)
    }
    const tags = mentions.map((x) => `@${x.phone}`).join(' ')
    const sent = mentions.length ? `${spec.text.trim() ? `${spec.text.trimEnd()} ` : ''}${tags}` : spec.text
    return { text: spec.text, sent, judged: file ? spec.text || file.name : spec.poll ? spec.poll.pergunta : sent, ...(spec.tpl ? { tpl: spec.tpl } : {}), ...(reply ? { reply } : {}), mentions, ...(file ? { file } : {}), ...(spec.poll ? { poll: spec.poll } : {}) }
  }

  // The message as the QR link takes it. The file is read now, not when it was planned.
  async outgoing(plan: Plan): Promise<Outgoing> {
    return {
      ...(plan.sent.trim() ? { text: plan.sent } : {}),
      ...(plan.reply ? { quoted: { id: plan.reply.id, fromMe: plan.reply.fromMe, ...(plan.reply.participant ? { participant: plan.reply.participant } : {}), text: plan.reply.text } } : {}),
      ...(plan.mentions.length ? { mentions: plan.mentions.map((x) => x.jid) } : {}),
      ...(plan.file ? { file: { data: await readFile(plan.file.path), mime: plan.file.mime, name: plan.file.name, kind: plan.file.kind } } : {}),
      ...(plan.poll ? { poll: { name: plan.poll.pergunta, values: plan.poll.opcoes, selectableCount: plan.poll.multipla ? plan.poll.opcoes.length : 1 } } : {})
    }
  }
}

// How a sent message is written down, and what the window and the agent read back about it later.
export function describePlan(plan: Plan): Pick<StoredMessage, 'text' | 'media' | 'fileName' | 'mime' | 'size'> {
  if (plan.tpl) return { text: `[${plan.tpl.nome}] ${plan.tpl.variaveis.join(' · ')}`.trim() }
  if (plan.file) return { text: `${cloud.placeholder(plan.file.kind)} ${plan.text.trim() || plan.file.name}`, media: plan.file.kind, fileName: plan.file.name, mime: plan.file.mime, size: plan.file.size }
  if (plan.poll) return { text: `${cloud.placeholder('poll')} ${plan.poll.pergunta} — ${plan.poll.opcoes.join(' / ')}` }
  return { text: plan.sent }
}
