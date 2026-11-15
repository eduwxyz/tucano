// The wakes of WhatsApp conversations: a burst of messages is one wake for an agent, a conversation
// can wake agents only so often, and a chat that never pauses still gets its answer. The service in
// index.ts stores every message; this class decides which arrivals wake an agent, and when.
import type { WhatsAppMessage } from '../../shared/whatsapp'

const WAKE_DEBOUNCE_MS = 8_000 // a burst of messages is one wake
const WAKE_MAX_WAIT_MS = 30_000 // a chat that never pauses for 8 s is answered at the latest this late
const WAKE_MAX_MESSAGES = 50
const WAKE_MAX_PER_HOUR = 12 // a bot or a spammer on the other side must not cost a model run per message
const WAKE_WINDOW_MS = 3_600_000

export interface Pending {
  numberId: string
  chat: string
  agentId: string
  messages: WhatsAppMessage[]
  firstAt: number // when the burst began: the longest wait is counted from here
  timer: NodeJS.Timeout
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
