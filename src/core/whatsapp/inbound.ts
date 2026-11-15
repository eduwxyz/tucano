// What arrives from WhatsApp, until an agent hears about it: every message is stored, a file that comes
// with it is downloaded and kept (an audio is also turned into words), edits, deletes and reactions
// change what is stored, and only then does this decide which arrivals wake an agent, and when. A burst
// of messages is one wake, a conversation can wake agents only so often, and a chat that never pauses
// still gets its answer. The service in index.ts lends the host (store, numbers, screen refresh).
import { L } from '../../shared/lang'
import { accessFor, MEDIA_IN_MAX, type WhatsAppChat, type WhatsAppMessage } from '../../shared/whatsapp'
import { MAX_AUDIO_BASE64 } from '../transcribe'
import type { Runtime } from './agent'
import { toWav, type WhatsAppMedia } from './media'
import { jidPhone, type QrChange, type QrMessage } from './qr'
import type { NumberRow, StoredMessage, WhatsAppStore } from './store'
import { REACTION_PREFIX, snippet } from './tools'

const WAKE_DEBOUNCE_MS = 8_000 // a burst of messages is one wake
const WAKE_MAX_WAIT_MS = 30_000 // a chat that never pauses for 8 s is answered at the latest this late
const WAKE_MAX_MESSAGES = 50
const WAKE_MAX_PER_HOUR = 12 // a bot or a spammer on the other side must not cost a model run per message
const WAKE_WINDOW_MS = 3_600_000
const STORED_TEXT_MAX = 8_000
const SAID_MAX = 4_000 // what one audio's words may take in the stored text
const LANE_MAX = 30 // downloads of one number waiting in its line: past this a new file is not kept, so a flood of files cannot fill the disk or hold every wake behind it

export interface Pending {
  numberId: string
  chat: string
  agentId: string
  messages: WhatsAppMessage[]
  firstAt: number // when the burst began: the longest wait is counted from here
  timer: NodeJS.Timeout
}

// What an agent is woken with.
export interface Inbound {
  numberId: string
  numberName: string
  chat: WhatsAppChat
  messages: WhatsAppMessage[] // what arrived, oldest first
  send: 'ask' | 'auto' // how this agent's answers leave that conversation
}

// A message from either kind of number, in the same shape.
export interface Incoming extends QrMessage {
  phone?: string
}

// What the service lends: how a wake is delivered, and how a failure is logged.
export interface WakeHost {
  deliver(p: Pending): void
  fail(e: unknown): void
}

export class Wakes {
  private pending = new Map<string, Pending>()
  private stamps = new Map<string, number[]>() // when each conversation was woken, by `numberId\nchat`

  constructor(private host: WakeHost) {}

  // Several messages in a row are one wake that carries all of them.
  debounce(numberId: string, chat: string, agentId: string, msg: WhatsAppMessage): void {
    const key = `${numberId}\n${chat}\n${agentId}`
    const old = this.pending.get(key)
    // A new wake is a model run: a conversation that used its hour's wakes drops the message (it is still stored).
    if (!old && !this.room(numberId, chat)) return
    const now = Date.now()
    const firstAt = old?.firstAt ?? now
    if (old) clearTimeout(old.timer)
    const messages = [...(old?.messages ?? []), msg].slice(-WAKE_MAX_MESSAGES)
    const wait = Math.max(0, Math.min(WAKE_DEBOUNCE_MS, firstAt + WAKE_MAX_WAIT_MS - now))
    const timer = setTimeout(() => this.fire(key), wait)
    timer.unref()
    this.pending.set(key, { numberId, chat, agentId, messages, firstAt, timer })
    // Past the longest wait, the burst goes now instead of waiting for another pause that may never come.
    if (old && now - firstAt >= WAKE_MAX_WAIT_MS) this.fire(key)
  }

  // Drops the wakes that match: a number that left, an agent that was archived, a person who took over the chat.
  drop(match: (p: Pending) => boolean): void {
    for (const [key, p] of this.pending) {
      if (!match(p)) continue
      clearTimeout(p.timer)
      this.pending.delete(key)
    }
  }

