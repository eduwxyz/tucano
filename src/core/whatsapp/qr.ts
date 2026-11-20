// A WhatsApp number linked by QR code (or by typing a code on the phone): this app becomes one
// more device of a WhatsApp that already lives on a phone, through the unofficial Baileys
// library. One driver per number. Baileys is only loaded when a number is connected, so an
// install without a QR number never pays for it. Nothing WhatsApp sends may throw out of here:
// every handler is wrapped, and a bad moment becomes a status the screen can read.
import type * as Baileys from 'baileys'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { SEND_GAP_MS, type WhatsAppMediaKind, type WhatsAppStatus } from '../../shared/whatsapp'
import { downloadFile, messageOf, type Outgoing } from './qr-actions'
import type { ChatPatch, WhatsAppStore } from './store'
import { chatPatchOf, contactPatchOf, contextOf, describe, endOfLink, groupPatchOf, isGroup, isLid, isPn, jidPhone, keep, log, logger, mediaOf, noop, norm, quotedOf, sealedKeys, statusOf, toMs, Unconfirmed, unwrap, withTimeout } from './wire'

export { describe, jidPhone, Unconfirmed } from './wire'
export type { Outgoing } from './qr-actions'

type Sock = Baileys.WASocket

export interface QrStatus {
  status: WhatsAppStatus
  error?: string
  qr?: string
  pairingCode?: string
  phone?: string
}

// A message the phone's WhatsApp delivered, already read into plain fields.
export interface QrMessage {
  chat: string
  id: string
  fromMe: boolean
  ours: boolean // this driver sent it (an agent), as opposed to a person answering from the phone
  group: boolean
  sender?: string // in a group, who wrote
  participant?: string // in a group, the id of who wrote (what quoting or reacting to it needs)
  chatName?: string // a contact's own profile name, for a conversation that has no other name
  text: string
  at: number
  mentioned: boolean // the number was tagged, or one of its messages was answered
  live: boolean // it arrived now (not history delivered after being offline): only these wake agents or pause a conversation
  media?: { kind: WhatsAppMediaKind; mime: string; fileName?: string; size?: number } // it carries a file (its words are in `text`)
  quoted?: { id: string; text: string; sender?: string } // the message it answers
  download?: () => Promise<Buffer> // the bytes, only when called; UserError past MEDIA_IN_MAX or after 60 s
}

// Something that happened to a message that already exists: someone edited it, took it back, or reacted to it.
export interface QrChange {
  chat: string
  target: string // the id of that message
  kind: 'edit' | 'delete' | 'reaction'
  text?: string // 'edit': the new words
  emoji?: string // 'reaction': empty means the reaction was taken back
  fromMe: boolean // done from the phone (or another device) of this number
  sender?: string // in a group, who did it (a phone, when known)
  participant?: string // in a group, the id of who did it, as WhatsApp knows them: an edit or a delete is only the author's to make
  at: number
}

export interface QrHooks {
  status(s: QrStatus): void
  chat(c: ChatPatch): void
  message(m: QrMessage): void
  change?(c: QrChange): void
}

const RETRY_FIRST_MS = 2_000
const RETRY_MAX_MS = 60_000
const SEND_TIMEOUT_MS = 60_000
const FILE_TIMEOUT_MS = 120_000 // a file goes up slower than a text
const SENT_KEPT = 500

export class QrDriver {
  private b?: typeof Baileys
  private sock?: Sock
  private gen = 0 // each socket has a number; events of an older one are ignored
  private ended = false // single use: after stop() or logout() it does nothing more
  private attempts = 0
  private restarts = 0
  private retry?: NodeJS.Timeout
  private steady?: NodeJS.Timeout // open for a minute: only then does the backoff start again from the first retry
  private saving: Promise<void> = Promise.resolve()
  private phone?: string
  private onlyLinked = false
  private codeAsked = false
  private view: QrStatus = { status: 'disconnected' }
  private tail: Promise<unknown> = Promise.resolve()
  private sent = new Set<string>()
  private lids = new Map<string, string>() // hidden (LID) id → phone id
  private asked = new Set<string>() // groups whose name was already asked for
  private waiting = new Set<() => void>()
  private version?: Baileys.WAVersion

  constructor(
    private numberId: string,
    private store: WhatsAppStore,
    private hooks: QrHooks
  ) {}

