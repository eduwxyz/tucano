// A session kept per agent, conversation and thread, so a reply goes on from the agent's last one
// with only what's new since (other people's and agents' messages, then the task), instead of the
// whole transcript again: the history is read back from the prompt cache, not written to it again.
//
// What the session saw is what decides whether it can go on. It starts over when anything it saw
// changed: the system prompt or the tools (Claude Code keeps the first system prompt on resume, so a
// new one needs a new session), a message it saw was edited or deleted, a message turns up in
// between, its last reply didn't end well, or it grew past what a fresh start would cost.
import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const SESSION_TTL_MS = 55 * 60_000 // the prompt cache lasts an hour: past it, resuming costs what starting over does
export const SESSION_MAX_CONTEXT = 60_000 // tokens; past it, the next reply starts over from the summary and the window
export const MAX_SESSIONS = 100

// A message as the transcript shows it: its id and its block.
export interface Shown {
  id: string
  block: string
}

export interface SessionPlan {
  id: string // the engine's session id
  token: string // the gateway's, for as long as the session lives: a process kept open keeps its URL
  resume: boolean
  send: string[] // the messages to send, of those shown: all of them when it starts, the new ones when it resumes
}

interface Entry {
  id: string
  token: string
  config: string
  seen: Map<string, string> // message id → its block's hash; '*' for its own replies, whose text it wrote
  usedAt: number
  context: number
}

const OWN = '*'
const hash = (text: string): string => createHash('sha256').update(text).digest('base64url')

// Everything a session is tied to: a change in any of these starts a new one.
export const sessionConfig = (parts: Record<string, unknown>): string => hash(JSON.stringify(parts))

export class Sessions {
  private entries = new Map<string, Entry>()
  private busy = new Set<string>()
  private doomed = new Set<string>() // to go when their running reply ends
  private readonly now: () => number

  constructor(
    private readonly opts: {
      exists(messageId: string): boolean // still in the database: a deleted message ends the session that saw it
      forget(s: { id: string; token: string }): void // the engine's process and file, and the gateway's token
      now?: () => number
      ttlMs?: number
      maxContext?: number
    }
  ) {
    this.now = opts.now ?? Date.now
  }

  // Undefined when a reply for the same key is already running: that one goes without a session.
  // `restart`: start over regardless ("try again" redoes a reply the session already holds).
  // `task`: the turn ends with a task block, so it has something to send even with no new message.
  begin(key: string, input: { config: string; shown: Shown[]; restart?: boolean; task?: boolean }): SessionPlan | undefined {
    if (this.busy.has(key)) return undefined
    this.busy.add(key)
    const e = this.entries.get(key)
    if (e && !input.restart) {
      const send = this.since(e, input)
      if (send && (send.length || input.task)) return { id: e.id, token: e.token, resume: true, send }
    }
    if (e) this.drop(key)
    return { id: randomUUID(), token: randomBytes(24).toString('hex'), resume: false, send: input.shown.map((s) => s.id) }
  }

  // The reply ended. `ok`: it finished on its own (not stopped, cut or failed), so the session holds
  // a whole turn and can go on; `reply`: the agent's own message; `context`: its size now, in tokens.
  end(key: string, plan: SessionPlan, out: { ok: boolean; config: string; shown: Shown[]; reply?: string; context?: number }): void {
    this.busy.delete(key)
    const e = this.entries.get(key)
    if (!out.ok || this.doomed.delete(key)) {
      if (e?.id === plan.id) this.drop(key)
      else this.opts.forget(plan)
      return
    }
    const entry: Entry = e?.id === plan.id ? e : { id: plan.id, token: plan.token, config: out.config, seen: new Map(), usedAt: 0, context: 0 }
    for (const s of out.shown) entry.seen.set(s.id, hash(s.block))
    if (out.reply) entry.seen.set(out.reply, OWN)
    entry.config = out.config
    entry.usedAt = this.now()
    entry.context = out.context ?? entry.context
    this.entries.set(key, entry)
    if (this.entries.size > MAX_SESSIONS) {
      const oldest = [...this.entries].filter(([k]) => !this.busy.has(k)).sort((a, b) => a[1].usedAt - b[1].usedAt)[0]
      if (oldest) this.drop(oldest[0])
    }
  }

  // Sessions that can't go on: their agent was archived or their conversation deleted. Keys are
  // agent:conversation:thread. One with a reply running goes when that reply ends.
  dropWhere(match: (key: string) => boolean): void {
    for (const k of new Set([...this.entries.keys(), ...this.busy]))
      if (!match(k)) continue
      else if (this.busy.has(k)) this.doomed.add(k)
      else this.drop(k)
  }

  // Sessions whose cache is gone: resuming them would cost what starting over does.
  sweep(): void {
    const ttl = this.opts.ttlMs ?? SESSION_TTL_MS
    for (const [k, e] of [...this.entries]) if (!this.busy.has(k) && this.now() - e.usedAt > ttl) this.drop(k)
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  // What's new since the session's last reply, or undefined when it can't go on.
  private since(e: Entry, input: { config: string; shown: Shown[] }): string[] | undefined {
    if (e.config !== input.config) return undefined
    if (this.now() - e.usedAt > (this.opts.ttlMs ?? SESSION_TTL_MS)) return undefined
    if (e.context > (this.opts.maxContext ?? SESSION_MAX_CONTEXT)) return undefined
    const send: string[] = []
    const shownIds = new Set<string>()
    for (const s of input.shown) {
      shownIds.add(s.id)
      const was = e.seen.get(s.id)
      if (was === undefined) {
        send.push(s.id)
        continue
      }
      if (send.length) return undefined // a message it saw comes after one it didn't: something turned up in between
      if (was !== OWN && was !== hash(s.block)) return undefined // edited since
    }
    // Out of the window now, or deleted.
    for (const id of e.seen.keys()) if (!shownIds.has(id) && !this.opts.exists(id)) return undefined
    return send
  }

  private drop(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    this.entries.delete(key)
    this.opts.forget(e)
  }
}