  // A message taken back is not answered: it leaves every burst still waiting for it, and a burst left empty is dropped.
  forgetMessage(numberId: string, chat: string, id: string): void {
    for (const [key, p] of this.pending) {
      if (p.numberId !== numberId || p.chat !== chat) continue
      const messages = p.messages.filter((m) => m.id !== id)
      if (messages.length === p.messages.length) continue
      if (messages.length === 0) {
        clearTimeout(p.timer)
        this.pending.delete(key)
      } else this.pending.set(key, { ...p, messages })
    }
  }

  // A number that leaves takes its hour's count with it.
  forget(numberId: string): void {
    for (const key of this.stamps.keys()) if (key.startsWith(`${numberId}\n`)) this.stamps.delete(key)
  }

  clear(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
    this.stamps.clear()
  }

  private fire(key: string): void {
    const p = this.pending.get(key)
    if (!p) return
    clearTimeout(p.timer) // a timer left behind must not fire a later burst that reuses this key
    this.pending.delete(key)
    try {
      this.host.deliver(p)
    } catch (e) {
      this.host.fail(e)
    }
  }

  // Whether this conversation may take one more wake: at most WAKE_MAX_PER_HOUR in a rolling hour.
  private room(numberId: string, chat: string): boolean {
    const key = `${numberId}\n${chat}`
    const now = Date.now()
    const recent = (this.stamps.get(key) ?? []).filter((t) => now - t < WAKE_WINDOW_MS)
    const full = recent.length >= WAKE_MAX_PER_HOUR
    if (!full) recent.push(now)
    this.stamps.set(key, recent)
    return !full
  }
}

// What the service lends to the arrivals.
export interface ArrivalsHost {
  store(): WhatsAppStore
  rt(id: string): Runtime
  live(id: string): boolean // the number still exists and is being served
  agents(): { id: string; name: string; archived?: boolean }[]
  media: WhatsAppMedia
  transcribe?: (wav: Buffer) => Promise<string | undefined> // undefined: dictation isn't set up
  withPause(numberId: string, c: WhatsAppChat): WhatsAppChat
  wake(agentId: string, inbound: Inbound): void
  changed(): void
  fail(e: unknown): void
}

export class Arrivals {
  readonly wakes: Wakes
  private lanes = new Map<string, Promise<unknown>>() // a number's downloads go one at a time
  private queued = new Map<string, number>() // a number's downloads waiting in its line (the one running included)

  constructor(private h: ArrivalsHost) {
    this.wakes = new Wakes({ deliver: (p) => this.deliver(p), fail: (e) => h.fail(e) })
  }

  clear(): void {
    this.wakes.clear()
    this.lanes.clear()
  }

  // ---------- messages ----------

  // Nothing a message does may throw out of here: the link and Meta's webhook both call this.
  message(numberId: string, m: Incoming): void {
    try {
      if (this.h.live(numberId)) this.inbound(numberId, m)
    } catch (e) {
      this.h.fail(e)
    }
  }

  private inbound(numberId: string, m: Incoming): void {
    const store = this.h.store()
    const n = store.number(numberId)
    if (!n || m.ours) return // what an agent sent is stored when it is sent
    const phone = m.phone ?? (m.group ? undefined : jidPhone(m.chat))
    store.upsertChat(numberId, { id: m.chat, kind: m.group ? 'group' : 'contact', ...(m.chatName ? { softName: m.chatName } : {}), ...(phone ? { phone } : {}), lastAt: m.at, ...(m.fromMe ? {} : { inboundAt: m.at }) })
    // The oldest message seen here, kept or not: "earlier messages" are asked backwards from it.
    store.setAnchor(numberId, m.chat, { id: m.id, fromMe: m.fromMe, ...(m.participant ? { participant: m.participant } : {}), at: m.at })
    const msg: StoredMessage = {
      id: m.id,
      chat: m.chat,
      fromMe: m.fromMe,
      ...(m.sender ? { sender: m.sender } : {}),
      text: m.text.slice(0, STORED_TEXT_MAX),
      at: m.at,
      ...(m.participant ? { participant: m.participant } : {}),
      ...(m.media ? { media: m.media.kind, mime: m.media.mime, ...(m.media.fileName ? { fileName: m.media.fileName } : {}), ...(m.media.size !== undefined ? { size: m.media.size } : {}) } : {}),
      ...(m.quoted ? { quoted: m.quoted } : {})
    }
    const readable = store.readable(numberId, m.chat)
    if (readable && !store.addMessage(numberId, msg)) return // the same message delivered twice
    // Stored now: the screen shows it, history asked for from the phone included (it is counted and its chat moves up).
    if (readable) this.h.changed()
    // Only an arrival that wakes someone now (see targetsOf) turns its audio into words on arrival.
    const targets = !m.fromMe && m.live !== false && readable ? this.targetsOf(numberId, n, m) : []
    // The file comes after the message is stored: nothing waits for it, and nothing that goes wrong with it loses the message.
    const filing = readable && m.media && m.download ? this.file(numberId, msg, m, targets.length > 0) : undefined
    if (m.live === false) return // history delivered after a reconnect: stored, but it wakes no one and pauses nothing
    const r = this.h.rt(numberId)
    if (m.fromMe) {
      // A person answered from the phone: the agents leave that conversation to them for a while.
      if (n.settings.pauseOnHumanMin > 0) {
        r.paused.set(m.chat, Date.now() + n.settings.pauseOnHumanMin * 60_000)
        this.wakes.drop((p) => p.numberId === numberId && p.chat === m.chat)
      }
      this.h.changed()
      return
    }
    if (!targets.length) return
    const wake = (text: string): void => {
      if (!this.h.live(numberId)) return
      for (const agentId of targets) this.wakes.debounce(numberId, m.chat, agentId, { ...msg, text })
    }
    // An audio wakes the agent with its words, so the wake waits for them (a file that fails to come never blocks it for long).
    if (filing) void filing.then((text) => wake(text ?? msg.text)).catch((e: unknown) => this.h.fail(e))
    else wake(msg.text)
  }