  // `phone` links by typing a code on the phone instead of scanning; `onlyLinked` is the app starting:
  // a number that never finished linking stays quiet instead of showing a code nobody asked for.
  async start(phone?: string, onlyLinked = false): Promise<void> {
    this.phone = phone
    this.onlyLinked = onlyLinked
    this.attempts = 0
    this.restarts = 0
    this.codeAsked = false
    await this.open()
  }

  private set(patch: Partial<QrStatus>): void {
    if (this.ended) return
    // A field set to undefined is a field that no longer applies.
    const next = Object.fromEntries(Object.entries({ ...this.view, ...patch }).filter(([, v]) => v !== undefined)) as unknown as QrStatus
    this.view = next
    try {
      this.hooks.status({ ...next })
    } catch (e) {
      log(e)
    }
  }

  // Ends this driver with a sentence for the person; the number stays disconnected until Connect is pressed.
  private async finish(error: string | undefined, wipe = false): Promise<void> {
    this.set({ status: 'disconnected', qr: undefined, pairingCode: undefined, ...(error ? { error } : { error: undefined }) })
    this.ended = true
    this.cut()
    if (wipe) {
      await this.saving
      this.store.authClear(this.numberId)
    }
  }

  // Drops the socket and every wait that depended on it.
  private cut(): void {
    this.gen++
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.clearSteady()
    for (const cancel of [...this.waiting]) cancel()
    const sock = this.sock
    this.sock = undefined
    try {
      void sock?.end(undefined)
    } catch {
      // already closed
    }
  }

  // A drop, however soon after opening, means the connection was not steady: the backoff keeps going.
  private clearSteady(): void {
    if (this.steady) clearTimeout(this.steady)
    this.steady = undefined
  }

  private async open(): Promise<void> {
    if (this.ended) return
    const gen = ++this.gen
    const old = this.sock
    this.sock = undefined
    try {
      void old?.end(undefined)
    } catch {
      // already closed
    }
    this.set({ status: 'connecting', error: undefined })
    try {
      const B = (this.b ??= await import('baileys'))
      await this.saving
      let creds: Baileys.AuthenticationCreds
      try {
        const raw = await this.store.authGet(this.numberId, 'creds')
        creds = raw ? (JSON.parse(raw, B.BufferJSON.reviver) as Baileys.AuthenticationCreds) : B.initAuthCreds()
      } catch (e) {
        // Keys that cannot be opened or read are of no use: a new link is the way forward, unless only a saved link may start.
        log(e)
        if (this.onlyLinked) {
          this.set({ status: 'disconnected', error: L('A ligação salva deste número não pôde ser aberta. Toque em Conectar para ligar de novo.', "This number's saved link could not be opened. Press Connect to link it again.") })
          return
        }
        this.store.authClear(this.numberId)
        creds = B.initAuthCreds()
      }
      if (this.onlyLinked && !creds.account) {
        this.set({ status: 'disconnected' })
        return
      }
      this.onlyLinked = false
      this.version ??= await B.fetchLatestWaWebVersion({ signal: AbortSignal.timeout(8_000) }).then(
        (r) => r.version,
        () => undefined
      )
      if (gen !== this.gen || this.ended) return
      const sock = B.makeWASocket({
        auth: { creds, keys: B.makeCacheableSignalKeyStore(sealedKeys(B, this.store, this.numberId, (e) => this.write(e)), logger) },
        logger,
        // The pairing code only works for a browser WhatsApp knows by name.
        browser: B.Browsers.macOS('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        ...(this.version ? { version: this.version } : {})
      })
      if (gen !== this.gen || this.ended) {
        void sock.end(undefined)
        return
      }
      this.sock = sock
      this.wire(sock, gen)
    } catch (e) {
      if (gen !== this.gen) return
      if (!(e instanceof UserError)) log(e)
      await this.finish(e instanceof UserError ? e.message : L('Não consegui conectar ao WhatsApp. Confira a internet e toque em Conectar de novo.', 'I could not connect to WhatsApp. Check the internet and press Connect again.'))
    }
  }

  // ---------- the link's keys, sealed in the store ----------

  // Writes go one after another and never after the number was unlinked (they would bring the keys back).
  private write(entries: [string, string | undefined][]): Promise<void> {
    if (this.ended) return Promise.resolve()
    this.saving = this.saving.then(() => this.store.authSet(this.numberId, entries)).catch(log)
    return this.saving
  }

  // ---------- events ----------

  // Every handler goes through here: an older socket is ignored and nothing it throws gets out.
  private listen<E extends keyof Baileys.BaileysEventMap>(sock: Sock, gen: number, event: E, fn: (arg: Baileys.BaileysEventMap[E]) => void | Promise<void>): void {
    sock.ev.on(event, (arg: Baileys.BaileysEventMap[E]) => {
      if (gen !== this.gen || this.ended) return
      try {
        const r = fn(arg)
        if (r instanceof Promise) r.catch(log)
      } catch (e) {
        log(e)
      }
    })
  }

  private wire(sock: Sock, gen: number): void {
    const B = this.b!
    const on = <E extends keyof Baileys.BaileysEventMap>(event: E, fn: (arg: Baileys.BaileysEventMap[E]) => void | Promise<void>): void => this.listen(sock, gen, event, fn)
    on('creds.update', () => void this.write([['creds', JSON.stringify(sock.authState.creds, B.BufferJSON.replacer)]]))
    on('connection.update', (u) => this.connection(sock, u))
    on('messages.upsert', async ({ messages, type }) => {
      // 'notify' is live; 'append' is what arrived while this app was offline (and the echo of its own sends).
      if (type !== 'notify' && type !== 'append') return
      for (const m of messages) await this.incoming(sock, m, type === 'notify').catch(log)
    })
    on('chats.upsert', (cs) => cs.forEach((c) => this.chatEvent(c)))
    on('chats.update', (cs) => cs.forEach((c) => this.chatEvent(c)))
    on('contacts.upsert', (cs) => cs.forEach((c) => this.contactEvent(c)))
    on('contacts.update', (cs) => cs.forEach((c) => this.contactEvent(c)))
    on('groups.upsert', (gs) => gs.forEach((g) => this.groupEvent(g)))
    on('groups.update', (gs) => gs.forEach((g) => this.groupEvent(g)))
    on('lid-mapping.update', (m) => this.learn(m.lid, m.pn))
    // Edits, deletes and reactions come as these two events (their carrier messages have no words, so `incoming` drops them).
    on('messages.update', async (us) => void (await Promise.all(us.map((u) => this.updated(sock, u).catch(log)))))
    on('messages.reaction', async (rs) => void (await Promise.all(rs.map((r) => this.reacted(sock, r).catch(log)))))
    on('messaging-history.set', async (h) => {
      for (const m of h.lidPnMappings ?? []) this.learn(m.lid, m.pn)
      h.contacts.forEach((c) => this.contactEvent(c))
      h.chats.forEach((c) => this.chatEvent(c))
      // Earlier messages (also what `fetchMessageHistory` asked for): kept, but they never wake anyone.
      for (const m of h.messages) await this.incoming(sock, m, false).catch(log)
    })
  }

  private async connection(sock: Sock, u: Partial<Baileys.ConnectionState>): Promise<void> {
    if (u.qr) await this.pairing(sock, u.qr)
    if (u.connection === 'open') {
      this.clearSteady()
      this.steady = setTimeout(() => {
        this.steady = undefined
        this.attempts = 0
        this.restarts = 0
      }, 60_000)
      this.steady.unref()
      const phone = norm(sock.user?.id).split('@')[0]
      this.set({ status: 'connected', error: undefined, qr: undefined, pairingCode: undefined, ...(phone ? { phone } : {}) })
      void this.directory(sock)
    }
    if (u.connection === 'close') await this.closed(sock, u.lastDisconnect?.error)
  }

  // WhatsApp wants someone to link: a code to scan, or (with a phone number) eight characters to type.
  private async pairing(sock: Sock, qr: string): Promise<void> {
    if (!this.phone) {
      this.set({ status: 'pairing', qr, pairingCode: undefined, error: undefined })
      return
    }
    if (this.codeAsked) return
    this.codeAsked = true
    try {
      const code = await sock.requestPairingCode(this.phone)
      this.set({ status: 'pairing', pairingCode: code, qr: undefined, error: undefined })
    } catch (e) {
      log(e)
      await this.finish(L('O WhatsApp não aceitou esse número para gerar o código. Confira o número (com código do país) ou use o código QR.', 'WhatsApp did not accept that number for a code. Check the number (with country code) or use the QR code.'))
    }
  }

  private async closed(sock: Sock, error: unknown): Promise<void> {
    if (sock !== this.sock) return
    const code = statusOf(error)
    const linked = !!sock.authState.creds.account
    this.sock = undefined
    this.clearSteady()
    // 401 and 411 mean WhatsApp itself ended the link. Other errors (Baileys reports any unknown stream error as 500) are often a server hiccup: the link stays.
    const over = endOfLink(code)
    if (over) {
      await this.finish(over.error, over.wipe)
      return
    }
    // After the phone scans, WhatsApp asks for a fresh connection once: that is part of linking.
    if (code === 515 && this.restarts++ < 3) {
      void this.open()
      return
    }
    if (!linked) {
      await this.finish(
        code === 408
          ? L('O código expirou antes de ser lido. Toque em Conectar para gerar outro.', 'The code expired before it was read. Press Connect to make another.')
          : L('Não consegui conectar ao WhatsApp. Confira a internet e toque em Conectar de novo.', 'I could not connect to WhatsApp. Check the internet and press Connect again.')
      )
      return
    }
    // A linked number that lost the connection tries again on its own, slower each time.
    const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(this.attempts++, 10)) * (0.8 + Math.random() * 0.4)
    this.set({ status: 'connecting', error: L('A conexão caiu; tentando de novo sozinho.', 'The connection dropped; trying again on its own.') })
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.open()
    }, delay)
    this.retry.unref()
  }

  // ---------- who is on this number ----------

  private learn(lid: string | null | undefined, pn: string | null | undefined): void {
    const a = norm(lid)
    const b = norm(pn)
    if (a && b && isLid(a) && isPn(b)) this.lids.set(a, b)
  }

  // The id a conversation is kept under: the phone id when it is known, since the LID is only a stand-in.
  private canon(jid: string, alt?: string | null): string {
    const n = norm(jid)
    if (!isLid(n)) return n
    this.learn(n, alt)
    return this.lids.get(n) ?? n
  }

  private async directory(sock: Sock): Promise<void> {
    try {
      const groups = await withTimeout(sock.groupFetchAllParticipating(), 60_000)
      if (sock !== this.sock) return
      for (const g of Object.values(groups)) this.groupEvent(g)
    } catch (e) {
      log(e) // the directory fills in later from events; nothing depends on this call
    }
  }

  // What the directory events say, read by wire.ts; the ids they carry go through this driver's own (LID → phone) map.
  private readonly ids = { canon: (jid: string, alt?: string | null): string => this.canon(jid, alt), learn: (lid: string | null | undefined, pn: string | null | undefined): void => this.learn(lid, pn) }

  private chatEvent(c: Baileys.ChatUpdate): void {
    const p = chatPatchOf(c, this.ids)
    if (p) this.hooks.chat(p)
  }

  private contactEvent(c: Partial<Baileys.Contact>): void {
    const p = contactPatchOf(c, this.ids)
    if (p) this.hooks.chat(p)
  }

  private groupEvent(g: Partial<Baileys.GroupMetadata>): void {
    const p = groupPatchOf(g)
    if (p) this.hooks.chat(p)
  }

  // ---------- what arrives ----------

  private async incoming(sock: Sock, msg: Baileys.WAMessage, live: boolean): Promise<void> {
    const key = msg.key
    const remote = key.remoteJid
    if (!remote || !key.id || !keep(remote)) return // status updates, channels and broadcasts are not conversations
    // This driver's own send: the service stored it when it was sent. Checked before any await, so it is never taken twice.
    if (key.fromMe && this.sent.has(key.id)) return
    const content = unwrap(msg.message)
    const text = describe(content)
    if (!content || !text?.trim()) return
    const group = isGroup(remote)
    let chat = this.canon(remote, key.remoteJidAlt)
    if (isLid(chat)) {
      // The phone id of a hidden id may be one question away.
      const pn = await sock.signalRepository.lidMapping.getPNForLID(chat).catch(() => null)
      this.learn(chat, pn)
      chat = this.canon(chat)
    }
    const fromMe = !!key.fromMe
    const ours = fromMe && this.sent.has(key.id)
    let sender: string | undefined
    let participant: string | undefined
    if (group && !fromMe && key.participant) {
      const who = this.canon(key.participant, key.participantAlt)
      sender = msg.pushName || jidPhone(who) || undefined
      participant = norm(key.participant) || undefined // as WhatsApp knows them: quoting or reacting needs this one, not the phone
    }
    const me = [sock.user?.id, sock.user?.lid].map(norm).filter(Boolean)
    const ctx = contextOf(content)
    const mentioned = !!(ctx?.mentionedJid?.some((j) => me.includes(norm(j))) || (ctx?.participant && me.includes(norm(ctx.participant))) || (ctx?.stanzaId && this.sent.has(ctx.stanzaId)))
    if (live && group && !this.asked.has(chat)) {
      // A group the directory has not named yet: its name is asked for once (not for every group of a history batch).
      this.asked.add(chat)
      void sock.groupMetadata(chat).then((g) => this.groupEvent(g), noop)
    }
    const media = mediaOf(content)
    const quoted = quotedOf(content)
    this.hooks.message({
      chat,
      id: key.id,
      fromMe,
      ours,
      group,
      ...(sender ? { sender } : {}),
      ...(participant ? { participant } : {}),
      ...(!group && !fromMe && msg.pushName ? { chatName: msg.pushName } : {}),
      text,
      at: toMs(msg.messageTimestamp) ?? Date.now(),
      mentioned,
      live,
      ...(media ? { media: { kind: media.kind, mime: media.mime, ...(media.fileName ? { fileName: media.fileName } : {}), ...(media.size !== undefined ? { size: media.size } : {}) }, download: () => this.fetch(sock, msg, media.size) } : {}),
      ...(quoted ? { quoted } : {})
    })
  }

  private fetch(sock: Sock, msg: Baileys.WAMessage, size: number | undefined): Promise<Buffer> {
    if (this.ended || !this.b) return Promise.reject(new UserError(L('A conexão com o WhatsApp foi encerrada.', 'The connection to WhatsApp was closed.')))
    return downloadFile(this.b, sock, msg, size)
  }

  // ---------- what happened to a message that already exists ----------

  // The conversation a key belongs to, in the id it is kept under.
  private async chatOf(sock: Sock, key: Baileys.WAMessageKey): Promise<string | undefined> {
    const remote = key.remoteJid
    if (!remote || !keep(remote)) return undefined
    let chat = this.canon(remote, key.remoteJidAlt)
    if (isLid(chat)) {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(chat).catch(() => null)
      this.learn(chat, pn)
      chat = this.canon(chat)
    }
    return chat
  }

  private who(key: Baileys.WAMessageKey): string | undefined {
    return key.participant ? jidPhone(this.canon(key.participant, key.participantAlt)) : undefined
  }

  // An edit or a delete: the key's id is the message it is about.
  private async updated(sock: Sock, u: Baileys.WAMessageUpdate): Promise<void> {
    const target = u.key.id
    const chat = await this.chatOf(sock, u.key)
    if (!target || !chat) return
    const sender = this.who(u.key)
    // The change's own key (Baileys builds an edit's and a delete's key from the carrier message's), so its participant is who sent it.
    const participant = norm(u.key.participant) || undefined
    const base = { chat, target, fromMe: !!u.key.fromMe, ...(sender ? { sender } : {}), ...(participant ? { participant } : {}) }
    if (u.update.messageStubType === this.b!.WAMessageStubType.REVOKE) {
      const carrier = u.update.key?.id // the delete's own message: one this driver sent is already known by the service
      if (carrier && this.sent.has(carrier)) return
      this.hooks.change?.({ ...base, kind: 'delete', at: Date.now() })
      return
    }
    const words = describe(unwrap(u.update.message?.editedMessage?.message))
    if (words) this.hooks.change?.({ ...base, kind: 'edit', text: words, at: toMs(u.update.messageTimestamp) ?? Date.now() })
  }

  // A reaction: `key` is the message reacted to, `reaction.key` the reaction's own message (so who reacted).
  private async reacted(sock: Sock, r: { key: Baileys.WAMessageKey; reaction: Baileys.proto.IReaction }): Promise<void> {
    const chat = await this.chatOf(sock, r.key)
    const target = r.key.id
    const by = r.reaction.key
    if (!target || !chat || (by?.id && this.sent.has(by.id))) return
    const sender = by?.participant ? jidPhone(this.canon(by.participant)) : undefined
    this.hooks.change?.({ chat, target, kind: 'reaction', emoji: r.reaction.text ?? '', fromMe: !!by?.fromMe, ...(sender ? { sender } : {}), ...(by?.participant ? { participant: norm(by.participant) } : {}), at: Date.now() })
  }

  // ---------- what goes out ----------

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cancel = (): void => {
        clearTimeout(t)
        this.waiting.delete(cancel)
        reject(new UserError(L('A conexão foi encerrada antes de enviar.', 'The connection was closed before sending.')))
      }
      const t = setTimeout(() => {
        this.waiting.delete(cancel)
        resolve()
      }, ms)
      t.unref()
      this.waiting.add(cancel)
    })
  }

  private live(): Sock {
    if (!this.sock || this.view.status !== 'connected' || this.ended) throw new UserError(L('Esse número não está conectado ao WhatsApp agora. Conecte-o e tente de novo.', "That number isn't connected to WhatsApp right now. Connect it and try again."))
    return this.sock
  }

  // One message at a time: "typing…", a person's pause, then the message; returns its id.
  // A string is plain text; an `Outgoing` can also quote, mention, carry a file or be a poll.
  send(chat: string, content: string | Outgoing): Promise<string> {
    const out: Outgoing = typeof content === 'string' ? { text: content } : content
    const run = this.tail.then(() => this.sendNow(chat, out))
    this.tail = run.catch(noop)
    return run
  }

  // Runs something on the live socket after the sends already waiting (so it never jumps ahead of a message),
  // with a time limit; anything it throws that is not already a sentence becomes one.
  use<T>(fn: (sock: Sock, B: typeof Baileys) => Promise<T>, timeoutMs = 30_000): Promise<T> {
    const run = this.tail.then(async () => {
      const sock = this.live()
      try {
        return await withTimeout(fn(sock, this.b!), timeoutMs)
      } catch (e) {
        if (e instanceof UserError) throw e
        log(e)
        throw new UserError(L('O WhatsApp não aceitou o pedido. Confira se o número ainda está conectado e tente de novo.', 'WhatsApp did not accept the request. Check that the number is still connected and try again.'))
      }
    })
    this.tail = run.catch(noop)
    return run
  }

  // The id is ours before it leaves, so the copy WhatsApp echoes back is not taken for a person typing on the phone.
  markSent(id: string): void {
    this.sent.add(id)
    if (this.sent.size > SENT_KEPT) this.sent.delete(this.sent.values().next().value as string)
  }

  private async sendNow(chat: string, out: Outgoing): Promise<string> {
    const { content, quoted } = messageOf(out, chat) // refuses what can't go, before the typing pause
    const sock = this.live()
    await sock.sendPresenceUpdate('composing', chat).catch(noop)
    await this.wait(SEND_GAP_MS[0] + Math.random() * (SEND_GAP_MS[1] - SEND_GAP_MS[0]))
    const live = this.live()
    const id = this.b!.generateMessageIDV2(live.user?.id)
    this.markSent(id)
    try {
      const res = await withTimeout(live.sendMessage(chat, content, { messageId: id, ...(quoted ? { quoted } : {}) }), out.file ? FILE_TIMEOUT_MS : SEND_TIMEOUT_MS, () => new Unconfirmed(id))
      return res?.key.id ?? id
    } catch (e) {
      if (e instanceof UserError) throw e
      log(e)
      throw new UserError(L('O WhatsApp não aceitou a mensagem. Confira se o número ainda está conectado e tente de novo.', 'WhatsApp did not accept the message. Check that the number is still connected and try again.'))
    } finally {
      void live.sendPresenceUpdate('paused', chat).catch(noop)
    }
  }

  // The conversation id of a phone number, or undefined when that number is not on WhatsApp.
  async resolvePhone(digits: string): Promise<string | undefined> {
    const sock = this.live()
    try {
      const found = (await withTimeout(sock.onWhatsApp(digits), 15_000))?.find((r) => r.exists)
      return found ? this.canon(found.jid) : undefined
    } catch (e) {
      if (e instanceof UserError) throw e
      log(e)
      throw new UserError(L('Não consegui conferir esse número no WhatsApp agora. Tente de novo.', "I couldn't check that number on WhatsApp right now. Try again."))
    }
  }

  // Unlinks the number: WhatsApp removes it from the phone's devices and the keys here are erased.
  async logout(): Promise<void> {
    const sock = this.sock
    this.ended = true
    try {
      if (sock && this.view.status === 'connected') await withTimeout(sock.logout(), 10_000)
    } catch (e) {
      log(e) // the phone may already have removed it; the keys go either way
    }
    this.cut()
    await this.saving
    this.store.authClear(this.numberId)
  }

  // Closes the connection and keeps the link (the app is closing, or the number is being replaced).
  stop(): void {
    this.ended = true
    this.cut()
  }
}