  // The agents this arrival wakes now, in order; none when it wakes nobody: the number does not wake agents, the chat is
  // paused (a person answered there), a group wants a mention that is not there, or no agent may reply in this chat.
  private targetsOf(numberId: string, n: NumberRow, m: Incoming): string[] {
    if (n.settings.inbound !== 'wake') return []
    if ((this.h.rt(numberId).paused.get(m.chat) ?? 0) > Date.now()) return []
    if (m.group && n.settings.groupsOnlyMention && !m.mentioned) return []
    const access = this.h.store().access(numberId)
    const agents = new Map(this.h.agents().map((a) => [a.id, a]))
    return [...new Set(access.map((a) => a.agentId))].filter((id) => accessFor(access, id, m.chat)?.level === 'reply' && agents.get(id) && !agents.get(id)!.archived)
  }

  // A burst that is still due when it fires: the conversation must still be open to the agent, and not paused.
  private deliver(p: Pending): void {
    const store = this.h.store()
    const n = store.number(p.numberId)
    const chat = store.chat(p.numberId, p.chat)
    const a = accessFor(store.access(p.numberId), p.agentId, p.chat)
    if (!n || !chat || a?.level !== 'reply' || (this.h.rt(p.numberId).paused.get(p.chat) ?? 0) > Date.now()) return
    // A message whose audio took longer than a later one still reads in the order it was said.
    const messages = [...p.messages].sort((x, y) => x.at - y.at)
    this.h.wake(p.agentId, { numberId: n.id, numberName: n.name, chat: this.h.withPause(n.id, chat), messages, send: a.send })
  }

  // ---------- files ----------

  // The file goes into the number's download line. Past LANE_MAX waiting there, the file is not kept: the message is,
  // and whatsapp_midia says the file was not kept.
  private file(numberId: string, msg: StoredMessage, m: Incoming, speak: boolean): Promise<string | undefined> | undefined {
    const waiting = this.queued.get(numberId) ?? 0
    if (waiting >= LANE_MAX) return undefined
    this.queued.set(numberId, waiting + 1)
    const run = (this.lanes.get(numberId) ?? Promise.resolve()).then(() => this.keep(numberId, msg, m, speak))
    this.lanes.set(numberId, run) // `keep` never rejects, so the line never breaks
    void run.finally(() => this.unqueue(numberId))
    return run
  }

  private unqueue(numberId: string): void {
    const left = (this.queued.get(numberId) ?? 0) - 1
    if (left > 0) this.queued.set(numberId, left)
    else this.queued.delete(numberId)
  }

  // Downloads and saves the file of a message; for an audio that someone reads now (`speak`), also its words. Returns the
  // new text of the message when it changed. A file that is too big stays a label, and a failure is only logged.
  private async keep(numberId: string, msg: StoredMessage, m: Incoming, speak: boolean): Promise<string | undefined> {
    const media = m.media!
    try {
      if (!this.h.live(numberId)) return undefined
      if (media.size !== undefined && media.size > MEDIA_IN_MAX) return undefined
      const data = await m.download!()
      if (data.length === 0 || data.length > MEDIA_IN_MAX) return undefined
      const rel = await this.h.media.save(numberId, msg.id, data, media.mime, media.fileName, msg.chat)
      // The message may have been taken back, or the number removed, while the file came.
      if (!this.h.live(numberId) || !this.h.store().setFile(numberId, msg.chat, msg.id, rel, data.length)) {
        await this.h.media.remove([rel])
        return undefined
      }
      if (!speak || media.kind !== 'audio') return undefined // no one reads it now: its words are made on demand (whatsapp_midia)
      const said = await this.speech(data)
      if (!said) return undefined
      const text = `${msg.text} "${said}"`.slice(0, STORED_TEXT_MAX)
      this.h.store().setText(numberId, msg.chat, msg.id, text, false)
      return text
    } catch (e) {
      this.h.fail(e)
      return undefined
    }
  }

  // The words of an audio, through ffmpeg and dictation; undefined when either is missing, the audio is longer
  // than the transcriber takes, or nothing was said. Never throws.
  async speech(data: Buffer): Promise<string | undefined> {
    if (!this.h.transcribe) return undefined
    try {
      const wav = await toWav(data)
      if (!wav || Math.ceil(wav.length / 3) * 4 > MAX_AUDIO_BASE64) return undefined
      const said = (await this.h.transcribe(wav))?.replace(/\s+/g, ' ').trim()
      return said ? said.slice(0, SAID_MAX) : undefined
    } catch (e) {
      this.h.fail(e)
      return undefined
    }
  }

  // ---------- what happens to a message that exists ----------

  // An edit, a delete or a reaction: it changes what is stored and wakes no one, pauses nothing.
  change(numberId: string, c: QrChange): void {
    try {
      if (!this.h.live(numberId)) return
      const store = this.h.store()
      if (!store.readable(numberId, c.chat)) return
      let changed = false
      if (c.kind === 'edit' || c.kind === 'delete') {
        // Anyone in a chat can name any message in an edit or a delete, so only its author may change it. This number's
        // own messages are its (fromMe). In a group, another person's message answers to the participant that wrote it,
        // and a change that does not say who sent it is not taken for that person.
        const stored = store.message(numberId, c.chat, c.target)
        if (!stored || stored.id !== c.target || stored.fromMe !== c.fromMe) return
        if (c.chat.endsWith('@g.us') && !stored.fromMe && (c.participant === undefined || stored.participant !== c.participant)) return
      }
      if (c.kind === 'edit') {
        const text = (c.text ?? '').trim()
        if (text) changed = store.setText(numberId, c.chat, c.target, text.slice(0, STORED_TEXT_MAX), true)
      } else if (c.kind === 'delete') {
        const gone = store.setDeleted(numberId, c.chat, c.target)
        changed = gone.found
        if (gone.file) void this.h.media.remove([gone.file]).catch((e: unknown) => this.h.fail(e))
        // A message taken back is not answered either: the wakes still waiting on it are dropped.
        if (gone.found) this.wakes.forgetMessage(numberId, c.chat, c.target)
      } else if (c.emoji) {
        // The emoji comes from outside: it is cut to 16 characters, and blanks alone are no reaction at all.
        const emoji = [...c.emoji.trim()].slice(0, 16).join('')
        // A reaction is kept as a line of its own, linked to the message it is about (one that isn't kept says nothing).
        const target = emoji ? store.message(numberId, c.chat, c.target) : undefined
        if (target) {
          const about = snippet(target.deleted ? '' : target.text, 60)
          const who = c.sender ?? (c.fromMe ? 'me' : 'them')
          changed = store.addMessage(numberId, {
            id: `${REACTION_PREFIX}${c.target}:${who}:${c.at}`,
            chat: c.chat,
            fromMe: c.fromMe,
            ...(c.sender ? { sender: c.sender } : {}),
            text: L(`[reagiu ${emoji} a "${about}"]`, `[reacted ${emoji} to "${about}"]`),
            at: c.at,
            quoted: { id: target.id, text: about, ...(target.sender ? { sender: target.sender } : {}) }
          })
        }
      }
      if (changed) this.h.changed()
    } catch (e) {
      this.h.fail(e)
    }
  }
}
